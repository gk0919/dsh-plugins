import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime, { assertSupportedJsonSchema, validateJsonSchemaValue } from '@deepseek-ai/dsh-tools'
import type { ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import * as NativeToolExecutor from '@deepseek-ai/dsh-tool-executor-native'
import { apply } from '../src/index.js'
import type { CommandDefinition, WorkflowHost } from '../src/index.js'
import { workspace, start } from './fixture.js'

test('real DSH 0.2.2-rc.3 pipeline registers schemas and enforces monotonic guard', async () => {
  const fixture = workspace()
  const ctx = new Context()
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(NativeToolExecutor)
  let command: CommandDefinition | undefined
  // Command/UI transport is a fixture; tools, Cordis effect ownership and guards are real.
  const host = {
    tools: ctx.tools,
    commands: { register: (value: CommandDefinition) => { command = value; return () => { command = undefined } } },
    workingDirectory: { ensure: async () => fixture.root },
    effect: (setup: () => () => void) => setup(),
  } satisfies WorkflowHost
  let shellRan = false
  const unregisterShell = ctx.tools.register({ name: 'shell', description: 'Forbidden capability fixture', parameters: { type: 'object' },
    output: { schema: { type: 'null' }, render: () => [] }, async execute() { shellRan = true; return null } })
  const dispose = apply(host)
  const agent = { id: 'real-pipeline-agent' }
  const signal = new AbortController().signal
  let n = 0
  const execute = async (name: string, args: Record<string, unknown>): Promise<ToolExecutionResult> => {
    const batch = await ctx.tools.execute({
      calls: [{ type: 'tool-call', id: `call-${++n}` as never, name, arguments: JSON.stringify(args) }],
      signal,
      agent: agent as never,
    })
    return batch.results[0]!.result
  }
  try {
    for (const schema of ctx.tools.schemas()) {
      assertSupportedJsonSchema(schema.parameters)
      if (schema.name === 'workflow_apply') assert.deepEqual(validateJsonSchemaValue(schema.parameters, { proposalId: 'id', changes: [{ path: 'new.txt', beforeHash: null, content: 'new' }] }), [])
    }
    const beforeStart = await execute('workflow_read', { path: 'code.txt' })
    assert.equal(beforeStart.isError, true)
    assert.equal((await command!.handler({ agent, rawInput: start, signal })).kind, 'success')
    const read = await execute('workflow_read', { path: 'code.txt' })
    assert.equal(read.isError, false, JSON.stringify(read))
    assert.equal((read.value as { content: string }).content, 'user content\n')
    const invalid = await execute('workflow_read', { path: 'code.txt', userApproved: true })
    assert.equal(invalid.isError, true)
    // A later allow listener must not reverse the owner's guard decision.
    const removeAllow = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }))
    const denied = await execute('shell', {})
    assert.equal(denied.isError, true)
    assert.match(JSON.stringify(denied), /受控工作流/)
    assert.equal(shellRan, false)
    removeAllow()
  } finally { dispose(); unregisterShell(); fixture.cleanup() }
})
