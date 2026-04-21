#!/usr/bin/env bun
/**
 * Fetches Polymarket market data + underlying asset klines.
 * Writes ctx snapshot to .claude/polymarket-strategy-runs/<$USER>/<slug>/<ts>.ctx.json
 * and prints {"ctxPath", "executionLogPath"} to stdout. run_js writes the execution
 * log (code + result) to executionLogPath alongside the ctx snapshot.
 *
 * Usage: bun run fetch.ts --slug <slug> --underlying <BTC|ETH|SOL|...>
 */

import { parseArgs } from 'util'
import { resolve } from 'node:path'
import { mkdirSync } from 'node:fs'
import { LiveAdapter } from './adapters/live'

// ─── CLI args ────────────────────────────────────────────────────────────────

const { values } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    slug: { type: 'string' },
    underlying: { type: 'string' },
    limit: { type: 'string' },
    'news-accounts': { type: 'string' },
    'news-since': { type: 'string' },
    'news-until': { type: 'string' },
  },
  strict: true,
})

const slug = values.slug

if (!slug) {
  process.stderr.write(
    'Usage: fetch.ts --slug <slug> [--underlying <BTC|ETH|SOL|...>]\n',
  )
  process.exit(1)
}

if (!/^[a-z0-9-]+$/i.test(slug)) {
  process.stderr.write(`Invalid slug: must match /^[a-z0-9-]+$/i\n`)
  process.exit(1)
}

// ─── Validate parameters ─────────────────────────────────────────────────────

const newsAccountsRaw = values['news-accounts']
const newsAccounts = newsAccountsRaw
  ?.split(',')
  .map(s => s.trim().replace(/^@/, ''))
  .filter(Boolean)

if (newsAccountsRaw != null && (!newsAccounts || !newsAccounts.length)) {
  process.stderr.write(
    `Invalid --news-accounts: no valid handles after normalization\n`,
  )
  process.exit(1)
}

const newsSince = values['news-since']
const newsUntil = values['news-until']

if (newsSince && isNaN(Date.parse(newsSince))) {
  process.stderr.write(`Invalid --news-since date: "${newsSince}"\n`)
  process.exit(1)
}
if (newsUntil && isNaN(Date.parse(newsUntil))) {
  process.stderr.write(`Invalid --news-until date: "${newsUntil}"\n`)
  process.exit(1)
}
if (newsSince && newsUntil && Date.parse(newsSince) > Date.parse(newsUntil)) {
  process.stderr.write(
    `--news-since (${newsSince}) is after --news-until (${newsUntil})\n`,
  )
  process.exit(1)
}

const limitRaw = values.limit
const klineLimit = limitRaw != null ? Number(limitRaw) : 200
if (
  !Number.isFinite(klineLimit) ||
  klineLimit < 1 ||
  klineLimit !== Math.floor(klineLimit)
) {
  process.stderr.write(
    `Invalid --limit: "${limitRaw}" (must be a positive integer)\n`,
  )
  process.exit(1)
}

// ─── Fetch via LiveAdapter ───────────────────────────────────────────────────

const adapter = new LiveAdapter()
const ctx = await adapter.buildCtx(slug, {
  underlying: values.underlying || undefined,
  klineLimit,
  newsAccounts,
  newsSince,
  newsUntil,
})

// ─── Write output ────────────────────────────────────────────────────────────

const user = process.env.USER || 'unknown'
const ts = Date.now()
const runDir = resolve('.claude', 'polymarket-strategy-runs', user, slug)
mkdirSync(runDir, { recursive: true })

const ctxPath = resolve(runDir, `${ts}.ctx.json`)
const executionLogPath = resolve(runDir, `${ts}.json`)

await Bun.write(ctxPath, JSON.stringify(ctx, null, 2))
process.stdout.write(JSON.stringify({ ctxPath, executionLogPath }) + '\n')
