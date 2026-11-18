# Multi-agent code review

DSH 插件：对**当前 Git 改动**做只读多 Agent 代码审查，最后汇总成一份可追踪的报告。

- 通过 DSH 正式的子 Agent 接口（`ctx.subagents.startActivation`）真实创建 3 个独立 Reviewer Agent，不是用提示词扮演多角色。
- 3 个角色：业务逻辑、安全与健壮性、测试。默认全部并行（受并发上限约束）。
- 插件本身只执行只读 git 命令，不修改被审查的代码。
- 报告单独列出：实际创建的 Agent 数量与 ID、创建/运行失败与超时、已检查范围、未验证项、Reviewer 之间的分歧。

## 安装 / 启用

本包是本地 bundle（Host-only）。二选一：

**A. 让 Agent 安装**（推荐）：让 Agent 执行
`plugin_manager` → `action: install_bundle`，`target` 填本目录绝对路径（`D:\Project\dsh-plugins\multi-agent-review`）。

**B. 手工安装**：DSH 侧边栏 **Plugins → Add plugin**，选择本目录；装好后在 Plugins 列表确认「多 Agent 代码审查」已启用。

安装后在**新会话**中生效（`code_review` 工具出现在工具列表里）。

## 触发

**方式一：`/review` 斜杠命令（直接跑，不经过模型）**

```text
/review                         审查未提交改动（vs HEAD）
/review origin/main             审查相对 origin/main 的改动（含未提交）
/review origin/main src/data    只看指定路径
/review -- src/data .proxyTable 首参数是路径时，用 -- 分隔
```

命令由 Host 直接执行 scope → 3 个子 Agent → 报告，结果作为命令输出显示；不消耗父会话的模型上下文。参数非法或 git 失败时以命令错误返回原因。

**方式二：对 Agent 说**

- 「审查当前改动」→ 审查工作区未提交改动（staged + unstaged）相对 `HEAD` 的 diff。
- 「审查相对 origin/main 的改动」→ 审查 `git diff origin/main`（含未提交改动）。

模型调用形如：

```json
{"base": "origin/main", "paths": ["src/data/"]}
```

## 配置

行 id `multi-agent-review` 的 `config`（写入 profile 的 `cordis.patch.yml`；本插件不声明 Config schema，直接读取下列字段，未知字段忽略）：

| 字段 | 默认 | 说明 |
| --- | --- | --- |
| `provider` | `spawn` | `ctx.subagents` 的 provider 名（`spawn` 为同进程新建子 Agent） |
| `toolName` | `code_review` | 暴露给模型的工具名 |
| `maxConcurrent` | `3` | 同时运行的 Reviewer 数上限 |
| `timeoutMs` | `600000` | 单个 Reviewer 的超时（毫秒），超时即取消，不重试 |
| `commandTimeoutMs` | `30000` | 单条 git 命令超时（毫秒） |
| `maxDiffBytes` | `150000` | 塞进 Reviewer 提示词的 diff 字节上限，超出截断并在报告与提示词中声明 |

## 报告包含

审查范围（仓库根、基准、命令、文件清单、未跟踪文件、是否截断）／Agent 执行状态表（名称、Agent ID、创建状态、运行状态、结束原因、耗时）／按严重程度分组的发现（文件:行号、代码证据、触发条件、影响、修复方向、Reviewer 与置信度）／分歧／未验证项／覆盖范围与限制。

- 同一位置的发现按严重程度分组后去重；不同 Reviewer 报告同一问题时标注「多 Reviewer 一致」，并明确写「一致不等于已验证」。
- 同一位置出现不同严重程度时，保留两种结论并标记需要人工判断。
- 没有任何发现且全部 Reviewer 正常完成时，报告写「本次审查未发现问题」并给出覆盖范围与限制，不会写「代码没有问题」。

## 验证状态

- **平台模拟测试**：`npm test`（12/12 通过，跑 `dist/` 编译产物）。覆盖入口 `apply()` 的工具+命令注册与配置、`/review` 参数解析与完整流水线（含错误返回）、范围识别（真实临时 git 仓库）、diff 截断、JSON 解析、去重/分歧/「未发现问题」措辞、创建失败/超时/取消的状态记录。`ctx.subprocess`、`ctx.workingDirectory`、`ctx.subagents` 均为测试内模拟实现。
- **`/review` 的 UI 调用未验证**：命令已注册（`application: applied`，且 `apply()` 未抛错才会注册工具），但本会话没有浏览器控制，无法替你敲一次；请自己试 `/review`。
- **真实 DSH 调度验证**（2026-11-13，JS 版本，profile `desktop`，模型 `jackyun/deepseek-flash`）：对 `DF.JackYun.Web.Common` 的 7 个文件 / 27918 字节未提交改动调用 `code_review`，真实创建并完成 3 个子 Agent（`reviewer-business` 438s、`reviewer-security` 277s、`reviewer-tests` 404s），报告含各自 Agent ID、0 创建失败、0 超时、10 条带证据的发现与 18 条未验证项。
- **TS 构建装载验证**：重新安装 1.1.0 后，`require.resolve('@local/multi-agent-review')` 解析到 `dist/index.js`，独立 Node 进程 `import()` 该入口得到 `apply/name/inject`；新会话中子 Agent 的工具列表可见 `code_review`（参数 `base`、`paths`），说明运行的是编译产物而非旧 JS。
- 实测耗时接近默认 `timeoutMs`（600s）：大 diff 或慢模型建议把 `timeoutMs` 调到 `1200000`。
- 安装结果以 `plugin_manager` 的 `application: applied` 为准。

## 已知限制

1. **只读靠约束而非强制**：Reviewer 的只读来自提示词 + 宿主权限模式；插件无法替子 Agent 裁剪工具，本 profile 默认权限为 `danger-full-access`，子 Agent 技术上具备写入能力。需要硬保证时，请把会话权限切到 `read-only` 再审查。
2. **不运行测试**：Reviewer 被禁止运行构建/测试命令（宿主项目规则），"测试通过"类结论一律作为未验证项。
3. **范围只限 diff**：未跟踪文件、被截断的 diff 尾部、未列出的文件都不在审查范围内；Reviewer 可按提示自查只读 git，但不保证。
4. **不重试**：启动失败或超时按实际状态上报，不做无限重试。
5. **Reviewer 输出是不可信数据**：只做解析、去重与展示；解析失败时原样附在报告里。
6. 子 Agent 与父 Agent 使用同一模型与预设（`agentPreset` 未指定），因此 Reviewer 不具备更强的专业模型。

## 构建（TypeScript）

源码在 `src/*.ts`，DSH 加载的是编译产物 `dist/*.js`（`exports` 指向 `./dist/index.js`），与 DSH 官方包 `src/*.ts + lib/*.js` 的结构一致。

```powershell
npm install          # 只装 devDependencies：typescript + @types/node（不参与运行时）
npm run build        # tsc -p tsconfig.json -> dist/
npm test             # node test/run.mjs，跑编译产物
```

- 运行时依赖为零：`dist/` 不 import 任何包，只用 Node 内置能力。
- DSH 类型在 `src/types/dsh.ts` 本地声明：npm 上的 `@deepseek-ai/*` 没有与本机 `0.2.2-rc.2` 对应的版本，导入它们会得到与运行版本不一致的类型。
- 改完源码要重新 `npm run build`，然后重启 DSH（或 toggle 插件）才会加载新的模块代。

## 目录

```
src/index.ts        插件入口：工具定义 + 注册 /review
src/command.ts      /review 命令：参数解析与同一条审查流水线
src/scope.ts        审查范围：只读 git diff / 文件清单 / 未跟踪文件
src/dispatch.ts     子 Agent 调度：并发上限、超时、状态与结果收集
src/report.ts       报告：解析、去重、分歧、未验证项、Markdown
src/prompts.ts      三个角色提示词与输出契约
src/config.ts       配置默认值与容错读取
src/types/dsh.ts    DSH Host 契约的本地类型声明（非运行时依赖）
dist/               tsc 编译产物（插件实际入口）
test/run.mjs        平台模拟自检（跑 dist/）
```

