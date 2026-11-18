/**
 * `/review` human command: the same scope → dispatch → report pipeline as the
 * model-facing tool, invoked straight from the composer without a model turn.
 */

import type { CommandInvocation, PluginContext } from './types/dsh.js'
import type { ReviewConfig } from './config.js'
import { collectScope, normalizeInput, type ReviewInput } from './scope.js'
import { dispatchReviewers } from './dispatch.js'
import { buildReport } from './report.js'

const HINT = '[base] [paths...]'

/**
 * Parse the text after `/review`.
 *
 * `origin/main src/a.js` = base plus a path; a first token that is really a
 * path needs the explicit separator: `-- src/a.js`.
 */
export function parseReviewArgs(rawInput: string): ReviewInput {
  const tokens = rawInput.trim().split(/\s+/).filter(token => token !== '')
  if (tokens[0] === '--') return normalizeInput({ base: null, paths: tokens.slice(1) })
  const base = tokens.length === 0 ? null : tokens[0]
  return normalizeInput({ base, paths: tokens.slice(1) })
}

/** Register `/review`; failures become command errors rather than thrown noise. */
export function registerReviewCommand(ctx: PluginContext, cfg: ReviewConfig): () => void {
  return ctx.commands.register({
    name: 'review',
    description: '只读多 Agent 审查当前 Git 改动：/review [base] [paths...]（首参数若只是路径，用 `--` 分隔）',
    input: { hint: HINT },
    async handler(invocation: CommandInvocation) {
      try {
        const input = parseReviewArgs(invocation.rawInput)
        const scope = await collectScope(ctx, invocation.agent, input, cfg, invocation.signal)
        const runs = scope.empty
          ? []
          : await dispatchReviewers(ctx, invocation.agent, scope, cfg, invocation.signal)
        const report = buildReport({ scope, runs, cfg, empty: scope.empty })
        return { kind: 'success', text: report.report }
      } catch (error) {
        return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
      }
    },
  })
}
