# Strategy Templates

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
