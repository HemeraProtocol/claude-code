#!/usr/bin/env bun
// Reads {code, ctx, helpersModulePath, timeoutMs, resultShape} JSON from stdin.
// Executes user code via new Function with ctx (helpers merged in).
// Outputs {result, durationMs, executionLogPath?} JSON to stdout.
// On error, exits non-zero with error message on stderr.
//
// Execution log schema version: 2
// - Records ctxHash (not inline ctx), helpersHash, gitCommit for reproducibility
// - Classifies failures via errorKind: timeout | throw | syntax | schema | io
// - executionLogPath must be under CWD (no escapes)

import { mkdir } from 'fs/promises'
import { dirname, resolve } from 'path'
import { z } from 'zod/v4'

import { hashContent } from '../../utils/hash.js'

type ResultShape = 'free' | 'strategy-array'

type RunJsInput = {
  code: string
  ctx: unknown
  ctxPath: string | null
  helpersModulePath: string | null
  executionLogPath: string | null
  resultShape: ResultShape
  timeoutMs: number
}

type ErrorKind = 'timeout' | 'throw' | 'syntax' | 'schema' | 'io'

const StrategyArraySchema = z.array(
  z
    .object({
      question: z.string(),
      decision: z.enum(['hold', 'buy']),
    })
    .passthrough(),
)

// Validate executionLogPath: must resolve to a path under CWD.
// Prevents LLM-generated paths from escaping into /tmp, /etc, $HOME, etc.
function ensureLogPathUnderCwd(executionLogPath: string): string {
  const cwd = resolve(process.cwd())
  const resolvedPath = resolve(executionLogPath)
  if (resolvedPath !== cwd && !resolvedPath.startsWith(cwd + '/')) {
    throw new Error(
      `executionLogPath must be under CWD (${cwd}), got ${resolvedPath}`,
    )
  }
  return resolvedPath
}

// Best-effort git HEAD capture. Never throws — returns null if git is absent
// or the working tree is not a repo. stderr is discarded to keep logs clean.
async function readGitCommit(): Promise<string | null> {
  try {
    const proc = Bun.spawn(['git', 'rev-parse', 'HEAD'], {
      stdout: 'pipe',
      stderr: 'ignore',
    })
    const out = await new Response(proc.stdout).text()
    const code = await proc.exited
    if (code !== 0) return null
    const trimmed = out.trim()
    return trimmed || null
  } catch {
    return null
  }
}

async function hashFileContent(path: string | null): Promise<string | null> {
  if (!path) return null
  try {
    const text = await Bun.file(path).text()
    return hashContent(text)
  } catch {
    return null
  }
}

// State captured during main() that the top-level catch needs for error logs.
type RunState = {
  input: RunJsInput | null
  resolvedLogPath: string | null
  ctxHash: string | null
  helpersHash: string | null
  gitCommit: string | null
  errorKind: ErrorKind
}

const state: RunState = {
  input: null,
  resolvedLogPath: null,
  ctxHash: null,
  helpersHash: null,
  gitCommit: null,
  errorKind: 'throw',
}

async function writeExecutionLog(
  payload: Record<string, unknown>,
): Promise<string | undefined> {
  if (!state.resolvedLogPath) return undefined
  await mkdir(dirname(state.resolvedLogPath), { recursive: true })
  await Bun.write(
    state.resolvedLogPath,
    JSON.stringify({ schemaVersion: 2, ...payload }, null, 2),
  )
  return state.resolvedLogPath
}

async function main(): Promise<void> {
  // --- Parse stdin --------------------------------------------------------
  let input: RunJsInput
  try {
    const raw = await new Response(Bun.stdin.stream()).text()
    input = JSON.parse(raw) as RunJsInput
  } catch (err) {
    state.errorKind = 'io'
    throw err
  }
  state.input = input

  // --- Validate executionLogPath (errorKind: io) --------------------------
  if (input.executionLogPath) {
    try {
      state.resolvedLogPath = ensureLogPathUnderCwd(input.executionLogPath)
    } catch (err) {
      state.errorKind = 'io'
      throw err
    }
  }

  // --- Provenance: git HEAD + helpers hash (best-effort) ------------------
  state.gitCommit = await readGitCommit()
  state.helpersHash = await hashFileContent(input.helpersModulePath)

  // --- Load ctx (errorKind: io on read failure) ---------------------------
  let rawCtx: unknown
  if (input.ctxPath) {
    try {
      const ctxText = await Bun.file(input.ctxPath).text()
      state.ctxHash = hashContent(ctxText)
      rawCtx = JSON.parse(ctxText)
    } catch (err) {
      state.errorKind = 'io'
      throw err
    }
  } else {
    rawCtx = input.ctx
    state.ctxHash = hashContent(JSON.stringify(rawCtx ?? null))
  }

  let fullCtx: Record<string, unknown> =
    rawCtx && typeof rawCtx === 'object'
      ? { ...(rawCtx as Record<string, unknown>) }
      : {}

  // --- Load helpers module (errorKind: io on import failure) --------------
  if (input.helpersModulePath) {
    try {
      const mod = await import(input.helpersModulePath)
      const helpers =
        (mod as Record<string, unknown>).helpers ??
        (mod as Record<string, unknown>).default
      if (helpers && typeof helpers === 'object') {
        fullCtx = { ...fullCtx, helpers }
      }
    } catch (err) {
      state.errorKind = 'io'
      throw err
    }
  }

  // --- Compile user code (errorKind: syntax on Function ctor failure) -----
  let fn: (c: unknown) => unknown
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    fn = new Function('ctx', input.code) as (c: unknown) => unknown
  } catch (err) {
    state.errorKind = 'syntax'
    throw err
  }

  // --- Execute with timeout (errorKind: timeout | throw) ------------------
  const start = Date.now()
  const resultPromise = Promise.resolve().then(() => fn(fullCtx))
  let timeoutTriggered = false
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => {
      timeoutTriggered = true
      reject(new Error('RunJsTool timeout'))
    }, input.timeoutMs),
  )

  let result: unknown
  try {
    result = await Promise.race([resultPromise, timeoutPromise])
  } catch (err) {
    state.errorKind = timeoutTriggered ? 'timeout' : 'throw'
    throw err
  }
  const durationMs = Date.now() - start

  // --- Validate resultShape (errorKind: schema on failure) ----------------
  if (input.resultShape === 'strategy-array') {
    const parsed = StrategyArraySchema.safeParse(result)
    if (!parsed.success) {
      state.errorKind = 'schema'
      const issueSummary = parsed.error.issues
        .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('; ')
      throw new Error(`RunJsTool result failed strategy-array schema: ${issueSummary}`)
    }
    result = parsed.data
  }

  // --- Success log --------------------------------------------------------
  const executionLogPath = await writeExecutionLog({
    timestamp: new Date().toISOString(),
    status: 'success',
    ctxPath: input.ctxPath,
    ctxHash: state.ctxHash,
    helpersModulePath: input.helpersModulePath,
    helpersHash: state.helpersHash,
    gitCommit: state.gitCommit,
    code: input.code,
    durationMs,
    result,
  })

  process.stdout.write(
    JSON.stringify({ result, durationMs, executionLogPath }) + '\n',
  )
  process.exit(0)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  void writeExecutionLog({
    timestamp: new Date().toISOString(),
    status: 'error',
    errorKind: state.errorKind,
    ctxPath: state.input?.ctxPath ?? null,
    ctxHash: state.ctxHash,
    helpersModulePath: state.input?.helpersModulePath ?? null,
    helpersHash: state.helpersHash,
    gitCommit: state.gitCommit,
    code: state.input?.code ?? null,
    error: {
      message: msg,
      name: err instanceof Error ? err.name : 'Error',
    },
  })
    .catch(() => undefined)
    .finally(() => {
      process.stderr.write(`${msg}\n`)
      process.exit(1)
    })
})
