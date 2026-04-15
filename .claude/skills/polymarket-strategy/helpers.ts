import { parseMoneyLabel } from './parser'

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

interface BinaryDecideResult {
  side: string
  sideIndex: 0 | 1 | null
  sideLabel: string | null
  fairPrice: number
  marketPrice: number
  edge: number
  reason: string
}

type FairProbOpts = {
  sigmaWindow?: VolWindow
  sigmaOverride?: number
  simPaths?: number
  simSteps?: number
}

// ─── High-level strategy building blocks ────────────────────────────────────

// ─── Shared vol + time resolver ──────────────────────────────────────────────

function resolveVolAndTime(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
  callerName: string,
): { sigma: number; S: number; T: number } {
  if (!opts.sigmaOverride) {
    const window = opts.sigmaWindow ?? '1h'
    const warnings: string[] = ctx.underlying?.realizedVolWarnings ?? []
    if (warnings.some((w: string) => w.includes(`realizedVol[${window}]`))) {
      throw new Error(`${callerName}: realized vol for window '${window}' unavailable; mark market as hold`)
    }
  }
  const { underlying, timing } = ctx
  const sigma =
    opts.sigmaOverride ??
    underlying.realizedVol?.[opts.sigmaWindow ?? '1h'] ??
    underlying.realizedVol?.['24h'] ??
    1
  const S = underlying.price as number
  const T = (timing.expiryTs - timing.nowTs) / (365.25 * 24 * 3600 * 1000)
  return { sigma, S, T }
}

function clamp01(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return x
}

// ─── Individual BS formula functions ────────────────────────────────────────

/** P(S_T > K) under lognormal, zero-drift (risk-neutral). */
function bsAbove(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  const { sigma, S, T } = resolveVolAndTime(ctx, opts, 'bsAbove')
  const K = ctx.market.strike as number
  if (T <= 0 || K <= 0 || S <= 0) return 0.5
  const d2 = (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T))
  return normCDF(d2)
}

/** P(K_lo ≤ S_T ≤ K_hi) = N(d2_lo) - N(d2_hi). Requires strike and strike2. */
function bsRange(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  const { sigma, S, T } = resolveVolAndTime(ctx, opts, 'bsRange')
  const Klo = ctx.market.strike as number
  const Khi = ctx.market.strike2 as number
  if (!Klo || !Khi) throw new Error('bsRange: requires both strike and strike2')
  if (T <= 0 || S <= 0) return 0.5
  const sqrtT = sigma * Math.sqrt(T)
  const d2lo = (Math.log(S / Klo) - 0.5 * sigma * sigma * T) / sqrtT
  const d2hi = (Math.log(S / Khi) - 0.5 * sigma * sigma * T) / sqrtT
  return Math.max(0, normCDF(d2lo) - normCDF(d2hi))
}

/**
 * One-touch barrier probability (no-drift lognormal approximation):
 *   P(touch K before T) ≈ 2·N(-|ln(K/S)| / (σ·√T))
 * Works for both upward (K > S) and downward (K < S) barriers.
 */
function bsOneTouch(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  const { sigma, S, T } = resolveVolAndTime(ctx, opts, 'bsOneTouch')
  const K = ctx.market.strike as number
  if (T <= 0 || K <= 0 || S <= 0) return 0.5
  const logDist = Math.abs(Math.log(K / S))
  return 2 * normCDF(-logDist / (sigma * Math.sqrt(T)))
}

// ─── Primary dispatch ────────────────────────────────────────────────────────

/**
 * P(YES outcome) for any Polymarket crypto market type.
 * Dispatches to the correct formula based on ctx.market.questionType.
 * Use this instead of bsProbUp for new strategy code.
 */
function probYes(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  const t: string = ctx.market.questionType ?? 'unknown'
  switch (t) {
    case 'above':       return bsAbove(ctx, opts)
    case 'below':       return 1 - bsAbove(ctx, opts)
    case 'range':       return bsRange(ctx, opts)
    case 'hit':         return bsOneTouch(ctx, opts)
    case 'directional': return directionalProbUp(ctx, opts as any)
    case 'firstHit':    throw new Error("probYes: firstHit is not a yes/no market; use fairProbs(ctx)")
    case 'unknown':     throw new Error(`probYes: questionType is 'unknown' for question: "${ctx.market.question}"`)
    default:            throw new Error(`probYes: unrecognized questionType '${t}'`)
  }
}

/**
 * Black-Scholes probability that underlying ends ABOVE the strike at expiry.
 * Uses realized vol for the chosen window (default '1h').
 * Throws if the required vol window was unavailable at fetch time (see ctx.underlying.realizedVolWarnings).
 *
 * @deprecated Use probYes(ctx) which dispatches correctly for all question types
 * (above/below/range/hit). bsProbUp always computes P(S > K) and will give
 * wrong results for below/range/hit markets.
 */
function bsProbUp(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
): number {
  return bsAbove(ctx, opts)
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

function outcomeSides(ctx: Record<string, any>): [SideInfo, SideInfo] {
  const outcomes: any[] = ctx.market.outcomes ?? []
  if (outcomes.length !== 2) {
    throw new Error(`outcomeSides: expected 2 outcomes, got ${outcomes.length}`)
  }
  const sides = outcomes.map((o: any, index: number) => ({
    index: index as 0 | 1,
    label: o.label ?? o.outcome ?? `outcome-${index}`,
    outcomePrice: o.price ?? 0.5,
    bestBid: o.bestBid ?? null,
    bestAsk: o.bestAsk ?? null,
  })) as [SideInfo, SideInfo]
  return sides
}

function fairProbabilitiesFromPYes(ctx: Record<string, any>, pYes: number): [number, number] {
  const yes = yesSide(ctx)
  const noIndex: 0 | 1 = yes.index === 0 ? 1 : 0
  const probs: [number, number] = [0, 0]
  probs[yes.index] = clamp01(pYes)
  probs[noIndex] = clamp01(1 - pYes)
  return probs
}

function normalizeBinaryProbabilities(probabilities: number[]): [number, number] {
  if (probabilities.length !== 2) {
    throw new Error(`normalizeBinaryProbabilities: expected 2 probabilities, got ${probabilities.length}`)
  }
  const raw0 = clamp01(probabilities[0] ?? 0)
  const raw1 = clamp01(probabilities[1] ?? 0)
  const sum = raw0 + raw1
  if (sum <= 0) return [0.5, 0.5]
  return [raw0 / sum, raw1 / sum]
}

function firstHitProbabilities(
  ctx: Record<string, any>,
  opts: FairProbOpts = {},
): [number, number] {
  const { sigma, S, T } = resolveVolAndTime(ctx, opts, 'firstHitProbabilities')
  const strikeA = ctx.market.strike as number
  const strikeB = ctx.market.strike2 as number
  if (!strikeA || !strikeB) {
    throw new Error('firstHitProbabilities: requires strike and strike2')
  }

  const lower = Math.min(strikeA, strikeB)
  const upper = Math.max(strikeA, strikeB)
  const [side0, side1] = outcomeSides(ctx)
  const side0Price = parseMoneyLabel(side0.label)
  const side1Price = parseMoneyLabel(side1.label)

  const alignProbabilities = (lowerProb: number, upperProb: number): [number, number] => {
    if (side0Price !== null && side1Price !== null) {
      const side0IsLower = Math.abs(side0Price - lower) <= Math.abs(side0Price - upper)
      const side1IsLower = Math.abs(side1Price - lower) <= Math.abs(side1Price - upper)
      if (side0IsLower !== side1IsLower) {
        return side0IsLower ? [lowerProb, upperProb] : [upperProb, lowerProb]
      }
    }
    return [lowerProb, upperProb]
  }

  if (S <= lower) return alignProbabilities(1, 0)
  if (S >= upper) return alignProbabilities(0, 1)
  if (T <= 0 || sigma <= 0) return alignProbabilities(0.5, 0.5)

  const paths = Math.max(500, Math.min(20_000, opts.simPaths ?? 4_000))
  const steps = Math.max(24, Math.min(720, opts.simSteps ?? Math.ceil(Math.sqrt(T * 365.25) * 48)))
  const dt = T / steps
  const drift = -0.5 * sigma * sigma * dt
  const diffusion = sigma * Math.sqrt(dt)

  let lowerFirst = 0
  let upperFirst = 0
  let noHit = 0
  let spareNormal: number | null = null

  const nextNormal = (): number => {
    if (spareNormal !== null) {
      const out = spareNormal
      spareNormal = null
      return out
    }
    const u1 = Math.max(Number.EPSILON, Math.random())
    const u2 = Math.random()
    const mag = Math.sqrt(-2 * Math.log(u1))
    const z0 = mag * Math.cos(2 * Math.PI * u2)
    spareNormal = mag * Math.sin(2 * Math.PI * u2)
    return z0
  }

  for (let path = 0; path < paths; path++) {
    let price = S
    let outcome: 'lower' | 'upper' | 'none' = 'none'

    for (let step = 0; step < steps; step++) {
      price *= Math.exp(drift + diffusion * nextNormal())
      if (price <= lower) {
        outcome = 'lower'
        break
      }
      if (price >= upper) {
        outcome = 'upper'
        break
      }
    }

    if (outcome === 'lower') lowerFirst++
    else if (outcome === 'upper') upperFirst++
    else noHit++
  }

  const total = lowerFirst + upperFirst + noHit
  const lowerProb = total > 0 ? (lowerFirst + 0.5 * noHit) / total : 0.5
  const upperProb = total > 0 ? (upperFirst + 0.5 * noHit) / total : 0.5
  return alignProbabilities(lowerProb, upperProb)
}

function fairProbs(
  ctx: Record<string, any>,
  opts: FairProbOpts = {},
): [number, number] {
  const t: string = ctx.market.questionType ?? 'unknown'
  switch (t) {
    case 'above':
    case 'below':
    case 'range':
    case 'hit':
    case 'directional':
      return fairProbabilitiesFromPYes(ctx, probYes(ctx, opts))
    case 'firstHit':
      return normalizeBinaryProbabilities(firstHitProbabilities(ctx, opts))
    case 'unknown':
      throw new Error(`fairProbs: questionType is 'unknown' for question: "${ctx.market.question}"`)
    default:
      throw new Error(`fairProbs: unrecognized questionType '${t}'`)
  }
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

function effectiveEdgeBinary(
  probabilities: [number, number],
  ctx: Record<string, any>,
  opts: { threshold?: number } = {},
): BinaryDecideResult {
  const threshold = opts.threshold ?? 0.05
  const sides = outcomeSides(ctx)
  const probs = normalizeBinaryProbabilities(probabilities)
  const candidates = sides.map((side, index) => {
    const ask = side.bestAsk ?? side.outcomePrice
    const fairPrice = probs[index] ?? 0.5
    return {
      ...side,
      fairPrice,
      marketPrice: ask,
      edge: fairPrice - ask,
    }
  })

  const best = candidates[0]!.edge >= candidates[1]!.edge ? candidates[0]! : candidates[1]!
  if (best.edge < threshold) {
    return {
      side: 'hold',
      sideIndex: best.index,
      sideLabel: best.label,
      fairPrice: best.fairPrice,
      marketPrice: best.marketPrice,
      edge: best.edge,
      reason: 'effective edge below threshold (after spread)',
    }
  }

  return {
    side: best.label,
    sideIndex: best.index,
    sideLabel: best.label,
    fairPrice: best.fairPrice,
    marketPrice: best.marketPrice,
    edge: best.edge,
    reason: 'model > market (ask-adjusted)',
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
  // strategy — preferred
  fairProbs,
  probYes,
  bsAbove,
  bsRange,
  bsOneTouch,
  directionalProbUp,
  empiricalProbUp,
  outcomeSides,
  yesSide,
  noSide,
  effectiveEdge,
  effectiveEdgeBinary,
  // deprecated
  bsProbUp,
}
