import { describe, expect, test, mock, beforeEach, afterEach } from 'bun:test'
import type { Ctx } from '../types'

// ─── Mock data ──────────────────────────────────────────────────────────────

const GAMMA_EVENT = {
  slug: 'test-event',
  title: 'Test Event',
  markets: [
    {
      id: 'm1',
      question: 'Will the price of Bitcoin be above $80,000 on April 15?',
      slug: 'btc-above-80k',
      endDate: '2026-04-15T00:00:00Z',
      outcomes: '["Yes","No"]',
      outcomePrices: '["0.62","0.38"]',
      volume: '500000',
      liquidity: '100000',
      active: true,
      closed: false,
      conditionId: 'cond1',
      clobTokenIds: '["tok1","tok2"]',
    },
  ],
}

const CLOB_BOOK = {
  bids: [{ price: '0.60', size: '100' }],
  asks: [{ price: '0.64', size: '100' }],
}

const BINANCE_KLINE = [
  [
    1713100800000,
    '84000',
    '84500',
    '83500',
    '84200',
    '1000',
    0,
    '0',
    0,
    '0',
    '0',
    '0',
  ],
  [
    1713104400000,
    '84200',
    '84800',
    '84000',
    '84600',
    '1200',
    0,
    '0',
    0,
    '0',
    '0',
    '0',
  ],
  [
    1713108000000,
    '84600',
    '85000',
    '84200',
    '84900',
    '1100',
    0,
    '0',
    0,
    '0',
    '0',
    '0',
  ],
]

// ─── Helpers ────────────────────────────────────────────────────────────────

function mockFetchResponses() {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mock(async (input: string | URL | Request) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url
    if (url.includes('gamma-api.polymarket.com')) {
      return new Response(JSON.stringify([GAMMA_EVENT]), { status: 200 })
    }
    if (url.includes('clob.polymarket.com')) {
      return new Response(JSON.stringify(CLOB_BOOK), { status: 200 })
    }
    if (url.includes('api.binance.com')) {
      return new Response(JSON.stringify(BINANCE_KLINE), { status: 200 })
    }
    return new Response('Not found', { status: 404 })
  }) as unknown as typeof fetch
  return originalFetch
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('LiveAdapter', () => {
  let originalFetch: typeof fetch

  beforeEach(() => {
    originalFetch = mockFetchResponses()
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  test('buildCtx returns correct Ctx shape', async () => {
    // Dynamic import after mock is installed
    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx: Ctx = await adapter.buildCtx('test-event', {
      underlying: 'BTC',
      klineLimit: 3,
    })

    // event
    expect(ctx.event).toEqual({ slug: 'test-event', title: 'Test Event' })

    // markets
    expect(ctx.markets).toHaveLength(1)
    const m = ctx.markets[0]!
    expect(m.slug).toBe('btc-above-80k')
    expect(m.questionType).toBe('above')
    expect(m.strike).toBe(80_000)
    expect(m.kind).toBe('absolute')
    expect(m.outcomes).toHaveLength(2)
    expect(m.outcomes[0]!.label).toBe('Yes')
    expect(typeof m.outcomes[0]!.price).toBe('number')
    expect(typeof m.outcomes[0]!.bestBid).toBe('number')
    expect(typeof m.outcomes[0]!.bestAsk).toBe('number')
    expect(typeof m.volume).toBe('number')
    expect(typeof m.liquidity).toBe('number')
    expect(typeof m.active).toBe('boolean')
    expect(typeof m.expiryTs).toBe('number')
    expect(typeof m.hoursToExpiry).toBe('number')

    // underlying
    expect(ctx.underlying.symbol).toBe('BTC')
    expect(typeof ctx.underlying.price).toBe('number')
    expect(ctx.underlying.price).toBeGreaterThan(0)
    expect(ctx.underlying.klines).toHaveLength(3)
    expect(ctx.underlying.klines[0]).toHaveProperty('timestamp')
    expect(ctx.underlying.klines[0]).toHaveProperty('open')
    expect(ctx.underlying.klines[0]).toHaveProperty('close')
    expect(typeof ctx.underlying.realizedVol).toBe('object')
    expect(Array.isArray(ctx.underlying.realizedVolWarnings)).toBe(true)

    // timing
    expect(typeof ctx.timing.nowTs).toBe('number')
    expect(ctx.timing.nowTs).toBeGreaterThan(0)
  })

  test('buildCtx uses default opts when none provided', async () => {
    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx = await adapter.buildCtx('test-event')

    expect(ctx.underlying).toBeUndefined()
    expect(ctx.news).toBeUndefined()
    expect(ctx.event.slug).toBe('test-event')
  })

  test('buildCtx populates underlying when underlying opt is passed', async () => {
    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx = await adapter.buildCtx('test-event', { underlying: 'BTC' })

    expect(ctx.underlying).toBeDefined()
    expect(ctx.underlying!.symbol).toBe('BTC')
  })

  test('throws on Gamma 404', async () => {
    // Override fetch to return 404 for Gamma
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('gamma-api.polymarket.com')) {
        return new Response('Not found', { status: 404 })
      }
      if (url.includes('api.binance.com')) {
        return new Response(JSON.stringify(BINANCE_KLINE), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    expect(adapter.buildCtx('nonexistent-slug')).rejects.toThrow(
      'Gamma API error: 404',
    )
  })

  test('fetchXtrackerPosts sorts by createdAt descending across accounts', async () => {
    // Override fetch to return posts from two accounts with interleaved timestamps
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('gamma-api.polymarket.com')) {
        return new Response(JSON.stringify([GAMMA_EVENT]), { status: 200 })
      }
      if (url.includes('clob.polymarket.com')) {
        return new Response(JSON.stringify(CLOB_BOOK), { status: 200 })
      }
      if (url.includes('xtracker.polymarket.com') && url.includes('alice')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              { content: 'alice-old', createdAt: '2026-04-10T01:00:00Z' },
              { content: 'alice-oldest', createdAt: '2026-04-09T01:00:00Z' },
            ],
          }),
          { status: 200 },
        )
      }
      if (url.includes('xtracker.polymarket.com') && url.includes('bob')) {
        return new Response(
          JSON.stringify({
            success: true,
            data: [
              { content: 'bob-newest', createdAt: '2026-04-11T01:00:00Z' },
              { content: 'bob-mid', createdAt: '2026-04-10T12:00:00Z' },
            ],
          }),
          { status: 200 },
        )
      }
      return new Response('Not found', { status: 404 })
    }) as unknown as typeof fetch

    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx = await adapter.buildCtx('test-event', {
      newsAccounts: ['alice', 'bob'],
    })

    expect(ctx.news).toBeDefined()
    expect(ctx.news!.totalCount).toBe(4)
    // Should be sorted newest-first regardless of account order
    expect(ctx.news!.tweets[0]!.text).toBe('bob-newest')
    expect(ctx.news!.tweets[1]!.text).toBe('bob-mid')
    expect(ctx.news!.tweets[2]!.text).toBe('alice-old')
    expect(ctx.news!.tweets[3]!.text).toBe('alice-oldest')
  })

  test('warnings are populated when CLOB returns empty book', async () => {
    // Override fetch: CLOB returns empty book
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('gamma-api.polymarket.com')) {
        return new Response(JSON.stringify([GAMMA_EVENT]), { status: 200 })
      }
      if (url.includes('clob.polymarket.com')) {
        return new Response(JSON.stringify({ bids: [], asks: [] }), {
          status: 200,
        })
      }
      if (url.includes('api.binance.com')) {
        return new Response(JSON.stringify(BINANCE_KLINE), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as unknown as typeof fetch

    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx = await adapter.buildCtx('test-event')

    expect(ctx.warnings).toBeDefined()
    expect(ctx.warnings!.some(w => w.includes('empty book'))).toBe(true)
  })

  test('warnings distinguish CLOB fetch failure from empty book', async () => {
    // CLOB returns 500 (fetch failure)
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('gamma-api.polymarket.com')) {
        return new Response(JSON.stringify([GAMMA_EVENT]), { status: 200 })
      }
      if (url.includes('clob.polymarket.com')) {
        return new Response('Internal Server Error', { status: 500 })
      }
      if (url.includes('api.binance.com')) {
        return new Response(JSON.stringify(BINANCE_KLINE), { status: 200 })
      }
      return new Response('Not found', { status: 404 })
    }) as unknown as typeof fetch

    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    const ctx = await adapter.buildCtx('test-event')

    expect(ctx.warnings).toBeDefined()
    expect(ctx.warnings!.some(w => w.includes('fetch failed (HTTP 500)'))).toBe(
      true,
    )
    // Should NOT say "empty book" for HTTP failures
    expect(ctx.warnings!.some(w => w.includes('empty book'))).toBe(false)
  })

  test('throws on Gamma empty result', async () => {
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url =
        typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.toString()
            : input.url
      if (url.includes('gamma-api.polymarket.com')) {
        return new Response(JSON.stringify([]), { status: 200 })
      }
      if (url.includes('api.binance.com')) {
        return new Response(JSON.stringify(BINANCE_KLINE), { status: 200 })
      }
      return new Response('{}', { status: 200 })
    }) as unknown as typeof fetch

    const { LiveAdapter } = await import('../adapters/live')
    const adapter = new LiveAdapter()
    expect(adapter.buildCtx('nonexistent-slug')).rejects.toThrow(
      'No event found for slug',
    )
  })
})
