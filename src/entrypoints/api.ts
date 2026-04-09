#!/usr/bin/env bun
/**
 * HTTP API server that exposes RunStrategyTool via Claude Code pipe mode.
 *
 * Each request spawns `bun <defines> <features> cli.tsx -p <prompt>` directly,
 * bypassing scripts/dev.ts to eliminate the double-spawn overhead.
 *
 * Supports multi-turn conversations via sessionId + --resume.
 */
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { getMacroDefines } from "../../scripts/defines.ts";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const PROJECT_ROOT = join(__dirname, "../..");
const CLI_PATH = join(PROJECT_ROOT, "src/entrypoints/cli.tsx");

const PORT = Number(process.env.PORT) || 3000;

// Pre-compute define and feature args once at startup (same logic as scripts/dev.ts)
const DEFINE_ARGS = Object.entries(getMacroDefines()).flatMap(([k, v]) => [
  "-d",
  `${k}:${v}`,
]);

const DEFAULT_FEATURES = [
  "BUDDY", "TRANSCRIPT_CLASSIFIER", "BRIDGE_MODE",
  "AGENT_TRIGGERS_REMOTE", "CHICAGO_MCP", "VOICE_MODE",
  "SHOT_STATS", "PROMPT_CACHE_BREAK_DETECTION", "TOKEN_BUDGET",
  "AGENT_TRIGGERS", "ULTRATHINK", "BUILTIN_EXPLORE_PLAN_AGENTS", "LODESTONE",
  "EXTRACT_MEMORIES", "VERIFICATION_AGENT", "KAIROS_BRIEF",
  "AWAY_SUMMARY", "ULTRAPLAN", "DAEMON",
];

const envFeatures = Object.entries(process.env)
  .filter(([k]) => k.startsWith("FEATURE_"))
  .map(([k]) => k.replace("FEATURE_", ""));

const FEATURE_ARGS = [...new Set([...DEFAULT_FEATURES, ...envFeatures])].flatMap(
  (name) => ["--feature", name],
);

// The static prefix of every spawn command — computed once
const SPAWN_PREFIX = ["bun", "run", ...DEFINE_ARGS, ...FEATURE_ARGS, CLI_PATH];

interface RequestBody {
  prompt: string;
  model?: string;
  sessionId?: string;
}

interface StrategyResult {
  sessionId: string | null;
  signal: string | null;
  price: number | null;
  symbol: string | null;
  timeframe: string | null;
  code: string | null;
  reasoning: string | null;
  durationMs: number;
}

/**
 * Parse NDJSON output from `--output-format stream-json`.
 * Extracts session_id, tool_result fields, and assistant reasoning.
 */
function parseStreamJson(stdout: string): StrategyResult {
  const lines = stdout.split("\n").filter((l) => l.trim());
  let sessionId: string | null = null;
  let signal: string | null = null;
  let price: number | null = null;
  let symbol: string | null = null;
  let timeframe: string | null = null;
  let code: string | null = null;
  const reasoningParts: string[] = [];

  for (const line of lines) {
    let event: any;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }

    if (event.session_id && !sessionId) {
      sessionId = event.session_id;
    }

    if (event.type === "tool_use" && event.tool?.name === "RunStrategy") {
      code = event.tool?.input?.code ?? code;
      symbol = event.tool?.input?.symbol ?? symbol;
      timeframe = event.tool?.input?.timeframe ?? timeframe;
    }

    if (event.type === "tool_result") {
      const content =
        typeof event.content === "string"
          ? event.content
          : typeof event.tool_result === "string"
            ? event.tool_result
            : "";
      for (const kv of content.split("\n")) {
        const [key, ...rest] = kv.split(":");
        const val = rest.join(":").trim();
        if (!key || !val) continue;
        const k = key.trim().toLowerCase();
        if (k === "signal") signal = val;
        if (k === "symbol") symbol = symbol ?? val;
        if (k === "timeframe") timeframe = timeframe ?? val;
        if (k === "latest price") price = Number(val) || null;
      }
    }

    if (event.type === "assistant" && event.message?.content) {
      const parts = Array.isArray(event.message.content)
        ? event.message.content
        : [event.message.content];
      for (const p of parts) {
        const text = typeof p === "string" ? p : p?.text;
        if (text) reasoningParts.push(text);
      }
    }

    if (event.type === "result") {
      if (event.session_id) sessionId = event.session_id;
      if (event.text && !reasoningParts.length) {
        reasoningParts.push(event.text);
      }
    }
  }

  return {
    sessionId,
    signal,
    price,
    symbol,
    timeframe,
    code,
    reasoning: reasoningParts.join("\n").trim() || null,
    durationMs: 0,
  };
}

Bun.serve({
  port: PORT,

  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url);

    if (url.pathname === "/health") {
      return Response.json({ status: "ok" });
    }

    if (req.method !== "POST" || url.pathname !== "/strategy") {
      return Response.json(
        { error: `Not found: ${req.method} ${url.pathname}` },
        { status: 404 },
      );
    }

    let body: RequestBody;
    try {
      body = (await req.json()) as RequestBody;
    } catch {
      return Response.json({ error: "Invalid JSON body" }, { status: 400 });
    }

    if (!body.prompt || typeof body.prompt !== "string") {
      return Response.json(
        { error: "Missing required field: prompt" },
        { status: 400 },
      );
    }

    const args = [
      ...SPAWN_PREFIX,
      "-p",
      body.prompt,
      "--allowedTools",
      "RunStrategy,AgentTool,WebSearch,WebFetch",
      "--output-format",
      "stream-json",
      "--verbose",
    ];

    if (body.model) {
      args.push("--model", body.model);
    }
    if (body.sessionId) {
      args.push("--resume", body.sessionId);
    }

    const start = Date.now();

    try {
      const proc = Bun.spawn(args, {
        stdout: "pipe",
        stderr: "pipe",
        cwd: PROJECT_ROOT,
      });

      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0 && !stdout.trim()) {
        console.error(`[api] process exited ${exitCode}: ${stderr}`);
        return Response.json(
          { error: "Strategy execution failed", detail: stderr.slice(0, 500) },
          { status: 500 },
        );
      }

      const result = parseStreamJson(stdout);
      result.durationMs = Date.now() - start;

      return Response.json(result);
    } catch (err: any) {
      console.error("[api] spawn error:", err);
      return Response.json(
        { error: "Internal server error", detail: err.message },
        { status: 500 },
      );
    }
  },
});

console.log(`RunStrategy API listening on http://localhost:${PORT}`);
