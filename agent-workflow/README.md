# DSH 受控工作流插件

当前插件版本为 0.9.3。插件把 `agent-workflow` Core 的状态投射成受控工具和暂停状态，**Core 是唯一状态机**：

0.9.3 修复 Implement 证据重试：代码已写入状态不会因提交失败丢失，补交证据无需再次批准。
已批准的计划定义在写入文档前受校验；确需修改时，先用 `changes-required` 返回 Plan 生成新提案。

小修改使用 `workflow_apply({changes:[{path,edits:[{oldText,newText}]}]})`，原文须唯一精确匹配，
多处编辑基于批准的原文件且不重叠。新增文件用 `{path,content}`，删除用 `content:null`，可同批混用。
Core 负责完整文件写入，无需人工补丁或让模型重写大文件；一次批准仍只允许一批。

0.9.1 修复多文档提交：整批预校验后发布一个检查点；简报直接列出当前阶段 items 和允许文档名。
Source Capture 复用已捕获来源，普通暂停用 continue，只有基线冲突才考虑 reconcile。

1. `workflow_stage` / `workflow_submit` 只在拥有受控任务的会话里存在（条件注册），模型用它们读取
   Core 的阶段简报、提交本阶段产物与证据；
2. `agent/turn-stopping` 里查一次 Core：当前阶段没提交就用 `agent.steer()` 重开回合，每阶段最多 5 次，
   模型无法在阶段未推进时安静收尾；
3. `tools.guard` 让代码仓库始终不接受原生 write/edit 或 Shell：文档只能写到私有暂存目录，批准后的代码只能通过 `workflow_apply` 进入 Core 的精确前像校验和一次性批准。

阶段、门禁、检查点、证据校验与验证合同全部由 Core 决定；插件不生产内容。
模型全程在同一份上下文里逐阶段推进：文档写到 `os.tmpdir()/dsh-workflow/<task-id>/`，由插件读入后
交给 `controller.artifact()` 落盘；Implement 阶段模型用 `workflow_apply` 提交局部编辑或完整文件内容，Verify 由 Core 固定检查器执行。
这能强制顺序、范围与人工批准点，不能自动证明分析正确、代码充分或审查可靠。

## 安装

适配 DSH `0.2.2-rc.3`（`engines.dsh: >=0.2.2-rc.3 <0.3.0`），需要支持 `tools.guard()`、
条件工具注册与 `agent/turn-stopping` 事件的 Host。插件源码为 TypeScript，`pnpm install` 后
`pnpm build` 产出 `dist/`；
Host 加载 `dist/src/index.js`，`@deepseek-ai/*` 由运行中的 DSH 安装解析。
Node 端与浏览器端统一使用 tsdown 构建，类型检查保留 `tsc --noEmit`。
浏览器入口 `dist/client.js` 打包为 DSH ModuleLoader 工厂，React 使用宿主实例；Node 端保留目录结构，Core 与 DSH 依赖由运行环境解析。
源码构建需 Node.js 22.19+（22.x）、24.11+（24.x）或 26+。
本目录依赖同级上层仓库 `../../agent-workflow`，需要先构建公开 `/control` 接口：

```powershell
cd D:\Project\agent-workflow
npm ci
npm run build
cd D:\Project\dsh-plugins\agent-workflow
pnpm install --force --ignore-scripts
pnpm check
pnpm build
pnpm test
```

生产分发时应把 `file:` 依赖换成包含 `/control` 接口的正式包版本；当前未发布该版本。
插件导入公开 package export，不导入 Core `src/`，也不会自动修改业务仓库的依赖或配置。

在 **独立 DSH Profile** 中通过 Plugins → Add plugin 选择本目录，或使用 DSH 的本地 bundle 安装方式。
bundle 的 `cordis.patch.yml` 注册插件，安装后在新会话使用。
该 Profile 必须挂载 **native** 工具执行器（`@deepseek-ai/dsh-tool-executor-native`），不要用 PTC 执行器。
插件依赖 `tools.guard()`、`ctx.tools.register(def, { when })`、`agent/turn-stopping` 事件与
`agent.steer()`；`/workflow doctor` 会报告这些能力是否可用。
该 Profile 必须使用固定可信插件组合，禁止模型卸载/热重载 guard 或修改部署文件。

## 阶段推进与停止点

Web/桌面客户端加载本插件的 `./client` 入口后，`/workflow run*` 会在进度卡上显示启动与 Core 进度。
进度是可忽略的 plugin record，进入进度卡但不进入模型上下文，也不授予权限；纯 Host/TUI 不含这张卡片。

真正的阶段推进靠会话内的注入：`/workflow run*` 创建任务后，插件用 `agent.steer()` 把首个阶段简报
送进对话（任务、阶段、Core Route Packet、任务目录、暂存目录与提交要求）。模型做完本阶段、用
`workflow_submit` 提交后，工具结果里直接带下一阶段简报；若模型想收尾，`agent/turn-stopping` 会
再注入一次提醒。到实施批准点插件不再 steer，命令返回阶段摘要与下一步；失败也直接作为命令错误显示。
期间按界面停止键即可中断，之后用 `/workflow status` 查看落点、`/workflow resume <task-id>` 继续。

## 使用

先在已有 `.agent-workflow/config.json`、AGENTS.md 和至少一个 Git 提交的工作区打开新会话。
工作区路径必须是仓库根目录，tasksRoot 目录须已初始化。

```text
/workflow run D:\Downloads\request.md
/workflow lookup <精确需求或缺陷编号>
/workflow run <精确需求或缺陷编号>
/workflow run-defect D:\Downloads\bug.md
/workflow run-requirement D:\Downloads\request.md
/workflow run-maintenance D:\Downloads\maintenance.md
```

`lookup` 仅返回编号详情和识别类型，不创建任务、不替换当前任务、不调度模型。
`run` 查询后创建任务，按 Provider 的类型识别需求或缺陷；显式 run-defect/run-requirement
若与查询结果冲突则拒绝。编号规则由 Active Profile 的 Source Provider 管理，Core 保持通用。
文档路径可含空格，命令后的整段文本直接作为路径，不加引号。

模型每阶段先用 `workflow_stage` 读简报（包含 stateToken、规范影响和依赖状态），按包里的产物格式与
证据要求把本阶段文档写到暂存目录，再调用：

```text
workflow_submit({ stateToken, files, evidence, items, verdict: "ready", reason })
```

`files` 是暂存目录里的任务文档相对路径；`items` 必须精确覆盖 `plan.md` 中本阶段全部未完成工作项；
`evidence` 形如 `prd.md#Summary`。插件读入文档后调用 `controller.artifact()`，再调用
`controller.submit()`；Core 拒绝时错误原样回到模型，按提示修正后重交。Plan 阶段额外给出
`summary` 与 `planFiles`（要修改的仓库相对路径），插件提交 proposal 后停下。

实施前人工核对完整 plan、summary、文件范围、前像：

```text
/workflow status
/workflow status --json
/workflow approve
```

默认 status 展示阶段、权限、proposal、完整文件范围与前像、完整计划和下一步；`--json` 保留完整机器状态。
`approve` 只批准当前提案（也可显式给 id）。批准后只显示 `workflow_apply({ changes })`；原生 write/edit 与 Shell 仍关闭，Core 负责前像、范围、一次性批准和固定检查器。
当前没有图形批准按钮。既有任务用 `/workflow resume <task-id>`，恢复进度但不继承批准状态。
`/workflow pause` 持久化暂停并解除钩子；`/workflow continue` 人工解除普通暂停，仍需重新批准写入。

## 固定构件与部署诊断

开发仓库仍使用 `file:../../agent-workflow`。两仓库构建和检查通过后运行 `npm run bundle`，
在本仓库 `build/agent-workflow-<版本>-<标识>/` 生成独立部署目录：已编译插件、Core 的 core.tgz、
本地包依赖、固定版本 MCP client、静态检查器示例和 SHA256SUMS。构件保存当时的字节快照，不再引用开发源码。
该命令不构建、不安装、不发布，也不修改运行 Profile；只打包已经检查过的输出。

在生成目录执行 `pnpm install --prod --ignore-scripts`，再按 DSH 本地 bundle 方式选择该目录。
peer 依赖继续由 DSH 提供；`pnpm-workspace.yaml` 的 autoInstallPeers=false 禁止自动安装另一份 DSH。
校验摘要用于核对构件，不等于签名或保证可重复构建。

```text
/workflow doctor
```

无需先绑定任务。报告插件/Core/Node 版本、Profile、Provider 名称、Git 根、任务目录、runtime
忽略规则、可用 Skill、检查器 ID、guard、条件工具与 turn-stopping 可用性；不输出凭据或完整配置，不查询远端，
不创建任务或目录。宿主契约没有暴露 DSH 版本和实际执行器，doctor 会明确要求人工确认。

## 重复请求与中断恢复

V3 对阶段提交和文件批次生成稳定操作编号，回执保存在项目 runtimeRoot/control-operations 下。
该目录必须被 Git 忽略；回执独立于任务与授权基线，只负责去重，不授予权限。保留该目录才能跨重启去重。
相同请求重复到达时返回已有回执，不再次推进或写入；阶段重放返回当前状态，避免旧 Packet 驱动新工作。

`status` 输出 nextAction、recovery、taskDirectory。恢复时区分：等待批准、已写入待补证据、普通暂停、
仓库/产物待 reconcile，以及尚无回执的不明操作。已写入且有回执的批次可继续阶段证据，不继承新写权限。
审批前的阶段屏障也会持久保留，resume 和 continue 均不会绕过。

存在不明操作时先核对 status/diff 和实际文件。若代码/产物未发布：

```text
/workflow task ["checkpoint","--reconcile","--expected-revision","<status中的revision>","--reason","已人工核对部分写入和任务证据"]
/workflow recover
```

recover 只承认已核对的现场并解除屏障，不重做旧请求、不回滚、不恢复旧批准。
正在写入的锁不能绕过；残留锁必须先确认没有存活执行者。

## 固定检查器

插件仅执行可信部署配置的 `checks`。默认没有检查器，Verify 保持未验证并返回缺口；
不会猜测或运行业务项目的构建/测试。部署者必须遵守目标项目 AGENTS，禁止测试的项目只配置允许的静态检查。

```yaml
checks:
  - id: static-check
    command: 'C:\Program Files\nodejs\node.exe'
    args: ['D:\trusted-checkers\check-source.mjs']
    timeoutMs: 30000
    testId: VT1
maxCorrections: 2
```

有 verification.json 时，testId 必须绑定 executor=agent、method=static/cli 的测试点。
Core 先登记执行基线，再运行固定命令，按真实退出结果写入独立证据并执行 verify-record；
代码或任务基线被检查器修改时拒绝登记通过。一次失败返回修正 Packet，连续失败达到 Core 预算后持久化暂停。
Review/Verify 返回 `changes-required` 时要求有效发现证据与具体原因，Core 回到 Plan 并重置受影响工作项，
方案修订后必须重新 proposal 和人工批准。

可选的 `deploy/check-changed-js.mjs` 只对当前 Git 仓库中相对 HEAD 的变更和未跟踪 JavaScript
运行 `node --check`，不导入/执行业务代码，不触发构建或测试。它不覆盖嵌套独立仓库、TypeScript、
浏览器或业务行为；使用 `deploy/checks.example.yml` 时替换绝对路径。

## 验证与边界

- `pnpm check`：`tsc --noEmit`，不构建。
- `pnpm test`：部署检查器、浏览器 client 入口和插件 guard/命令适配层测试；需要先 `pnpm build`。
- Core 的 `quality:policy` 包含真实临时 Git 仓库、任务阶段/产物门禁、批准/重放、外部改动、
  范围/前像、写锁与部分写入恢复的回归。
- 尚未在图形界面做模型端到端验收。

这是 DSH 工具管线的强制边界，不是 OS 沙箱。绕开共享管线的第三方执行器、可修改部署的同机进程、
人工通过其它终端写入以及插件卸载均在保证范围外。多文件写入不是事务：遇到部分写入或检查点失败，
保留差异并人工核对，不能盲重试。宿主必须在插件激活失败时停止启动模型任务。

Core API 和失败恢复细节见 `D:\Project\agent-workflow\docs\host-control.md`。
V4 实际部署验收步骤见 [deploy/ACCEPTANCE.md](deploy/ACCEPTANCE.md)。

`/workflow spec-init {"baselines":[".agent-workflow/specs/export.json"],"capabilities":[]}` 捕获明确规范基线；`/workflow spec-impact` 查看原规则、新规则、场景、AC/VT 和依赖阻塞；`/workflow pause` 保留任务绑定并记录原因。
