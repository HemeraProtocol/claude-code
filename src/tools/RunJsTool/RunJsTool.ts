import React from 'react'
import { z } from 'zod/v4'
import { buildTool, type ToolDef } from '../../Tool.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { RUN_JS_TOOL_NAME, DESCRIPTION } from './constants.js'
import { renderRunJsMessage } from './display.js'

// RUNNER_PATH resolution:
// - dev mode (bun run src/...): import.meta.url is the source file URL, runner.ts is co-located
// - dist mode: set RUN_JS_RUNNER_PATH env var to point to the built runner.js
const RUNNER_PATH =
  process.env.RUN_JS_RUNNER_PATH ??
  join(dirname(fileURLToPath(import.meta.url)), 'runner.ts')

const inputSchema = lazySchema(() =>
  z.strictObject({
    code: z.string().describe(
      'JavaScript function body. Receives `ctx` parameter. Must return a value (sync or async).',
    ),
    ctx: z.unknown().describe(
      'Structured context (JSON-serializable). Passed as `ctx` to the function.',
    ),
    ctxPath: z.string().optional().describe(
      'Absolute path to a JSON file containing ctx. Takes priority over inline `ctx`.',
    ),
    helpersModulePath: z.string().optional().describe(
      'Absolute path to a .ts/.js module. Exported `helpers` object is merged into ctx.helpers.',
    ),
    executionLogPath: z.string().optional().describe(
      'Optional path to a JSON file where execution inputs and outputs should be recorded. Must be under CWD.',
    ),
    resultShape: z.enum(['free', 'strategy-array']).optional().describe(
      'Optional runtime validation on the returned result. "strategy-array" enforces an array of {question, decision} with passthrough. Default "free" (any value).',
    ),
    timeoutMs: z.number().int().positive().optional().describe(
      'Execution timeout in ms. Default 5000.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    result: z.unknown(),
    durationMs: z.number(),
    executionLogPath: z.string().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>

type Output = z.infer<OutputSchema>

export const RunJsTool = buildTool({
  name: RUN_JS_TOOL_NAME,
  searchHint: 'execute JavaScript code with structured context',
  maxResultSizeChars: 50_000,

  async description() {
    return DESCRIPTION
  },

  async prompt() {
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
    return false
  },

  renderToolUseMessage(input: Partial<z.infer<InputSchema>>): React.ReactNode {
    return renderRunJsMessage(input)
  },

  async call(input) {
    const payload = JSON.stringify({
      code: input.code,
      ctx: input.ctx ?? {},
      ctxPath: input.ctxPath ?? null,
      helpersModulePath: input.helpersModulePath ?? null,
      executionLogPath: input.executionLogPath ?? null,
      resultShape: input.resultShape ?? 'free',
      timeoutMs: input.timeoutMs ?? 5000,
    })

    const proc = Bun.spawn(['bun', 'run', RUNNER_PATH], {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    })
    proc.stdin.write(payload)
    proc.stdin.end()

    // Hard kill: child timeout + 2s grace to ensure we can kill sync infinite loops
    const hardKill = setTimeout(
      () => {
        try {
          proc.kill()
        } catch {
          // ignore
        }
      },
      (input.timeoutMs ?? 5000) + 2000,
    )

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ])
    clearTimeout(hardKill)

    if (exitCode !== 0) {
      throw new Error(`RunJsTool exited ${exitCode}: ${stderr.trim() || stdout.trim()}`)
    }

    let parsed: Output
    try {
      parsed = JSON.parse(stdout.trim())
    } catch {
      throw new Error(`RunJsTool invalid JSON output: ${stdout.slice(0, 300)}`)
    }
    return { data: parsed }
  },

  mapToolResultToToolResultBlockParam(output, toolUseID) {
    const logLine = output.executionLogPath
      ? `\nexecutionLogPath: ${output.executionLogPath}`
      : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `result: ${JSON.stringify(output.result)}\ndurationMs: ${output.durationMs}${logLine}`,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
