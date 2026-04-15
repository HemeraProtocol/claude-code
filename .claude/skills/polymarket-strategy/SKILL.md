---
name: polymarket-strategy
description: Generate and execute a signal-only strategy for a Polymarket crypto event. Fetches the event plus all underlying markets, orderbooks, klines, and realized vol; runs LLM-composed strategy via run_js; returns per-market signals grouped under the event.
argument-hint: "<Polymarket URL 或 slug>"
allowed-tools:
    - Bash(bun *)
    - run_js
user-invocable: "true"
---

# Polymarket Strategy Runner

## Workflow

1. **Extract slug and underlying** from user input.
    - Slug: last path segment of the URL (e.g. `btc-updown-5m-1766162100`), or infer from text.
    - Underlying: detect ticker from slug/title (BTC / ETH / SOL / ...), default BTC.

2. **Fetch market data** by running:

    ```bash
    bun run "${CLAUDE_SKILL_DIR}/fetch.ts" --slug <slug> --underlying <UNDERLYING> [--limit 200]
    ```

    The script writes the full ctx to `/tmp/polymarket-ctx-<slug>.json` and prints `{"ctxPath":"/tmp/..."}` to stdout.
    Parse stdout JSON and extract `ctxPath` (do **not** use ctx inline — it is too large for tool results).
    **Do NOT inspect the file via Bash** — the schema is documented below; proceed directly to Step 3.

3. **Compose a strategy** (≤15 lines) using helpers documented below.
    - ⚠️ **FORBIDDEN in `code`**: `import`, `require`, `export` — the code runs inside `new Function()` with no module system. All helpers are already in `ctx.helpers`.
    - ⚠️ **FORBIDDEN**: reading files or making network calls inside `code`. All data is in `ctx`.

4. **Execute via run_js**:
    - `code`: the strategy body
    - `ctxPath`: the path from step 2 (e.g. `/tmp/polymarket-ctx-<slug>.json`)
    - `ctx`: `{}` (leave empty — ctxPath takes priority)
    - `helpersModulePath`: `"${CLAUDE_SKILL_DIR}/helpers.ts"`
    - `timeoutMs`: 5000

5. **Report in Chinese**: 先写 event 标题，再逐个 market 汇报：市场问题, 到期时间, 盘口价格, 模型估计概率, 决策, 一句话原因, edge 大小。

## ctx Schema

```
ctx.event
  .slug           string          — event slug (user usually provides this)
  .title          string          — event title shown in Polymarket UI

ctx.markets[]                     — all markets under the event (one per price level)
  .slug           string
  .question       string          — e.g. "Will BTC be above $95,000 on Jan 1?"
  .questionType   'above'|'below'|'range'|'hit'|'directional'|'firstHit'|'unknown'
                                  — semantic type parsed from question text
  .kind           'absolute'|'directional'
                                  — legacy field; use questionType for new code
  .strike         number|null     — lower (or only) strike; null for directional
  .strike2        number|null     — upper strike for range/firstHit markets; null otherwise
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

ctx.underlying
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

### Strategy building blocks

- `fairProbs(ctx, {sigmaWindow?, sigmaOverride?, simPaths?, simSteps?})` → `[p0, p1]`
  **Preferred for all binary markets.** Returns fair probabilities aligned to `market.outcomes` index order.
    - `above` / `below` / `range` / `hit` / `directional` map to `[p(outcome0), p(outcome1)]`
    - `firstHit` uses a Monte Carlo first-touch model and applies Polymarket's "no touch => 50/50" rule
- `probYes(ctx, {sigmaWindow?, sigmaOverride?})` → number
  **Yes/No only.** Dispatches to the correct BS formula based on `market.questionType`:
    - `above` → N(d2) = P(S_T > K)
    - `below` → 1 − N(d2) = P(S_T < K)
    - `range` → N(d2_lo) − N(d2_hi) = P(K_lo ≤ S_T ≤ K_hi); requires `strike2`
    - `hit` → 2·N(−|ln(K/S)|/(σ√T)), one-touch barrier (no-drift approx)
    - `directional` → delegates to `directionalProbUp` (≈ 0.5)
      Throws if `questionType === 'firstHit'`, `questionType === 'unknown'`, or vol window missing.
- `bsAbove(ctx, opts)` — underlying primitive for above type; exported for inspection.
- `bsRange(ctx, opts)` — range formula; throws if `strike2` missing.
- `bsOneTouch(ctx, opts)` — one-touch barrier; works for both up and down.
- `bsProbUp(ctx, {sigmaWindow?, sigmaOverride?})` → number
  **Deprecated** — alias for `bsAbove`. Always computes P(S > K); incorrect for below/range/hit.
- `directionalProbUp(ctx, {sigmaWindow?})` → number
  For "Up or Down" markets: returns N(-0.5·σ·√T) ≈ 0.5. Model cannot provide edge here; edge must come from orderbook imbalance.
- `empiricalProbUp(ctx, {lookback?})` → number
  Fraction of recent kline bars that closed up.
- `outcomeSides(ctx)` → `[side0, side1]`
  Returns both binary outcomes with labels and orderbook info, preserving market order.
- `yesSide(ctx)` → `{index, label, outcomePrice, bestBid, bestAsk}`
  Recognises "yes/up/above/over/higher/>" labels. Throws on unknown labels.
- `noSide(ctx)` → same shape
- `effectiveEdge(pHat, ctx, {threshold?})` → `{side, pHat, marketPrice, edge, reason}`
  Legacy helper for Yes/No-style markets only. Computes edge against `bestAsk` (real cost after crossing the spread).
- `effectiveEdgeBinary(probs, ctx, {threshold?})` → `{side, sideIndex, sideLabel, fairPrice, marketPrice, edge, reason}`
  Generic binary-market decision helper. `probs` must align to `market.outcomes` order, so it works for `Yes/No`, `Up/Down`, and `$60k/$80k`-style first-hit markets.
  Threshold default 0.05.

## Reference Strategy (generic binary markets)

```js
return ctx.markets.map((market) => {
	const mCtx = {
		market,
		underlying: ctx.underlying,
		timing: { ...ctx.timing, expiryTs: market.expiryTs },
	};

	let probs;
	try {
		probs = ctx.helpers.fairProbs(mCtx);
	} catch (err) {
		return {
			question: market.question,
			questionType: market.questionType,
			side: "hold",
			reason: String(err),
		};
	}

	return {
		question: market.question,
		questionType: market.questionType,
		strike: market.strike,
		strike2: market.strike2,
		probs,
		...ctx.helpers.effectiveEdgeBinary(probs, mCtx, { threshold: 0.05 }),
	};
});
```

## Custom Strategies

For MACD / RSI / momentum approaches, iterate over `ctx.markets`:

```js
const closes = ctx.underlying.klines.map((k) => k.close);
const ema12 = ctx.helpers.emaArray(closes, 12);
const ema26 = ctx.helpers.emaArray(closes, 26);
const macd = ema12.map((v, i) => v - ema26[i]);
const signal = ctx.helpers.emaArray(macd, 9);
const histLast = macd.at(-1) - signal.at(-1);
const pHat = histLast > 0 ? 0.58 : 0.42;

return ctx.markets.map((market) => {
	const mCtx = {
		market,
		underlying: ctx.underlying,
		timing: { ...ctx.timing, expiryTs: market.expiryTs },
	};
	return {
		question: market.question,
		...ctx.helpers.effectiveEdge(pHat, mCtx, { threshold: 0.05 }),
	};
});
```

Always return an array (one entry per market) so the report covers all price levels under the event.

## Notes

- `CLAUDE_SKILL_DIR` is the absolute path to this skill's directory, available in bash and as an injectable variable.
- Input is typically an **event slug**. Fetching happens at the event level, but analysis happens at the **market** level (`ctx.markets[]`).
- Each market has its own `hoursToExpiry`; skip (mark closed) those where it is < 0.
- `market.questionType === 'directional'` means the question is "Up or Down" with no fixed $ strike. `directionalProbUp` returns ≈0.5; these markets will output `hold` unless orderbook imbalance is added.
- `market.questionType === 'firstHit'` means a two-barrier race such as `Will Bitcoin hit $60k or $80k first?`. Use `fairProbs` + `effectiveEdgeBinary`, not `probYes`.
- If `market.strike` is null (e.g. `questionType === 'unknown'`), model-based pricing cannot run — mark hold or fall back explicitly.
- `ctx.underlying.realizedVolWarnings` is an array of strings. Non-empty = some vol windows had fetch failures (fallback σ=1 was used). `fairProbs` / `probYes` / `bsAbove` / `bsRange` / `bsOneTouch` throw when the needed vol window is listed; catch and mark hold or apply an explicit fallback.
- Do NOT hardcode strategy logic in bash heredocs. Always use the `run_js` tool.
