import assert from 'node:assert/strict'
import test from 'node:test'
import path from 'node:path'
import { mkdtempSync, rmSync, linkSync, writeFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { precheck } from '../src/index.js'
import { DENIED, decide, inside } from '../src/tool-access.js'

const workspace = path.resolve('/repo')
const staging = realpathSync(mkdtempSync(path.join(tmpdir(), 'workflow-policy-')))
const locked = { workspace, staging, paused: false }
process.on('exit', () => rmSync(staging, { recursive: true, force: true }))

test('a session without a controlled task is untouched', () => {
  assert.equal(decide({ name: 'bash' }, undefined), undefined)
})

test('reads, host plumbing and the stage tools stay available while locked', () => {
  for (const name of ['read', 'grep', 'workflow_stage', 'workflow_submit', 'structured_output']) {
    assert.equal(decide({ name }, locked), undefined, name)
  }
  assert.equal(decide({ name: 'str_replace_editor', arguments: { command: 'view', path: path.join(workspace, 'src/a.ts') } }, locked), undefined)
})

test('stage documents are writable in the staging directory before approval', () => {
  assert.equal(decide({ name: 'write', arguments: { file_path: path.join(staging, 'intake.md') } }, locked), undefined)
})

test('repository writes and commands are denied before approval', () => {
  assert.equal(decide({ name: 'edit', arguments: { file_path: path.join(workspace, 'src/a.ts') } }, locked), DENIED)
  assert.equal(decide({ name: 'bash', arguments: { command: 'git status' } }, locked), DENIED)
})

test('approval never opens native repository writes or arbitrary commands', () => {
  for (const name of ['write', 'edit', 'bash', 'pwsh', 'unknown-tool']) {
    assert.equal(decide({ name, arguments: { file_path: 'src/a.ts', command: 'write anywhere' } }, locked), DENIED)
  }
  assert.equal(decide({ name: 'unknown-tool', arguments: { path: path.join(staging, 'intake.md') } }, locked), DENIED)
})

test('paused staging and hardlinks cannot bypass Core', () => {
  assert.equal(decide({ name: 'write', arguments: { file_path: path.join(staging, 'intake.md') } }, { ...locked, paused: true }), DENIED)
  const original = path.join(staging, 'original.txt')
  writeFileSync(original, 'protected')
  linkSync(original, path.join(staging, 'review.md'))
  assert.match(String(decide({ name: 'edit', arguments: { file_path: path.join(staging, 'review.md') } }, locked)), /链接/)
})

test('inside() rejects sibling prefixes', () => {
  assert.ok(inside(path.resolve('/tmp/x'), path.resolve('/tmp/x/a')))
  assert.ok(!inside(path.resolve('/tmp/x'), path.resolve('/tmp/xy/a')))
})

const spec = (extra: string): string => `---\ntask_id: task-1\nentry_mode: pool\nsource_type: jackyun-mcp\nspec_level: M\nstatus: confirmed\ncreated_at: 2026-11-19T09:00:00Z\n${extra}---\n# Spec\n`

test('spec.md without frontmatter is rejected before it can poison the task', () => {
  assert.throws(() => precheck(new Map([['spec.md', '# Spec\n']]), 'task-1'), /frontmatter/)
  assert.throws(() => precheck(new Map([['spec.md', spec('')]]), 'task-2'), /task_id 必须是 task-2/)
})

test('contract_version and verification.json must be declared together and agree', () => {
  const files = (version: string, schemaVersion: string): Map<string, string> =>
    new Map([['spec.md', spec(`contract_version: ${version}\n`)], ['verification.json', JSON.stringify({ schemaVersion })]])
  assert.doesNotThrow(() => precheck(files('2', '2'), 'task-1'))
  assert.throws(() => precheck(new Map([['spec.md', spec('contract_version: 2\n')]]), 'task-1'), /verification\.json/)
  assert.throws(() => precheck(new Map([['spec.md', spec('')], ['verification.json', '{"schemaVersion":2}']]), 'task-1'), /contract_version/)
  assert.throws(() => precheck(files('2', '1'), 'task-1'), /schemaVersion 必须是 2/)
})
