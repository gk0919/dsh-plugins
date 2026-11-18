/**
 * Report assembly: parse each reviewer's machine-readable block, deduplicate
 * findings, keep contradictions visible, and render the markdown report.
 * Reviewer prose is untrusted data and is only ever quoted, never interpreted.
 */

import type { ReviewConfig } from './config.js'
import type { ReviewScope } from './scope.js'
import type { RunRecord } from './dispatch.js'

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'] as const
type Severity = typeof SEVERITIES[number]

const SEVERITY_ALIASES = new Map<string, Severity>([
  ['critical', 'Critical'], ['blocker', 'Critical'],
  ['high', 'High'], ['major', 'High'],
  ['medium', 'Medium'], ['moderate', 'Medium'], ['minor', 'Medium'],
  ['low', 'Low'], ['info', 'Low'], ['trivial', 'Low'],
])

/** One normalized finding; `reviewers` lists every Reviewer that reported it. */
export interface Finding {
  severity: Severity
  severityAssumed: boolean
  file: string | null
  line: number | null
  locationNote: string
  evidence: string
  trigger: string
  impact: string
  fix: string
  confidence: number | null
  needsHuman: boolean
  reviewers: string[]
}

/** One reviewer's parsed result block. */
export interface ParsedReviewerOutput {
  parsed: boolean
  findings: Finding[]
  unverified: string[]
  notes: string
  error: string | null
}

/** One unparsable reviewer answer, kept verbatim for the report. */
export interface UnparsedOutput {
  role: string
  title: string
  error: string
  text: string
}

/** One reviewer disagreement at the same location. */
export interface Conflict {
  file: string
  line: number
  entries: { reviewer: string; severity: Severity }[]
}

/** The consolidated tool result. */
export interface ReviewReport {
  report: string
  scope: {
    repoRoot: string
    base: string | null
    command: string
    files: string[]
    untracked: string[]
    diffBytes: number
    includedBytes: number
    truncated: boolean
    empty: boolean
  }
  agents: {
    role: string
    title: string
    name: string | null
    agentId: string | null
    creation: string
    runStatus: string
    stopReason: string | null
    diagnostic: string | null
    error: string | null
    durationMs: number | null
    promptBytes: number
    outputBytes: number
  }[]
  findings: Finding[]
  conflicts: Conflict[]
  unverified: { reviewer: string; item: string }[]
  unparsed: UnparsedOutput[]
  stats: {
    created: number
    completed: number
    requested: number
    counts: Record<Severity, number>
  }
}

type RawFinding = Finding & { reviewer: string }

/** Extract the reviewer's JSON block; report parse failures instead of guessing. */
export function parseReviewerOutput(text: string): ParsedReviewerOutput {
  const source = typeof text === 'string' ? text : ''
  for (const candidate of jsonCandidates(source)) {
    const parsed = tryParse(candidate)
    if (parsed === undefined) continue
    const findings = Array.isArray(parsed)
      ? parsed
      : isRecord(parsed) && Array.isArray(parsed.findings) ? parsed.findings : undefined
    if (findings === undefined) continue
    const unverified = isRecord(parsed) ? stringList(parsed.unverified) : []
    const notes = isRecord(parsed) && typeof parsed.notes === 'string' ? parsed.notes : ''
    return {
      parsed: true,
      findings: findings.map(normalizeFinding).filter((finding): finding is Finding => finding !== null),
      unverified,
      notes,
      error: null,
    }
  }
  return {
    parsed: false,
    findings: [],
    unverified: [],
    notes: '',
    error: source.trim() === '' ? 'reviewer returned no text' : 'reviewer output contained no parsable JSON findings block',
  }
}

/** Build the consolidated report object returned by the tool. */
export function buildReport(input: {
  scope: ReviewScope
  runs: RunRecord[]
  cfg: ReviewConfig
  empty: boolean
}): ReviewReport {
  const { scope, runs, cfg, empty } = input
  const completed = runs.filter(run => run.runStatus === 'completed')
  const started = runs.filter(run => run.creation === 'created')
  const parsed = new Map<string, ParsedReviewerOutput>()
  const unparsed: UnparsedOutput[] = []

  for (const run of runs) {
    if (run.runStatus !== 'completed') continue
    const result = parseReviewerOutput(run.text)
    if (result.parsed) parsed.set(run.role, result)
    else unparsed.push({ role: run.role, title: run.title, error: result.error ?? 'unparsable', text: run.text })
  }

  const rawFindings: RawFinding[] = []
  for (const [role, result] of parsed) {
    for (const finding of result.findings) rawFindings.push({ ...finding, reviewer: role })
  }

  const findings = dedupeFindings(rawFindings)
  const conflicts = findConflicts(rawFindings)
  const unverified: { reviewer: string; item: string }[] = []
  for (const [role, result] of parsed) {
    for (const item of result.unverified) unverified.push({ reviewer: role, item })
  }
  for (const run of runs) {
    if (run.runStatus !== 'completed' && run.runStatus !== 'not-started') {
      unverified.push({
        reviewer: run.role,
        item: `该 Reviewer 未完成（${run.runStatus}）${run.error === null ? '' : `：${run.error}`}`,
      })
    }
  }

  const counts: Record<Severity, number> = { Critical: 0, High: 0, Medium: 0, Low: 0 }
  for (const finding of findings) counts[finding.severity] += 1

  const report = renderMarkdown({
    scope, runs, cfg, findings, conflicts, unverified, unparsed, counts, completed, started,
  })

  return {
    report,
    scope: {
      repoRoot: scope.repoRoot,
      base: scope.ref,
      command: scope.command,
      files: scope.files,
      untracked: scope.untracked,
      diffBytes: scope.diffBytes,
      includedBytes: scope.includedBytes,
      truncated: scope.truncated,
      empty: scope.empty,
    },
    agents: runs.map(run => ({
      role: run.role,
      title: run.title,
      name: run.agentName,
      agentId: run.agentId,
      creation: run.creation,
      runStatus: run.runStatus,
      stopReason: run.stopReason,
      diagnostic: run.diagnostic,
      error: run.error,
      durationMs: run.durationMs,
      promptBytes: run.promptBytes,
      outputBytes: Buffer.byteLength(run.text),
    })),
    findings,
    conflicts,
    unverified,
    unparsed,
    stats: {
      created: started.length,
      completed: completed.length,
      requested: runs.length,
      counts,
    },
  }
}

function renderMarkdown(input: {
  scope: ReviewScope
  runs: RunRecord[]
  cfg: ReviewConfig
  findings: Finding[]
  conflicts: Conflict[]
  unverified: { reviewer: string; item: string }[]
  unparsed: UnparsedOutput[]
  counts: Record<Severity, number>
  completed: RunRecord[]
  started: RunRecord[]
}): string {
  const { scope, runs, cfg, findings, conflicts, unverified, unparsed, counts, completed, started } = input
  const lines: string[] = []
  lines.push('# 多 Agent Code Review 报告（只读）', '')

  lines.push('## 审查范围', '')
  lines.push(`- 仓库根目录：\`${scope.repoRoot}\``)
  lines.push(`- 基准：${scope.ref === null ? '尚无提交，审查工作区改动' : `\`git diff ${scope.ref}\`（含工作区未提交改动）`}`)
  lines.push(`- 命令：\`${scope.command}\``)
  lines.push(`- 变更文件数：${String(scope.files.length)}`)
  if (scope.files.length > 0) {
    lines.push(`- 变更文件：${scope.files.slice(0, 50).map(file => `\`${file}\``).join('、')}${scope.files.length > 50 ? ' …' : ''}`)
  }
  lines.push(`- diff 字节数：${String(scope.diffBytes)}${scope.truncated ? `（超过上限，仅提供给 Reviewer ${String(scope.includedBytes)} 字节）` : ''}`)
  lines.push(scope.untracked.length === 0
    ? '- 未跟踪文件：无'
    : `- 未跟踪文件（不在任何 diff 中，本次未审查其内容）：${scope.untracked.slice(0, 20).map(file => `\`${file}\``).join('、')}${scope.untracked.length > 20 ? ' …' : ''}`)
  lines.push('')

  lines.push('## Agent 执行状态', '')
  if (runs.length === 0) {
    lines.push('未启动任何 Reviewer（没有可审查的改动）。', '')
    lines.push('## 发现', '', '本次未检测到可审查的改动（diff 为空），因此没有启动任何 Reviewer。这不等于“代码没有问题”。', '')
    lines.push('## Reviewer 之间的分歧', '', '无（没有 Reviewer 运行）。', '')
    lines.push('## 尚未验证的项目', '', '无（没有 Reviewer 运行）。', '')
    lines.push('## 覆盖范围与限制', '')
    lines.push('- 只运行了只读 git 命令，diff 为空，未做任何代码审查。')
    lines.push(`- 基准：${scope.ref === null ? '尚无提交' : `\`git diff ${scope.ref}\``}；未跟踪文件不产生 diff。`, '')
    return lines.join('\n')
  }
  lines.push('| 角色 | Agent 名称 | Agent ID | 创建状态 | 运行状态 | 结束原因 | 耗时 |')
  lines.push('| --- | --- | --- | --- | --- | --- | --- |')
  for (const run of runs) {
    const agentId = run.agentId === null ? '—' : `\`${run.agentId}\``
    const duration = run.durationMs === null ? '—' : `${String(Math.round(run.durationMs / 1000))}s`
    lines.push(`| ${run.title} | ${run.agentName ?? '—'} | ${agentId} | ${run.creation} | ${run.runStatus} | ${run.stopReason ?? '—'} | ${duration} |`)
  }
  lines.push('')
  lines.push(`- 实际创建并启动的 Agent：${String(started.length)} / ${String(runs.length)}`)
  lines.push(`- Agent ID：${started.length === 0 ? '无' : started.map(run => `\`${String(run.agentId)}\``).join('、')}`)
  lines.push(`- 完成并参与汇总：${String(completed.length)} / ${String(runs.length)}`)

  const notStarted = runs.filter(run => run.runStatus === 'not-started' || run.runStatus === 'cancelled' || run.creation === 'not-attempted')
  const failedStart = runs.filter(run => run.creation === 'failed')
  const failedRun = runs.filter(run => started.includes(run) && run.runStatus !== 'completed' && run.runStatus !== 'running')
  lines.push(notStarted.length > 0 ? `- 未执行：${notStarted.map(run => run.title).join('、')}` : '- 未执行：无')
  lines.push(failedStart.length > 0
    ? `- 创建失败：${failedStart.map(run => `${run.title}（${run.error ?? 'unknown error'}）`).join('；')}`
    : '- 创建失败：无')
  lines.push(failedRun.length > 0
    ? `- 运行失败/超时：${failedRun.map(run => `${run.title}（${run.runStatus}${run.error === null ? '' : `：${run.error}`}）`).join('；')}`
    : '- 运行失败/超时：无')
  lines.push('')

  lines.push('## 发现', '')
  if (findings.length === 0) {
    if (completed.length === runs.length && unparsed.length === 0) {
      lines.push('本次审查未发现问题。', '')
      lines.push('该结论只表示：在下方“审查范围”内、由已完成的 Reviewer 按其职责检查后没有报告发现；它不表示代码没有问题，也不证明代码正确。', '')
    } else {
      lines.push('已完成的 Reviewer 没有报告发现，但本次审查未覆盖全部角色或存在无法解析的输出，因此不能据此认为没有发现问题。', '')
    }
  } else {
    lines.push(`按严重程度：Critical ${String(counts.Critical)}、High ${String(counts.High)}、Medium ${String(counts.Medium)}、Low ${String(counts.Low)}。`, '')
    let index = 0
    for (const severity of SEVERITIES) {
      const group = findings.filter(finding => finding.severity === severity)
      if (group.length === 0) continue
      lines.push(`### ${severity}`, '')
      for (const finding of group) {
        index += 1
        const location = finding.file === null
          ? '（无法定位文件）'
          : `\`${finding.file}\`${finding.line === null ? '' : `:${String(finding.line)}`}`
        lines.push(`${String(index)}. **${location}**`)
        if (finding.locationNote !== '') lines.push(`   - 定位说明：${finding.locationNote}`)
        lines.push(`   - 代码证据：${quote(finding.evidence)}`)
        lines.push(`   - 触发条件：${quote(finding.trigger)}`)
        lines.push(`   - 具体影响：${quote(finding.impact)}`)
        lines.push(`   - 建议修复方向：${quote(finding.fix)}`)
        lines.push(`   - Reviewer：${finding.reviewers.join('、')}（置信度 ${finding.confidence === null ? '未给出' : String(finding.confidence)}）`)
        if (finding.reviewers.length > 1) {
          lines.push(`   - 多 Reviewer 一致：是（${finding.reviewers.join('、')}）。一致不等于已验证。`)
        }
        if (finding.needsHuman) lines.push('   - 需要人工判断：是')
        lines.push('')
      }
    }
  }

  lines.push('## Reviewer 之间的分歧', '')
  if (conflicts.length === 0) lines.push('未发现同一位置被不同 Reviewer 给出不同严重程度的情况。')
  else {
    for (const conflict of conflicts) {
      lines.push(`- \`${conflict.file}:${String(conflict.line)}\`：${conflict.entries.map(entry => `${entry.reviewer} 认为 ${entry.severity}`).join('；')}。需要人工判断。`)
    }
  }
  lines.push('')

  lines.push('## 尚未验证的项目', '')
  if (unverified.length === 0) lines.push('无（这表示没有 Reviewer 声明未验证项，不代表所有结论都已被验证）。')
  else for (const item of unverified) lines.push(`- [${item.reviewer}] ${item.item}`)
  lines.push('')

  if (unparsed.length > 0) {
    lines.push('## 无法结构化的 Reviewer 输出', '')
    for (const entry of unparsed) {
      lines.push(`### ${entry.title}（${entry.role}）`, '', `未解析原因：${entry.error}。原始输出如下（截断至 2000 字符）：`, '', '```text', clamp(entry.text, 2000), '```', '')
    }
  }

  lines.push('## 覆盖范围与限制', '')
  lines.push('- 只审查了上面列出的变更文件；未跟踪文件、未列出的改动和仓库其余代码不在范围内。')
  lines.push('- Reviewer 被要求只读、且禁止运行构建/测试命令；因此“测试通过”一类结论都没有执行证据，需要人工验证。')
  lines.push('- “只读”是由 Reviewer 的提示词和宿主权限模式保证的，插件本身不做写入；本插件无法阻止子 Agent 越权写入。')
  lines.push('- Reviewer 的输出（包括代码注释与 diff 内容）被视为不可信数据，插件只做去重与展示，不据此放宽任何限制。')
  lines.push(`- 并发上限 ${String(cfg.maxConcurrent)}，单个 Reviewer 超时 ${String(cfg.timeoutMs)} ms，不重试。`)
  lines.push('')
  return lines.join('\n')
}

function normalizeFinding(raw: unknown): Finding | null {
  if (!isRecord(raw)) return null
  const severityRaw = typeof raw.severity === 'string' ? raw.severity.trim() : ''
  const severity = SEVERITY_ALIASES.get(severityRaw.toLowerCase())
  const file = typeof raw.file === 'string' && raw.file.trim() !== '' ? raw.file.trim() : null
  const line = Number.isInteger(raw.line) && (raw.line as number) > 0 ? raw.line as number : null
  const confidence = typeof raw.confidence === 'number' && Number.isFinite(raw.confidence)
    ? Math.max(0, Math.min(1, raw.confidence))
    : null
  const locationNote = typeof raw.location_note === 'string' ? raw.location_note.trim() : ''
  return {
    severity: severity ?? 'Medium',
    severityAssumed: severity === undefined,
    file,
    line,
    locationNote,
    evidence: text(raw.evidence),
    trigger: text(raw.trigger),
    impact: text(raw.impact),
    fix: text(raw.fix),
    confidence,
    needsHuman: raw.needs_human === true,
    reviewers: [],
  }
}

function dedupeFindings(findings: RawFinding[]): Finding[] {
  const unique = new Map<string, Finding>()
  for (const finding of findings) {
    const key = [
      finding.file ?? '',
      finding.line ?? '',
      finding.severity,
      finding.evidence.toLowerCase().replace(/\s+/g, ' ').slice(0, 120),
    ].join('|')
    const existing = unique.get(key)
    if (existing === undefined) {
      unique.set(key, { ...finding, reviewers: [finding.reviewer] })
      continue
    }
    if (!existing.reviewers.includes(finding.reviewer)) existing.reviewers.push(finding.reviewer)
    if (finding.needsHuman) existing.needsHuman = true
    if (existing.confidence === null || (finding.confidence !== null && finding.confidence > existing.confidence)) {
      existing.confidence = finding.confidence
    }
  }
  return [...unique.values()]
}

function findConflicts(findings: RawFinding[]): Conflict[] {
  const byLocation = new Map<string, RawFinding[]>()
  for (const finding of findings) {
    if (finding.file === null || finding.line === null) continue
    const key = `${finding.file}:${String(finding.line)}`
    const list = byLocation.get(key) ?? []
    list.push(finding)
    byLocation.set(key, list)
  }
  const conflicts: Conflict[] = []
  for (const [key, list] of byLocation) {
    const severities = new Set(list.map(finding => finding.severity))
    if (severities.size < 2) continue
    const separator = key.lastIndexOf(':')
    conflicts.push({
      file: key.slice(0, separator),
      line: Number(key.slice(separator + 1)),
      entries: list.map(finding => ({ reviewer: finding.reviewer, severity: finding.severity })),
    })
  }
  return conflicts
}

function* jsonCandidates(source: string): Generator<string> {
  const fences = [...source.matchAll(/```(?:json|JSON)?\s*\r?\n([\s\S]*?)```/g)]
  for (const fence of fences.reverse()) {
    const body = fence[1]
    if (body !== undefined) yield body
  }
  const firstBrace = source.indexOf('{')
  const lastBrace = source.lastIndexOf('}')
  if (firstBrace !== -1 && lastBrace > firstBrace) yield source.slice(firstBrace, lastBrace + 1)
  const firstBracket = source.indexOf('[')
  const lastBracket = source.lastIndexOf(']')
  if (firstBracket !== -1 && lastBracket > firstBracket) yield source.slice(firstBracket, lastBracket + 1)
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text.trim())
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string' && entry.trim() !== '').map(entry => entry.trim())
    : []
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clamp(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n…[truncated]`
}

/** Keep each quoted field on one bounded line so a value cannot forge report structure. */
function quote(value: string): string {
  if (value === '') return '（Reviewer 未提供）'
  return clamp(value.replace(/\r?\n+/g, ' ⏎ '), 1200)
}
