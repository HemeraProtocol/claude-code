---
name: polymarket-strategy
description: Generate and execute a signal-only strategy for a Polymarket crypto up/down prediction market. Fetches live market + orderbook + klines + realized vol, runs LLM-composed strategy via run_js, returns yes/no/hold signal.
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

5. **Report in Chinese**: 市场问题, 到期时间, yes/no 盘口价格, 模型估计概率, 决策(yes/no/hold), 一句话原因, edge 大小.

## ctx Schema

```
ctx.markets[]                     — all markets under the event (one per price level)
  .slug           string
  .question       string          — e.g. "Will BTC be above $95,000 on Jan 1?"
  .kind           'absolute'|'directional'
                                  — 'directional' for "Up or Down" markets (no fixed $ strike)
  .strike         number|null     — parsed strike price; null for directional markets
  .expiryDate     string          — ISO date
  .expiryTs       number          — epoch ms
  .hoursToExpiry  number
  .outcomes[]
    .label        string          — "Yes"/"No" or "Up"/"Down"
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

- `bsProbUp(ctx, {sigmaWindow?, sigmaOverride?})` → number
  Black-Scholes prob of underlying ending above strike at expiry. Throws if the required vol window has a fetch warning (check `ctx.underlying.realizedVolWarnings`).
- `directionalProbUp(ctx, {sigmaWindow?})` → number
  For "Up or Down" markets: returns N(-0.5·σ·√T) ≈ 0.5. Model cannot provide edge here; edge must come from orderbook imbalance.
- `empiricalProbUp(ctx, {lookback?})` → number
  Fraction of recent kline bars that closed up.
- `yesSide(ctx)` → `{index, label, outcomePrice, bestBid, bestAsk}`
  Recognises "yes/up/above/over/higher/>" labels. Throws on unknown labels.
- `noSide(ctx)` → same shape
- `effectiveEdge(pHat, ctx, {threshold?})` → `{side, pHat, marketPrice, edge, reason}`
  Computes edge against `bestAsk` (real cost after crossing the spread). Use this for live signals.
  Threshold default 0.05.

## Reference Strategy (BS + Empirical Blend, all markets)

```js
const v1h = ctx.underlying.realizedVol["1h"] ?? 1;
const v30d = ctx.underlying.realizedVol["30d"] ?? 1;
const useEmp = v1h / v30d > 1.2;

return ctx.markets.map((market) => {
	const mCtx = {
		market,
		underlying: ctx.underlying,
		timing: { ...ctx.timing, expiryTs: market.expiryTs },
	};

	let pHat;
	if (market.kind === "directional") {
		// Short-window "Up or Down" market: model gives ~0.5, BS/empirical cannot provide edge.
		pHat = ctx.helpers.directionalProbUp(mCtx);
	} else if (market.strike) {
		let pBS;
		try {
			pBS = ctx.helpers.bsProbUp(mCtx);
		} catch {
			// vol data unavailable — fall back to empirical only
			pBS = null;
		}
		const pEmp = ctx.helpers.empiricalProbUp(mCtx);
		pHat = pBS === null
			? pEmp
			: useEmp ? 0.3 * pBS + 0.7 * pEmp : 0.7 * pBS + 0.3 * pEmp;
	} else {
		pHat = ctx.helpers.empiricalProbUp(mCtx);
	}

	return {
		question: market.question,
		strike: market.strike,
		kind: market.kind,
		...ctx.helpers.effectiveEdge(pHat, mCtx, { threshold: 0.05 }),
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
	return { question: market.question, ...ctx.helpers.effectiveEdge(pHat, mCtx, { threshold: 0.05 }) };
});
```

Always return an array (one entry per market) so the report covers all price levels.

## Notes

- `CLAUDE_SKILL_DIR` is the absolute path to this skill's directory, available in bash and as an injectable variable.
- Each market has its own `hoursToExpiry`; skip (mark closed) those where it is < 0.
- `market.kind === 'directional'` means the question is "Up or Down" with no fixed $ strike. `directionalProbUp` returns ≈0.5; these markets will output `hold` unless orderbook imbalance is added.
- If `market.strike` is null (non-directional), BS model cannot run — fall back to `empiricalProbUp`.
- `ctx.underlying.realizedVolWarnings` is an array of strings. Non-empty = some vol windows had fetch failures (fallback σ=1 was used). `bsProbUp` throws when the needed window is listed; catch and fall back to empirical or mark hold.
- Do NOT hardcode strategy logic in bash heredocs. Always use the `run_js` tool.
