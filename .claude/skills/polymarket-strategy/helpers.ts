// ─── Low-level math (pure, no dependencies) ────────────────────────────────

/** Abramowitz & Stegun 7.1.26 approximation — max error < 1.5e-7 */
function normCDF(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const t = 1 / (1 + p * Math.abs(x))
  const poly = ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t
  return 0.5 * (1 + sign * (1 - poly * Math.exp(-x * x)))
}

function mean(a: number[]): number {
  if (a.length === 0) return 0
  return a.reduce((s, v) => s + v, 0) / a.length
}

function stdev(a: number[]): number {
  if (a.length < 2) return 0
  const m = mean(a)
  return Math.sqrt(a.reduce((s, v) => s + (v - m) ** 2, 0) / (a.length - 1))
}

function quantile(a: number[], p: number): number {
  if (a.length === 0) return 0
  const sorted = [...a].sort((x, y) => x - y)
  const idx = p * (sorted.length - 1)
  const lo = Math.floor(idx)
  const hi = Math.ceil(idx)
  if (lo === hi) return sorted[lo]!
  return sorted[lo]! * (hi - idx) + sorted[hi]! * (idx - lo)
}

function sma(a: number[], w: number): number {
  const slice = a.slice(-w)
  return mean(slice)
}

function ema(a: number[], w: number): number {
  if (a.length === 0) return 0
  const k = 2 / (w + 1)
  let e = a[0]!
  for (let i = 1; i < a.length; i++) e = a[i]! * k + e * (1 - k)
  return e
}

function logReturns(prices: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!
    if (prev > 0) out.push(Math.log(prices[i]! / prev))
  }
  return out
}

// ─── Types ──────────────────────────────────────────────────────────────────

type VolWindow = '15m' | '1h' | '24h' | '7d' | '30d'

interface SideInfo {
  index: 0 | 1
  label: string
  outcomePrice: number
  bestBid: number | null
  bestAsk: number | null
}

interface DecideResult {
  side: 'yes' | 'no' | 'hold'
  pHat: number
  marketPrice: number
  edge: number
  reason: string
}

// ─── High-level strategy building blocks ────────────────────────────────────

/**
 * Black-Scholes probability that underlying ends ABOVE the strike at expiry.
 * Uses realized vol for the chosen window (default '1h').
 */
function bsProbUp(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  const { market, underlying, timing } = ctx
  const sigma =
    opts.sigmaOverride ??
    underlying.realizedVol?.[opts.sigmaWindow ?? '1h'] ??
    underlying.realizedVol?.['24h'] ??
    1
  const S = underlying.price as number
  const K = market.strike as number
  const T = (timing.expiryTs - timing.nowTs) / (365.25 * 24 * 3600 * 1000)
  if (T <= 0 || K <= 0 || S <= 0) return 0.5
  const d2 = (Math.log(S / K) + (-0.5 * sigma * sigma * T)) / (sigma * Math.sqrt(T))
  return normCDF(d2)
}

/**
 * Fraction of recent kline closes that ended above the prior close (empirical win rate).
 * lookback defaults to 20 bars.
 */
function empiricalProbUp(
  ctx: Record<string, any>,
  opts: { lookback?: number } = {},
): number {
  const klines: Array<{ close: number }> = ctx.underlying.klines ?? []
  const n = opts.lookback ?? 20
  const slice = klines.slice(-n - 1)
  if (slice.length < 2) return 0.5
  let ups = 0
  for (let i = 1; i < slice.length; i++) {
    if (slice[i]!.close > slice[i - 1]!.close) ups++
  }
  return ups / (slice.length - 1)
}

/** Returns the "YES" side metadata from ctx.market.outcomes */
function yesSide(ctx: Record<string, any>): SideInfo {
  const outcomes: any[] = ctx.market.outcomes ?? []
  const book = ctx.market.orderBook ?? []
  const idx = outcomes.findIndex(
    (o: any) => String(o.label ?? o.outcome ?? '').toLowerCase() === 'yes',
  )
  const i = idx >= 0 ? idx : 0
  const ob = book[i] ?? {}
  return {
    index: i as 0 | 1,
    label: outcomes[i]?.label ?? 'yes',
    outcomePrice: outcomes[i]?.price ?? 0.5,
    bestBid: ob.bestBid ?? null,
    bestAsk: ob.bestAsk ?? null,
  }
}

/** Returns the "NO" side metadata from ctx.market.outcomes */
function noSide(ctx: Record<string, any>): SideInfo {
  const yes = yesSide(ctx)
  const i: 0 | 1 = yes.index === 0 ? 1 : 0
  const outcomes: any[] = ctx.market.outcomes ?? []
  const book = ctx.market.orderBook ?? []
  const ob = book[i] ?? {}
  return {
    index: i,
    label: outcomes[i]?.label ?? 'no',
    outcomePrice: outcomes[i]?.price ?? 0.5,
    bestBid: ob.bestBid ?? null,
    bestAsk: ob.bestAsk ?? null,
  }
}

/**
 * Compute edge vs market price and return a signal.
 * threshold defaults to 0.05 (5 cent edge required to trade).
 */
function decideEdge(
  pHat: number,
  ctx: Record<string, any>,
  opts: { threshold?: number } = {},
): DecideResult {
  const threshold = opts.threshold ?? 0.05
  const yes = yesSide(ctx)
  const mktPrice = yes.outcomePrice
  const edge = pHat - mktPrice

  if (Math.abs(edge) < threshold) {
    return { side: 'hold', pHat, marketPrice: mktPrice, edge, reason: 'edge below threshold' }
  }
  if (edge > 0) {
    return { side: 'yes', pHat, marketPrice: mktPrice, edge, reason: 'model > market' }
  }
  return { side: 'no', pHat, marketPrice: mktPrice, edge, reason: 'model < market' }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const helpers = {
  // math
  normCDF,
  mean,
  stdev,
  quantile,
  sma,
  ema,
  logReturns,
  // strategy
  bsProbUp,
  empiricalProbUp,
  yesSide,
  noSide,
  decideEdge,
}
