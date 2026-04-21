---
name: polymarket-strategy
description: Generate and execute a signal-only strategy for a Polymarket event (crypto or politics/tweet). Fetches markets, orderbooks, and optionally klines/vol and Twitter data; runs LLM-composed strategy via run_js; returns per-market signals grouped under the event.
argument-hint: "<Polymarket URL 或 slug>"
allowed-tools:
    - Read
    - Bash(bun *)
    - run_js
user-invocable: "true"
---

# Polymarket Strategy Runner

## Workflow

1. **Extract slug** from user input:
    - Slug: last path segment of the URL (e.g. `elon-musk-of-tweets-april-18-april-20`), or infer from text.

2. **Fetch event detail** (first call — markets only, no extra data):

    ```bash
    bun run "${CLAUDE_SKILL_DIR}/fetch.ts" --slug <slug>
    ```

    Parse stdout JSON → extract `ctxPath` and `executionLogPath`.
    Read `ctxPath` to inspect `event.title` and `event.description` — these contain resolution rules, Twitter accounts, time windows, and other critical info needed to decide what additional data to fetch.

3. **Determine data sources from description**, then re-fetch with correct flags:
    - **Crypto price markets** (description mentions BTC/ETH/SOL price targets): add `--underlying <TICKER>`
    - **Tweet-count/activity markets** (description specifies a Twitter account + time window): add `--news-accounts <handle> --news-since <ISO> --news-until <ISO>` — extract the exact handle and UTC time window from description text
    - **News/policy markets** (description references political figures or policy events): add `--news-accounts <relevant_handles>`
    - **Pure prediction markets** (no external data needed): skip re-fetch, use ctx from step 2 directly

    ```bash
    bun run "${CLAUDE_SKILL_DIR}/fetch.ts" --slug <slug> [--underlying <TICKER>] [--news-accounts <handles>] [--news-since <ISO>] [--news-until <ISO>] [--limit 200]
    ```

    This second call re-fetches fresh market prices + the requested additional data. Use the new `ctxPath` and `executionLogPath` from this call for subsequent steps.

4. **Compose a strategy** using helpers documented below.
    - For **crypto events**: use BS pricing + technical indicators (see crypto template below).
    - For **politics/tweet events**: estimate `pYes` per market from `ctx.news` data and question semantics (see politics template below). Do **not** call `eventPrimaryQuestionType` — it throws on all-unknown events.
    - ⚠️ **FORBIDDEN in `code`**: `import`, `require`, `export` — the code runs inside `new Function()` with no module system. All helpers are already in `ctx.helpers`.
    - ⚠️ **FORBIDDEN**: reading files or making network calls inside `code`. All data is in `ctx`.
    - ⚠️ **Never hand-write epoch timestamps**. Use `new Date("2026-04-18T16:00:00Z").getTime()` instead of literal numbers — manual conversion is error-prone.

5. **Execute via run_js**:
    - `code`: the strategy body
    - `ctxPath`: the path from step 2 or 3 (e.g. `/tmp/polymarket-ctx-<slug>.json`)
    - `ctx`: `{}` (leave empty — ctxPath takes priority)
    - `helpersModulePath`: `"${CLAUDE_SKILL_DIR}/helpers.ts"`
    - `executionLogPath`: the path from step 2 or 3; this records code/result provenance for later evaluation. Must be under the current working directory.
    - `resultShape`: `"strategy-array"` — enforces that `result` is an array of `{question, decision}` objects; extra fields are allowed.
    - `timeoutMs`: 5000

6. **Report in Chinese**: 先写 event 标题，再逐个 market 汇报：市场问题, 到期时间, 盘口价格, 模型估计概率, 决策, 一句话原因, edge 大小。

## ctx Schema

```
ctx.event
  .slug           string          — event slug (user usually provides this)
  .title          string          — event title shown in Polymarket UI
  .description    string|undefined — event rules text (contains time windows, accounts, resolution rules)

ctx.markets[]                     — all markets under the event (one per price level)
  .slug           string
  .question       string          — e.g. "Will BTC be above $95,000 on Jan 1?"
  .questionType   'above'|'below'|'range'|'hit'|'directional'|'firstHit'|'count'|'unknown'
                                  — semantic type parsed from question text
                                  — 'count' = tweet/post count markets ("post 80-99 tweets")
  .kind           'absolute'|'directional'
                                  — legacy field; use questionType for new code
  .strike         number|null     — lower (or only) strike; null for directional
  .strike2        number|null     — upper strike for range/firstHit/count markets; null for count "N+" (open-ended)
  .parser         'rules'         — current parser implementation
  .confidence     number          — parser confidence (1 for rules matches, 0 for unknown)
  .expiryDate     string          — ISO date
  .expiryTs       number          — epoch ms
  .hoursToExpiry  number
  .outcomes[]
    .label        string          — e.g. "Yes"/"No", "Up"/"Down", "$60k"/"$80k"
    .price        number          — current market price (0–1)
    .bestBid      number|null
    .bestAsk      number|null
  .volume         number
  .liquidity      number
  .active         boolean
  .closed         boolean

ctx.underlying                    — OPTIONAL: only present when --underlying is passed (crypto markets)
  .symbol         string          — "BTC", "ETH", etc.
  .price          number          — latest 1h-close price in USD
  .klines[]                       — up to 200 hourly candles (default; use --limit to adjust)
    .timestamp    number
    .open/high/low/close number
    .volume       number
  .realizedVol                    — annualized realized vol
    ['15m']       number
    ['1h']        number
    ['24h']       number
    ['7d']        number
    ['30d']       number
  .realizedVolWarnings  string[]  — non-empty if any vol window failed; empty = all OK

ctx.news                          — OPTIONAL: only present when --news-accounts is passed
  .tweets[]                       — up to 20 most recent tweets (within time window), newest first
    .author       string          — Twitter handle (e.g. "elonmusk")
    .text         string          — tweet content
    .createdAt    string          — e.g. "Tue Dec 10 07:00:30 +0000 2024"
  .totalCount     number          — total tweets in the time window (paginated count)
  .fetchedAt      string          — ISO timestamp of when tweets were fetched
  .accounts       string[]        — accounts that were queried

ctx.timing
  .nowTs          number          — epoch ms (captured at fetch time)
```

## ctx.helpers (injected by run_js from helpers.ts)

### Math primitives

- `normCDF(x)` — standard normal CDF
- `mean(arr)`, `stdev(arr)`, `quantile(arr, p)`
- `sma(arr, w)` — simple moving average (last w elements)
- `emaArray(arr, w)` — full EMA series (same length as input). Use `.at(-1)` for latest, slice for crossover/MACD.
- `rsi(closes, period?)` — Wilder-smoothed RSI of latest bar. Default period 14. Returns 50 if not enough bars.
- `logReturns(prices)` — log return array

### Baseline pricing primitives (per questionType)

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

### Event-level type helpers

- `eventQuestionTypes(ctx)` → `questionType[]`
  Distinct `questionType` values present in `ctx.markets`.
- `eventPrimaryQuestionType(ctx)` → `questionType | null`
  Returns the single non-unknown type if the event is single-type, otherwise **`null`** (mixed).
  Throws only when all markets are `'unknown'` (fetch/parse failure).

### Feature helpers

- `timeToExpiryHours(mCtx)`, `timeToExpiryYears(mCtx)`
- `vol(ctx, window?)` — realized vol for the chosen window; throws if fetch warned that window failed.
- `volRatio(ctx, shortWindow?, longWindow?)`
- `distanceToStrike(mCtx)` — signed percent distance `(strike - spot) / spot`
- `distanceToRangeMid(mCtx)` — signed percent distance from spot to range midpoint
- `distanceToBarriers(mCtx)` → `{currentPrice, lower, upper, pctToLower, pctToUpper, logDistToLower, logDistToUpper}`

### Market structure helpers

- `outcomeSides(mCtx)` → `[side0, side1]`
- `yesSide(mCtx)`, `noSide(mCtx)` — label recognizers for `Yes/No` and `Up/Down` style markets
- `outcomeAsks(mCtx)`, `outcomeBids(mCtx)`
- `spreadByOutcome(mCtx)`
- `noArbResidual(mCtx)` → `[residual0, residual1]`
  **Price-domain** residual `bid_i - (1 - ask_{!i})`. Positive = potential arbitrage against the opposite quote.
  ⚠️ This is NOT orderbook pressure / flow imbalance. Do **not** add directly to probabilities.

### Count model helpers (for tweet/post count markets)

- `countModel({ observed, windowStart, windowEnd, nowTs, regimeUncertainty? })` → `CountModel`
  Builds a Poisson→normal projection: `{ mu, sigma, rate, elapsed, remaining }`.
  - `observed`: total count so far (use `ctx.news.totalCount`)
  - `windowStart`/`windowEnd`: epoch ms of the counting window (from event description)
  - `nowTs`: `ctx.timing.nowTs`
  - `regimeUncertainty`: optional, default `0.08` (8% of mu added as extra sigma)

- `countRangeProb(model, lo, hi)` → `number`
  P(lo ≤ X ≤ hi) under the normal approximation. Uses continuity correction (lo−0.5, hi+0.5).
  Pass `hi = null` for open-ended ("N+ tweets") markets.

### Execution helpers

- `edgeFromProbs(probs, mCtx)` → `[edge0, edge1]`
  Returns per-outcome `{fairPrice, marketPrice, edge, bestBid, bestAsk}` aligned to `market.outcomes`.
  **Strict**: throws if `probs` is not a valid 2-simplex (`|p0 + p1 - 1| > 1e-6`). Construct probabilities
  via `binaryProbsFromYesProb` or a log-odds adjustment to preserve the invariant.

## Strategy Guidance

Strategy composition is **your** job. The helpers are primitives, not a dispatcher.

1. Compute event-scope features **once** (RSI, EMA slope, realized vol, etc.) before `.map`.
2. Inside `.map`, build `mCtx = { market, underlying: ctx.underlying, timing: ctx.timing }`.
   `resolveVolAndTime` reads `market.expiryTs` directly — you do not need to splat `timing.expiryTs`.
3. Compute the per-questionType baseline `pYes` from the primitives listed above.
4. Apply adjustments **in log-odds space**: `logit(p) + Σ shift → sigmoid`. This preserves the 2-simplex automatically and avoids the need for runtime renormalization.
5. Build the aligned pair via `binaryProbsFromYesProb(mCtx, pYesAdjusted)`.
6. Call `edgeFromProbs(probs, mCtx)`, compare the best edge to your threshold, and return a signal.
7. Wrap every market body in `try/catch` so one broken market does not kill the whole event report.

**NEVER** write per-questionType `if/else` or `switch` inside `.map` unless `eventPrimaryQuestionType(ctx)` is `null` (genuinely mixed event).

Recommended feature sets:

- `directional`: RSI, MACD, short momentum, volume confirmation, noArbResidual as a price-domain sanity check
- `above` / `below`: BS baseline, distance to strike, momentum, vol regime
- `range`: BS baseline, distance to range midpoint, vol regime, trend strength
- `hit`: BS baseline, distance to strike, vol regime, acceleration toward the barrier
- `firstHit`: Monte Carlo baseline, distance to barriers, barrier asymmetry, vol regime
- `count`: countModel + countRangeProb baseline, no underlying needed — uses ctx.news.totalCount

## Strategy Template: Crypto (single-type event)

```js
const et = ctx.helpers.eventPrimaryQuestionType(ctx);
if (et === null) throw new Error("mixed-type event: use the mixed template instead");
if (!["above", "below", "directional"].includes(et)) {
	throw new Error(`strategy supports above/below/directional only, got ${et}`);
}

// Event-scope features computed once
const closes = ctx.underlying.klines.map((k) => k.close);
const rsi = ctx.helpers.rsi(closes, 14);
const emaFast = ctx.helpers.emaArray(closes, 12).at(-1);
const emaSlow = ctx.helpers.emaArray(closes, 26).at(-1);
const momentum = Math.sign(emaFast - emaSlow);

// Per-questionType YES-prob baseline (explicit — no helper dispatch)
const baseYesProb = (mCtx) => {
	switch (et) {
		case "above":       return ctx.helpers.bsAbove(mCtx);
		case "below":       return 1 - ctx.helpers.bsAbove(mCtx);
		case "directional": return 0.5; // directional: neutral BS baseline
	}
};

// Log-odds adjustment preserves the 2-simplex automatically
const logit   = (p) => Math.log(p / (1 - p));
const sigmoid = (x) => 1 / (1 + Math.exp(-x));

const THRESHOLD = 0.05;

return ctx.markets.map((market) => {
	try {
		if (market.closed || market.hoursToExpiry < 0) {
			return { question: market.question, questionType: market.questionType, decision: "hold", reason: "closed or expired" };
		}
		const mCtx = { market, underlying: ctx.underlying, timing: ctx.timing };
		const yes0 = baseYesProb(mCtx);
		const shift = (rsi - 50) / 100 + momentum * 0.05;
		const yes = sigmoid(logit(Math.min(Math.max(yes0, 1e-6), 1 - 1e-6)) + shift);
		const probs = ctx.helpers.binaryProbsFromYesProb(mCtx, yes);
		const edges = ctx.helpers.edgeFromProbs(probs, mCtx);
		const best = edges[0].edge >= edges[1].edge ? edges[0] : edges[1];
		if (best.edge < THRESHOLD) {
			return { question: market.question, questionType: market.questionType, probs, decision: "hold", edge: best.edge };
		}
		return {
			question: market.question,
			questionType: market.questionType,
			probs,
			decision: "buy",
			side: best.label,
			fairPrice: best.fairPrice,
			marketPrice: best.marketPrice,
			edge: best.edge,
		};
	} catch (err) {
		return { question: market.question, decision: "hold", reason: String(err) };
	}
});
```

## Strategy Template: Crypto (mixed-type event)

Only use this when `eventPrimaryQuestionType(ctx)` returns `null`. Dispatch per-market:

```js
if (ctx.helpers.eventPrimaryQuestionType(ctx) !== null) {
	throw new Error("use the single-type template for single-type events");
}

const THRESHOLD = 0.05;

const yesProbFor = (mCtx) => {
	switch (mCtx.market.questionType) {
		case "above": return ctx.helpers.bsAbove(mCtx);
		case "below": return 1 - ctx.helpers.bsAbove(mCtx);
		case "range": return ctx.helpers.bsRange(mCtx);
		case "hit":   return ctx.helpers.bsOneTouch(mCtx);
		default: throw new Error(`unsupported questionType: ${mCtx.market.questionType}`);
	}
};

return ctx.markets.map((market) => {
	try {
		if (market.closed || market.hoursToExpiry < 0) {
			return { question: market.question, decision: "hold", reason: "closed" };
		}
		const mCtx = { market, underlying: ctx.underlying, timing: ctx.timing };
		let probs;
		if (market.questionType === "firstHit") {
			probs = ctx.helpers.firstHitProbabilities(mCtx);
		} else {
			probs = ctx.helpers.binaryProbsFromYesProb(mCtx, yesProbFor(mCtx));
		}
		const edges = ctx.helpers.edgeFromProbs(probs, mCtx);
		const best = edges[0].edge >= edges[1].edge ? edges[0] : edges[1];
		if (best.edge < THRESHOLD) {
			return { question: market.question, questionType: market.questionType, probs, decision: "hold", edge: best.edge };
		}
		return { question: market.question, questionType: market.questionType, probs, decision: "buy", side: best.label, edge: best.edge, fairPrice: best.fairPrice, marketPrice: best.marketPrice };
	} catch (err) {
		return { question: market.question, decision: "hold", reason: String(err) };
	}
});
```

Always return an array (one entry per market) so the report covers all price levels under the event.

## Strategy Template: Politics / Tweet events

Use this when `ctx.underlying` is undefined (no crypto price data). The LLM estimates `pYes` per market based on `ctx.news` data and question semantics. Do **not** call `eventPrimaryQuestionType` — it throws on all-unknown events.

```js
// Tweet-count event — uses countModel + countRangeProb helpers
// LLM: extract windowStart/windowEnd from event description

const THRESHOLD = 0.04;

// ── Build count model from ctx.news ──
// LLM: replace these timestamps with actual values from event description
const windowStart = new Date("2026-04-17T16:00:00Z").getTime();
const windowEnd   = new Date("2026-04-24T16:00:00Z").getTime();

const model = ctx.helpers.countModel({
  observed: ctx.news.totalCount,
  windowStart,
  windowEnd,
  nowTs: ctx.timing.nowTs,
});

return ctx.markets.map((market) => {
  try {
    if (market.closed || market.hoursToExpiry < 0) {
      return { question: market.question, decision: "hold", reason: "closed or expired" };
    }
    const mCtx = { market, timing: ctx.timing };

    // Use parser-extracted strike/strike2 for count markets
    let pYes;
    if (market.questionType === "count" && market.strike !== null) {
      pYes = ctx.helpers.countRangeProb(model, market.strike, market.strike2);
    } else {
      pYes = 0.5; // fallback for unrecognized questions
    }

    const probs = ctx.helpers.binaryProbsFromYesProb(mCtx, pYes);
    const edges = ctx.helpers.edgeFromProbs(probs, mCtx);
    const best = edges[0].edge >= edges[1].edge ? edges[0] : edges[1];
    if (best.edge < THRESHOLD) {
      return { question: market.question, decision: "hold", edge: best.edge, pYes };
    }
    return {
      question: market.question,
      decision: "buy",
      side: best.label,
      fairPrice: best.fairPrice,
      marketPrice: best.marketPrice,
      edge: best.edge,
      pYes,
    };
  } catch (err) {
    return { question: market.question, decision: "hold", reason: String(err) };
  }
});
```

## Notes

- `CLAUDE_SKILL_DIR` is the absolute path to this skill's directory, available in bash and as an injectable variable.
- Input is typically an **event slug**. Fetching happens at the event level, but analysis happens at the **market** level (`ctx.markets[]`).
- Each run should pass through the provided `executionLogPath` so a structured JSON log is written under `.claude/polymarket-strategy-runs/`.
- Each market has its own `hoursToExpiry`; skip (mark closed) those where it is < 0.
- `market.questionType === 'directional'` means the question is "Up or Down" with no fixed $ strike. A zero-drift BS baseline is ~0.5 and useless; edge must come from microstructure + momentum. These markets output `hold` unless your adjustment pushes `yes` meaningfully off 0.5.
- `market.questionType === 'firstHit'` means a two-barrier race such as `Will Bitcoin hit $60k or $80k first?`. Use `firstHitProbabilities`, not `bsAbove` / `bsRange` / `bsOneTouch`.
- If `market.strike` is null (e.g. `questionType === 'unknown'`), BS pricing cannot run. For politics/tweet events, use the politics template with LLM-estimated probabilities instead.
- When `ctx.underlying` is undefined, all BS pricing helpers (`bsAbove`, `bsRange`, `bsOneTouch`, `firstHitProbabilities`) and vol/distance helpers will throw. This is expected for politics events — use the politics template.
- When `ctx.underlying` is present, `realizedVolWarnings` is an array of strings. Non-empty = some vol windows had fetch failures (fallback σ=1 was used). `vol` / `volRatio` / BS helpers throw when the needed vol window is listed; catch and mark hold or apply an explicit fallback.
- `ctx.news` is only present when `--news-accounts` was passed. Data comes from **xtracker.polymarket.com** (the settlement source, includes deleted posts). Use `ctx.news.totalCount` for tweet-count markets and `ctx.news.tweets` for content analysis. No API key required.
- `TWITTER_API_KEY` env var is only needed if you switch to the twitterapi.io fallback (not used by default).
- Do NOT hardcode strategy logic in bash heredocs. Always use the `run_js` tool.
