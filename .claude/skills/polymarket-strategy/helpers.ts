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

// ─── Types ──────────────────────────────────────────────────────────────────

import type {
  QuestionType,
  VolWindow,
  SideInfo,
  BarrierDistanceInfo,
  BinaryEdgeInfo,
  PricingOpts,
  CountModel,
} from './types'

/** mulberry32 — deterministic seeded RNG for reproducible Monte Carlo. */
function mulberry32(seed: number): () => number {
  let t = seed >>> 0
  return () => {
    t = (t + 0x6d2b79f5) | 0
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

// ─── Shared vol + time resolver ──────────────────────────────────────────────

function resolveVolAndTime(
  ctx: Record<string, any>,
  opts: { sigmaWindow?: VolWindow; sigmaOverride?: number } = {},
  callerName: string,
): { sigma: number; S: number; T: number } {
  if (!ctx.underlying) {
    throw new Error(
      `${callerName}: requires ctx.underlying (not available for politics/non-crypto markets)`,
    )
  }
  if (!opts.sigmaOverride) {
    const window = opts.sigmaWindow ?? '1h'
    const warnings: string[] = ctx.underlying?.realizedVolWarnings ?? []
    if (warnings.some((w: string) => w.includes(`realizedVol[${window}]`))) {
      throw new Error(
        `${callerName}: realized vol for window '${window}' unavailable; mark market as hold`,
      )
    }
  }
  const { underlying, timing } = ctx
  const sigma =
    opts.sigmaOverride ??
    underlying.realizedVol?.[opts.sigmaWindow ?? '1h'] ??
    underlying.realizedVol?.['24h'] ??
    1
  const S = underlying.price as number
  const expiryTs = ctx.market?.expiryTs ?? timing?.expiryTs
  if (typeof expiryTs !== 'number') {
    throw new Error(
      `${callerName}: requires ctx.market.expiryTs or ctx.timing.expiryTs`,
    )
  }
  if (typeof timing?.nowTs !== 'number') {
    throw new Error(`${callerName}: requires ctx.timing.nowTs`)
  }
  const T = (expiryTs - timing.nowTs) / (365.25 * 24 * 3600 * 1000)
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
  const d2 =
    (Math.log(S / K) - 0.5 * sigma * sigma * T) / (sigma * Math.sqrt(T))
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

// ─── Time, vol, and market feature helpers ──────────────────────────────────

function timeToExpiryYears(ctx: Record<string, any>): number {
  const expiryTs = ctx.market?.expiryTs ?? ctx.timing?.expiryTs
  const nowTs = ctx.timing?.nowTs
  if (typeof expiryTs !== 'number' || typeof nowTs !== 'number') {
    throw new Error(
      'timeToExpiryYears: ctx.market.expiryTs/ctx.timing.expiryTs and ctx.timing.nowTs are required',
    )
  }
  return (expiryTs - nowTs) / (365.25 * 24 * 3600 * 1000)
}

function timeToExpiryHours(ctx: Record<string, any>): number {
  return timeToExpiryYears(ctx) * 365.25 * 24
}

function vol(ctx: Record<string, any>, window: VolWindow = '1h'): number {
  const warnings: string[] = ctx.underlying?.realizedVolWarnings ?? []
  if (warnings.some((w: string) => w.includes(`realizedVol[${window}]`))) {
    throw new Error(`vol: realized vol for window '${window}' unavailable`)
  }
  const sigma = ctx.underlying?.realizedVol?.[window]
  if (typeof sigma !== 'number') {
    throw new Error(`vol: realized vol for window '${window}' missing`)
  }
  return sigma
}

function volRatio(
  ctx: Record<string, any>,
  shortWindow: VolWindow = '1h',
  longWindow: VolWindow = '30d',
): number {
  const longVol = vol(ctx, longWindow)
  if (longVol <= 0) throw new Error('volRatio: longWindow vol must be > 0')
  return vol(ctx, shortWindow) / longVol
}

function distanceToStrike(ctx: Record<string, any>): number {
  const S = ctx.underlying?.price
  const K = ctx.market?.strike
  if (typeof S !== 'number' || S <= 0 || typeof K !== 'number' || K <= 0) {
    throw new Error(
      'distanceToStrike: underlying.price and market.strike must both be positive numbers',
    )
  }
  return (K - S) / S
}

function distanceToRangeMid(ctx: Record<string, any>): number {
  const S = ctx.underlying?.price
  const K1 = ctx.market?.strike
  const K2 = ctx.market?.strike2
  if (
    typeof S !== 'number' ||
    S <= 0 ||
    typeof K1 !== 'number' ||
    K1 <= 0 ||
    typeof K2 !== 'number' ||
    K2 <= 0
  ) {
    throw new Error(
      'distanceToRangeMid: underlying.price, market.strike, and market.strike2 must all be positive numbers',
    )
  }
  const mid = (K1 + K2) / 2
  return (mid - S) / S
}

function distanceToBarriers(ctx: Record<string, any>): BarrierDistanceInfo {
  const S = ctx.underlying?.price
  const strikeA = ctx.market?.strike
  const strikeB = ctx.market?.strike2
  if (
    typeof S !== 'number' ||
    S <= 0 ||
    typeof strikeA !== 'number' ||
    strikeA <= 0 ||
    typeof strikeB !== 'number' ||
    strikeB <= 0
  ) {
    throw new Error(
      'distanceToBarriers: underlying.price, market.strike, and market.strike2 must all be positive numbers',
    )
  }

  const lower = Math.min(strikeA, strikeB)
  const upper = Math.max(strikeA, strikeB)
  return {
    currentPrice: S,
    lower,
    upper,
    pctToLower: (lower - S) / S,
    pctToUpper: (upper - S) / S,
    logDistToLower: Math.abs(Math.log(lower / S)),
    logDistToUpper: Math.abs(Math.log(upper / S)),
  }
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

function binaryProbsFromYesProb(
  ctx: Record<string, any>,
  pYes: number,
): [number, number] {
  const yes = yesSide(ctx)
  const noIndex: 0 | 1 = yes.index === 0 ? 1 : 0
  const probs: [number, number] = [0, 0]
  probs[yes.index] = clamp01(pYes)
  probs[noIndex] = clamp01(1 - pYes)
  return probs
}

function firstHitProbabilities(
  ctx: Record<string, any>,
  opts: PricingOpts = {},
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

  const alignProbabilities = (
    lowerProb: number,
    upperProb: number,
  ): [number, number] => {
    if (side0Price !== null && side1Price !== null) {
      const side0IsLower =
        Math.abs(side0Price - lower) <= Math.abs(side0Price - upper)
      const side1IsLower =
        Math.abs(side1Price - lower) <= Math.abs(side1Price - upper)
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
  const steps = Math.max(
    24,
    Math.min(720, opts.simSteps ?? Math.ceil(Math.sqrt(T * 365.25) * 48)),
  )
  const dt = T / steps
  const drift = -0.5 * sigma * sigma * dt
  const diffusion = sigma * Math.sqrt(dt)

  let lowerFirst = 0
  let upperFirst = 0
  let noHit = 0
  let spareNormal: number | null = null

  const rand =
    typeof opts.seed === 'number' ? mulberry32(opts.seed) : Math.random

  const nextNormal = (): number => {
    if (spareNormal !== null) {
      const out = spareNormal
      spareNormal = null
      return out
    }
    const u1 = Math.max(Number.EPSILON, rand())
    const u2 = rand()
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

function eventQuestionTypes(ctx: Record<string, any>): QuestionType[] {
  const types = new Set<QuestionType>()
  const markets: Array<Record<string, any>> = ctx.markets ?? []
  for (const market of markets) {
    types.add((market.questionType ?? 'unknown') as QuestionType)
  }
  return [...types]
}

/**
 * Returns the single non-unknown questionType shared by all markets in the event.
 * - Mixed-type events → `null` (caller must dispatch per-market).
 * - All-unknown events → throws (data error, fetch failed to classify).
 */
function eventPrimaryQuestionType(
  ctx: Record<string, any>,
): QuestionType | null {
  const types = eventQuestionTypes(ctx).filter(type => type !== 'unknown')
  if (types.length === 0) {
    throw new Error(
      'eventPrimaryQuestionType: no supported questionType found in ctx.markets',
    )
  }
  if (types.length !== 1) return null
  return types[0]!
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

function outcomeAsks(ctx: Record<string, any>): [number, number] {
  const sides = outcomeSides(ctx)
  return [
    sides[0].bestAsk ?? sides[0].outcomePrice,
    sides[1].bestAsk ?? sides[1].outcomePrice,
  ]
}

function outcomeBids(ctx: Record<string, any>): [number, number] {
  const sides = outcomeSides(ctx)
  return [
    sides[0].bestBid ?? sides[0].outcomePrice,
    sides[1].bestBid ?? sides[1].outcomePrice,
  ]
}

function spreadByOutcome(ctx: Record<string, any>): [number, number] {
  const sides = outcomeSides(ctx)
  return [
    (sides[0].bestAsk ?? sides[0].outcomePrice) -
      (sides[0].bestBid ?? sides[0].outcomePrice),
    (sides[1].bestAsk ?? sides[1].outcomePrice) -
      (sides[1].bestBid ?? sides[1].outcomePrice),
  ]
}

/**
 * Price-domain no-arb residual per outcome: `bid_i - (1 - ask_{!i})`.
 * Positive means the side is bid above the opposite ask's complement (a
 * potential arbitrage if both are live). This is a residual in price space,
 * NOT a measure of orderbook pressure — do not add directly to probabilities.
 */
function noArbResidual(ctx: Record<string, any>): [number, number] {
  const bids = outcomeBids(ctx)
  const asks = outcomeAsks(ctx)
  return [bids[0] - (1 - asks[1]), bids[1] - (1 - asks[0])]
}

/**
 * Computes per-outcome edge = fair - ask, aligned to `market.outcomes` order.
 *
 * Requires the input to be a valid 2-simplex (`|p0 + p1 - 1| < 1e-6`) —
 * throws otherwise. Callers must construct probabilities that sum to 1;
 * use `binaryProbsFromYesProb` or log-odds adjustment to preserve the invariant.
 */
function edgeFromProbs(
  probabilities: [number, number],
  ctx: Record<string, any>,
): [BinaryEdgeInfo, BinaryEdgeInfo] {
  if (probabilities.length !== 2) {
    throw new Error(
      `edgeFromProbs: expected 2 probabilities, got ${probabilities.length}`,
    )
  }
  const p0 = probabilities[0]
  const p1 = probabilities[1]
  if (
    typeof p0 !== 'number' ||
    typeof p1 !== 'number' ||
    !Number.isFinite(p0) ||
    !Number.isFinite(p1)
  ) {
    throw new Error('edgeFromProbs: both probabilities must be finite numbers')
  }
  if (Math.abs(p0 + p1 - 1) > 1e-6) {
    throw new Error(
      `edgeFromProbs: probabilities must sum to 1 (got ${p0} + ${p1} = ${p0 + p1}); ` +
        'use binaryProbsFromYesProb or log-odds adjustment to preserve the 2-simplex',
    )
  }
  const sides = outcomeSides(ctx)
  const candidates = sides.map((side, index) => {
    const ask = side.bestAsk ?? side.outcomePrice
    const fairPrice = index === 0 ? p0 : p1
    return {
      index: side.index,
      label: side.label,
      fairPrice,
      marketPrice: ask,
      edge: fairPrice - ask,
      bestBid: side.bestBid,
      bestAsk: side.bestAsk,
    }
  }) as [BinaryEdgeInfo, BinaryEdgeInfo]
  return candidates
}

// ─── Count model (Poisson → normal projection) ─────────────────────────────

/**
 * Build a count projection model from observed data.
 * Assumes a Poisson counting process: observed count in elapsed time,
 * projected forward over remaining time with normal approximation.
 */
function countModel(opts: {
  observed: number
  windowStart: number
  windowEnd: number
  nowTs: number
  regimeUncertainty?: number
}): CountModel {
  const { observed, windowStart, windowEnd, nowTs } = opts
  const regimeUncertainty = opts.regimeUncertainty ?? 0.08
  const elapsed = (nowTs - windowStart) / 3_600_000
  const remaining = (windowEnd - nowTs) / 3_600_000
  if (elapsed <= 0) {
    throw new Error('countModel: nowTs must be after windowStart')
  }
  const rate = observed / elapsed
  const projectedAdditional = rate * remaining
  const mu = observed + projectedAdditional
  const poissonSigma = Math.sqrt(projectedAdditional)
  const regimeNoise = mu * regimeUncertainty
  const sigma = Math.sqrt(
    poissonSigma * poissonSigma + regimeNoise * regimeNoise,
  )
  return { mu, sigma, rate, elapsed, remaining }
}

/**
 * P(lo ≤ X ≤ hi) under the normal approximation from countModel.
 * Applies continuity correction: lo - 0.5 and hi + 0.5.
 * If hi is null, computes P(X ≥ lo) (open-ended upper bound).
 */
function countRangeProb(
  model: CountModel,
  lo: number,
  hi: number | null,
): number {
  const { mu, sigma } = model
  if (sigma <= 0) return mu >= lo && (hi === null || mu <= hi) ? 1 : 0
  const loAdj = lo - 0.5
  const hiAdj = hi === null ? Infinity : hi + 0.5
  const pLo = normCDF((loAdj - mu) / sigma)
  const pHi = hiAdj === Infinity ? 1 : normCDF((hiAdj - mu) / sigma)
  return Math.max(0, pHi - pLo)
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
  // baseline pricing primitives
  bsAbove,
  bsRange,
  bsOneTouch,
  empiricalProbUp,
  firstHitProbabilities,
  binaryProbsFromYesProb,
  eventQuestionTypes,
  eventPrimaryQuestionType,
  // feature helpers
  timeToExpiryHours,
  timeToExpiryYears,
  vol,
  volRatio,
  distanceToStrike,
  distanceToRangeMid,
  distanceToBarriers,
  // market structure helpers
  outcomeSides,
  yesSide,
  noSide,
  outcomeAsks,
  outcomeBids,
  spreadByOutcome,
  noArbResidual,
  // count model
  countModel,
  countRangeProb,
  // execution helpers
  edgeFromProbs,
}
