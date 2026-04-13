export const RUN_JS_TOOL_NAME = 'run_js'

export const DESCRIPTION = `Execute a JavaScript function body with structured context.
- Takes a JS function body that receives \`ctx\` and returns a value (sync or async)
- Optionally loads helpers from a .ts/.js module into \`ctx.helpers\`
- Runs in a child process (Bun) with timeout protection
- Returns \`{ result, durationMs }\``
