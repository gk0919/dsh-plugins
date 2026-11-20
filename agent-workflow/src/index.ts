/**
 * Human-gated driver for the fixed Core workflow.
 *
 * Core stays the only state machine and the only validator. This plugin projects
 * its state into three DSH locks: the stage tools the model must call, the
 * turn-stopping steering guard that refuses to let a stage end unsubmitted, and
 * the write-scope guard that keeps the repository read-only until approval.
 */
import { mkdtempSync, readFileSync, realpathSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { appendPluginRecord } from '@deepseek-ai/dsh-session'
import type { Session } from '@deepseek-ai/dsh-session'
import { AsyncWorkflowController } from '@gk0919/agent-workflow/control'
import type { AutomationDelivery, AutomationOptions, ControlledWrite, ControlledSpecCapture, StageSubmission } from '@gk0919/agent-workflow/control'
import { decide, READ_TOOLS, stagedPath } from './tool-access.js'
import type { ToolAccessConfig, WriteScope } from './tool-access.js'

export const name = 'agent-workflow-control'
export const inject = ['tools', 'commands', 'workingDirectory']

export interface TextBlock { readonly type: 'text'; readonly text: string }
/** The user-source message shape `agent.steer()` accepts. */
export interface UserMessage {
  readonly id: string
  readonly role: 'user'
  readonly content: readonly TextBlock[]
  readonly source: { readonly kind: 'user' }
}
/** Structural view of the parts of a DSH agent this plugin reads. */
export interface AgentRef {
  readonly id: string
  readonly session?: Session
  readonly ctx?: { tools: { restrict(filter: { allow: string[] }): () => void } }
  steer(message: UserMessage): void
}
export interface StartupProgress { id: string; phase: string; text: string; elapsedMs: number }
declare module '@deepseek-ai/dsh-session/types' {
  interface PluginRecordMap { 'plugin:agent-workflow/startup': StartupProgress }
}
export type CommandResult = { kind: 'success' | 'error'; text: string }
export type CommandInvocation = { agent: AgentRef; rawInput: string; signal: AbortSignal }
export type CommandDefinition = {
  name: string
  description: string
  input: { hint: string }
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}
export type ToolGuard = (exec: { name: string; arguments?: unknown; agent?: AgentRef | undefined }) => string | undefined
/** Registry-ready tool definition: compiled raw JSON Schema plus a text projection. */
export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  output: { schema: Record<string, unknown>; render(args: unknown, value: unknown): TextBlock[] }
  execute(args: unknown, exec: { signal: AbortSignal; agent?: AgentRef | undefined }): Promise<unknown>
}
export type ToolRegistration = { when(context: { agent: AgentRef; signal?: AbortSignal }): boolean | Promise<boolean> }

/**
 * Structural host contract. The real DSH `Context` satisfies it through `tools`,
 * `commands`, `workingDirectory` and events; tests substitute the same members.
 */
export interface WorkflowHost {
  tools: {
    guard(guard: ToolGuard): () => void
    register(definition: ToolDefinition, options?: ToolRegistration): () => void
    definitions?(scope?: AgentRef): readonly ToolDefinition[]
  }
  commands: { register(definition: CommandDefinition): () => void }
  workingDirectory: { ensure(agent: AgentRef, signal?: AbortSignal): Promise<string> }
  on(event: 'agent/disposed', listener: (payload: { agent: AgentRef }) => void | Promise<void>): () => void
  on(event: 'agent/turn-stopping', listener: (payload: { agent: AgentRef }) => void | Promise<void>): () => void
  effect(execute: () => () => void): () => void
}

const LABELS: Record<string, string> = { starting: '正在启动工作流', source: '正在查询需求或读取来源', initialize: '正在初始化任务', context: '正在准备上下文', failed: '工作流启动失败，请查看错误详情' }
/** Cap on consecutive nudges for one stage; a stuck stage must not loop forever. */
const MAX_REMINDERS = 5
const HELP = `/workflow doctor 只读检查本地环境：插件/Core/Node 版本、git 根、任务目录、guard，不查远端、不改配置
/workflow lookup <编号> 仅查询需求或缺陷详情，不创建任务
/workflow run <编号或Markdown路径> 创建受控任务并开始阶段推进；此后每个阶段的简报由插件注入，模型用 workflow_submit 提交
/workflow run-defect <编号或Markdown路径> 明确缺陷入口（类型冲突时拒绝）
/workflow run-requirement <编号或Markdown路径> 明确需求入口（类型冲突时拒绝）
/workflow run-maintenance <Markdown路径> 工作流维护
/workflow status [--json] 审核阶段、完整计划、文件范围与前像
/workflow approve 批准当前提案的一批代码变更；模型通过 workflow_apply 写入
/workflow resume <task-id> 恢复受控任务，重新挂钩子；批准状态不继承
/workflow pause 持久化暂停并保留任务绑定与写入限制
/workflow continue 人工解除普通暂停
/workflow recover 核对不明操作结果并 reconcile 后解除恢复屏障
/workflow reconcile <原因> 人工确认工作树差异后重新记录检查点（Core 报 Repository changed 时用）
/workflow spec-init <JSON> 捕获规范基线；如 {"baselines":[".agent-workflow/specs/export.json"],"capabilities":[]}
/workflow spec-refresh 人工核对后刷新已捕获基线；阶段不变，仍需重新审核
/workflow spec-impact 显示原规则、新规则、场景与 AC/VT、依赖阻塞原因
/workflow task <JSON字符串数组> 高级人工 Core 命令；Core 的持久化命令都要带 --expected-revision N（如 checkpoint --reconcile --reason … --expected-revision 14）
/workflow help 显示本说明
模型通过 workflow_stage、workflow_diff、workflow_submit 和批准后可见的 workflow_apply 工作；文档写入暂存目录，任意 Shell 和直接仓库写入始终关闭。`

/** One agent's controlled task: the controller plus the capability state its guard reads. */
interface TaskSession {
  readonly taskId: string
  readonly agent: AgentRef
  readonly controller: AsyncWorkflowController
  readonly workspace: string
  readonly staging: string
  scope: WriteScope
  stage: string
  reminders: number
  disposeMask: () => void
  close: () => Promise<void>
  report: (phase: string, detail?: string) => void
  reported: string
}

interface SubmitArgs {
  stateToken: string
  files?: string[]
  evidence: string
  items: Array<{ id: string; evidence: string }>
  verdict: StageSubmission['verdict']
  reason: string
  summary?: string
  planFiles?: string[]
}

const SUBMIT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['stateToken', 'evidence', 'items', 'verdict', 'reason'],
  properties: {
    stateToken: { type: 'string', description: '当前 workflow_stage 简报中的 stateToken；提交前先读取最新阶段，防止重复或过期提交' },
    files: { type: 'array', items: { type: 'string' }, description: '暂存目录内本阶段写出的任务文档相对路径，例如 intake.md；插件读取后交给 Core 落盘' },
    evidence: { type: 'string', description: '本阶段证据定位符，形如 prd.md#Summary，必须指向你写出的章节' },
    items: {
      type: 'array',
      description: 'plan.md 中本阶段所有未完成工作项，每项一条，不得遗漏或重复',
      items: {
        type: 'object', additionalProperties: false, required: ['id', 'evidence'],
        properties: { id: { type: 'string' }, evidence: { type: 'string' } },
      },
    },
    verdict: { type: 'string', enum: ['ready', 'needs-input', 'changes-required'], description: 'ready 正常推进；needs-input 缺信息；changes-required 仅用于 Review/Verify 返工' },
    reason: { type: 'string' },
    summary: { type: 'string', description: '仅 Plan：提案说明' },
    planFiles: { type: 'array', items: { type: 'string' }, description: '仅 Plan：要修改的仓库相对路径，1-100 个、去重' },
  },
}

const text = (value: string): TextBlock[] => [{ type: 'text', text: value }]
const message = (value: string): UserMessage => ({ id: randomUUID(), role: 'user', content: text(value), source: { kind: 'user' } })

/** Read Core state once and project it into the cached write scope. */
async function sync(session: TaskSession, signal?: AbortSignal): Promise<AutomationDelivery> {
  const delivery = await session.controller.delivery(signal)
  if (session.stage !== delivery.task.stage) {
    session.reminders = 0
    session.stage = delivery.task.stage
  }
  session.scope.paused = delivery.waitingFor === 'human' || delivery.waitingFor === 'complete'
  const reported = `${delivery.task.stage}:${delivery.waitingFor}:${delivery.progress.lastError}`
  if (reported !== session.reported) {
    session.reported = reported
    session.report(delivery.waitingFor, delivery.waitingFor === 'model' ? `正在执行 ${delivery.task.stage}` : describe(delivery))
  }
  return delivery
}

function specImpact(task: AutomationDelivery['task']): string {
  const report = task.specChange
  if (!report?.enabled) return '规范增量：未启用；可由人工 /workflow spec-init 捕获明确基线或新增能力'
  return ['规范影响与依赖：', `specChangeHash: ${report.specChangeHash ?? '(invalid)'}`,
    ...report.errors.map(error => `错误：${error}`),
    ...report.artifacts.map(artifact => `${artifact.id}: ${artifact.status}${artifact.issues.length ? ` — ${artifact.issues.join('; ')}` : ''}`),
    ...report.impacts.map(impact => `${impact.operation} ${impact.capability}/${impact.requirementId} | ${impact.reason}\nAC: ${impact.acceptanceIds.join(', ')} | VT: ${impact.verificationIds.join(', ')}\n原规则/场景：${JSON.stringify(impact.before)}\n新规则/场景：${JSON.stringify(impact.after)}`),
  ].join('\n')
}

function describe(delivery: AutomationDelivery): string {
  const { waitingFor, recovery, progress, nextAction } = delivery
  if (waitingFor === 'approval') return '等待审批流程：Agent 先提交具体文件范围的提案，用户在 /workflow status 确认存在提案后执行 /workflow approve'
  if (waitingFor === 'human') return `需要人工处理：${recovery.issue || progress.lastError || nextAction}`
  if (waitingFor === 'complete') return '工作流已完成'
  return `工作流在阶段 ${delivery.task.stage} 等待模型继续`
}

/** Manifest 的 Identity/Source Record 是 spec frontmatter 的唯一事实源；读不到就退回通用提示。 */
function specFacts(taskDirectory: string): string {
  let manifest: string
  try {
    manifest = readFileSync(path.join(taskDirectory, 'manifest.md'), 'utf8')
  } catch {
    return 'spec.md frontmatter 必须与 manifest 的 Identity / Source Record 一致（task_id、entry_mode、source_type、source_sn）。'
  }
  const field = (label: string): string | undefined => new RegExp(`^- ${label}: (.+)$`, 'm').exec(manifest)?.[1]?.trim()
  return [
    'spec.md frontmatter 必须与 manifest 完全一致（值照抄，不要自造）：',
    `  task_id: ${field('Task ID') ?? '?'}、entry_mode: ${field('Entry Mode') ?? '?'}、source_type: ${field('Type') ?? '?'}、source_sn: ${field('SN') ?? '?'}`,
    '  spec_level 取 S/M/L（level-2 通常 M）；status 在 Spec 阶段 complete 时必须 confirmed；created_at 用合法 date-time。',
    '声明 contract_version: 2 时必须同时提交 schemaVersion 2 的 verification.json。',
  ].join('\n')
}

/** The stage brief the model works from; it carries Core's route packet verbatim. */
function brief(delivery: AutomationDelivery, session: TaskSession): string {
  const { task, waitingFor, context, nextAction } = delivery
  const head = [
    `受控工作流 | 任务 ${task.taskId} | 阶段 ${task.stage} | 等待：${waitingFor} | 检查点 ${task.revision}`,
    `stateToken: ${task.stateToken}`,
    `任务目录：${delivery.taskDirectory}`,
    `暂存目录：${session.staging}；允许的文档名：${task.stageSubmission.authoredArtifacts.join(', ')}。source.md 是 Core 捕获的只读来源，不要创建或覆盖。`,
    `本阶段必须提交的工作项：${JSON.stringify(task.stageSubmission.items)}；为空时 items 必须为 []，不要提交其他阶段的工作项。`,
    ...(task.stage === 'Implement' ? ['交付证据写入 changes.md，并在 items.evidence 中引用；不得为补交证据修改已批准的 plan.md Artifact/Done When。已写入的代码不因证据提交失败而需要再次批准。确需修改定义时，用现有文档作 evidence、items:[]、files:[]、verdict:"changes-required" 和具体 reason 返回 Plan，重新提交提案后再请用户批准。'] : []),
    ...(task.stageSubmission.sourceEvidence ? [`Source Capture 已有来源：files: []，evidence: "${task.stageSubmission.sourceEvidence}"；核实来源完整后直接提交，不需要新写来源文档。`] : []),
    ...(['Spec', 'Plan', 'Implement'].includes(task.stage) || task.specChange ? [specImpact(task)] : []),
  ]
  if (waitingFor !== 'model') return [...head, describe(delivery), ...(waitingFor === 'human' ? [
    delivery.recovery.issue ? '人工先核对 workflow_diff 和阻塞原因；只有确认基线差异后才执行 /workflow reconcile <原因>。'
      : delivery.recovery.pending ? '存在结果不明的操作；核对差异后使用 /workflow recover。'
        : delivery.progress.paused ? '当前因暂停或修正次数耗尽而停止；修正方案经人工确认后执行 /workflow continue。reconcile 不解除暂停。'
          : delivery.nextAction,
  ] : [])].join('\n')
  const specNote = task.stage === 'Spec' ? [`2. ${specFacts(path.resolve(session.workspace, delivery.taskDirectory))}`] : []
  return [
    ...head,
    '## Core 阶段包',
    context ?? '（Core 未提供额外上下文）',
    '## 工作方式',
    '1. 先在本阶段读齐需要的文件，再把本阶段文档写到暂存目录（write/edit）。',
    ...specNote,
    '3. evidence 与 items 的每一项都要指向你写出的章节，形如 prd.md#Summary；items 必须精确覆盖 plan.md 中本阶段所有未完成工作项。',
    '4. 调用 workflow_submit({ stateToken, files, evidence, items, verdict:"ready", reason })。提交前 workflow_stage 获取最新 token；Core 拒绝时按返回错误修正，不要伪造证据。',
    '5. Plan ready 提交须带 summary 与 planFiles；人工批准后，小改动用 workflow_apply({changes:[{path,edits:[{oldText,newText}]}]})。oldText 必须在批准的原文件中唯一精确匹配，多处修改均基于原文件且不能重叠。新增/删除可用 {path,content}，可同批混用，一次批准仅一批；不要为大文件重写整文件、改错责任层或要求人工补丁/reconcile。Shell 始终关闭，Verify 由 Core 固定检查器执行。',
    '6. PRD/Spec 与来源或代码证据冲突时修订相关文档并明确依据；接口字段、枚举或验收范围未确认不得标 confirmed。只完成前端不能代表后端协同已完成。',
    `6. 下一步（Core）：${nextAction}`,
  ].join('\n')
}

/** artifact() 不校验内容，Core 要到下一个检查点才拒；这里做最小前置检查，避免把任务写成不可推进状态。 */
export function precheck(files: Map<string, string>, taskId: string): void {
  const spec = files.get('spec.md')
  if (spec === undefined) return
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(spec)?.[1]
  if (frontmatter === undefined) throw new Error('spec.md 必须以 --- 包裹的 frontmatter 开头；否则 Core 会在下一个检查点拒绝整个任务')
  const keys = new Set([...frontmatter.matchAll(/^([a-z_]+):/gm)].map(match => match[1]))
  const missing = ['task_id', 'entry_mode', 'source_type', 'spec_level', 'status', 'created_at'].filter(key => !keys.has(key))
  if (missing.length > 0) throw new Error(`spec.md frontmatter 缺少字段：${missing.join('、')}`)
  const declared = /^task_id:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim()
  if (declared !== taskId) throw new Error(`spec.md frontmatter 的 task_id 必须是 ${taskId}，当前为 ${declared ?? '空'}`)
  const version = /^contract_version:\s*(\S+)/m.exec(frontmatter)?.[1]
  const contract = files.get('verification.json')
  if (version !== undefined && contract === undefined) throw new Error('spec.md 声明了 contract_version，就必须同时提交 schemaVersion 相同的 verification.json')
  if (version === undefined && contract !== undefined) throw new Error('提交了 verification.json，就必须在 spec.md 声明 contract_version')
  if (version === undefined || contract === undefined) return
  let schemaVersion: unknown
  try {
    schemaVersion = (JSON.parse(contract) as { schemaVersion?: unknown }).schemaVersion
  } catch {
    throw new Error('verification.json 不是合法 JSON')
  }
  if (String(schemaVersion) !== version) throw new Error(`verification.json 的 schemaVersion 必须是 ${version}，当前为 ${String(schemaVersion)}`)
}

/** The two stage capabilities; both are registered only for agents that own a controlled task. */
const createTools = (requireSession: (agent: AgentRef | undefined) => TaskSession): Record<'stage' | 'submit' | 'diff' | 'apply', ToolDefinition> => ({
  apply: {
    name: 'workflow_apply',
    description: '通过 Core 应用一批已批准变更。现有文件小改动优先 edits:[{oldText,newText}]，原文须唯一精确匹配且多处编辑不重叠，均基于批准的原文件；新增用 content，删除 content:null。可混合文件类型，批准仅消耗一次。不需重写大文件或人工补丁。',
    parameters: { type: 'object', additionalProperties: false, required: ['changes'], properties: {
      changes: { type: 'array', items: { oneOf: [{
        type: 'object', additionalProperties: false, required: ['path', 'content'], properties: {
          path: { type: 'string' }, content: { oneOf: [{ type: 'string' }, { type: 'null' }] },
        },
      }, {
        type: 'object', additionalProperties: false, required: ['path', 'edits'], properties: {
          path: { type: 'string' }, edits: { type: 'array', items: { type: 'object', additionalProperties: false,
            required: ['oldText', 'newText'], properties: { oldText: { type: 'string' }, newText: { type: 'string' } } } },
        },
      }] } },
    } },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(raw, exec) {
      const session = requireSession(exec.agent)
      const state = await session.controller.status(exec.signal)
      if (!state.approved || !state.proposal) throw new Error('当前没有生效的人工批准，先由用户审核并批准提案')
      const files = new Map(state.proposal.files.map(file => [file.path, file.beforeHash]))
      const args = raw as { changes: Array<Omit<ControlledWrite, 'beforeHash'>> }
      const changes = args.changes.map(change => {
        if (!files.has(change.path)) throw new Error(`未批准的文件：${change.path}`)
        return { ...change, beforeHash: files.get(change.path)! }
      }) as ControlledWrite[]
      const result = await session.controller.apply(state.proposal.id, changes, exec.signal)
      return `已受控写入：${result.applied.join(', ')}；批准已消耗。\n${brief(await sync(session, exec.signal), session)}`
    },
  },
  diff: {
    name: 'workflow_diff',
    description: '读取工作树相对 Core 基线的差异（git status、HEAD diff、未跟踪文件）。只读；Core 报 "Repository changed" 或核对实施结果时先调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(_args, exec) {
      const session = requireSession(exec.agent)
      const diff = await session.controller.diff(exec.signal)
      return [`status:`, diff.status || '(clean)', `untracked: ${diff.untracked.join(', ') || '(none)'}`, 'diff:', diff.diff || '(empty)'].join('\n')
    },
  },
  stage: {
    name: 'workflow_stage',
    description: '读取当前受控工作流阶段的简报：任务、阶段、Core Route Packet、任务目录、暂存目录与提交要求。接手新阶段或迷失时先调用。',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
    async execute(_args, exec) {
      const session = requireSession(exec.agent)
      return brief(await sync(session, exec.signal), session)
    },
  },
  submit: {
  name: 'workflow_submit',
  description: '向 Core 提交当前阶段的产物与证据；Core 是唯一校验者，拒绝原因会原样返回，按提示修正后重交。',
  parameters: SUBMIT_SCHEMA,
  output: { schema: { type: 'string' }, render: (_args, value) => text(String(value)) },
  async execute(raw, exec) {
    const session = requireSession(exec.agent)
    const args = raw as SubmitArgs
    const signal = exec.signal
    const state = await session.controller.status(signal)
    if (args.stateToken !== state.task.stateToken) throw new Error('阶段提交已过期或重复；调用 workflow_stage 读取最新 stateToken 后重交')
    // Check proposal inputs before publishing documents or consuming a stage submission.
    if ((session.stage === 'Plan' || (session.stage === 'Implement' && args.planFiles)) && args.verdict === 'ready' &&
        (!args.summary?.trim() || !args.planFiles?.length || args.planFiles.length > 100 ||
          new Set(args.planFiles.map(file => file.toLowerCase())).size !== args.planFiles.length)) {
      throw new Error('Plan ready 提交必须给出非空 summary 和 1-100 个去重的 planFiles')
    }
    const staged = new Map<string, string>()
    for (const file of args.files ?? []) {
      if (path.basename(file) !== file) throw new Error('文档名必须是暂存目录内的文件名')
      const absolute = stagedPath(session.scope, path.join(session.staging, file))
      try { staged.set(file, readFileSync(absolute, 'utf8')) } catch { throw new Error(`暂存目录里没有 ${file}，先写出本阶段文档`) }
    }
    const expected = args.verdict === 'changes-required' ? [] : state.task.stageSubmission.items.map(item => item.id)
    if (args.items.length !== expected.length || new Set(args.items.map(item => item.id)).size !== expected.length || args.items.some(item => !expected.includes(item.id))) {
      throw new Error(`当前 ${state.task.stage} 阶段 items 必须精确为 ${JSON.stringify(expected)}；其他阶段工作项不要提交。尚未写入任何文档。`)
    }
    const evidenceText = (locator: string): void => {
      const [file, section] = locator.split('#')
      if (!file || path.basename(file) !== file || !['source.md', ...state.task.stageSubmission.authoredArtifacts].includes(file)) throw new Error('证据必须引用任务文档及其实际标题')
      const content = staged.get(file) ?? readFileSync(path.join(session.workspace, state.task.taskDirectory, file), 'utf8')
      if (!content.trim()) throw new Error(`证据为空：${locator}`)
      if (section && !content.split(/\r?\n/).some(line => /^#{1,6} /.test(line) && line.replace(/^#{1,6} /, '').trim() === section)) throw new Error(`证据章节不存在：${locator}；请照抄实际标题，尚未写入任何文档。`)
    }
    evidenceText(args.evidence)
    for (const item of args.items) evidenceText(item.evidence)
    if (staged.size) await session.controller.artifacts([...staged].map(([file, content]) => ({ file, content })), args.stateToken, signal)
    const delivery = await sync(session, signal)
    const propose = async (): Promise<string> => {
      await session.controller.propose(args.summary!, args.planFiles!, signal)
      return `${brief(await sync(session, signal), session)}\n提案已提交，等待用户审核后执行 /workflow approve。`
    }
    // A previous proposal error must not force the model to resubmit or advance Plan twice.
    if (delivery.waitingFor === 'approval' && ['Plan', 'Implement'].includes(delivery.task.stage) && args.verdict === 'ready') {
      if (!args.summary?.trim() || !args.planFiles?.length) throw new Error('恢复或补交提案需要 summary 与 planFiles；由用户重新批准')
      return propose()
    }
    const replan = args.verdict === 'changes-required' && delivery.task.stage === 'Implement' && delivery.waitingFor === 'approval'
    if (delivery.waitingFor !== 'model' && !replan) throw new Error(`${describe(delivery)}\n${brief(delivery, session)}`)
    const after = await session.controller.submit({
      stateToken: delivery.task.stateToken, evidence: args.evidence, items: args.items, verdict: args.verdict, reason: args.reason,
    }, signal)
    session.scope.paused = after.waitingFor === 'human' || after.waitingFor === 'complete'
    if (session.stage !== after.task.stage) { session.stage = after.task.stage; session.reminders = 0 }
    if (after.progress.failures > 0 || after.progress.lastError) throw new Error(after.context ?? after.progress.lastError)
    if (after.waitingFor === 'approval') {
      if (after.task.stage !== 'Plan') return `本阶段（${after.task.stage}）要求人工批准，但 Core 没有可提交的文件范围。\n${brief(after, session)}`
      return propose()
    }
    return brief(after, session)
  },
  },
})

export function apply(ctx: WorkflowHost, config: AutomationOptions & { toolAccess?: ToolAccessConfig } = {}): () => Promise<void> {
  if (typeof ctx.tools.guard !== 'function') throw new Error('This plugin requires DSH tools.guard()')
  const sessions = new Map<string, TaskSession>()
  const pending = new Set<string>()
  let disposed = false
  let shutdown: Promise<unknown> = Promise.resolve()
  const closing = new Set<Promise<void>>()
  const operations = new Map<string, Promise<unknown>>()
  const exclusive = async <T>(agent: AgentRef, execute: () => Promise<T>): Promise<T> => {
    const previous = operations.get(agent.id) ?? Promise.resolve()
    const work = previous.catch(() => {}).then(() => {
      if (disposed) throw new Error('Workflow plugin was disposed')
      return execute()
    })
    operations.set(agent.id, work)
    try { return await work } finally { if (operations.get(agent.id) === work) operations.delete(agent.id) }
  }

  const requireSession = (agent: AgentRef | undefined): TaskSession => {
    if (disposed) throw new Error('Workflow plugin was disposed')
    const session = agent && sessions.get(agent.id)
    if (!session) throw new Error('先由用户执行 /workflow run 或 /workflow resume')
    return session
  }
  const tools = createTools(requireSession)

  /** Hook a fresh controller to the agent and start the loop; the command returns the stop reason. */
  const attach = async (agent: AgentRef, controller: AsyncWorkflowController, workspace: string, report: TaskSession['report']): Promise<{ session: TaskSession; delivery: AutomationDelivery }> => {
    const status = await controller.status()
    if (disposed) throw new Error('Workflow plugin was disposed')
    if (!agent.ctx) throw new Error('DSH agent.ctx.tools is required for scoped tool visibility')
    const staging = realpathSync(mkdtempSync(path.join(tmpdir(), `dsh-workflow-${status.task.taskId}-`)))
    const available = ctx.tools.definitions?.(agent).map(definition => definition.name) ?? ['write', 'edit']
    const allow = available.filter(name => READ_TOOLS.has(name) || config.toolAccess?.readOnlyTools?.includes(name) || ['write', 'edit'].includes(name) || name.startsWith('workflow_'))
    const disposeMask = agent.ctx.tools.restrict({ allow })
    const session: TaskSession = {
      agent, controller, workspace, staging, taskId: status.task.taskId,
      scope: { workspace, staging, paused: false },
      stage: status.task.stage, reminders: 0,
      disposeMask,
      close: async () => { disposeMask(); await controller.dispose() },
      report, reported: '',
    }
    sessions.set(agent.id, session)
    return { session, delivery: await sync(session) }
  }

  const cleanup = ctx.effect(() => {
    const disposers: Array<() => void> = []
    const guard = ctx.tools.guard(exec => disposed ? undefined : decide(exec, exec.agent ? sessions.get(exec.agent.id)?.scope : undefined, config.toolAccess))
    try {
      for (const definition of Object.values(tools)) disposers.push(ctx.tools.register({ ...definition,
        execute: (args, exec) => exclusive(exec.agent!, async () => {
          exec.signal.throwIfAborted()
          try { return await definition.execute(args, exec) }
          catch (error) {
            if (exec.signal.aborted) await requireSession(exec.agent).controller.pause('操作已取消；检查已完成的副作用后继续')
            throw error
          }
        }),
      }, { when: async ({ agent }) => {
        const session = sessions.get(agent.id)
        if (disposed || !session) return false
        if (definition.name === 'workflow_apply') return !session.scope.paused && session.controller.canApply()
        return true
      } }))
      disposers.push(ctx.on('agent/turn-stopping', ({ agent }) => exclusive(agent, async () => {
        const session = sessions.get(agent.id)
        if (!session || disposed) return
        let delivery: AutomationDelivery
        try {
          delivery = await sync(session)
        } catch (error) {
          // 已发布的产物坏掉时 sync 会一直抛；把原因交回模型，它可以用 workflow_submit 覆盖。
          if (session.reminders >= MAX_REMINDERS) {
            session.scope.paused = true
            await session.controller.pause('阶段产物持续无法解析，达到修正上限；需要人工检查')
            session.report('human', '阶段产物无法解析，工作流已暂停；请查看 /workflow status')
            return
          }
          session.reminders += 1
          const reason = error instanceof Error ? error.message : String(error)
          agent.steer(message(`受控任务 ${path.basename(session.staging)} 的已发布产物无法解析：${reason}\n修正暂存目录里的对应文件，再用 workflow_submit 覆盖（提交会先落盘再校验）。`))
          return
        }
        if (delivery.waitingFor !== 'model') return
        if (session.reminders >= MAX_REMINDERS) {
          session.scope.paused = true
          await session.controller.pause(`阶段 ${delivery.task.stage} 达到 ${MAX_REMINDERS} 次提醒上限，需要人工继续`)
          session.report('human', `阶段 ${delivery.task.stage} 提醒次数耗尽，工作流已暂停`)
          return
        }
        session.reminders += 1
        // The model cannot close a turn while its stage is unsubmitted; steering re-opens it.
        agent.steer(message(`阶段 ${delivery.task.stage} 尚未提交（提醒 ${session.reminders}/${MAX_REMINDERS}）。\n${brief(delivery, session)}`))
      })))
      disposers.push(ctx.on('agent/disposed', ({ agent }) => {
        const session = sessions.get(agent.id)
        sessions.delete(agent.id)
        if (session) {
          const work = (operations.get(agent.id) ?? Promise.resolve()).catch(() => {}).then(() => session.close())
          closing.add(work)
          void work.catch(error => console.error('Workflow disposal failed:', error)).finally(() => closing.delete(work))
        }
      }))
      disposers.push(ctx.commands.register({
        name: 'workflow',
        description: '受控工作流：启动、审核、人工批准与 Core 任务操作',
        input: { hint: 'doctor | lookup <id> | run <id-or-path> | status | approve | resume <task-id> | continue | recover | pause | task <json>' },
        async handler({ agent, rawInput, signal }) {
          if (pending.has(agent.id)) return { kind: 'error', text: '当前会话的工作流命令仍在执行' }
          pending.add(agent.id)
          const startedAt = Date.now()
          const progressId = randomUUID()
          let stopProgress: (() => void) | undefined
          let starting = false
          const report = (phase: string, detail?: string): void => {
            if (!disposed && agent.session) appendPluginRecord(agent.session, 'plugin:agent-workflow/startup', { id: progressId, phase, text: detail ?? LABELS[phase] ?? phase, elapsedMs: Date.now() - startedAt })
          }
          starting = /^\s*(run|run-maintenance|run-defect|run-requirement|resume)(?:\s|$)/.test(rawInput)
          if (starting && !signal.aborted) report('starting')
          return exclusive<CommandResult>(agent, async () => {
          try {
            signal.throwIfAborted()
            const match = /^\s*(\S+)?\s*([\s\S]*)$/.exec(rawInput) as RegExpExecArray
            const action = match[1] ?? 'help'
            const rest = match[2].trim()
            if (action === 'help') return { kind: 'success', text: HELP }
            if (action === 'doctor' || action === 'lookup') {
              const root = await ctx.workingDirectory.ensure(agent, signal)
              const reader = new AsyncWorkflowController(root, action === 'doctor' ? config : {})
              try {
                if (action === 'lookup') return { kind: 'success', text: JSON.stringify(await reader.lookup(rest, signal), null, 2) }
                const doctor = await reader.doctor(signal)
                return {
                  kind: 'success',
                  text: JSON.stringify({
                    ...doctor,
                    pluginVersion: (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version,
                    checks: (config.checks ?? []).map(({ id, testId }) => ({ id, testId })),
                    host: { guard: true, stageTools: true, turnStopping: true, steering: true },
                    stagedDocuments: path.join(tmpdir(), 'dsh-workflow'),
                  }, null, 2),
                }
              } finally { await reader.dispose() }
            }
            starting = ['run', 'run-maintenance', 'run-defect', 'run-requirement', 'resume'].includes(action)
            if (starting) {
              const previous = sessions.get(agent.id)
              if (previous) { previous.scope.paused = true; await previous.close() }
              sessions.delete(agent.id)
              const workspace = await ctx.workingDirectory.ensure(agent, signal)
              signal.throwIfAborted()
              if (disposed) throw new Error('Workflow plugin was disposed')
              const controller = new AsyncWorkflowController(workspace, config)
              stopProgress = controller.onProgress(report)
              try {
                if (action === 'resume') await controller.resume(rest, signal)
                else await controller.run(rest, action === 'run-maintenance' ? 'workflow-maintenance' : action === 'run-defect' ? 'defect' : action === 'run-requirement' ? 'requirement' : 'auto', signal)
                const { session, delivery } = await attach(agent, controller, workspace, report)
                if (delivery.waitingFor === 'model') agent.steer(message(brief(delivery, session)))
                return { kind: 'success', text: brief(delivery, session) }
              } catch (error) {
                sessions.get(agent.id)?.disposeMask()
                sessions.delete(agent.id)
                await controller.dispose(); throw error
              }
            }
            const session = requireSession(agent)
            if (action === 'status') {
              const status = await session.controller.status(signal)
              const delivery = await sync(session, signal)
              return { kind: 'success', text: rest === '--json' ? JSON.stringify({ ...status, automation: delivery }, null, 2) : formatStatus(status, delivery) }
            }
            if (action === 'approve') {
              const status = await session.controller.status(signal)
              const proposal = status.proposal
              if (!proposal) throw new Error('当前没有待批准的提案，批准命令无法推进任务。请让 Agent 调用 workflow_stage：已写入代码只需补交证据；计划定义需要修改时先提交 changes-required 返回 Plan，再生成新提案。')
              if (rest && rest !== proposal.id) throw new Error(`提案 id 不匹配：当前提案是 ${proposal.id}`)
              await session.controller.approve(proposal.id, signal)
              const delivery = await sync(session, signal)
              if (delivery.waitingFor === 'model') agent.steer(message(brief(delivery, session)))
              return { kind: 'success', text: `已批准提案 ${proposal.id}：\n${brief(delivery, session)}` }
            }
            if (action === 'spec-impact') return { kind: 'success', text: specImpact((await sync(session, signal)).task) }
            if (action === 'spec-init' || action === 'spec-refresh') {
              const input: ControlledSpecCapture = { action: action === 'spec-init' ? 'init' : 'refresh' }
              if (action === 'spec-init') {
                const parsed: unknown = JSON.parse(rest)
                if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(key => !['baselines', 'capabilities'].includes(key))) throw new Error('spec-init 只接受 baselines/capabilities 字符串数组')
                Object.assign(input, parsed)
              } else if (rest) throw new Error('spec-refresh 不接受额外参数')
              await session.controller.captureSpec(input, signal)
              const delivery = await sync(session, signal)
              return { kind: 'success', text: `${specImpact(delivery.task)}\n重新审核增量与验证定义后继续。` }
            }
            if (action === 'pause') { session.scope.paused = true; await session.controller.pause() }
            else if (action === 'continue') { await session.controller.continue(signal); session.reminders = 0 }
            else if (action === 'recover') await session.controller.recover(signal)
            else if (action === 'reconcile') {
              const reason = rest || '人工核对工作树差异后重新记录检查点'
              // Core 的每条持久化命令都要求显式 expected-revision，读取当前检查点后再写。
              const state = await session.controller.status(signal)
              await session.controller.task(['checkpoint', '--reconcile', '--reason', reason, '--expected-revision', String(state.task.revision)], signal)
            }
            else if (action === 'task') {
              const args: unknown = JSON.parse(rest)
              if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) throw new Error('task 参数必须是字符串数组')
              await session.controller.task(args, signal)
            } else throw new Error(`未知操作：${action}；使用 /workflow help`)
            const synced = await sync(session, signal)
            if (synced.waitingFor === 'model') agent.steer(message(brief(synced, session)))
            return { kind: 'success', text: brief(synced, session) }
          } catch (error) {
            if (starting) report('failed')
            if (signal.aborted && sessions.has(agent.id)) {
              const session = sessions.get(agent.id)!
              session.scope.paused = true
              await session.controller.pause('命令已取消；检查 status/diff 后继续')
            }
            return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
          } finally { stopProgress?.(); pending.delete(agent.id) }
          }).finally(() => { pending.delete(agent.id) })
        },
      }))
    } catch (error) {
      disposed = true
      for (const dispose of disposers.reverse()) dispose()
      throw error
    }
    return () => {
      disposed = true
      shutdown = (async () => {
        await Promise.allSettled([...operations.values()])
        await Promise.all([...closing, ...[...sessions.values()].map(session => session.close())])
        sessions.clear()
      })()
      for (const dispose of disposers.reverse()) dispose()
      guard()
    }
  })
  return async () => { cleanup(); await shutdown }
}

type HumanStatus = Awaited<ReturnType<AsyncWorkflowController['status']>>
function formatStatus(state: HumanStatus, delivery: AutomationDelivery): string {
  const { task, proposal, approved, issue } = state
  return [
    `任务：${task.taskId} | 阶段：${task.stage} | 等待：${delivery.waitingFor}`,
    `目录：${task.taskDirectory}`,
    `批准：${approved ? '当前批次有效，仅 workflow_apply 可写' : '无写入权限，仓库只读'} | 检查点：${task.revision}`,
    specImpact(task),
    ...(proposal ? [`提案：${proposal.id}`, `说明：${proposal.summary}`, '文件与前像：', ...proposal.files.map(file => `  ${file.path} | ${file.beforeHash ?? '新建'}`)] : ['提案：尚未提交']),
    ...(issue ? [`阻塞：${issue}`] : []),
    ...(delivery.progress.lastError ? [`最近错误：${delivery.progress.lastError}`] : []),
    `下一步：${delivery.nextAction}`,
    '完整计划：', task.plan ?? '尚无计划',
    '文档：intake.md / prd.md / spec.md / plan.md 均在上述任务目录；完整状态：/workflow status --json',
  ].join('\n')
}
