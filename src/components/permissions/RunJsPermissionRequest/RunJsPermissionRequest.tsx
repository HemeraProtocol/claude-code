import React, { useMemo } from 'react'
import { Box, Text } from '@anthropic/ink'
import {
  type OptionWithDescription,
  Select,
} from '../../CustomSelect/select.js'
import { type UnaryEvent, usePermissionRequestLogging } from '../hooks.js'
import { PermissionDialog } from '../PermissionDialog.js'
import type { PermissionRequestProps } from '../PermissionRequest.js'
import { PermissionRuleExplanation } from '../PermissionRuleExplanation.js'
import { logUnaryPermissionEvent } from '../utils.js'
import { getHelpersFull, getRunJsCode } from '../../../tools/RunJsTool/display.js'

export function RunJsPermissionRequest({
  toolUseConfirm,
  onDone,
  onReject,
  workerBadge,
}: PermissionRequestProps): React.ReactNode {
  const input = toolUseConfirm.input as {
    code?: string
    ctx?: unknown
    ctxPath?: string
    helpersModulePath?: string
    executionLogPath?: string
    timeoutMs?: number
  }

  const ctxKeys =
    input.ctx && typeof input.ctx === 'object'
      ? Object.keys(input.ctx as object).length
      : 0
  const helpersFull = getHelpersFull(input.helpersModulePath)
  const codeDisplay = getRunJsCode(input)

  const unaryEvent = useMemo<UnaryEvent>(
    () => ({ completion_type: 'tool_use_single', language_name: 'none' }),
    [],
  )

  usePermissionRequestLogging(toolUseConfirm, unaryEvent)

  const options = useMemo((): OptionWithDescription<string>[] => {
    return [
      { label: 'Yes', value: 'yes' },
      {
        label: (
          <Text>
            No, and tell Claude what to do differently <Text bold>(esc)</Text>
          </Text>
        ),
        value: 'no',
      },
    ]
  }, [])

  function onChange(value: string) {
    switch (value) {
      case 'yes':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'accept')
        toolUseConfirm.onAllow(toolUseConfirm.input, [])
        onDone()
        break
      case 'no':
        logUnaryPermissionEvent('tool_use_single', toolUseConfirm, 'reject')
        toolUseConfirm.onReject()
        onReject()
        onDone()
        break
    }
  }

  return (
    <PermissionDialog title="Run JS code" workerBadge={workerBadge}>
      <Box flexDirection="column" paddingX={2} paddingY={1}>
        <Text>
          ctx=<Text bold>{ctxKeys} keys</Text>
        </Text>
        <Text>
          helpers=<Text bold>{helpersFull}</Text>
        </Text>
        <Text dimColor>{toolUseConfirm.description}</Text>
        {input.executionLogPath ? (
          <Text dimColor>log={input.executionLogPath}</Text>
        ) : null}
        <Text dimColor>
          This code runs in a child process with filesystem and network access.
        </Text>
        <Box marginTop={1}>
          <Text>{codeDisplay}</Text>
        </Box>
      </Box>

      <Box flexDirection="column">
        <PermissionRuleExplanation
          permissionResult={toolUseConfirm.permissionResult}
          toolType="tool"
        />
        <Text>Do you want to allow Claude to execute this JS code?</Text>
        <Select
          options={options}
          onChange={onChange}
          onCancel={() => onChange('no')}
        />
      </Box>
    </PermissionDialog>
  )
}
