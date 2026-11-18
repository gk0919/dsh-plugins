/**
 * Reviewer dispatch and result collection. Each reviewer is one real subagent
 * activation started through the `subagents` seam; this module owns the
 * concurrency cap, the per-reviewer deadline, and the structured run record.
 */

import type { Agent, PluginContext, SubagentActivation } from './types/dsh.js'
import type { ReviewConfig } from './config.js'
import type { ReviewScope } from './scope.js'
import { ROLES, reviewerPrompt, type ReviewerRole } from './prompts.js'

/** Creation/run state of one reviewer; only `created` agents can run. */
export type Creation = 'not-started' | 'not-attempted' | 'created' | 'failed'

/** Terminal (or pending) state of one reviewer run. */
export type RunStatus =
  | 'not-started'
  | 'running'
  | 'completed'
  | 'aborted'
  | 'error'
  | 'max-tokens'
  | 'refusal'
  | 'timeout'
  | 'cancelled'
  | 'failed-to-start'

/** Everything the report needs to state what actually happened. */
export interface RunRecord {
  role: ReviewerRole['id']
  title: string
  label: string
  requestedName: string
  agentName: string | null
  agentId: string | null
  creation: Creation
  runStatus: RunStatus
  stopReason: string | null
  diagnostic: string | null
  error: string | null
  startedAt: number
  endedAt: number | null
  durationMs: number | null
  promptBytes: number
  text: string
}

type Outcome =
  | { kind: 'result'; value: { output?: unknown; stopReason?: unknown; diagnostic?: unknown } }
  | { kind: 'threw'; error: unknown }
  | { kind: 'timeout' }
  | { kind: 'cancelled' }

/**
 * Start every reviewer through the subagent seam, at most `maxConcurrent` at a
 * time, and collect one structured record per role in role order. A role that
 * cannot be started or does not finish is reported as such — never as done.
 */
export async function dispatchReviewers(
  ctx: PluginContext,
  agent: Agent,
  scope: ReviewScope,
  cfg: ReviewConfig,
  signal: AbortSignal | undefined,
): Promise<RunRecord[]> {
  const records: RunRecord[] = []
  const limit = Math.max(1, Math.min(cfg.maxConcurrent, ROLES.length))
  let cursor = 0

  const worker = async (): Promise<void> => {
    for (;;) {
      const index = cursor
      cursor += 1
      const role = ROLES[index]
      if (role === undefined) return
      records[index] = await reviewOne(ctx, agent, role, scope, cfg, signal)
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))
  return records
}

async function reviewOne(
  ctx: PluginContext,
  agent: Agent,
  role: ReviewerRole,
  scope: ReviewScope,
  cfg: ReviewConfig,
  signal: AbortSignal | undefined,
): Promise<RunRecord> {
  const record: RunRecord = {
    role: role.id,
    title: role.title,
    label: role.label,
    requestedName: role.name,
    agentName: null,
    agentId: null,
    creation: 'not-started',
    runStatus: 'not-started',
    stopReason: null,
    diagnostic: null,
    error: null,
    startedAt: Date.now(),
    endedAt: null,
    durationMs: null,
    promptBytes: 0,
    text: '',
  }

  const finish = (): RunRecord => {
    record.endedAt = Date.now()
    record.durationMs = record.endedAt - record.startedAt
    return record
  }

  if (signal?.aborted === true) {
    record.creation = 'not-attempted'
    record.runStatus = 'cancelled'
    record.error = 'the calling turn was cancelled before this reviewer started'
    return finish()
  }

  const controller = new AbortController()
  const forwardAbort = (): void => { controller.abort(signal?.reason) }
  signal?.addEventListener('abort', forwardAbort, { once: true })

  let timer: ReturnType<typeof setTimeout> | undefined
  let activation: SubagentActivation | undefined
  try {
    const prompt = reviewerPrompt(role, scope)
    record.promptBytes = Buffer.byteLength(prompt)

    try {
      activation = await ctx.subagents.startActivation({
        provider: cfg.provider,
        label: role.label,
        name: role.name,
        prompt: [{ type: 'text', text: prompt }],
        parent: agent,
        signal: controller.signal,
        delivery: 'caller',
      })
    } catch (error) {
      record.creation = 'failed'
      record.runStatus = 'failed-to-start'
      record.error = errorMessage(error)
      return finish()
    }

    record.creation = 'created'
    record.runStatus = 'running'
    record.agentId = String(activation.childId)
    record.agentName = activation.name === '' ? role.name : activation.name

    const outcome: Outcome = await Promise.race([
      activation.result.then(
        (value): Outcome => ({ kind: 'result', value }),
        (error: unknown): Outcome => ({ kind: 'threw', error }),
      ),
      new Promise<Outcome>(resolve => {
        timer = setTimeout(() => {
          controller.abort(new Error('reviewer timeout'))
          resolve({ kind: 'timeout' })
        }, cfg.timeoutMs)
      }),
      new Promise<Outcome>(resolve => {
        if (signal === undefined) return
        signal.addEventListener('abort', () => { resolve({ kind: 'cancelled' }) }, { once: true })
      }),
    ])

    if (outcome.kind === 'result') {
      const value = outcome.value
      record.stopReason = typeof value.stopReason === 'string' ? value.stopReason : 'unknown'
      record.diagnostic = typeof value.diagnostic === 'string' ? value.diagnostic : null
      record.text = blocksToText(value.output)
      record.runStatus = record.stopReason === 'completed' ? 'completed' : asRunStatus(record.stopReason)
    } else if (outcome.kind === 'timeout') {
      record.runStatus = 'timeout'
      record.error = `reviewer did not finish within ${String(cfg.timeoutMs)} ms; the activation was cancelled`
    } else if (outcome.kind === 'cancelled') {
      record.runStatus = 'cancelled'
      record.error = 'the calling turn was cancelled while this reviewer was running'
    } else {
      record.runStatus = 'error'
      record.error = errorMessage(outcome.error)
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer)
    signal?.removeEventListener('abort', forwardAbort)
    controller.abort(new Error('review finished'))
    if (activation !== undefined) {
      try {
        await activation.dispose()
      } catch (error) {
        record.diagnostic = record.diagnostic ?? `dispose failed: ${errorMessage(error)}`
      }
    }
  }

  return finish()
}

/** Map a provider stop reason onto the record's bounded status vocabulary. */
function asRunStatus(stopReason: string): RunStatus {
  switch (stopReason) {
    case 'aborted':
    case 'max-tokens':
    case 'refusal':
      return stopReason
    default:
      return 'error'
  }
}

function blocksToText(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block): block is { type: string; text?: unknown } => block !== null && typeof block === 'object')
    .filter(block => block.type === 'text' && typeof block.text === 'string')
    .map(block => block.text as string)
    .join('\n')
    .trim()
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
