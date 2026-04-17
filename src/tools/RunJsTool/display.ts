export interface RunJsDisplayInput {
  code?: string
  helpersModulePath?: string | null
  executionLogPath?: string | null
}

export function getHelpersShort(
  helpersModulePath?: string | null,
): string {
  return helpersModulePath?.split('/').slice(-2).join('/') ?? '(none)'
}

export function getHelpersFull(
  helpersModulePath?: string | null,
): string {
  return helpersModulePath ?? '(none)'
}

export function getRunJsCode(
  input: RunJsDisplayInput,
): string {
  return input.code?.trim() || '(empty code)'
}

export function renderRunJsHeader(
  input: RunJsDisplayInput,
): string {
  const helpers = getHelpersShort(input.helpersModulePath)
  const logPath = input.executionLogPath
    ? ` log=${input.executionLogPath}`
    : ''
  return `RunJS helpers=${helpers}${logPath}`
}

export function renderRunJsMessage(
  input: RunJsDisplayInput,
): string {
  return `${renderRunJsHeader(input)}\n${getRunJsCode(input)}`
}
