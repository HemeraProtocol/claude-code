import { describe, expect, test } from 'bun:test'

import { helpers } from './helpers'

describe('fairProbs', () => {
  test('maps yes-probability markets onto outcome order', () => {
    const ctx = {
      market: {
        questionType: 'above',
        strike: 90,
        outcomes: [
          { label: 'No', price: 0.1, bestAsk: 0.11 },
          { label: 'Yes', price: 0.9, bestAsk: 0.91 },
        ],
      },
      underlying: {
        price: 100,
        realizedVol: { '1h': 0.2 },
      },
      timing: {
        nowTs: 0,
        expiryTs: 86_400_000,
      },
    }

    const probs = helpers.fairProbs(ctx, { sigmaOverride: 0.2 })
    expect(probs).toHaveLength(2)
    expect(probs[1]).toBeGreaterThan(probs[0])
    expect(probs[0]! + probs[1]!).toBeCloseTo(1, 8)
  })

  test('supports first-hit outcome labels that are not yes/no', () => {
    const ctx = {
      market: {
        questionType: 'firstHit',
        strike: 60_000,
        strike2: 80_000,
        outcomes: [
          { label: '$60k', price: 0.4, bestAsk: 0.41 },
          { label: '$80k', price: 0.6, bestAsk: 0.61 },
        ],
      },
      underlying: {
        price: 85_000,
        realizedVol: { '1h': 0.5 },
      },
      timing: {
        nowTs: 0,
        expiryTs: 86_400_000,
      },
    }

    expect(helpers.fairProbs(ctx, { sigmaOverride: 0.5 })).toEqual([0, 1])
  })
})

describe('effectiveEdgeBinary', () => {
  test('selects the best binary outcome by edge', () => {
    const ctx = {
      market: {
        outcomes: [
          { label: '$60k', price: 0.35, bestAsk: 0.36 },
          { label: '$80k', price: 0.55, bestAsk: 0.56 },
        ],
      },
    }

    expect(helpers.effectiveEdgeBinary([0.2, 0.8], ctx, { threshold: 0.05 })).toEqual({
      side: '$80k',
      sideIndex: 1,
      sideLabel: '$80k',
      fairPrice: 0.8,
      marketPrice: 0.56,
      edge: 0.24,
      reason: 'model > market (ask-adjusted)',
    })
  })
})
