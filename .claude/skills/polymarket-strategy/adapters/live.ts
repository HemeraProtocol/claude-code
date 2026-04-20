/**
 * LiveAdapter — fetches real-time data from Gamma API, CLOB orderbooks,
 * Binance klines, and Twitter (twitterapi.io), then assembles a unified Ctx.
 *
 * Named "Live" (not "Polymarket") because data sources span multiple
 * providers (Binance, Twitter — not all are Polymarket).
 */

import { parseQuestion } from '../parser'
import type { Ctx, BuildCtxOpts, DataAdapter, Kline, TweetData, NewsData } from '../types'

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

function normalizeBook(book: ClobBook): { bestBid: number | null; bestAsk: number | null } {
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
  const variance = returns.reduce((s, v) => s + (v - mean) ** 2, 0) / (returns.length - 1)
  return Math.sqrt(variance * barsPerYear)
}

const BARS_PER_YEAR: Record<KlineInterval, number> = {
  '1m':  525_600,
  '5m':  105_120,
  '15m': 35_040,
  '1h':  8_760,
  '4h':  2_190,
  '1d':  365,
}

// ─── LiveAdapter ────────────────────────────────────────────────────────────

export class LiveAdapter implements DataAdapter {
  async buildCtx(slug: string, opts?: BuildCtxOpts): Promise<Ctx> {
    const underlying = opts?.underlying?.toUpperCase()
    const klineLimit = Math.max(1, Math.min(1500, opts?.klineLimit ?? 200))

    // Gamma event + orderbooks are always fetched
    const event = await this.fetchGammaEvent(slug)

    // Binance — only when underlying is specified
    let underlyingData: Ctx['underlying'] = undefined
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
    }

    // Twitter — only when newsAccounts is specified
    let newsData: NewsData | undefined = undefined
    if (opts?.newsAccounts?.length) {
      newsData = await this.fetchTweets(opts.newsAccounts, opts.newsSince, opts.newsUntil)
    }

    // Fetch orderbooks for all markets in parallel
    const parsedMarkets = event.markets.map(m => ({
      m,
      outcomes: JSON.parse(m.outcomes) as string[],
      prices: JSON.parse(m.outcomePrices) as string[],
      tokenIds: JSON.parse(m.clobTokenIds) as string[],
    }))

    const allBooks = await Promise.all(
      parsedMarkets.flatMap(({ tokenIds }) => tokenIds.map(id => this.fetchOrderBook(id)))
    )

    // Re-associate books with markets
    let bookCursor = 0
    const markets = parsedMarkets.map(({ m, outcomes, prices, tokenIds }) => {
      const books = allBooks.slice(bookCursor, bookCursor + tokenIds.length)
      bookCursor += tokenIds.length

      const { questionType, strike, strike2, parser, confidence } = parseQuestion(m.question)
      const kind: 'absolute' | 'directional' = questionType === 'directional' ? 'directional' : 'absolute'
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
      event: { slug: event.slug, title: event.title, description: event.description },
      markets,
      underlying: underlyingData,
      news: newsData,
      timing: { nowTs: Date.now() },
    }
  }

  // ── private methods ─────────────────────────────────────────────────────

  private async fetchGammaEvent(slug: string): Promise<GammaEvent> {
    const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}&limit=1`
    const res = await fetch(url)
    if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`)
    const data: GammaEvent[] = await res.json()
    if (!data.length) throw new Error(`No event found for slug: ${slug}`)
    return data[0]!
  }

  private async fetchOrderBook(tokenId: string): Promise<ClobBook> {
    const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`
    const res = await fetch(url)
    if (!res.ok) return { bids: [], asks: [] }
    return res.json()
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
    const windows: Array<{ label: string; interval: KlineInterval; limit: number }> = [
      { label: '15m', interval: '1m',  limit: 15 },
      { label: '1h',  interval: '5m',  limit: 12 },
      { label: '24h', interval: '15m', limit: 96 },
      { label: '7d',  interval: '1h',  limit: 168 },
      { label: '30d', interval: '4h',  limit: 180 },
    ]
    const vols: Record<string, number> = {}
    const warnings: string[] = []
    await Promise.all(
      windows.map(async w => {
        try {
          const klines = await this.fetchBinanceKlines(symbol, w.interval, w.limit)
          const rets = logReturns(klines.map(k => k.close))
          if (rets.length < 2) {
            warnings.push(`realizedVol[${w.label}]: insufficient samples (${rets.length})`)
            vols[w.label] = 1
          } else {
            vols[w.label] = annualizedVol(rets, BARS_PER_YEAR[w.interval])
          }
        } catch (err) {
          warnings.push(`realizedVol[${w.label}]: fetch failed (${String(err)})`)
          vols[w.label] = 1
        }
      }),
    )
    return { vols, warnings }
  }

  private async fetchTweets(
    accounts: string[],
    since?: string,
    until?: string,
  ): Promise<NewsData> {
    const apiKey = process.env.TWITTER_API_KEY
    if (!apiKey) throw new Error('fetchTweets: TWITTER_API_KEY env var is required')

    const sinceTs = since ? new Date(since).getTime() : 0
    const untilTs = until ? new Date(until).getTime() : Infinity
    const recentTweets: TweetData[] = []
    let totalCount = 0

    for (const userName of accounts) {
      let cursor = ''
      let done = false
      while (!done) {
        const url = `https://api.twitterapi.io/twitter/user/last_tweets?userName=${encodeURIComponent(userName)}&cursor=${encodeURIComponent(cursor)}`
        const res = await fetch(url, { headers: { 'X-API-Key': apiKey } })
        if (!res.ok) {
          process.stderr.write(`fetchTweets: ${userName} returned ${res.status}, skipping\n`)
          break
        }
        const raw = await res.json() as {
          data?: { tweets?: Array<{ id: string; text: string; createdAt: string; author: { userName: string } }> }
          has_next_page?: boolean
          next_cursor?: string
        }
        for (const t of raw.data?.tweets ?? []) {
          const ts = new Date(t.createdAt).getTime()
          if (ts < sinceTs) { done = true; break }
          if (ts > untilTs) continue
          totalCount++
          if (recentTweets.length < 20) {
            recentTweets.push({
              author: t.author.userName,
              text: t.text,
              createdAt: t.createdAt,
            })
          }
        }
        if (!raw.has_next_page || done) break
        cursor = raw.next_cursor ?? ''
      }
    }

    return {
      tweets: recentTweets,
      totalCount,
      fetchedAt: new Date().toISOString(),
      accounts,
    }
  }
}
