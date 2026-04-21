# ctx.helpers API Reference

All helpers are injected by `run_js` from `helpers.ts`. Available as `ctx.helpers.*` inside strategy code.

## Math primitives

- `normCDF(x)` — standard normal CDF
- `mean(arr)`, `stdev(arr)`, `quantile(arr, p)`
- `sma(arr, w)` — simple moving average (last w elements)
- `emaArray(arr, w)` — full EMA series (same length as input). Use `.at(-1)` for latest, slice for crossover/MACD.
- `rsi(closes, period?)` — Wilder-smoothed RSI of latest bar. Default period 14. Returns 50 if not enough bars.
- `logReturns(prices)` — log return array

## Baseline pricing primitives (per questionType)

There is **no** dispatcher helper. You choose the primitive based on the event's `questionType`:

- `above` → `bsAbove(mCtx, opts?)`
- `below` → `1 - bsAbove(mCtx, opts?)`
- `range` → `bsRange(mCtx, opts?)` — requires `strike2`
- `hit` → `bsOneTouch(mCtx, opts?)`
- `firstHit` → `firstHitProbabilities(mCtx, opts?)` — returns `[p0, p1]` aligned to `market.outcomes`
- `directional` → **no stable BS baseline** (zero-drift lognormal is ~0.5). Compose from orderbook + momentum.

All scalar baselines return the **YES-side** probability. To get a valid 2-simplex aligned to `market.outcomes`, wrap with `binaryProbsFromYesProb(mCtx, pYes)`.

- `bsAbove(mCtx, {sigmaWindow?, sigmaOverride?})` → number
  `P(S_T > K)` under zero-drift lognormal.
- `bsRange(mCtx, {sigmaWindow?, sigmaOverride?})` → number
  `P(K_lo ≤ S_T ≤ K_hi)`.
- `bsOneTouch(mCtx, {sigmaWindow?, sigmaOverride?})` → number
  No-drift one-touch barrier probability.
- `firstHitProbabilities(mCtx, {sigmaWindow?, sigmaOverride?, simPaths?, simSteps?, seed?})` → `[p0, p1]`
  Monte Carlo two-barrier race, aligned to `market.outcomes` order. Pass `seed` for reproducibility.
- `empiricalProbUp(mCtx, {lookback?})` → number
  Recent fraction of up-closes from klines. Lightweight directional feature.
- `binaryProbsFromYesProb(mCtx, pYes)` → `[p0, p1]`
  Aligns a yes/up/above-style probability to `market.outcomes` order. Returns a valid 2-simplex (sums to 1).

## Event-level type helpers

- `eventQuestionTypes(ctx)` → `questionType[]`
  Distinct `questionType` values present in `ctx.markets`.
- `eventPrimaryQuestionType(ctx)` → `questionType | null`
  Returns the single non-unknown type if the event is single-type, otherwise **`null`** (mixed).
  Throws only when all markets are `'unknown'` (fetch/parse failure).

## Feature helpers

- `timeToExpiryHours(mCtx)`, `timeToExpiryYears(mCtx)`
- `vol(ctx, window?)` — realized vol for the chosen window; throws if fetch warned that window failed.
- `volRatio(ctx, shortWindow?, longWindow?)`
- `distanceToStrike(mCtx)` — signed percent distance `(strike - spot) / spot`
- `distanceToRangeMid(mCtx)` — signed percent distance from spot to range midpoint
- `distanceToBarriers(mCtx)` → `{currentPrice, lower, upper, pctToLower, pctToUpper, logDistToLower, logDistToUpper}`

## Market structure helpers

- `outcomeSides(mCtx)` → `[side0, side1]`
- `yesSide(mCtx)`, `noSide(mCtx)` — label recognizers for `Yes/No` and `Up/Down` style markets
- `outcomeAsks(mCtx)`, `outcomeBids(mCtx)`
- `spreadByOutcome(mCtx)`
- `noArbResidual(mCtx)` → `[residual0, residual1]`
  **Price-domain** residual `bid_i - (1 - ask_{!i})`. Positive = potential arbitrage against the opposite quote.
  ⚠️ This is NOT orderbook pressure / flow imbalance. Do **not** add directly to probabilities.

## Count model helpers (for tweet/post count markets)

- `countModel({ observed, windowStart, windowEnd, nowTs, regimeUncertainty? })` → `CountModel`
  Builds a Poisson→normal projection: `{ mu, sigma, rate, elapsed, remaining }`.
  - `observed`: total count so far (use `ctx.news.totalCount`)
  - `windowStart`/`windowEnd`: epoch ms of the counting window (from event description)
  - `nowTs`: `ctx.timing.nowTs`
  - `regimeUncertainty`: optional, default `0.08` (8% of mu added as extra sigma)

- `countRangeProb(model, lo, hi)` → `number`
  P(lo ≤ X ≤ hi) under the normal approximation. Uses continuity correction (lo−0.5, hi+0.5).
  Pass `hi = null` for open-ended ("N+ tweets") markets.

## Execution helpers

- `edgeFromProbs(probs, mCtx)` → `[edge0, edge1]`
  Returns per-outcome `{fairPrice, marketPrice, edge, bestBid, bestAsk}` aligned to `market.outcomes`.
  **Strict**: throws if `probs` is not a valid 2-simplex (`|p0 + p1 - 1| > 1e-6`). Construct probabilities
  via `binaryProbsFromYesProb` or a log-odds adjustment to preserve the invariant.
