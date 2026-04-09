import { appendFileSync } from 'fs'
import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import type { KlineData, Signal } from '../../trading/types.js'
import { RUN_STRATEGY_TOOL_NAME, DESCRIPTION } from './prompt.js'

const VALID_SIGNALS: Signal[] = ['buy', 'sell', 'hold']

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z
      .string()
      .describe(
        'JavaScript function BODY that receives `klines` (Array<{open,high,low,close,volume,timestamp}>) and returns "buy", "sell", or "hold".',
      ),
    symbol: z
      .string()
      .describe('Trading pair symbol, e.g. "BTCUSDT", "ETHUSDT".'),
    timeframe: z
      .string()
      .describe('Kline interval, e.g. "1m", "5m", "15m", "1h", "4h", "1d".'),
    limit: z
      .number()
      .optional()
      .describe('Number of klines to fetch (default 100, max 1000).'),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    signal: z.enum(['buy', 'sell', 'hold']),
    symbol: z.string(),
    timeframe: z.string(),
    latestPrice: z.number(),
    klineCount: z.number(),
    durationMs: z.number(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

async function fetchKlines(
  symbol: string,
  interval: string,
  limit: number,
): Promise<KlineData[]> {
  const url = `https://api.binance.com/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(interval)}&limit=${limit}`
  const res = await fetch(url)
  if (!res.ok) {
    throw new Error(`Binance API error: ${res.status} ${res.statusText}`)
  }
  const raw: unknown[][] = await res.json()
  return raw.map(k => ({
    timestamp: Number(k[0]),
    open: Number(k[1]),
    high: Number(k[2]),
    low: Number(k[3]),
    close: Number(k[4]),
    volume: Number(k[5]),
  }))
}

function executeStrategy(code: string, klines: KlineData[]): Signal {
  const fn = new Function('klines', code) as (klines: KlineData[]) => unknown
  const result = fn(klines)
  if (typeof result !== 'string' || !VALID_SIGNALS.includes(result as Signal)) {
    throw new Error(
      `Strategy must return "buy", "sell", or "hold", got: ${JSON.stringify(result)}`,
    )
  }
  return result as Signal
}

export const RunStrategyTool = buildTool({
  name: RUN_STRATEGY_TOOL_NAME,
  searchHint: 'execute trading strategy on market data',
  maxResultSizeChars: 50_000,

  async description() {
    return DESCRIPTION
  },

  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },

  isConcurrencySafe() {
    return true
  },
  isReadOnly() {
    return true
  },

  renderToolUseMessage(
    input: Partial<z.infer<InputSchema>>,
  ): React.ReactNode {
    const parts = [input.symbol, input.timeframe].filter(Boolean).join(' ')
    return parts ? `RunStrategy ${parts}` : 'RunStrategy'
  },

  async prompt() {
    return DESCRIPTION
  },

  async call(input) {
    const LOG = '/tmp/run_strategy.log'
    const log = (msg: string) =>
      appendFileSync(LOG, `[${new Date().toISOString()}] ${msg}\n`)

    const start = Date.now()
    const limit = Math.min(input.limit ?? 100, 1000)

    log(`>>> RunStrategy ${input.symbol} ${input.timeframe} limit=${limit}`)
    log(`code:\n${input.code}`)

    const klines = await fetchKlines(input.symbol, input.timeframe, limit)
    log(`fetched ${klines.length} klines, last close=${klines[klines.length - 1]?.close}`)

    if (klines.length === 0) {
      throw new Error(`No kline data returned for ${input.symbol} ${input.timeframe}`)
    }

    log('executing strategy...')
    log(input.code)

    const signal = executeStrategy(input.code, klines)
    const latestPrice = klines[klines.length - 1]!.close
    const durationMs = Date.now() - start

    log(`signal=${signal} price=${latestPrice} duration=${durationMs}ms\n`)

    const output: Output = {
      signal,
      symbol: input.symbol,
      timeframe: input.timeframe,
      latestPrice,
      klineCount: klines.length,
      durationMs,
    }
    return { data: output }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Signal: ${output.signal}\nSymbol: ${output.symbol}\nTimeframe: ${output.timeframe}\nLatest Price: ${output.latestPrice}\nKlines: ${output.klineCount}\nDuration: ${output.durationMs}ms`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
