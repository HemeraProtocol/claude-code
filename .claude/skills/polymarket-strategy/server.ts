#!/usr/bin/env bun
/**
 * Minimal SSE server wrapping `claude -p` for polymarket-strategy skill.
 *
 * Usage:
 *   bun run server.ts                      # starts on port 3000
 *   PORT=8080 bun run server.ts            # custom port
 *
 * Test:
 *   curl -N -X POST http://localhost:3000/run \
 *     -H 'Content-Type: application/json' \
 *     -d '{"message":"帮我分析 bitcoin-price-april-18 这个市场，生成策略"}'
 */

const PORT = Number(process.env.PORT ?? 3000)

Bun.serve({
  port: PORT,
  idleTimeout: 255, // max allowed by Bun (seconds)
  async fetch(req) {
    const url = new URL(req.url)

    // Health check
    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' })
    }

    // Main endpoint
    if (url.pathname === '/run' && req.method === 'POST') {
      return handleRun(req)
    }

    return new Response('Not found', { status: 404 })
  },
})

console.log(`polymarket-strategy server listening on http://localhost:${PORT}`)
console.log(`POST /run  — run strategy (SSE stream)`)
console.log(`GET  /health — health check`)

async function handleRun(req: Request): Promise<Response> {
  let body: { message: string }
  try {
    body = await req.json()
  } catch {
    return Response.json({ error: 'invalid JSON' }, { status: 400 })
  }

  if (!body.message?.trim()) {
    return Response.json({ error: 'message is required' }, { status: 400 })
  }

  const prompt = body.message

  // Spawn claude in pipe mode with streaming JSON
  const proc = Bun.spawn(
    [
      'claude',
      '-p',
      '--verbose',
      '--output-format', 'stream-json',
      '--dangerously-skip-permissions',
    ],
    {
      stdin: 'pipe',
      stdout: 'pipe',
      stderr: 'pipe',
    },
  )

  // Write prompt to stdin and close
  proc.stdin.write(prompt)
  proc.stdin.flush()
  proc.stdin.end()

  // Stream stdout as SSE
  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder()

      // Send initial event
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: 'start', message: body.message })}\n\n`))

      try {
        const reader = proc.stdout.getReader()
        const decoder = new TextDecoder()
        let buffer = ''

        while (true) {
          const { done, value } = await reader.read()
          if (done) break

          buffer += decoder.decode(value, { stream: true })

          // Forward complete lines as SSE events
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''

          for (const line of lines) {
            if (!line.trim()) continue
            controller.enqueue(encoder.encode(`data: ${line}\n\n`))
          }
        }

        // Flush remaining buffer
        if (buffer.trim()) {
          controller.enqueue(encoder.encode(`data: ${buffer}\n\n`))
        }

        // Capture stderr
        const stderrText = await new Response(proc.stderr).text()

        // Wait for process to exit
        const exitCode = await proc.exited
        if (exitCode !== 0 && stderrText) {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify({ type: 'error', exitCode, stderr: stderrText })}\n\n`),
          )
        }
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'done', exitCode })}\n\n`),
        )
      } catch (err) {
        controller.enqueue(
          encoder.encode(`data: ${JSON.stringify({ type: 'error', message: String(err) })}\n\n`),
        )
      }

      controller.close()
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*',
    },
  })
}
