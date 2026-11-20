import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { Session, SessionId, isSurfaceEvent } from '@deepseek-ai/dsh-session'
import { apply } from '../dist/src/index.js'
import { progressDefinition } from '../client/progress.js'

test('built client registers with the DSH module loader and renders startup status', () => {
  let plugin, definition, render
  runInNewContext(readFileSync(new URL('../dist/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load({ id, factory }) {
      assert.equal(id, '@local/agent-workflow-control')
      plugin = factory(name => {
        assert.equal(name, 'react')
        return { createElement: (type, props, text) => ({ type, props, text }) }
      })
    } } },
  })
  plugin.apply({
    effect: setup => setup(),
    uiConversation: { events: { register(value) { definition = value; return () => {} } } },
    slots: {
      inject(name, setup) { assert.equal(name, 'conversation.chat.node'); setup() },
      register(options, renderer) { assert.equal(options.key, definition.kind); render = renderer; return () => {} },
    },
  })
  const node = render({ node: { data: { phase: 'source', text: '正在查询需求', elapsedMs: 1200 } } })
  assert.equal(node.props.role, 'status')
  assert.equal(node.text, '正在查询需求 · 1.2 秒')
  assert.equal(render({ node: { data: { phase: 'failed', text: '失败', elapsedMs: 1500 } } }).props.role, 'alert')
})

test('startup is visible before workspace resolution; failures update one log-only node without waking the model', async () => {
  let handler, rejectWorkspace
  const pendingRoot = new Promise((_resolve, reject) => { rejectWorkspace = reject })
  const session = Session.create(SessionId('startup-fixture'))
  let steers = 0
  const agent = { id: session.id, session, steer() { steers++ }, ctx: { tools: { restrict: () => () => {}, register: () => () => {} } } }
  const dispose = apply({
    tools: { guard: () => () => {}, register: () => () => {}, definitions: () => [], executable: () => undefined },
    agents: { list: () => [] }, on: () => () => {}, effect: setup => setup(),
    commands: { register(command) { handler = command.handler; return () => {} } },
    workingDirectory: { ensure: () => pendingRoot },
  })
  try {
    const running = handler({ agent, rawInput: 'run XQ123', signal: new AbortController().signal })
    const initial = session.snapshotEvents()
    assert.equal(initial.length, 1)
    assert.equal(initial[0].data.phase, 'starting')
    rejectWorkspace(new Error('Workspace unavailable'))
    assert.equal((await running).kind, 'error')
    const events = session.snapshotEvents()
    assert.equal(events.at(-1).data.phase, 'failed')
    assert.ok(events.every(event => event.ignorable && !isSurfaceEvent(event)))
    assert.equal(steers, 0)
    const start = { event: events[0], location: { kind: 'unresolved' } }
    const context = { key: 'progress', id: events[0].data.id, start }
    context.state = progressDefinition.start(context, start)
    context.state = progressDefinition.update(context, { event: events.at(-1) })
    const view = progressDefinition.buildViewNode(context)
    assert.equal(view.data.phase, 'failed')
    assert.equal(view.anchorSeq, events[0].seq)
    assert.equal(progressDefinition.match(events[0]).id, progressDefinition.match(events.at(-1)).id)
    assert.equal(view.target, 'chat')
  } finally { dispose() }
})
