/** Native writes only compose task documents; repository changes always use Core. */
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import path from 'node:path'

export interface GuardExecution { readonly name: string; readonly arguments?: unknown }
export interface WriteScope { readonly workspace: string; readonly staging: string; paused: boolean }
export interface ToolAccessConfig { readOnlyTools?: string[] }
export const DENIED = '受控工作流：代码只能经 workflow_apply 写入；命令由 Core 固定检查器执行，原生 write/edit 仅可编写暂存文档'
export const ARTIFACTS = new Set(['intake.md', 'prd.md', 'spec.md', 'plan.md', 'changes.md', 'review.md', 'verify.md', 'verification.json', 'spec-change.json'])
export const READ_TOOLS = new Set([
  'read', 'read_image', 'grep', 'glob', 'web_search', 'web_fetch', 'skill',
  'list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource',
  'session_search', 'session_event_search', 'session_trace', 'session_event_trace', 'session_event_read',
  'search_context', 'acp_status', 'acp_cache', 'acp_read_original_image',
  'ask_user_question', 'todo_write', 'plan_write', 'structured_output',
  'workflow_stage', 'workflow_diff', 'workflow_submit', 'workflow_apply',
])
export const inside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target)
  return relative === '' || (relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
}

/** Staging has a private real directory and a flat, bounded allowlist; links cannot alias code. */
export function stagedPath(scope: WriteScope, target: string): string {
  const absolute = path.resolve(scope.workspace, target)
  if (path.dirname(absolute) !== scope.staging || !ARTIFACTS.has(path.basename(absolute))) throw new Error(DENIED)
  if (realpathSync(scope.staging) !== scope.staging) throw new Error('暂存目录不能通过链接重定向')
  if (existsSync(absolute)) {
    const stats = lstatSync(absolute)
    if (!stats.isFile() || stats.isSymbolicLink() || stats.nlink !== 1 || stats.size > 4 * 1024 * 1024) throw new Error('暂存文档必须是 4 MiB 内的普通文件，不能是链接')
  }
  return absolute
}

export function decide(exec: GuardExecution, scope: WriteScope | undefined, config: ToolAccessConfig = {}): string | undefined {
  if (!scope) return undefined
  if (READ_TOOLS.has(exec.name) || config.readOnlyTools?.includes(exec.name)) return undefined
  if (exec.name === 'str_replace_editor' && (exec.arguments as { command?: unknown } | undefined)?.command === 'view') return undefined
  if (scope.paused || !['write', 'edit'].includes(exec.name)) return DENIED
  const args = exec.arguments as Record<string, unknown> | undefined
  const target = args?.file_path ?? args?.filePath ?? args?.path
  if (typeof target !== 'string') return DENIED
  try { stagedPath(scope, target); return undefined } catch (error) { return error instanceof Error ? error.message : DENIED }
}
