---
name: polymarket-strategy
description: Generate and execute a signal-only strategy for a Polymarket event (crypto or politics/tweet). Fetches markets, orderbooks, and optionally klines/vol and tweet/post data (via xtracker); runs LLM-composed strategy via run_js; returns per-market signals grouped under the event.
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

4. **Compose a strategy** using helpers documented in `docs/helpers.md`.
    - For **crypto events**: use BS pricing + technical indicators (see `docs/templates.md` crypto template).
    - For **politics/tweet events**: estimate `pYes` per market from `ctx.news` data and question semantics (see `docs/templates.md` politics template). Do **not** call `eventPrimaryQuestionType` — it throws on all-unknown events.
    - Read `docs/schema.md` for the full `ctx` structure if needed.
    - ⚠️ **FORBIDDEN in `code`**: `import`, `require`, `export` — the code runs inside `new Function()` with no module system. All helpers are already in `ctx.helpers`.
    - ⚠️ **FORBIDDEN**: reading files or making network calls inside `code`. All data is in `ctx`.
    - ⚠️ **Never hand-write epoch timestamps**. Use `new Date("2026-04-18T16:00:00Z").getTime()` instead of literal numbers — manual conversion is error-prone.

5. **Execute via run_js**:
    - `code`: the strategy body
    - `ctxPath`: the path from step 2 or 3 (e.g. `.claude/polymarket-strategy-runs/<user>/<slug>/<ts>.ctx.json`)
    - `ctx`: `{}` (leave empty — ctxPath takes priority)
    - `helpersModulePath`: `"${CLAUDE_SKILL_DIR}/helpers.ts"`
    - `executionLogPath`: the path from step 2 or 3; this records code/result provenance for later evaluation. Must be under the current working directory.
    - `resultShape`: `"strategy-array"` — enforces that `result` is an array of `{question, decision}` objects; extra fields are allowed.
    - `timeoutMs`: 5000

6. **Report in Chinese**: 先写 event 标题，再逐个 market 汇报：市场问题, 到期时间, 盘口价格, 模型估计概率, 决策, 一句话原因, edge 大小。

## Strategy Guidance

Strategy composition is **your** job. The helpers are primitives, not a dispatcher.

1. Compute event-scope features **once** (RSI, EMA slope, realized vol, etc.) before `.map`.
2. Inside `.map`, build `mCtx = { market, underlying: ctx.underlying, timing: ctx.timing }`.
3. Compute the per-questionType baseline `pYes` from the primitives in `docs/helpers.md`.
4. Apply adjustments **in log-odds space**: `logit(p) + Σ shift → sigmoid`. This preserves the 2-simplex automatically.
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

## Reference Docs

- **`docs/schema.md`** — Full `ctx` structure definition
- **`docs/helpers.md`** — `ctx.helpers` API reference
- **`docs/templates.md`** — Strategy templates (crypto single-type, crypto mixed-type, politics/tweet)

## Notes

- `CLAUDE_SKILL_DIR` is the absolute path to this skill's directory, available in bash and as an injectable variable.
- Input is typically an **event slug**. Fetching happens at the event level, but analysis happens at the **market** level (`ctx.markets[]`).
- Each run should pass through the provided `executionLogPath` so a structured JSON log is written under `.claude/polymarket-strategy-runs/`.
- Each market has its own `hoursToExpiry`; skip (mark closed) those where it is < 0.
- `market.questionType === 'directional'` means "Up or Down" with no fixed $ strike. Edge must come from microstructure + momentum.
- `market.questionType === 'firstHit'` means a two-barrier race. Use `firstHitProbabilities`, not `bsAbove` / `bsRange` / `bsOneTouch`.
- If `market.strike` is null (e.g. `questionType === 'unknown'`), BS pricing cannot run. Use the politics template with LLM-estimated probabilities.
- When `ctx.underlying` is undefined, all BS pricing and vol/distance helpers will throw. Use the politics template.
- `ctx.warnings` is present when any data source had issues. Check it for degraded-data awareness.
- `ctx.news` data comes from **xtracker.polymarket.com** (the settlement source, includes deleted posts). No API key required.
- Do NOT hardcode strategy logic in bash heredocs. Always use the `run_js` tool.
