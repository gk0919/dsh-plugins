import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { apply } from '../src/index.js'
import type { CommandDefinition, ToolGuard, WorkflowHost } from '../src/index.js'
import type { ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { workspace, start, plan } from './fixture.js'

test('command authority, per-agent state, schema validation, revocation and disposal', async () => {
  const fixture = workspace()
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, CommandDefinition>()
  let guard: ToolGuard | undefined
  const ctx: WorkflowHost = {
    tools: {
      register: (tool) => { tools.set(tool.name, tool); return () => { tools.delete(tool.name) } },
      guard: (value) => { guard = value; return () => { guard = undefined } },
    },
    commands: { register: (command) => { commands.set(command.name, command); return () => { commands.delete(command.name) } } },
    effect: (setup) => setup(),
    workingDirectory: { ensure: async () => fixture.root },
  }
  const dispose = apply(ctx)
  const agent = { id: 'parent' }, stranger = { id: 'stranger' }
  const signal = new AbortController().signal
  const command = (rawInput: string, caller = agent) => commands.get('workflow')!.handler({ agent: caller, rawInput, signal })
  const call = async (name: string, args: Record<string, unknown> = {}, caller = agent): Promise<any> =>
    tools.get(name)!.execute(args, { agent: caller, signal } as unknown as ToolRunContext)
  try {
    for (const name of ['shell', 'exec', 'apply_patch', 'plugin_manager', 'mcp', 'subagent', 'run_code', 'unknown']) assert.ok(guard!({ name, agent }))
    assert.ok(guard!({ name: 'workflow_read' }))
    assert.equal(guard!({ name: 'workflow_read', agent }), undefined)
    await assert.rejects(call('workflow_read', { path: 'code.txt' }), /start/)
    assert.equal((await command(start)).kind, 'success')
    await assert.rejects(call('workflow_read', { path: 'code.txt' }, stranger), /start/)
    await assert.rejects(call('workflow_read', { path: 'code.txt', approved: true }), /additional|unexpected|approved/i)
    await assert.rejects(call('workflow_apply', { proposalId: 'fake', changes: [{ path: 'code.txt', beforeHash: null, content: 'bad' }], userApproved: true }))
    assert.equal((await command('task ["--task","different-task"]')).kind, 'error')
    await call('workflow_artifact', { file: 'changes.md', content: '# Changes\n\n## Implementation\nAdd one approved line.\n' })
    await call('workflow_artifact', { file: 'plan.md', content: plan })
    const before = await call('workflow_read', { path: 'code.txt' })
    let proposal = await call('workflow_propose', { summary: 'Add one line', paths: ['code.txt'] })
    assert.equal((await command(`approve ${proposal.id}`)).kind, 'success')
    assert.equal((await command('pause')).kind, 'success')
    await assert.rejects(call('workflow_apply', { proposalId: proposal.id, changes: [{ path: 'code.txt', beforeHash: before.hash, content: 'bad' }] }), /approval/i)
    proposal = await call('workflow_propose', { summary: 'Add one line', paths: ['code.txt'] })
    assert.equal((await command(`approve ${proposal.id}`)).kind, 'success')
    const applied = await call('workflow_apply', { proposalId: proposal.id, changes: [{ path: 'code.txt', beforeHash: before.hash, content: before.content + 'approved\n' }] })
    assert.deepEqual(applied.applied, ['code.txt'])
    assert.equal((await call('workflow_status')).approved, false)
    assert.equal(readFileSync(path.join(fixture.root, 'code.txt'), 'utf8'), 'user content\napproved\n')
    assert.equal((await command('resume plugin-test')).kind, 'success')
    assert.equal((await call('workflow_status')).approved, false)
    const retained = tools.get('workflow_apply')!
    dispose()
    assert.equal(tools.size, 0); assert.equal(commands.size, 0)
    await assert.rejects(retained.execute({ proposalId: 'fake', changes: [] }, { agent, signal } as unknown as ToolRunContext), /disposed/)
  } finally { if (tools.size) dispose(); fixture.cleanup() }
})

test('unsupported host fails before exposing tools', () => {
  assert.throws(() => apply({ tools: {} } as unknown as WorkflowHost), /guard/)
})

test('pending directory resolution cannot replace another command or bind after unload', async () => {
  let handler: CommandDefinition['handler'] = () => ({ kind: 'error', text: 'unregistered' }), release: (root: string) => void = () => {}
  const waiting = new Promise<string>((resolve) => { release = resolve })
  const dispose = apply({
    tools: { guard: () => () => {}, register: () => () => {} },
    commands: { register: (value) => { handler = value.handler; return () => {} } },
    workingDirectory: { ensure: () => waiting }, effect: (setup) => setup(),
  })
  const invocation = { agent: { id: 'pending-agent' }, signal: new AbortController().signal }
  const pending = handler({ ...invocation, rawInput: 'resume example-task' })
  assert.equal((await handler({ ...invocation, rawInput: 'resume other-task' })).kind, 'error')
  dispose(); release('.')
  assert.match((await pending).text, /disposed/)
})
