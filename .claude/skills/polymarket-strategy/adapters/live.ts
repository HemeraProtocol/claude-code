/**
 * LiveAdapter — fetches real-time data from Gamma API, CLOB orderbooks,
 * Binance klines, and xtracker (settlement source), then assembles a unified Ctx.
 *
 * Named "Live" (not "Polymarket") because data sources span multiple
 * providers (Binance, xtracker — not all are Polymarket).
 */

import { parseQuestion } from '../parser'
import type {
  Ctx,
  BuildCtxOpts,
  DataAdapter,
  Kline,
  TweetData,
  NewsData,
} from '../types'

// ─── Gamma / CLOB types (internal to this adapter) ──────────────────────────

interface GammaMarket {
  id: string
  question: string
  slug: string
  endDate: string
  outcomes: string
  outcomePrices: string
  volume: string
  liquidity: string
  active: boolean
  closed: boolean
  conditionId: string
  clobTokenIds: string
  startDate?: string
  description?: string
}

interface GammaEvent {
  slug: string
  title: string
  description?: string
  markets: GammaMarket[]
}

interface ClobBook {
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

type KlineInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

// ─── helpers (module-private) ───────────────────────────────────────────────

function normalizeBook(book: ClobBook): {
  bestBid: number | null
  bestAsk: number | null
} {
  const bestBid = book.bids.length
    ? Math.max(...book.bids.map(b => Number(b.price)))
    : null
  const bestAsk = book.asks.length
    ? Math.min(...book.asks.map(a => Number(a.price)))
    : null
  return { bestBid, bestAsk }
}

function logReturns(closes: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]!
    if (prev > 0) out.push(Math.log(closes[i]! / prev))
  }
  return out
}

function annualizedVol(returns: number[], barsPerYear: number): number {
  if (returns.length < 2) return 1
  const mean = returns.reduce((s, v) => s + v, 0) / returns.length
  const variance =
    returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance * barsPerYear)
}

const BARS_PER_YEAR: Record<KlineInterval, number> = {
  '1m': 525_600,
  '5m': 105_120,
  '15m': 35_040,
  '1h': 8_760,
  '4h': 2_190,
  '1d': 365,
}

// ─── LiveAdapter ────────────────────────────────────────────────────────────

export class LiveAdapter implements DataAdapter {
  async buildCtx(slug: string, opts?: BuildCtxOpts): Promise<Ctx> {
    const underlying = opts?.underlying?.toUpperCase()
    const klineLimit = Math.max(1, Math.min(1500, opts?.klineLimit ?? 200))
    const warnings: string[] = []

    // Gamma event + orderbooks are always fetched
    const event = await this.fetchGammaEvent(slug)

    // Binance — only when underlying is specified
    let underlyingData: Ctx['underlying']
    if (underlying) {
      const [klines1h, volResult] = await Promise.all([
        this.fetchBinanceKlines(underlying, '1h', klineLimit),
        this.realizedVolByWindow(underlying),
      ])
      const currentPrice = klines1h[klines1h.length - 1]?.close ?? 0
      underlyingData = {
        symbol: underlying,
        price: currentPrice,
        klines: klines1h,
        realizedVol: volResult.vols,
        realizedVolWarnings: volResult.warnings,
      }
      warnings.push(...volResult.warnings)
    }

    // News — only when newsAccounts is specified (xtracker = default, settlement source)
    let newsData: NewsData | undefined
    if (opts?.newsAccounts?.length) {
      newsData = await this.fetchXtrackerPosts(
        opts.newsAccounts,
        opts.newsSince,
        opts.newsUntil,
        warnings,
      )
    }

    // Fetch orderbooks for all markets in parallel
    const parsedMarkets = event.markets.map(m => ({
      m,
      outcomes: JSON.parse(m.outcomes) as string[],
      prices: JSON.parse(m.outcomePrices) as string[],
      tokenIds: JSON.parse(m.clobTokenIds) as string[],
    }))

    const allBooks = await Promise.all(
      parsedMarkets.flatMap(({ m, tokenIds }) =>
        tokenIds.map(id => this.fetchOrderBook(id, m.slug, warnings)),
      ),
    )

    // Re-associate books with markets
    let bookCursor = 0
    const markets = parsedMarkets.map(({ m, outcomes, prices, tokenIds }) => {
      const books = allBooks.slice(bookCursor, bookCursor + tokenIds.length)
      bookCursor += tokenIds.length

      const { questionType, strike, strike2, parser, confidence } =
        parseQuestion(m.question)
      const kind: 'absolute' | 'directional' =
        questionType === 'directional' ? 'directional' : 'absolute'
      const expiryTs = new Date(m.endDate).getTime()

      return {
        slug: m.slug,
        question: m.question,
        questionType,
        kind,
        strike,
        strike2,
        parser,
        confidence: confidence!,
        expiryDate: m.endDate,
        expiryTs,
        hoursToExpiry: (Date.now() - expiryTs) / -3_600_000,
        outcomes: outcomes.map((label, i) => ({
          label,
          price: Number(prices[i] ?? 0),
          ...normalizeBook(books[i] ?? { bids: [], asks: [] }),
        })),
        volume: Number(m.volume),
        liquidity: Number(m.liquidity),
        active: m.active,
        closed: m.closed,
      }
    })

    return {
      event: {
        slug: event.slug,
        title: event.title,
        description: event.description,
      },
      markets,
      underlying: underlyingData,
      news: newsData,
      timing: { nowTs: Date.now() },
      warnings: warnings.length ? warnings : undefined,
    }
  }

  // ── private methods ─────────────────────────────────────────────────────

  private async fetchGammaEvent(slug: string): Promise<GammaEvent> {
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}&limit=1`
    const res = await fetch(url)
    if (!res.ok)
      throw new Error(`Gamma API error: ${res.status} ${await res.text()}`)
    const data: GammaEvent[] = await res.json()
    if (!data.length) throw new Error(`No event found for slug: ${slug}`)
    return data[0]!
  }

  private async fetchOrderBook(
    tokenId: string,
    marketSlug: string,
    warnings: string[],
  ): Promise<ClobBook> {
    const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`
    let res: Response
    try {
      res = await fetch(url)
    } catch (err) {
      warnings.push(
        `CLOB: fetch failed (${String(err)}) for token ${tokenId} (market: ${marketSlug})`,
      )
      return { bids: [], asks: [] }
    }
    if (!res.ok) {
      warnings.push(
        `CLOB: fetch failed (HTTP ${res.status}) for token ${tokenId} (market: ${marketSlug})`,
      )
      return { bids: [], asks: [] }
    }
    let book: ClobBook
    try {
      book = await res.json()
    } catch (err) {
      warnings.push(
        `CLOB: invalid JSON response for token ${tokenId} (market: ${marketSlug})`,
      )
      return { bids: [], asks: [] }
    }
    if (!book.bids.length && !book.asks.length) {
      warnings.push(
        `CLOB: empty book for token ${tokenId} (market: ${marketSlug})`,
      )
    }
    return book
  }

  private async fetchBinanceKlines(
    symbol: string,
    interval: KlineInterval,
    limit: number,
  ): Promise<Kline[]> {
    const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}USDT&interval=${interval}&limit=${limit}`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Binance klines error: ${res.status}`)
    const raw: unknown[][] = await res.json()
    return raw.map(k => ({
      timestamp: Number(k[0]),
      open: Number(k[1]),
      high: Number(k[2]),
      low: Number(k[3]),
      close: Number(k[4]),
      volume: Number(k[5]),
    }))
  }

  private async realizedVolByWindow(
    symbol: string,
  ): Promise<{ vols: Record<string, number>; warnings: string[] }> {
    const windows: Array<{
      label: string
      interval: KlineInterval
      limit: number
    }> = [
      { label: '15m', interval: '1m', limit: 15 },
      { label: '1h', interval: '5m', limit: 12 },
      { label: '24h', interval: '15m', limit: 96 },
      { label: '7d', interval: '1h', limit: 168 },
      { label: '30d', interval: '4h', limit: 180 },
    ]
    const vols: Record<string, number> = {}
    const warnings: string[] = []
    await Promise.all(
      windows.map(async w => {
        try {
          const klines = await this.fetchBinanceKlines(
            symbol,
            w.interval,
            w.limit,
          )
          const rets = logReturns(klines.map(k => k.close))
          if (rets.length < 2) {
            warnings.push(
              `realizedVol[${w.label}]: insufficient samples (${rets.length})`,
            )
            vols[w.label] = 1
          } else {
            vols[w.label] = annualizedVol(rets, BARS_PER_YEAR[w.interval])
          }
        } catch (err) {
          warnings.push(
            `realizedVol[${w.label}]: fetch failed (${String(err)})`,
          )
          vols[w.label] = 1
        }
      }),
    )
    return { vols, warnings }
  }

  private async fetchXtrackerPosts(
    accounts: string[],
    since?: string,
    until?: string,
    warnings?: string[],
  ): Promise<NewsData> {
    const sinceTs = since ? new Date(since).getTime() : 0
    const untilTs = until ? new Date(until).getTime() : Infinity

    const sinceDate = since ? new Date(since) : new Date(Date.now() - 7 * 86400_000)
    const untilDate = until ? new Date(until) : new Date()
    const pad = (n: number) => String(n).padStart(2, '0')
    const fmtDate = (d: Date) =>
      `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`

    // xtracker uses date-level params; we do precise time filtering client-side
    const startDate = fmtDate(sinceDate)
    // xtracker endDate is exclusive — +1 day to include posts on the until-date
    const endAdj = new Date(untilDate)
    endAdj.setUTCDate(endAdj.getUTCDate() + 1)
    const endDate = fmtDate(endAdj)

    const allPosts: TweetData[] = []
    let totalCount = 0

    for (const handle of accounts) {
      const url = `https://xtracker.polymarket.com/api/users/${encodeURIComponent(handle)}/posts?startDate=${startDate}&endDate=${endDate}`
      let res: Response
      try {
        res = await fetch(url)
      } catch (err) {
        warnings?.push(
          `fetchXtrackerPosts: ${handle} fetch failed (${String(err)}), skipping`,
        )
        continue
      }
      if (!res.ok) {
        warnings?.push(
          `fetchXtrackerPosts: ${handle} returned ${res.status}, skipping`,
        )
        continue
      }
      let raw: {
        success: boolean
        data?: Array<{
          content: string
          createdAt: string
          [k: string]: unknown
        }>
      }
      try {
        raw = await res.json()
      } catch {
        warnings?.push(
          `fetchXtrackerPosts: ${handle} invalid JSON response, skipping`,
        )
        continue
      }
      if (!raw.success || !raw.data) {
        warnings?.push(
          `fetchXtrackerPosts: ${handle} returned success=false, skipping`,
        )
        continue
      }
      for (const post of raw.data) {
        const ts = new Date(post.createdAt).getTime()
        if (ts < sinceTs || ts > untilTs) continue
        totalCount++
        allPosts.push({
          author: handle,
          text: post.content,
          createdAt: post.createdAt,
        })
      }
    }

    // Sort all posts by createdAt descending, then take top 20
    allPosts.sort(
      (a, b) =>
        new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    )

    return {
      tweets: allPosts.slice(0, 20),
      totalCount,
      fetchedAt: new Date().toISOString(),
      accounts,
    }
  }
}
