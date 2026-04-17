#!/usr/bin/env bun
/**
 * Fetches Polymarket market data + underlying asset klines.
 * Writes ctx JSON to /tmp/polymarket-ctx-<slug>-<pid>-<rand>.json and prints
 * {"ctxPath": "...", "executionLogPath": "..."} to stdout. Downstream callers
 * (run_js) read ctx via ctxPath and persist structured execution logs via
 * executionLogPath.
 *
 * Usage: bun run fetch.ts --slug <slug> --underlying <BTC|ETH|SOL|...>
 */

import { parseArgs } from 'util'
import { randomBytes } from 'node:crypto'
import { resolve } from 'node:path'
import { LiveAdapter } from './adapters/live'

// ─── CLI args ────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    slug: { type: 'string' },
    underlying: { type: 'string' },
    limit: { type: 'string' },
  },
  strict: true,
})

const slug = values.slug

if (!slug) {
  process.stderr.write('Usage: fetch.ts --slug <slug> [--underlying <BTC|ETH|SOL|...>]\n')
  process.exit(1)
}

if (!/^[a-z0-9-]+$/i.test(slug)) {
  process.stderr.write(`Invalid slug: must match /^[a-z0-9-]+$/i\n`)
  process.exit(1)
}

// ─── Fetch via LiveAdapter ───────────────────────────────────────────────────

const adapter = new LiveAdapter()
const ctx = await adapter.buildCtx(slug, {
  underlying: values.underlying ?? 'BTC',
  klineLimit: Number(values.limit ?? '200') || 200,
})

// ─── Write output ────────────────────────────────────────────────────────────

const rand = randomBytes(4).toString('hex')
const tmpPath = `/tmp/polymarket-ctx-${slug}-${process.pid}-${rand}.json`
const executionLogPath = resolve(
  '.claude',
  'polymarket-strategy-runs',
  slug,
  `${Date.now()}-${process.pid}-${rand}.json`,
)
await Bun.write(tmpPath, JSON.stringify(ctx))
process.stdout.write(JSON.stringify({ ctxPath: tmpPath, executionLogPath }) + '\n')
