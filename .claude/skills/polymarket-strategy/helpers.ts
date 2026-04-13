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

function emaArray(a: number[], w: number): number[] {
  if (a.length === 0) return []
  const k = 2 / (w + 1)
  const out: number[] = [a[0]!]
  for (let i = 1; i < a.length; i++) out.push(a[i]! * k + out[i - 1]! * (1 - k))
  return out
}

function rsi(closes: number[], period: number = 14): number {
  if (closes.length <= period) return 50
  let avgGain = 0
  let avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i]! - closes[i - 1]!
    if (diff > 0) avgGain += diff
    else avgLoss += -diff
  }
  avgGain /= period
  avgLoss /= period
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i]! - closes[i - 1]!
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }
  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

function logReturns(prices: number[]): number[] {
  const out: number[] = []
  for (let i = 1; i < prices.length; i++) {
    const prev = prices[i - 1]!
    if (prev > 0) out.push(Math.log(prices[i]! / prev))
  }
  return out
}

// ─── Label sets for outcome recognition ─────────────────────────────────────

const YES_LIKE = new Set(['yes', 'up', 'above', 'over', 'higher', '>'])
const NO_LIKE  = new Set(['no',  'down', 'below', 'under', 'lower', '<'])

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
 * Throws if the required vol window was unavailable at fetch time (see ctx.underlying.realizedVolWarnings).
 */
function bsProbUp(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  if (!opts.sigmaOverride) {
    const window = opts.sigmaWindow ?? '1h'
    const warnings: string[] = ctx.underlying?.realizedVolWarnings ?? []
    if (warnings.some((w: string) => w.includes(`realizedVol[${window}]`))) {
      throw new Error(`bsProbUp: realized vol for window '${window}' unavailable; mark market as hold`)
    }
  }
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
 * Probability that underlying goes UP (S_end >= S_start) in a short window.
 * For directional Polymarket markets (e.g. "BTC Up or Down 5m") where the
 * strike is NOT a fixed dollar amount but the window-open price.
 *
 * Under log-normal with drift μ=0: P(S_end >= S_0) = N(-0.5·σ·√T) ≈ 0.5
 * Edge on directional markets should come from microstructure, not BS.
 */
function directionalProbUp(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow } = {},
): number {
  const { underlying, timing, market } = ctx
  const sigma =
    underlying.realizedVol?.[opts.sigmaWindow ?? '1h'] ??
    underlying.realizedVol?.['24h'] ??
    1
  const T = (market.expiryTs - timing.nowTs) / (365.25 * 24 * 3600 * 1000)
  if (T <= 0) return 0.5
  return normCDF(-0.5 * sigma * Math.sqrt(T))
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

/** Returns the "YES" side metadata from ctx.market.outcomes.
 *  Recognises: yes / up / above / over / higher / > */
function yesSide(ctx: Record<string, any>): SideInfo {
  const outcomes: any[] = ctx.market.outcomes ?? []
  const idx = outcomes.findIndex((o: any) =>
    YES_LIKE.has(String(o.label ?? o.outcome ?? '').toLowerCase()),
  )
  if (idx < 0) {
    throw new Error(
      `yesSide: cannot identify YES outcome from labels ${JSON.stringify(
        outcomes.map((o: any) => o.label ?? o.outcome),
      )} — extend YES_LIKE or handle this market type`,
    )
  }
  const o = outcomes[idx] ?? {}
  return {
    index: idx as 0 | 1,
    label: o.label ?? 'yes',
    outcomePrice: o.price ?? 0.5,
    bestBid: o.bestBid ?? null,
    bestAsk: o.bestAsk ?? null,
  }
}

/** Returns the "NO" side metadata from ctx.market.outcomes */
function noSide(ctx: Record<string, any>): SideInfo {
  const yes = yesSide(ctx)
  const i: 0 | 1 = yes.index === 0 ? 1 : 0
  const outcomes: any[] = ctx.market.outcomes ?? []
  const o = outcomes[i] ?? {}
  return {
    index: i,
    label: o.label ?? 'no',
    outcomePrice: o.price ?? 0.5,
    bestBid: o.bestBid ?? null,
    bestAsk: o.bestAsk ?? null,
  }
}

/**
 * Compute edge against bestAsk (real cost after crossing the spread) and return a signal.
 * threshold defaults to 0.05 (5 cent edge required to trade).
 */
function effectiveEdge(
  pHat: number,
  ctx: Record<string, any>,
  opts: { threshold?: number } = {},
): DecideResult {
  const threshold = opts.threshold ?? 0.05
  const yes = yesSide(ctx)
  const no = noSide(ctx)
  const yesAsk = yes.bestAsk ?? yes.outcomePrice
  const noAsk = no.bestAsk ?? no.outcomePrice
  const yesBuyEdge = pHat - yesAsk
  const noBuyEdge = (1 - pHat) - noAsk

  if (yesBuyEdge >= noBuyEdge) {
    if (yesBuyEdge < threshold) {
      return { side: 'hold', pHat, marketPrice: yesAsk, edge: yesBuyEdge, reason: 'effective edge below threshold (after spread)' }
    }
    return { side: 'yes', pHat, marketPrice: yesAsk, edge: yesBuyEdge, reason: 'model > market (ask-adjusted)' }
  } else {
    if (noBuyEdge < threshold) {
      return { side: 'hold', pHat, marketPrice: noAsk, edge: noBuyEdge, reason: 'effective edge below threshold (after spread)' }
    }
    return { side: 'no', pHat, marketPrice: noAsk, edge: noBuyEdge, reason: 'model < market (ask-adjusted)' }
  }
}

// ─── Export ──────────────────────────────────────────────────────────────────

export const helpers = {
  // math
  normCDF,
  mean,
  stdev,
  quantile,
  sma,
  emaArray,
  rsi,
  logReturns,
  // strategy
  bsProbUp,
  directionalProbUp,
  empiricalProbUp,
  yesSide,
  noSide,
  effectiveEdge,
}
