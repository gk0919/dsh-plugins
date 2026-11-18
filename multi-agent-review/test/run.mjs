/**
 * Runnable self-check for the bundle. It exercises the compiled `dist/` output
 * against a real temporary git repository and a *simulated* DSH platform seam:
 * `ctx.subprocess`, `ctx.workingDirectory`, and `ctx.subagents` are fakes, so
 * this proves scope/dispatch/report behaviour only — never that DSH's real
 * subagent runtime works. Run with: node test/run.mjs
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { collectScope, normalizeInput } from '../dist/scope.js'
import { dispatchReviewers } from '../dist/dispatch.js'
import { buildReport, parseReviewerOutput } from '../dist/report.js'
import { apply } from '../dist/index.js'
import { parseReviewArgs } from '../dist/command.js'

const checks = []
function check(name, body) {
  checks.push({ name, body })
}

const CFG = {
  toolName: 'code_review',
  provider: 'spawn',
  maxConcurrent: 3,
  timeoutMs: 60_000,
  commandTimeoutMs: 20_000,
  maxDiffBytes: 150_000,
}

/** Simulated `ctx.subprocess` seam backed by a synchronous local spawn. */
function fakeSubprocess() {
  return {
    spawn(spec) {
      const result = spawnSync(spec.argv[0], spec.argv.slice(1), {
        cwd: spec.cwd,
        encoding: 'utf8',
        maxBuffer: 64 * 1024 * 1024,
      })
      const stdout = result.stdout ?? ''
      const stderr = result.stderr ?? ''
      return {
        collected: {
          stdout: { readFrom: () => ({ text: stdout, nextOffset: stdout.length, lossy: false }) },
          stderr: { readFrom: () => ({ text: stderr, nextOffset: stderr.length, lossy: false }) },
        },
        done: Promise.resolve({ exitCode: result.status ?? 1, signal: null }),
        terminate() {},
        waitForExit: async () => true,
      }
    },
  }
}

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-review-'))
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: dir, encoding: 'utf8' })
    assert.equal(result.status, 0, `git ${args.join(' ')} failed: ${result.stderr}`)
    return result.stdout
  }
  git('init', '-q')
  writeFileSync(join(dir, 'app.js'), 'export const value = 1\n')
  git('add', 'app.js')
  git('-c', 'user.name=test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'init')
  writeFileSync(join(dir, 'app.js'), 'export const value = 2\nexport const other = undefined\n')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'untracked.js'), 'export const untracked = true\n')
  return dir
}

function ctxFor(dir, overrides = {}) {
  return {
    subprocess: fakeSubprocess(),
    workingDirectory: { ensure: async () => dir },
    ...overrides,
  }
}

const AGENT = { id: 'session-root' }

check('normalizeInput accepts a ref and rejects unsafe values', () => {
  assert.deepEqual(normalizeInput({ base: 'origin/main', paths: ['src/a.js'] }), { base: 'origin/main', paths: ['src/a.js'] })
  assert.deepEqual(normalizeInput(undefined), { base: null, paths: [] })
  assert.throws(() => normalizeInput({ base: '--upload-pack=evil' }), /not a valid git ref/)
  assert.throws(() => normalizeInput({ paths: ['-p'] }), /not options/)
})

check('collectScope reads the uncommitted change set as the default range', async () => {
  const dir = makeRepo()
  const scope = await collectScope(ctxFor(dir), AGENT, { base: null, paths: [] }, CFG, undefined)
  assert.equal(scope.empty, false)
  assert.equal(scope.ref, 'HEAD')
  assert.deepEqual(scope.files, ['app.js'])
  assert.match(scope.diff, /\+export const other = undefined/)
  assert.deepEqual(scope.untracked, ['src/untracked.js'], 'untracked files are listed, not diffed')
  assert.match(scope.command, /^git diff .*HEAD/)
})

check('collectScope honours a base ref and reports an empty diff', async () => {
  const dir = makeRepo()
  const scope = await collectScope(ctxFor(dir), AGENT, { base: 'HEAD', paths: ['src'] }, CFG, undefined)
  assert.equal(scope.empty, true, 'path-limited diff against HEAD has no changes')
  assert.deepEqual(scope.files, [])
})

check('collectScope truncates an oversized diff and says so', async () => {
  const dir = makeRepo()
  const scope = await collectScope(ctxFor(dir), AGENT, { base: null, paths: [] }, { ...CFG, maxDiffBytes: 40 }, undefined)
  assert.equal(scope.truncated, true)
  assert.ok(scope.includedBytes < scope.diffBytes)
  assert.match(scope.diff, /diff truncated at 40 bytes/)
})

check('parseReviewerOutput reads the JSON block and reports a missing block', () => {
  const ok = parseReviewerOutput('summary\n```json\n{"findings":[{"severity":"High","file":"a.js","line":3,"evidence":"x","trigger":"y","impact":"z","fix":"f","confidence":0.8}],"unverified":["t"],"notes":"n"}\n```')
  assert.equal(ok.parsed, true)
  assert.equal(ok.findings.length, 1)
  assert.equal(ok.findings[0].severity, 'High')
  assert.deepEqual(ok.unverified, ['t'])
  const bad = parseReviewerOutput('no json here')
  assert.equal(bad.parsed, false)
  assert.match(bad.error, /no parsable JSON/)
})

check('buildReport deduplicates, keeps conflicts, and never claims correctness', () => {
  const scope = { repoRoot: '/repo', ref: 'HEAD', command: 'git diff HEAD --', files: ['a.js'], untracked: [], diffBytes: 10, includedBytes: 10, truncated: false, empty: false }
  const runs = [
    run('business', 'completed', JSON.stringify({ findings: [{ severity: 'High', file: 'a.js', line: 3, evidence: 'if (x) {', trigger: 'x null', impact: 'crash', fix: 'guard', confidence: 0.7 }], unverified: [], notes: '' })),
    run('security', 'completed', JSON.stringify({ findings: [{ severity: 'High', file: 'a.js', line: 3, evidence: 'if (x) {', trigger: 'x null', impact: 'crash', fix: 'guard', confidence: 0.6 }, { severity: 'Low', file: 'a.js', line: 3, evidence: 'log(x)', trigger: 'always', impact: 'noise', fix: 'drop log', confidence: 0.3 }], unverified: [], notes: '' })),
    run('tests', 'completed', JSON.stringify({ findings: [], unverified: [], notes: '本次审查未发现符合本角色职责的问题' })),
  ]
  const report = buildReport({ scope, runs, cfg: CFG, empty: false })
  assert.equal(report.findings.length, 2, 'identical findings collapse, differing evidence does not')
  assert.equal(report.findings[0].reviewers.length, 2)
  assert.equal(report.conflicts.length, 1, 'same line, different severity is reported as a conflict')
  assert.match(report.report, /一致不等于已验证/)
  assert.doesNotMatch(report.report, /代码没有问题/)
})

check('buildReport states "no findings" with scope and limits, not correctness', () => {
  const scope = { repoRoot: '/repo', ref: 'HEAD', command: 'git diff HEAD --', files: ['a.js'], untracked: [], diffBytes: 5, includedBytes: 5, truncated: false, empty: false }
  const runs = ['business', 'security', 'tests'].map(role => run(role, 'completed', JSON.stringify({ findings: [], unverified: ['无法运行测试'], notes: '' })))
  const report = buildReport({ scope, runs, cfg: CFG, empty: false })
  assert.match(report.report, /本次审查未发现问题/)
  assert.match(report.report, /不表示代码没有问题/)
  assert.match(report.report, /无法运行测试/)
})

check('buildReport with no dispatch states that nothing was reviewed', () => {
  const scope = { repoRoot: '/repo', ref: null, command: 'git diff --', files: [], untracked: ['a.js'], diffBytes: 0, includedBytes: 0, truncated: false, empty: true }
  const report = buildReport({ scope, runs: [], cfg: CFG, empty: true })
  assert.match(report.report, /未启动任何 Reviewer/)
  assert.match(report.report, /不产生 diff/)
  assert.doesNotMatch(report.report, /本次审查未发现问题/)
})

check('apply registers the compiled tool definition, honours config, and projects text', () => {
  const captured = []
  const capturedCommands = []
  const fakeCtx = () => ({
    tools: {
      register(definition) {
        captured.push(definition)
        return () => {}
      },
    },
    commands: {
      register(definition) {
        capturedCommands.push(definition)
        return () => {}
      },
    },
    effect(setup) {
      return setup()
    },
  })
  const dispose = apply(fakeCtx(), { toolName: 'code_review', maxConcurrent: 2 })
  assert.equal(typeof dispose, 'function')
  const definition = captured[0]
  assert.equal(definition.name, 'code_review')
  assert.equal(definition.parameters.properties.base.type, 'string')
  assert.equal(definition.parameters.additionalProperties, false)
  assert.deepEqual(definition.output.schema, { type: 'object', additionalProperties: true })
  assert.deepEqual(definition.output.render({}, { report: '# r' }), [{ type: 'text', text: '# r' }])
  assert.match(definition.output.render({}, {}).at(0).text, /produced no report/)
  assert.equal(definition.isConcurrencySafe({}), true)
  assert.equal(capturedCommands[0].name, 'review', '/review is registered alongside the tool')
  assert.equal(capturedCommands[0].input.hint, '[base] [paths...]')
  apply(fakeCtx(), { toolName: 'cr_renamed' })
  assert.equal(captured[1].name, 'cr_renamed', 'config renames the tool')
})

check('the /review command parses arguments and returns the report without a model turn', async () => {
  assert.deepEqual(parseReviewArgs(''), { base: null, paths: [] })
  assert.deepEqual(parseReviewArgs('origin/main src/a.js'), { base: 'origin/main', paths: ['src/a.js'] })
  assert.deepEqual(parseReviewArgs('-- src/a.js'), { base: null, paths: ['src/a.js'] }, '`--` keeps a path out of the base slot')
  assert.throws(() => parseReviewArgs('--upload-pack=evil'), /not a valid git ref/)

  const dir = makeRepo()
  const capturedCommands = []
  const ctx = {
    subprocess: fakeSubprocess(),
    workingDirectory: { ensure: async () => dir },
    tools: { register: () => () => {} },
    effect(setup) {
      return setup()
    },
    commands: {
      register(definition) {
        capturedCommands.push(definition)
        return () => {}
      },
    },
    subagents: {
      async startActivation() {
        const findings = [{ severity: 'High', file: 'app.js', line: 2, evidence: '+export const other = undefined', trigger: 'import', impact: 'x', fix: 'y', confidence: 0.5 }]
        return activation('cmd-child', JSON.stringify({ findings, unverified: [], notes: '' }))
      },
    },
  }
  apply(ctx, {})
  const command = capturedCommands[0]
  const result = await command.handler({ agent: AGENT, rawInput: '', signal: new AbortController().signal })
  assert.equal(result.kind, 'success')
  assert.match(result.text, /实际创建并启动的 Agent：3 \/ 3/)
  assert.match(result.text, /### High/)
  assert.match(result.text, /`app\.js`:2/)
  assert.match(result.text, /多 Reviewer 一致：是（business、security、tests）。一致不等于已验证/)

  const failed = await command.handler({ agent: AGENT, rawInput: '--upload-pack=evil', signal: new AbortController().signal })
  assert.equal(failed.kind, 'error')
  assert.match(failed.text, /not a valid git ref/)
})

check('dispatchReviewers records real-looking created/completed agents', async () => {
  const started = []
  const ctx = {
    subagents: {
      async startActivation(spec) {
        started.push(spec)
        return activation(String(started.length), JSON.stringify({ findings: [], unverified: [], notes: '' }))
      },
    },
  }
  const scope = { repoRoot: '/repo', ref: 'HEAD', command: 'git diff', diff: 'x', diffBytes: 1, includedBytes: 1, truncated: false, files: [], untracked: [] }
  const runs = await dispatchReviewers(ctx, AGENT, scope, CFG, undefined)
  assert.equal(runs.length, 3)
  assert.deepEqual(runs.map(run => run.role), ['business', 'security', 'tests'])
  assert.deepEqual(runs.map(run => run.creation), ['created', 'created', 'created'])
  assert.deepEqual(runs.map(run => run.runStatus), ['completed', 'completed', 'completed'])
  assert.deepEqual(runs.map(run => run.agentId), ['1', '2', '3'])
  assert.equal(started[0].provider, 'spawn')
  assert.equal(started[0].delivery, 'caller')
  assert.equal(started[0].parent, AGENT)
  assert.ok(started[0].prompt[0].text.includes('只读'))
})

check('dispatchReviewers reports start failures, timeouts, and aborted children without pretending', async () => {
  let call = 0
  const ctx = {
    subagents: {
      async startActivation() {
        call += 1
        if (call === 1) throw new Error('subagent provider "spawn" is not registered')
        if (call === 2) return { childId: 'hung', name: 'reviewer-security', result: new Promise(() => {}), dispose: async () => {} }
        return { childId: 'cancelled', name: 'reviewer-tests', result: Promise.resolve({ output: [], stopReason: 'aborted', diagnostic: 'cancelled' }), dispose: async () => {} }
      },
    },
  }
  const scope = { repoRoot: '/repo', ref: 'HEAD', command: 'git diff', diff: 'x', diffBytes: 1, includedBytes: 1, truncated: false, files: [], untracked: [] }
  const runs = await dispatchReviewers(ctx, AGENT, scope, { ...CFG, timeoutMs: 30 }, undefined)
  assert.equal(runs[0].creation, 'failed')
  assert.equal(runs[0].runStatus, 'failed-to-start')
  assert.equal(runs[0].agentId, null)
  assert.match(runs[1].runStatus, /timeout/)
  assert.equal(runs[2].runStatus, 'aborted')
  const report = buildReport({ scope, runs, cfg: CFG, empty: false })
  assert.match(report.report, /实际创建并启动的 Agent：2 \/ 3/)
  assert.match(report.report, /创建失败/)
  assert.doesNotMatch(report.report, /本次审查未发现问题/)
})

function activation(id, text) {
  return {
    childId: id,
    name: `reviewer-${id}`,
    messageId: 'm',
    result: Promise.resolve({ output: [{ type: 'text', text }], stopReason: 'completed' }),
    dispose: async () => {},
  }
}

function run(role, runStatus, text) {
  return {
    role, title: role, label: role, requestedName: role, agentName: role, agentId: `id-${role}`,
    creation: 'created', runStatus, stopReason: 'completed', diagnostic: null, error: null,
    startedAt: 0, endedAt: 1, durationMs: 1, promptBytes: 1, text,
  }
}

let failed = 0
for (const { name, body } of checks) {
  try {
    await body()
    console.log(`ok - ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL - ${name}\n${error?.stack ?? error}`)
  }
}
console.log(`\n${checks.length - failed}/${checks.length} checks passed`)
if (failed > 0) process.exit(1)
