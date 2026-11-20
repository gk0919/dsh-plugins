import assert from 'node:assert/strict'
import { test } from 'node:test'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import { apply } from '../dist/src/index.js'

test('workflow command attaches a resident Core session and pause keeps it resumable', async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'dsh-lifecycle-'))
  try {
    mkdirSync(path.join(root, '.agent-workflow', 'tasks'), { recursive: true })
    writeFileSync(path.join(root, '.agent-workflow', 'config.json'), JSON.stringify({ schemaVersion: 1, activeProfile: 'workflow:resources/profiles/default/profile.json', plugins: [], paths: { tasksRoot: '.agent-workflow/tasks', runtimeRoot: '.agent-workflow/runtime', skillsRoot: '.agents/skills', knowledgeRoot: '.agent-workflow/knowledge' } }))
    writeFileSync(path.join(root, '.gitignore'), '.agent-workflow/\n')
    writeFileSync(path.join(root, 'AGENTS.md'), '# Fixture\n')
    writeFileSync(path.join(root, 'request.md'), '# Maintenance\nInspect this fixture.\n')
    const git = (...args) => execFileSync('git', args, { cwd: root, windowsHide: true, stdio: 'pipe' })
    git('init', '--quiet'); git('add', '.'); git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'fixture')
    let command
    const tools = new Map()
    const session = Session.create(SessionId('lifecycle-fixture'))
    const agent = { id: session.id, session, steer() {}, ctx: { tools: { restrict: () => () => {} } } }
    const host = {
      tools: {
        guard: () => () => {}, register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
        definitions: () => [{ name: 'read' }, { name: 'write' }, { name: 'edit' }, { name: 'workflow_stage' }, { name: 'workflow_submit' }, { name: 'workflow_apply' }],
      },
      commands: { register(definition) { command = definition; return () => {} } },
      workingDirectory: { ensure: async () => root },
      on: () => () => {}, effect: setup => setup(),
    }
    const dispose = apply(host)
    try {
      assert.equal((await command.handler({ agent, rawInput: `run-maintenance ${path.join(root, 'request.md')}`, signal: new AbortController().signal })).kind, 'success')
      const signal = new AbortController().signal
      const brief = await tools.get('workflow_stage').execute({}, { agent, signal })
      assert.match(brief, /items 必须为 \[\]/)
      assert.match(brief, /source.md 是 Core 捕获的只读来源/)
      const noProposal = await command.handler({ agent, rawInput: 'approve', signal })
      assert.equal(noProposal.kind, 'error')
      assert.match(noProposal.text, /批准命令无法推进任务/)
      assert.match(noProposal.text, /changes-required 返回 Plan/)
      const token = /stateToken: (\w+)/.exec(brief)[1]
      const statusBefore = JSON.parse((await command.handler({ agent, rawInput: 'status --json', signal })).text)
      await assert.rejects(tools.get('workflow_submit').execute({ stateToken: token, files: [], evidence: 'intake.md', items: [{ id: 'T99', evidence: 'intake.md' }], verdict: 'ready', reason: '' }, { agent, signal }), /items 必须精确为 \[\]/)
      const statusAfter = JSON.parse((await command.handler({ agent, rawInput: 'status --json', signal })).text)
      assert.equal(statusAfter.task.revision, statusBefore.task.revision)
      assert.equal(statusAfter.automation.progress.failures, 0, 'Preflight errors do not consume Core stage correction budget')
      const paused = await command.handler({ agent, rawInput: 'pause', signal: new AbortController().signal })
      assert.equal(paused.kind, 'success')
      assert.match(paused.text, /human|暂停|paused/i)
      assert.match(paused.text, /\/workflow continue/)
      assert.match(paused.text, /reconcile 不解除暂停/)
      const status = await command.handler({ agent, rawInput: 'status --json', signal: new AbortController().signal })
      assert.equal(status.kind, 'success')
      assert.match(status.text, /paused|暂停/)
    } finally { await dispose() }
  } finally { rmSync(root, { recursive: true, force: true }) }
})
