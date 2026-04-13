#!/usr/bin/env bun
/**
 * Fetches Polymarket market data + underlying asset klines.
 * Writes ctx JSON to /tmp/polymarket-ctx-<slug>-<pid>-<rand>.json and prints
 * {"ctxPath": "..."} to stdout. Downstream callers (run_js) read ctx via ctxPath.
 *
 * Usage: bun run fetch.ts --slug <slug> --underlying <BTC|ETH|SOL|...>
 */

import { parseArgs } from 'util'
import { randomBytes } from 'node:crypto'

// ─── CLI args ────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    slug: { type: 'string' },
    underlying: { type: 'string' },
    limit: { type: 'string' },
  },
  strict: true,
})

const slug = values.slug
const underlying = (values.underlying ?? 'BTC').toUpperCase()
const klineLimit = Math.max(1, Math.min(1500, Number(values.limit ?? '200') || 200))

if (!slug) {
  process.stderr.write('Usage: fetch.ts --slug <slug> [--underlying <BTC|ETH|SOL|...>]\n')
  process.exit(1)
}

if (!/^[a-z0-9-]+$/i.test(slug)) {
  process.stderr.write(`Invalid slug: must match /^[a-z0-9-]+$/i\n`)
  process.exit(1)
}

// ─── Polymarket Gamma API ────────────────────────────────────────────────────

interface GammaMarket {
  id: string
  question: string
  slug: string
  endDate: string
  outcomes: string       // JSON array string e.g. '["Yes","No"]'
  outcomePrices: string  // JSON array string e.g. '["0.62","0.38"]'
  volume: string
  liquidity: string
  active: boolean
  closed: boolean
  conditionId: string
  clobTokenIds: string   // JSON array string
  startDate?: string
}

interface GammaEvent {
  slug: string
  title: string
  markets: GammaMarket[]
}

async function fetchGammaEvent(slug: string): Promise<GammaEvent> {
  const url = `https://gamma-api.polymarket.com/events?slug=${encodeURIComponent(slug)}&limit=1`
  const res = await fetch(url)
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`)
  const data: GammaEvent[] = await res.json()
  if (!data.length) throw new Error(`No event found for slug: ${slug}`)
  return data[0]!
}

// ─── Polymarket CLOB orderbook ───────────────────────────────────────────────

interface ClobBook {
  bids: Array<{ price: string; size: string }>
  asks: Array<{ price: string; size: string }>
}

async function fetchOrderBook(tokenId: string): Promise<ClobBook> {
  const url = `https://clob.polymarket.com/book?token_id=${encodeURIComponent(tokenId)}`
  const res = await fetch(url)
  if (!res.ok) return { bids: [], asks: [] }
  return res.json()
}

function normalizeBook(book: ClobBook): { bestBid: number | null; bestAsk: number | null } {
  const bestBid = book.bids.length
    ? Math.max(...book.bids.map(b => Number(b.price)))
    : null
  const bestAsk = book.asks.length
    ? Math.min(...book.asks.map(a => Number(a.price)))
    : null
  return { bestBid, bestAsk }
}

// ─── Binance klines ──────────────────────────────────────────────────────────

interface Kline {
  timestamp: number
  open: number
  high: number
  low: number
  close: number
  volume: number
}

type KlineInterval = '1m' | '5m' | '15m' | '1h' | '4h' | '1d'

async function fetchBinanceKlines(
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

// ─── Realized volatility ─────────────────────────────────────────────────────

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

// bars per year for each interval
const BARS_PER_YEAR: Record<KlineInterval, number> = {
  '1m':  525_600,
  '5m':  105_120,
  '15m': 35_040,
  '1h':  8_760,
  '4h':  2_190,
  '1d':  365,
}

async function realizedVolByWindow(
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
        const klines = await fetchBinanceKlines(symbol, w.interval, w.limit)
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

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const [event, klines1h, volResult] = await Promise.all([
    fetchGammaEvent(slug!),
    fetchBinanceKlines(underlying, '1h', klineLimit),
    realizedVolByWindow(underlying),
  ])

  // Fetch orderbooks for all markets in parallel
  const parsedMarkets = event.markets.map(m => ({
    m,
    outcomes: JSON.parse(m.outcomes) as string[],
    prices: JSON.parse(m.outcomePrices) as string[],
    tokenIds: JSON.parse(m.clobTokenIds) as string[],
  }))

  const allBooks = await Promise.all(
    parsedMarkets.flatMap(({ tokenIds }) => tokenIds.map(fetchOrderBook))
  )

  // Re-associate books with markets
  let bookCursor = 0
  const markets = parsedMarkets.map(({ m, outcomes, prices, tokenIds }) => {
    const books = allBooks.slice(bookCursor, bookCursor + tokenIds.length)
    bookCursor += tokenIds.length

    const strikeMatch = m.question.match(/\$([0-9,]+(?:\.[0-9]+)?)/i)
    const isDirectional = /up or down/i.test(m.question)
    const kind: 'absolute' | 'directional' = isDirectional ? 'directional' : 'absolute'
    const strike = kind === 'absolute' && strikeMatch
      ? Number(strikeMatch[1]!.replace(/,/g, ''))
      : null
    const expiryTs = new Date(m.endDate).getTime()

    return {
      slug: m.slug,
      question: m.question,
      kind,
      strike,
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

  const currentPrice = klines1h[klines1h.length - 1]?.close ?? 0
  const nowTs = Date.now()

  const ctx = {
    markets,
    underlying: {
      symbol: underlying,
      price: currentPrice,
      klines: klines1h,
      realizedVol: volResult.vols,
      realizedVolWarnings: volResult.warnings,
    },
    timing: {
      nowTs,
    },
  }

  const rand = randomBytes(4).toString('hex')
  const tmpPath = `/tmp/polymarket-ctx-${slug}-${process.pid}-${rand}.json`
  await Bun.write(tmpPath, JSON.stringify(ctx))
  process.stdout.write(JSON.stringify({ ctxPath: tmpPath }) + '\n')
}

main().catch(err => {
  process.stderr.write((err instanceof Error ? err.message : String(err)) + '\n')
  process.exit(1)
})
