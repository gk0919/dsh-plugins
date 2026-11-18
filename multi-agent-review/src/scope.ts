/**
 * Review-scope discovery: the single place that decides what "the current
 * changes" means. Only read-only git commands run here.
 */

import type { Agent, PluginContext } from './types/dsh.js'
import type { ReviewConfig } from './config.js'

const REF_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_./~^@{}-]*$/
const STDOUT_MAX_BYTES = 16 * 1024 * 1024
const STDERR_MAX_BYTES = 64 * 1024

/** Validated tool arguments. */
export interface ReviewInput {
  base: string | null
  paths: string[]
}

/** What the review covers, plus the diff handed to reviewers. */
export interface ReviewScope {
  cwd: string
  repoRoot: string
  ref: string | null
  command: string
  diff: string
  diffBytes: number
  includedBytes: number
  truncated: boolean
  files: string[]
  untracked: string[]
  empty: boolean
}

interface GitResult {
  ok: boolean
  code: number | null
  stdout: string
  stderr: string
  command: string
}

/**
 * Validate the model-supplied arguments. Git receives an argv array (never a
 * shell string), and refs/paths are still checked so an argument cannot become
 * an option or span outside the intended scope.
 */
export function normalizeInput(args: unknown): ReviewInput {
  const raw: Record<string, unknown> = args !== null && typeof args === 'object'
    ? args as Record<string, unknown>
    : {}
  const base = typeof raw.base === 'string' ? raw.base.trim() : ''
  if (base !== '' && !REF_PATTERN.test(base)) {
    throw new Error(`base "${base}" is not a valid git ref (letters, digits, and _ . / ~ ^ @ { } - only)`)
  }
  const paths = Array.isArray(raw.paths)
    ? raw.paths.filter((path): path is string => typeof path === 'string').map(path => path.trim()).filter(path => path !== '')
    : []
  for (const path of paths) {
    if (path.startsWith('-')) throw new Error(`paths must be repository-relative, not options: "${path}"`)
    if (path.includes('\0')) throw new Error('paths must not contain NUL bytes')
  }
  return { base: base === '' ? null : base, paths }
}

/**
 * Read the change set the review covers: repository root, the diff itself, the
 * reviewed file list, and untracked files that no diff contains.
 */
export async function collectScope(
  ctx: PluginContext,
  agent: Agent,
  input: ReviewInput,
  cfg: ReviewConfig,
  signal: AbortSignal | undefined,
): Promise<ReviewScope> {
  const cwd = await ctx.workingDirectory.ensure(agent, signal)

  const inside = await runGit(ctx, cwd, ['rev-parse', '--show-toplevel'], cfg, signal)
  if (!inside.ok) {
    throw new Error(`not a git repository: ${firstLine(inside.stderr) || inside.command}`)
  }
  const repoRoot = inside.stdout.trim() || cwd

  const head = await runGit(ctx, cwd, ['rev-parse', '--verify', '--quiet', 'HEAD'], cfg, signal)
  const ref = input.base ?? (head.ok ? 'HEAD' : null)

  const range = [...ref === null ? [] : [ref], '--', ...input.paths]
  const diffArgs = ['diff', '--no-color', '--no-ext-diff', '--unified=3', ...range]
  const diffRun = await runGit(ctx, cwd, diffArgs, cfg, signal)
  if (!diffRun.ok) {
    throw new Error(`git diff failed: ${firstLine(diffRun.stderr) || `exit ${String(diffRun.code)}`}`)
  }

  const namesRun = await runGit(ctx, cwd, ['diff', '--name-only', '--no-color', ...range], cfg, signal)
  const statusRun = await runGit(ctx, cwd, ['status', '--porcelain', '--untracked-files=all'], cfg, signal)

  const fullDiff = diffRun.stdout
  const diffBytes = Buffer.byteLength(fullDiff)
  const truncated = diffBytes > cfg.maxDiffBytes
  const diff = truncated ? truncateUtf8(fullDiff, cfg.maxDiffBytes) : fullDiff
  const files = splitLines(namesRun.ok ? namesRun.stdout : '')
  const untracked = splitLines(statusRun.ok ? statusRun.stdout : '')
    .filter(line => line.startsWith('?? '))
    .map(line => line.slice(3).trim())
    .filter(name => name !== '')
    .slice(0, 200)

  return {
    cwd,
    repoRoot,
    ref,
    command: ['git', ...diffArgs].join(' '),
    diff,
    diffBytes,
    includedBytes: Buffer.byteLength(diff),
    truncated,
    files,
    untracked,
    empty: diff.trim() === '',
  }
}

/** Run one git invocation with a deadline; never throws for a non-zero exit. */
async function runGit(
  ctx: PluginContext,
  cwd: string,
  argv: readonly string[],
  cfg: ReviewConfig,
  signal: AbortSignal | undefined,
): Promise<GitResult> {
  if (signal?.aborted === true) throw abortError()
  const controller = new AbortController()
  const forward = (): void => { controller.abort(signal?.reason) }
  signal?.addEventListener('abort', forward, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('git command timed out')), cfg.commandTimeoutMs)
  const spawnArgv = ['git', ...argv]
  const command = spawnArgv.join(' ')
  try {
    let handle
    try {
      handle = ctx.subprocess.spawn({
        argv: spawnArgv,
        cwd,
        graceMs: 2_000,
        signal: controller.signal,
        stdio: {
          stdin: 'ignore',
          stdout: { maxBytes: STDOUT_MAX_BYTES },
          stderr: { maxBytes: STDERR_MAX_BYTES },
        },
      })
    } catch (error) {
      throw new Error(`cannot start git (${command}): ${errorMessage(error)}`)
    }
    let outcome
    try {
      outcome = await handle.done
    } catch (error) {
      throw new Error(`git failed to run (${command}): ${errorMessage(error)}`)
    }
    return {
      ok: outcome.exitCode === 0,
      code: outcome.exitCode,
      stdout: read(handle.collected.stdout),
      stderr: read(handle.collected.stderr),
      command,
    }
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener('abort', forward)
  }
}

function read(reader: { readFrom(fromByte: number): { text: string } } | undefined): string {
  return reader === undefined ? '' : reader.readFrom(0).text
}

function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= maxBytes) return text
  return `${bytes.subarray(0, maxBytes).toString('utf8')}\n\n[diff truncated at ${String(maxBytes)} bytes]`
}

function splitLines(text: string): string[] {
  return text.split('\n').map(line => line.replace(/\r$/, '')).filter(line => line !== '')
}

function firstLine(text: string): string {
  return text.split('\n').map(line => line.trim()).find(line => line !== '') ?? ''
}

function abortError(): Error {
  const error = new Error('review cancelled')
  error.name = 'AbortError'
  return error
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
