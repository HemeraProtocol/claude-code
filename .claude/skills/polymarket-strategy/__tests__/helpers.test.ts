import { describe, expect, test } from 'bun:test'

import { helpers } from '../helpers'

// ─── Shared fixtures ────────────────────────────────────────────────────────

function makeAboveCtx(overrides: Record<string, any> = {}) {
  return {
    market: {
      questionType: 'above',
      strike: 100,
      expiryTs: 86_400_000,
      outcomes: [
        { label: 'Yes', price: 0.5, bestAsk: 0.51, bestBid: 0.49 },
        { label: 'No', price: 0.5, bestAsk: 0.51, bestBid: 0.49 },
      ],
      ...overrides.market,
    },
    underlying: {
      price: 100,
      realizedVol: { '1h': 0.3, '24h': 0.35, '30d': 0.4 },
      realizedVolWarnings: [],
      ...overrides.underlying,
    },
    timing: {
      nowTs: 0,
      ...overrides.timing,
    },
  }
}

function makeRangeCtx() {
  return {
    market: {
      questionType: 'range',
      strike: 90,
      strike2: 110,
      expiryTs: 86_400_000,
      outcomes: [
        { label: 'Yes', price: 0.3, bestAsk: 0.31, bestBid: 0.29 },
        { label: 'No', price: 0.7, bestAsk: 0.71, bestBid: 0.69 },
      ],
    },
    underlying: {
      price: 100,
      realizedVol: { '1h': 0.3 },
      realizedVolWarnings: [],
    },
    timing: { nowTs: 0 },
  }
}

function makeFirstHitCtx() {
  return {
    market: {
      questionType: 'firstHit',
      strike: 90_000,
      strike2: 110_000,
      expiryTs: 86_400_000 * 7,
      outcomes: [
        { label: '$90k', price: 0.5, bestAsk: 0.51, bestBid: 0.49 },
        { label: '$110k', price: 0.5, bestAsk: 0.51, bestBid: 0.49 },
      ],
    },
    underlying: {
      price: 100_000,
      realizedVol: { '1h': 0.5 },
      realizedVolWarnings: [],
    },
    timing: { nowTs: 0 },
  }
}

// ─── E1. Baseline pricing primitives ────────────────────────────────────────

describe('bsAbove', () => {
  test('returns 0.5 at K=S (zero-drift, atm)', () => {
    const ctx = makeAboveCtx({ market: { strike: 100 } })
    const p = helpers.bsAbove(ctx, { sigmaOverride: 0.3 })
    expect(p).toBeGreaterThan(0.45)
    expect(p).toBeLessThan(0.5)
  })

  test('is monotonically decreasing in K (fixed S, σ, T)', () => {
    const ctxLow = makeAboveCtx({ market: { strike: 90 } })
    const ctxMid = makeAboveCtx({ market: { strike: 100 } })
    const ctxHigh = makeAboveCtx({ market: { strike: 110 } })
    const pLow = helpers.bsAbove(ctxLow, { sigmaOverride: 0.3 })
    const pMid = helpers.bsAbove(ctxMid, { sigmaOverride: 0.3 })
    const pHigh = helpers.bsAbove(ctxHigh, { sigmaOverride: 0.3 })
    expect(pLow).toBeGreaterThan(pMid)
    expect(pMid).toBeGreaterThan(pHigh)
  })

  test('returns 0.5 when T=0 (expired)', () => {
    const ctx = makeAboveCtx({ market: { strike: 200, expiryTs: 0 } })
    expect(helpers.bsAbove(ctx, { sigmaOverride: 0.3 })).toBe(0.5)
  })
})

describe('bsRange', () => {
  test('returns high probability when spot is well inside a wide range', () => {
    const ctx = makeRangeCtx()
    const p = helpers.bsRange(ctx, { sigmaOverride: 0.3 })
    expect(p).toBeGreaterThan(0.5)
    expect(p).toBeLessThanOrEqual(1)
  })

  test('returns a probability strictly in (0, 1) for a narrow range and high vol', () => {
    const ctx = makeRangeCtx()
    ctx.market.strike = 99
    ctx.market.strike2 = 101
    const p = helpers.bsRange(ctx, { sigmaOverride: 1.5 })
    expect(p).toBeGreaterThan(0)
    expect(p).toBeLessThan(1)
  })

  test('throws when strike2 is missing', () => {
    const ctx = makeRangeCtx()
    ctx.market.strike2 = null as any
    expect(() => helpers.bsRange(ctx, { sigmaOverride: 0.3 })).toThrow(/strike2/)
  })
})

describe('bsOneTouch', () => {
  test('returns 1 when barrier equals spot (log dist = 0)', () => {
    const ctx = makeAboveCtx({ market: { strike: 100 } })
    expect(helpers.bsOneTouch(ctx, { sigmaOverride: 0.3 })).toBeCloseTo(1, 6)
  })

  test('returns near 0 for far barriers with low vol and short T', () => {
    const ctx = makeAboveCtx({
      market: { strike: 1_000_000, expiryTs: 1000 }, // 1 second
    })
    const p = helpers.bsOneTouch(ctx, { sigmaOverride: 0.05 })
    expect(p).toBeGreaterThanOrEqual(0)
    expect(p).toBeLessThan(0.01)
  })
})

describe('firstHitProbabilities', () => {
  test('returns [1, 0]-aligned outcome when spot is at/below lower barrier', () => {
    const ctx = makeFirstHitCtx()
    ctx.underlying.price = 85_000 // below lower
    const probs = helpers.firstHitProbabilities(ctx, { sigmaOverride: 0.5, seed: 42 })
    // $90k side should win (1.0), $110k side should be 0
    expect(probs[0]).toBe(1)
    expect(probs[1]).toBe(0)
  })

  test('Monte Carlo path is deterministic under a fixed seed', () => {
    const ctx = makeFirstHitCtx()
    const a = helpers.firstHitProbabilities(ctx, { sigmaOverride: 0.5, seed: 12345, simPaths: 800 })
    const b = helpers.firstHitProbabilities(ctx, { sigmaOverride: 0.5, seed: 12345, simPaths: 800 })
    expect(a).toEqual(b)
  })

  test('Monte Carlo output sums to 1 (2-simplex invariant)', () => {
    const ctx = makeFirstHitCtx()
    const probs = helpers.firstHitProbabilities(ctx, {
      sigmaOverride: 0.5,
      seed: 7,
      simPaths: 500,
    })
    expect(probs[0] + probs[1]).toBeCloseTo(1, 8)
  })

  test('supports money labels that are not yes/no', () => {
    const ctx = {
      market: {
        questionType: 'firstHit',
        strike: 60_000,
        strike2: 80_000,
        expiryTs: 86_400_000,
        outcomes: [
          { label: '$60k', price: 0.4, bestAsk: 0.41 },
          { label: '$80k', price: 0.6, bestAsk: 0.61 },
        ],
      },
      underlying: { price: 85_000, realizedVol: { '1h': 0.5 }, realizedVolWarnings: [] },
      timing: { nowTs: 0 },
    }
    // Spot above upper → $80k wins
    expect(helpers.firstHitProbabilities(ctx, { sigmaOverride: 0.5 })).toEqual([0, 1])
  })
})

// ─── E2. Feature and market structure helpers ──────────────────────────────

describe('vol', () => {
  test('returns the requested window', () => {
    const ctx = {
      underlying: { realizedVol: { '1h': 0.3, '24h': 0.5 }, realizedVolWarnings: [] },
    }
    expect(helpers.vol(ctx, '24h')).toBe(0.5)
  })

  test('throws when the requested window is listed as unavailable', () => {
    const ctx = {
      underlying: {
        realizedVol: { '1h': 0.3 },
        realizedVolWarnings: ['realizedVol[1h] fetch failed'],
      },
    }
    expect(() => helpers.vol(ctx, '1h')).toThrow(/unavailable/)
  })
})

describe('volRatio', () => {
  test('compares two windows', () => {
    const ctx = {
      underlying: { realizedVol: { '1h': 0.3, '30d': 0.6 }, realizedVolWarnings: [] },
    }
    expect(helpers.volRatio(ctx, '1h', '30d')).toBeCloseTo(0.5, 8)
  })

  test('throws when the long window has zero vol', () => {
    const ctx = {
      underlying: { realizedVol: { '1h': 0.3, '30d': 0 }, realizedVolWarnings: [] },
    }
    expect(() => helpers.volRatio(ctx, '1h', '30d')).toThrow(/long/i)
  })
})

describe('outcomeAsks / outcomeBids / spreadByOutcome', () => {
  test('reads bestAsk/bestBid and computes spread in outcome order', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: 'Yes', price: 0.5, bestAsk: 0.52, bestBid: 0.48 },
          { label: 'No', price: 0.5, bestAsk: 0.53, bestBid: 0.47 },
        ],
      },
    }
    expect(helpers.outcomeAsks(ctx)).toEqual([0.52, 0.53])
    expect(helpers.outcomeBids(ctx)).toEqual([0.48, 0.47])
    const spreads = helpers.spreadByOutcome(ctx)
    expect(spreads[0]).toBeCloseTo(0.04, 8)
    expect(spreads[1]).toBeCloseTo(0.06, 8)
  })
})

describe('noArbResidual', () => {
  test('computes bid_i - (1 - ask_{!i}) per side', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: 'Yes', price: 0.5, bestAsk: 0.55, bestBid: 0.50 },
          { label: 'No', price: 0.5, bestAsk: 0.50, bestBid: 0.45 },
        ],
      },
    }
    // side 0: 0.50 - (1 - 0.50) = 0.00
    // side 1: 0.45 - (1 - 0.55) = 0.00
    const r = helpers.noArbResidual(ctx)
    expect(r[0]).toBeCloseTo(0, 8)
    expect(r[1]).toBeCloseTo(0, 8)
  })
})

// ─── E3. Execution helpers: strict edgeFromProbs + binaryProbsFromYesProb ──

describe('edgeFromProbs', () => {
  test('computes per-outcome edge when probabilities sum to 1', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: '$60k', price: 0.35, bestBid: 0.34, bestAsk: 0.36 },
          { label: '$80k', price: 0.55, bestBid: 0.54, bestAsk: 0.56 },
        ],
      },
    }
    const edges = helpers.edgeFromProbs([0.2, 0.8], ctx)
    expect(edges[0]).toMatchObject({ index: 0, label: '$60k', fairPrice: 0.2, marketPrice: 0.36 })
    expect(edges[0].edge).toBeCloseTo(-0.16, 8)
    expect(edges[1]).toMatchObject({ index: 1, label: '$80k', fairPrice: 0.8, marketPrice: 0.56 })
    expect(edges[1].edge).toBeCloseTo(0.24, 8)
  })

  test('throws when probabilities do not sum to 1', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: 'Yes', price: 0.5, bestAsk: 0.51 },
          { label: 'No', price: 0.5, bestAsk: 0.51 },
        ],
      },
    }
    expect(() => helpers.edgeFromProbs([1.3 as any, 0.2 as any], ctx)).toThrow(/sum to 1/)
  })

  test('throws when a probability is not finite', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: 'Yes', price: 0.5, bestAsk: 0.51 },
          { label: 'No', price: 0.5, bestAsk: 0.51 },
        ],
      },
    }
    expect(() => helpers.edgeFromProbs([NaN as any, 0.5 as any], ctx)).toThrow(/finite/)
  })
})

describe('binaryProbsFromYesProb', () => {
  test('returns a valid 2-simplex aligned to outcome order', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: 'No', price: 0.1, bestAsk: 0.11 },
          { label: 'Yes', price: 0.9, bestAsk: 0.91 },
        ],
      },
    }
    const probs = helpers.binaryProbsFromYesProb(ctx, 0.8)
    expect(probs[0]).toBeCloseTo(0.2, 8)
    expect(probs[1]).toBeCloseTo(0.8, 8)
    expect(probs[0] + probs[1]).toBeCloseTo(1, 8)
  })
})

// ─── E4. resolveVolAndTime footgun fix ─────────────────────────────────────

describe('resolveVolAndTime via bsAbove', () => {
  test('prefers ctx.market.expiryTs when timing.expiryTs is absent', () => {
    // Only market.expiryTs is set — timing has no expiryTs field.
    const ctx = {
      market: { strike: 100, expiryTs: 86_400_000 },
      underlying: { price: 100, realizedVol: { '1h': 0.3 }, realizedVolWarnings: [] },
      timing: { nowTs: 0 },
    }
    const p = helpers.bsAbove(ctx, { sigmaOverride: 0.3 })
    // Should be close to 0.5 (atm, 1 day) but NOT the "silent 0.5" footgun path.
    expect(p).toBeGreaterThan(0.45)
    expect(p).toBeLessThan(0.5)
  })

  test('falls back to ctx.timing.expiryTs when market.expiryTs is absent', () => {
    const ctx = {
      market: { strike: 100 },
      underlying: { price: 100, realizedVol: { '1h': 0.3 }, realizedVolWarnings: [] },
      timing: { nowTs: 0, expiryTs: 86_400_000 },
    }
    const p = helpers.bsAbove(ctx, { sigmaOverride: 0.3 })
    expect(p).toBeGreaterThan(0.45)
    expect(p).toBeLessThan(0.5)
  })

  test('throws when neither market nor timing has expiryTs', () => {
    const ctx = {
      market: { strike: 100 },
      underlying: { price: 100, realizedVol: { '1h': 0.3 }, realizedVolWarnings: [] },
      timing: { nowTs: 0 },
    }
    expect(() => helpers.bsAbove(ctx, { sigmaOverride: 0.3 })).toThrow(/expiryTs/)
  })
})

// ─── eventPrimaryQuestionType: null on mixed, throw on empty ───────────────

describe('eventPrimaryQuestionType', () => {
  test('returns the single non-unknown type', () => {
    const ctx = {
      markets: [
        { questionType: 'range' },
        { questionType: 'range' },
        { questionType: 'unknown' },
      ],
    }
    expect(helpers.eventPrimaryQuestionType(ctx)).toBe('range')
  })

  test('returns null when multiple non-unknown types are present', () => {
    const ctx = {
      markets: [
        { questionType: 'above' },
        { questionType: 'hit' },
      ],
    }
    expect(helpers.eventPrimaryQuestionType(ctx)).toBeNull()
  })

  test('throws when all markets are unknown', () => {
    const ctx = { markets: [{ questionType: 'unknown' }] }
    expect(() => helpers.eventPrimaryQuestionType(ctx)).toThrow(/no supported questionType/)
  })
})

describe('eventQuestionTypes', () => {
  test('returns distinct types including unknown in first-seen order', () => {
    const ctx = {
      markets: [
        { questionType: 'above' },
        { questionType: 'above' },
        { questionType: 'hit' },
        { questionType: 'unknown' },
      ],
    }
    expect(helpers.eventQuestionTypes(ctx)).toEqual(['above', 'hit', 'unknown'])
  })
})

describe('distanceToBarriers', () => {
  test('returns symmetric barrier metadata', () => {
    const ctx = {
      market: { strike: 60_000, strike2: 80_000 },
      underlying: { price: 70_000 },
    }
    expect(helpers.distanceToBarriers(ctx)).toEqual({
      currentPrice: 70_000,
      lower: 60_000,
      upper: 80_000,
      pctToLower: -1 / 7,
      pctToUpper: 1 / 7,
      logDistToLower: Math.abs(Math.log(60_000 / 70_000)),
      logDistToUpper: Math.abs(Math.log(80_000 / 70_000)),
    })
  })
})

// ─── No-underlying guard (politics markets) ──────────────────────────────────

// ─── Count model helpers ──────────��──────────────────────────────────────────

describe('countModel', () => {
  const hr = 3_600_000

  test('projects total from observed rate', () => {
    // 100 tweets in 50 hours, 50 hours remaining
    const model = helpers.countModel({
      observed: 100,
      windowStart: 0,
      windowEnd: 100 * hr,
      nowTs: 50 * hr,
    })
    expect(model.rate).toBeCloseTo(2, 8) // 100/50
    expect(model.mu).toBeCloseTo(200, 8) // 100 + 2*50
    expect(model.elapsed).toBeCloseTo(50, 8)
    expect(model.remaining).toBeCloseTo(50, 8)
    expect(model.sigma).toBeGreaterThan(0)
  })

  test('sigma includes both Poisson and regime components', () => {
    const model = helpers.countModel({
      observed: 100,
      windowStart: 0,
      windowEnd: 100 * hr,
      nowTs: 50 * hr,
      regimeUncertainty: 0.1,
    })
    const poissonSigma = Math.sqrt(100) // sqrt of projected additional
    const regimeNoise = 200 * 0.1 // mu * 0.1
    const expected = Math.sqrt(poissonSigma ** 2 + regimeNoise ** 2)
    expect(model.sigma).toBeCloseTo(expected, 6)
  })

  test('throws when nowTs is before windowStart', () => {
    expect(() =>
      helpers.countModel({
        observed: 10,
        windowStart: 100 * hr,
        windowEnd: 200 * hr,
        nowTs: 50 * hr,
      }),
    ).toThrow(/windowStart/)
  })
})

describe('countRangeProb', () => {
  const hr = 3_600_000

  test('probabilities across all bins sum to ~1', () => {
    const model = helpers.countModel({
      observed: 109,
      windowStart: 0,
      windowEnd: 168 * hr,
      nowTs: 85.7 * hr,
    })
    // bins: 0-19, 20-39, ..., 560-579, 580+
    let total = 0
    for (let lo = 0; lo < 580; lo += 20) {
      total += helpers.countRangeProb(model, lo, lo + 19)
    }
    total += helpers.countRangeProb(model, 580, null) // open-ended
    expect(total).toBeCloseTo(1, 2)
  })

  test('open-ended (hi=null) captures upper tail', () => {
    const model = helpers.countModel({
      observed: 100,
      windowStart: 0,
      windowEnd: 100 * hr,
      nowTs: 50 * hr,
    })
    // P(X >= 0) should be ~1
    expect(helpers.countRangeProb(model, 0, null)).toBeCloseTo(1, 4)
  })

  test('returns 0 for impossibly high range', () => {
    const model = helpers.countModel({
      observed: 10,
      windowStart: 0,
      windowEnd: 100 * hr,
      nowTs: 90 * hr, // near end, only 10 remaining hours
    })
    // rate ~0.11/hr, mu ~11.1, asking for 10000-20000 range
    expect(helpers.countRangeProb(model, 10000, 20000)).toBeCloseTo(0, 8)
  })
})

describe('no-underlying guard', () => {
  function makePoliticsCtx() {
    return {
      market: {
        questionType: 'unknown',
        strike: null,
        expiryTs: 86_400_000,
        outcomes: [
          { label: 'Yes', price: 0.7, bestAsk: 0.71, bestBid: 0.69 },
          { label: 'No', price: 0.3, bestAsk: 0.31, bestBid: 0.29 },
        ],
      },
      timing: { nowTs: 0 },
    }
  }

  test('bsAbove throws when ctx.underlying is undefined', () => {
    expect(() => helpers.bsAbove(makePoliticsCtx())).toThrow('requires ctx.underlying')
  })

  test('bsRange throws when ctx.underlying is undefined', () => {
    const ctx = makePoliticsCtx()
    ;(ctx.market as any).strike = 90
    ;(ctx.market as any).strike2 = 110
    expect(() => helpers.bsRange(ctx)).toThrow('requires ctx.underlying')
  })

  test('bsOneTouch throws when ctx.underlying is undefined', () => {
    const ctx = makePoliticsCtx()
    ;(ctx.market as any).strike = 100
    expect(() => helpers.bsOneTouch(ctx)).toThrow('requires ctx.underlying')
  })

  test('edgeFromProbs works without underlying', () => {
    const ctx = makePoliticsCtx()
    const result = helpers.edgeFromProbs([0.8, 0.2], ctx)
    expect(result[0].fairPrice).toBe(0.8)
    expect(result[1].fairPrice).toBe(0.2)
  })

  test('outcomeSides works without underlying', () => {
    const ctx = makePoliticsCtx()
    const [s0, s1] = helpers.outcomeSides(ctx)
    expect(s0.label).toBe('Yes')
    expect(s1.label).toBe('No')
  })

  test('binaryProbsFromYesProb works without underlying', () => {
    const ctx = makePoliticsCtx()
    const probs = helpers.binaryProbsFromYesProb(ctx, 0.75)
    expect(probs[0]).toBeCloseTo(0.75)
    expect(probs[1]).toBeCloseTo(0.25)
  })
})
