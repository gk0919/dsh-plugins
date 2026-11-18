/** Plugin configuration: defaults plus tolerant reading of the patch row's `config`. */

export interface ReviewConfig {
  /** Model-facing tool name. */
  toolName: string
  /** `ctx.subagents` provider to start reviewers on, e.g. `spawn`. */
  provider: string
  /** Upper bound on simultaneously running reviewers. */
  maxConcurrent: number
  /** Per-reviewer deadline in milliseconds. */
  timeoutMs: number
  /** Per-git-command deadline in milliseconds. */
  commandTimeoutMs: number
  /** Largest diff (bytes) embedded in a reviewer prompt. */
  maxDiffBytes: number
}

export const DEFAULTS: ReviewConfig = {
  toolName: 'code_review',
  provider: 'spawn',
  maxConcurrent: 3,
  timeoutMs: 600_000,
  commandTimeoutMs: 30_000,
  maxDiffBytes: 150_000,
}

const NUMERIC_KEYS = ['maxConcurrent', 'timeoutMs', 'commandTimeoutMs', 'maxDiffBytes'] as const

/** Accept only known values so one bad patch row cannot poison a review. */
export function readConfig(config: unknown): ReviewConfig {
  const raw: Record<string, unknown> = config !== null && typeof config === 'object'
    ? config as Record<string, unknown>
    : {}
  const result: ReviewConfig = { ...DEFAULTS }
  if (typeof raw.toolName === 'string' && raw.toolName.trim() !== '') result.toolName = raw.toolName.trim()
  if (typeof raw.provider === 'string' && raw.provider.trim() !== '') result.provider = raw.provider.trim()
  for (const key of NUMERIC_KEYS) {
    const value = raw[key]
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) result[key] = Math.floor(value)
  }
  return result
}
