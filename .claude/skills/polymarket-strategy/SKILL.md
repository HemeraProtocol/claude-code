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
  .strike         number|null     — parsed strike price from question
  .expiryDate     string          — ISO date
  .expiryTs       number          — epoch ms
  .hoursToExpiry  number
  .outcomes[]
    .label        string          — "Yes" or "No"
    .price        number          — current market price (0–1)
    .bestBid      number|null
    .bestAsk      number|null
  .volume         number
  .liquidity      number
  .active         boolean
  .closed         boolean

ctx.underlying
  .symbol         string          — "BTC", "ETH", etc.
  .price          number          — latest close price in USD
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

ctx.timing
  .nowTs          number          — epoch ms
```

## ctx.helpers (injected by run_js from helpers.ts)

### Math primitives

- `normCDF(x)` — standard normal CDF
- `mean(arr)`, `stdev(arr)`, `quantile(arr, p)`
- `sma(arr, w)` — simple moving average (last w elements)
- `ema(arr, w)` — exponential moving average
- `logReturns(prices)` — log return array

### Strategy building blocks

- `bsProbUp(ctx, {sigmaWindow?, sigmaOverride?})` → number
  Black-Scholes prob of underlying ending above strike at expiry.
- `empiricalProbUp(ctx, {lookback?})` → number
  Fraction of recent kline bars that closed up.
- `yesSide(ctx)` → `{index, label, outcomePrice, bestBid, bestAsk}`
- `noSide(ctx)` → same shape
- `decideEdge(pHat, ctx, {threshold?})` → `{side, pHat, marketPrice, edge, reason}`
  Returns `side: 'yes'|'no'|'hold'`. Threshold default 0.05.

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
	const pBS = market.strike ? ctx.helpers.bsProbUp(mCtx) : null;
	const pEmp = ctx.helpers.empiricalProbUp(mCtx);
	const pHat =
		pBS === null
			? pEmp
			: useEmp
				? 0.3 * pBS + 0.7 * pEmp
				: 0.7 * pBS + 0.3 * pEmp;
	return {
		question: market.question,
		strike: market.strike,
		...ctx.helpers.decideEdge(pHat, mCtx, { threshold: 0.05 }),
	};
});
```

## Custom Strategies

For MACD / RSI / momentum approaches, iterate over `ctx.markets`:

```js
const closes = ctx.underlying.klines.map((k) => k.close);
const fast = ctx.helpers.ema(closes, 12);
const slow = ctx.helpers.ema(closes, 26);
const macd = fast - slow;
const pHat = macd > 0 ? 0.6 : 0.4;

return ctx.markets.map((market) => {
	const mCtx = {
		market,
		underlying: ctx.underlying,
		timing: { ...ctx.timing, expiryTs: market.expiryTs },
	};
	return {
		question: market.question,
		...ctx.helpers.decideEdge(pHat, mCtx, { threshold: 0.05 }),
	};
});
```

Always return an array (one entry per market) so the report covers all price levels.

## Notes

- `CLAUDE_SKILL_DIR` is the absolute path to this skill's directory, available in bash and as an injectable variable.
- Each market has its own `hoursToExpiry`; skip (mark closed) those where it is < 0.
- If `market.strike` is null, BS model cannot run — fall back to `empiricalProbUp`.
- Do NOT hardcode strategy logic in bash heredocs. Always use the `run_js` tool.
