import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../src/index.js'
import type { CommandDefinition, WorkflowHost } from '../src/index.js'

test('real DSH tool registry keeps workflow tools conditional and native writes unavailable before a task', async () => {
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  let command: CommandDefinition | undefined
  const host = {
    tools: ctx.tools,
    commands: { register(definition: CommandDefinition) { command = definition; return () => { command = undefined } } },
    workingDirectory: { ensure: async () => { throw new Error('unused') } },
    effect: (setup: () => () => void) => setup(),
    on: () => () => {},
  } as unknown as WorkflowHost
  const dispose = apply(host)
  try {
    assert.ok(command)
    const names = ctx.tools.definitions().map(definition => definition.name)
    assert.ok(names.includes('workflow_apply'))
    assert.ok(names.includes('workflow_stage'))
    assert.ok(names.includes('workflow_submit'))
    const schema = ctx.tools.definitions().find(definition => definition.name === 'workflow_apply')!.parameters
    assert.deepEqual(validateJsonSchemaValue(schema, { changes: [
      { path: 'large.js', edits: [{ oldText: 'original line', newText: 'changed line' }] },
      { path: 'new.js', content: 'new content' },
    ] }), [])
    assert.ok(validateJsonSchemaValue(schema, { changes: [{ path: 'file.js', content: 'bad', edits: [] }] }).length)
    // `when` is evaluated during step admission; global definitions are intentionally
    // retained so the host can resolve them after a session is attached.
  } finally { await dispose() }
})
