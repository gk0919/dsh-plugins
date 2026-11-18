/**
 * Minimal local type declarations for the DSH Host contracts this plugin
 * consumes. They mirror the shapes verified in the running installation
 * (0.2.2-rc.2); they are NOT a re-export of `@deepseek-ai/*`, whose published
 * versions do not track the installed build.
 *
 * Sources (installed checkout):
 *   packages/core/tools/src/contracts.ts  -> ToolDefinition, ToolRunContext
 *   packages/subagent/subagent/src/types.ts -> SubagentActivation, SubagentResult
 *   packages/core/subprocess/src/types.ts  -> SubprocessSpawnSpec, SubprocessHandle
 *   packages/core/commands/src/types.ts    -> CommandResult, CommandDefinition
 *   packages/session/working-directory/src/index.ts -> WorkingDirectoryService
 */

/** One model-facing content block. Only text blocks are read or produced here. */
export interface ContentBlock {
  type: string
  text?: string
}

/** Live agent handle; the tool run context supplies the calling agent. */
export interface Agent {
  readonly id: string
}

/** Per-call context handed to `ToolDefinition.execute`. */
export interface ToolRunContext {
  readonly agent?: Agent
  readonly signal: AbortSignal
}

/** Registry-ready tool description; `parameters` is raw JSON Schema. */
export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: unknown
    render(args: unknown, value: unknown): ContentBlock[]
  }
  isConcurrencySafe?(args: unknown): boolean
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}

/** Terminal outcome of one subagent run. */
export interface SubagentResult {
  readonly output: readonly ContentBlock[]
  readonly stopReason: string
  readonly diagnostic?: string
}

/** One managed child execution owned by the caller until disposal. */
export interface SubagentActivation {
  readonly childId: string
  readonly name: string
  readonly result: Promise<SubagentResult>
  dispose(): Promise<void>
}

/** Start request accepted by `ctx.subagents.startActivation`. */
export interface SubagentActivationSpec {
  provider: string
  label: string
  name?: string
  prompt: ContentBlock[]
  parent: Agent
  signal: AbortSignal
  delivery: 'parent' | 'caller'
}

/** `ctx.subagents` seam (consume-only here). */
export interface SubagentsService {
  startActivation(spec: SubagentActivationSpec): Promise<SubagentActivation>
}

/** Offset-based reader for one collected subprocess stream. */
export interface SubprocessOutputReader {
  readFrom(fromByte: number): { text: string }
}

/** Live subprocess handle exposing exit facts and collected output. */
export interface SubprocessHandle {
  readonly collected: {
    readonly stdout?: SubprocessOutputReader
    readonly stderr?: SubprocessOutputReader
  }
  readonly done: Promise<{ exitCode: number | null }>
}

/** One fully specified spawn request; argv is never shell-interpreted. */
export interface SubprocessSpawnSpec {
  argv: readonly string[]
  cwd: string
  stdio: {
    stdin: 'ignore'
    stdout: { maxBytes: number }
    stderr: { maxBytes: number }
  }
  graceMs: number
  signal?: AbortSignal
}

/** `ctx.subprocess` seam (consume-only here). */
export interface SubprocessService {
  spawn(spec: SubprocessSpawnSpec): SubprocessHandle
}

/** `ctx.workingDirectory` seam (consume-only here). */
export interface WorkingDirectoryService {
  ensure(agent: Agent, signal?: AbortSignal): Promise<string>
}

/** Expected command outcome rendered directly by the dispatching UI. */
export type CommandResult =
  | { readonly kind: 'success'; readonly text?: string }
  | { readonly kind: 'error'; readonly text: string }

/** Invocation passed to one registered slash command's handler. */
export interface CommandInvocation {
  readonly agent: Agent
  /** Exact text following the command name, including separator whitespace. */
  readonly rawInput: string
  readonly signal: AbortSignal
}

/** One plugin-owned human-facing command. */
export interface CommandDefinition {
  readonly name: string
  readonly description: string
  readonly input?: { readonly hint: string }
  handler(invocation: CommandInvocation): CommandResult | Promise<CommandResult>
}

/** The subset of the Cordis plugin context this plugin uses. */
export interface PluginContext {
  tools: {
    register(definition: ToolDefinition): () => void
  }
  commands: {
    register(definition: CommandDefinition): () => void
  }
  effect(setup: () => () => void): () => void
  subagents: SubagentsService
  subprocess: SubprocessService
  workingDirectory: WorkingDirectoryService
}
