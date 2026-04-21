import { afterEach, describe, expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { RunJsTool } from './RunJsTool.js'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })),
  )
})

// Runner requires executionLogPath to be under CWD. mkdtemp under os.tmpdir
// would escape CWD, so we place temp dirs inside the project directory.
async function makeTempDir(): Promise<string> {
  const base = join(process.cwd(), '.tmp-runjs-tests')
  await mkdir(base, { recursive: true })
  tempDirs.push(base)
  const dir = await mkdtemp(join(base, 'run-'))
  return dir
}

describe('RunJsTool — display', () => {
  test('renders code preview in tool message', () => {
    const message = RunJsTool.renderToolUseMessage({
      code: 'return ctx.value + 1',
      helpersModulePath: '/tmp/helpers.ts',
      executionLogPath: '/tmp/run-log.json',
    })

    expect(message).toBe(
      'RunJS helpers=tmp/helpers.ts log=/tmp/run-log.json\nreturn ctx.value + 1',
    )
  })
})

describe('RunJsTool — execution log provenance (schemaVersion 2)', () => {
  test('success log records schemaVersion 2 + provenance, no inline ctx', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'success.json')

    const output = await RunJsTool.call({
      code: 'return { next: ctx.value + 1 }',
      ctx: { value: 2 },
      executionLogPath,
      timeoutMs: 1000,
    })

    expect(output.data.result).toEqual({ next: 3 })
    expect(output.data.executionLogPath).toBe(executionLogPath)

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.schemaVersion).toBe(2)
    expect(log.status).toBe('success')
    expect(log.code).toBe('return { next: ctx.value + 1 }')
    expect(log.result).toEqual({ next: 3 })
    expect(log.durationMs).toEqual(expect.any(Number))

    // Provenance fields populated
    expect(log.ctxHash).toEqual(expect.any(String))
    expect(log.ctxHash.length).toBeGreaterThan(0)
    expect(log).toHaveProperty('helpersHash')
    expect(log).toHaveProperty('gitCommit')

    // No inline ctx in the log
    expect(log.ctx).toBeUndefined()
  })

  test('success log records helpersHash when helpers module is loaded', async () => {
    const dir = await makeTempDir()
    const helpersPath = join(dir, 'helpers.ts')
    await writeFile(
      helpersPath,
      `export const helpers = { double: (x: number) => x * 2 }`,
    )
    const executionLogPath = join(dir, 'success.json')

    const output = await RunJsTool.call({
      code: 'return ctx.helpers.double(ctx.value)',
      ctx: { value: 5 },
      helpersModulePath: helpersPath,
      executionLogPath,
      timeoutMs: 2000,
    })

    expect(output.data.result).toBe(10)
    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.helpersModulePath).toBe(helpersPath)
    expect(log.helpersHash).toEqual(expect.any(String))
    expect(log.helpersHash.length).toBeGreaterThan(0)
  })

  test('loads ctx from ctxPath instead of inline', async () => {
    const dir = await makeTempDir()
    const ctxPath = join(dir, 'ctx.json')
    await writeFile(ctxPath, JSON.stringify({ value: 42 }))
    const executionLogPath = join(dir, 'success.json')

    const output = await RunJsTool.call({
      code: 'return ctx.value',
      ctx: { value: 0 }, // should be overridden by ctxPath
      ctxPath,
      executionLogPath,
      timeoutMs: 1000,
    })

    expect(output.data.result).toBe(42)
    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.ctxPath).toBe(ctxPath)
    expect(log.ctxHash).toEqual(expect.any(String))
  })
})

describe('RunJsTool — errorKind classification', () => {
  test('throw → errorKind "throw"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'error.json')

    await expect(
      RunJsTool.call({
        code: 'throw new Error("boom")',
        ctx: {},
        executionLogPath,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow('boom')

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.schemaVersion).toBe(2)
    expect(log.status).toBe('error')
    expect(log.errorKind).toBe('throw')
    expect(log.error.message).toBe('boom')
  })

  test('syntax error → errorKind "syntax"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'syntax.json')

    await expect(
      RunJsTool.call({
        code: 'return {', // unclosed object literal — genuine parse error
        ctx: {},
        executionLogPath,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow()

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.status).toBe('error')
    expect(log.errorKind).toBe('syntax')
  })

  test('timeout → errorKind "timeout"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'timeout.json')

    await expect(
      RunJsTool.call({
        code: 'return new Promise(() => {})', // never resolves
        ctx: {},
        executionLogPath,
        timeoutMs: 50,
      }),
    ).rejects.toThrow(/timeout/i)

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.status).toBe('error')
    expect(log.errorKind).toBe('timeout')
  })
})

describe('RunJsTool — executionLogPath CWD constraint', () => {
  test('rejects path outside CWD', async () => {
    const outsidePath = join(tmpdir(), 'evil-log.json')

    await expect(
      RunJsTool.call({
        code: 'return 1',
        ctx: {},
        executionLogPath: outsidePath,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/executionLogPath must be under CWD/)
  })

  test('rejects path escaping via ..', async () => {
    const dir = await makeTempDir()
    const escape = join(dir, '..', '..', '..', '..', '..', 'escape.json')

    await expect(
      RunJsTool.call({
        code: 'return 1',
        ctx: {},
        executionLogPath: escape,
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/executionLogPath must be under CWD/)
  })
})

describe('RunJsTool — resultShape', () => {
  test('strategy-array: valid result passes and passthrough fields survive', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'ok.json')

    const output = await RunJsTool.call({
      code: `return [
        { question: "Q1", decision: "buy", side: "Yes", edge: 0.1 },
        { question: "Q2", decision: "hold", reason: "expired" },
      ]`,
      ctx: {},
      executionLogPath,
      resultShape: 'strategy-array',
      timeoutMs: 1000,
    })

    expect(Array.isArray(output.data.result)).toBe(true)
    const result = output.data.result as Array<Record<string, unknown>>
    expect(result).toHaveLength(2)
    // passthrough: extra fields retained
    expect(result[0]).toMatchObject({ question: 'Q1', decision: 'buy', side: 'Yes', edge: 0.1 })
    expect(result[1]).toMatchObject({ question: 'Q2', decision: 'hold', reason: 'expired' })
  })

  test('strategy-array: non-array top-level → errorKind "schema"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'schema-top.json')

    await expect(
      RunJsTool.call({
        code: 'return { question: "Q", decision: "buy" }',
        ctx: {},
        executionLogPath,
        resultShape: 'strategy-array',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/strategy-array/)

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.status).toBe('error')
    expect(log.errorKind).toBe('schema')
  })

  test('strategy-array: missing question field → errorKind "schema"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'schema-missing.json')

    await expect(
      RunJsTool.call({
        code: 'return [{ decision: "buy" }]',
        ctx: {},
        executionLogPath,
        resultShape: 'strategy-array',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/strategy-array/)

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.errorKind).toBe('schema')
    expect(log.error.message).toMatch(/question/)
  })

  test('strategy-array: invalid decision enum → errorKind "schema"', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'schema-enum.json')

    await expect(
      RunJsTool.call({
        code: 'return [{ question: "Q", decision: "maybe" }]',
        ctx: {},
        executionLogPath,
        resultShape: 'strategy-array',
        timeoutMs: 1000,
      }),
    ).rejects.toThrow(/strategy-array/)

    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.errorKind).toBe('schema')
  })

  test('default (free) accepts any result for backward compatibility', async () => {
    const dir = await makeTempDir()
    const executionLogPath = join(dir, 'free.json')

    const output = await RunJsTool.call({
      code: 'return 42',
      ctx: {},
      executionLogPath,
      timeoutMs: 1000,
    })

    expect(output.data.result).toBe(42)
    const log = JSON.parse(await readFile(executionLogPath, 'utf8'))
    expect(log.status).toBe('success')
  })
})
