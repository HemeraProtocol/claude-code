#!/usr/bin/env bun
// Reads {code, ctx, helpersModulePath, timeoutMs} JSON from stdin.
// Executes user code via new Function with ctx (helpers merged in).
// Outputs {result, durationMs} JSON to stdout.
// On error, exits non-zero with error message on stderr.

async function main(): Promise<void> {
  const raw = await new Response(Bun.stdin.stream()).text()
  const input: {
    code: string
    ctx: unknown
    ctxPath: string | null
    helpersModulePath: string | null
    timeoutMs: number
  } = JSON.parse(raw)

  const rawCtx = input.ctxPath
    ? JSON.parse(await Bun.file(input.ctxPath).text())
    : input.ctx

  let fullCtx: Record<string, unknown> =
    rawCtx && typeof rawCtx === 'object'
      ? { ...(rawCtx as Record<string, unknown>) }
      : {}

  if (input.helpersModulePath) {
    const mod = await import(input.helpersModulePath)
    const helpers = (mod as Record<string, unknown>).helpers ?? (mod as Record<string, unknown>).default
    if (helpers && typeof helpers === 'object') {
      fullCtx = { ...fullCtx, helpers }
    }
  }

  const start = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function('ctx', input.code) as (c: unknown) => unknown

  const resultPromise = Promise.resolve().then(() => fn(fullCtx))
  const timeoutPromise = new Promise<never>((_, reject) =>
    setTimeout(() => reject(new Error('RunJsTool timeout')), input.timeoutMs),
  )

  const result = await Promise.race([resultPromise, timeoutPromise])
  const durationMs = Date.now() - start

  process.stdout.write(JSON.stringify({ result, durationMs }) + '\n')
  process.exit(0)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`${msg}\n`)
  process.exit(1)
})
