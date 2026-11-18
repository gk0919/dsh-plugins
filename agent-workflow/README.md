# DSH 受控工作流插件

这是第一版可运行适配器。人工 `/workflow` 命令直接调用代码，模型通过专用工具读取、
撰写任务文档和提交变更。任务阶段、先决条件、检查点与验证合同仍由 `agent-workflow` 管理。

代码写入必须同时满足：Core 处于 Implement、人工批准当前 proposal、方案和仓库基线未变、
文件处于批准范围且前像哈希一致。每次批准只能提交一批变更；方案变化或恢复后重新批准。
这能强制工具权限和门禁顺序，不能自动证明 AI 的分析正确、代码充分必要或审查结论可靠。

## 安装

适配 DSH `0.2.2-rc.3`（`engines.dsh: >=0.2.2-rc.3 <0.3.0`），需要支持 `tools.guard()` 的 Host。
宿主启用 Node 22.19+。插件源码为 TypeScript，`pnpm install` 后 `pnpm build` 产出 `dist/`；
Host 加载 `dist/src/index.js`，`@deepseek-ai/*` 由运行中的 DSH 安装解析，不在本包内重复安装。
本目录依赖同级上层仓库 `../../agent-workflow`，需要先构建新增公开 `/control` 接口：

```powershell
cd D:\Project\agent-workflow
npm ci
npm run build
cd D:\Project\dsh-plugins\agent-workflow
pnpm install
pnpm check
pnpm build
pnpm test
pnpm test:dsh
```

生产分发时应把 `file:` 依赖换成包含 `/control` 接口的正式包版本；当前未发布该版本。
插件导入公开 package export，不导入 Core `src/`，也不会自动修改业务仓库的依赖或配置。

在 **独立 DSH Profile** 中通过 Plugins → Add plugin 选择本目录，或使用 DSH 的本地 bundle
安装方式。bundle 的 `cordis.patch.yml` 注册插件，安装后在新会话使用。
该 Profile 必须挂载 **native** 工具执行器（`@deepseek-ai/dsh-tool-executor-native`），
不要挂载 PTC 执行器：0.2.2-rc.3 已移除 tools 插件的 `config.mode`，执行器改由插件决定。
插件会拒绝 `run_code`，ptc 模式下模型无法调用这些专用工具。

该 Profile 必须使用固定可信插件组合，禁止模型卸载/热重载 guard 或修改部署文件。
插件/Core 代码与部署配置应放在模型工作区之外并设为只读。插件卸载以后 DSH 会撤销 guard，
因此不能把“可由模型管理插件的普通 Profile”当作隔离环境。

插件的全局 guard 对此 Profile 中所有 Agent 生效：只放行本插件的 `workflow_*` 名称，
其余 shell、编辑、MCP、子代理、插件管理、任意代码执行以及未来新增工具均被拒绝。
未绑定任务的 Agent 也无法使用这些专用工具。不要在日常通用 Profile 直接启用。

## 使用

先在已有 `.agent-workflow/config.json`、AGENTS.md 和至少一个 Git 提交的工作区打开新会话。
工作区路径必须是仓库根目录，tasksRoot 目录须已初始化。业务需求选用项目实际 Route、Entry
和 Source Type，不能为省略业务门禁套用 maintenance。

```text
/workflow help
/workflow start {"taskId":"example-task","route":"task-workflow-maintenance","entry":"not-applicable","goal":"调整工作流配置"}
```

业务任务的 start 还可传 `sourceType`、`sourceText`、`sourceId`，由 Core 校验有效性。
来源快照在初始化时由宿主记录，后续模型不能修改。已有任务用：

```text
/workflow resume example-task
```

然后告诉模型：**“先调用 workflow_context，按当前阶段分析并撰写任务方案，提交 proposal 后等待我批准。”**
人工命令输出显示在命令面板；它不会伪装成用户消息自动驱动模型继续。

模型工具：

| 工具 | 能力 |
|---|---|
| `workflow_status` | 当前阶段、完整 Core plan、proposal、是否仍有有效批准 |
| `workflow_context` | 由 Core `workflow:next` 物化当前 Route Packet |
| `workflow_list` | 列目录，单次最多 1000 项，不递归链接 |
| `workflow_read` | 读取 UTF-8 文本和精确 SHA-256，单文件最多 4 MiB |
| `workflow_diff` | 固定的 Git status、相对 HEAD 的 diff 和未跟踪文件列表；无 Git 写入 |
| `workflow_artifact` | 撰写允许的任务文档；verification.json 只能写未执行的定义 |
| `workflow_propose` | summary + 1–100 个明确文件路径，绑定 Core plan 与当前基线 |
| `workflow_apply` | proposalId + 一批完整文件文本与 beforeHash，校验后落盘 |

人工查看方案和范围后，使用 proposal 的完整 ID 批准：

```text
/workflow status
/workflow approve <完整 proposal ID>
```

批准命令会执行 Core 原有 Implement 入口门禁。若仍处于尚未完成的前置阶段，不会跳过阶段；
先完成该阶段产物并通过已有任务 CLI 推进。之后告诉模型继续，它便可提交已批准的变更。
create 用 `beforeHash: null`，delete 用 `content: null`；新建文件的父目录必须已存在。
不支持二进制、路径链接、跨仓库批次、自动建目录或无限制 shell。

修改任务状态由人工调用现有 CLI 语义，argv 必须是 JSON 字符串数组：

```text
/workflow task ["item","--item","T1","--status","complete","--evidence","changes.md#Implementation","--expected-revision","<当前 revision>","--reason","已核对差异"]
/workflow task ["advance","--to","Review","--expected-last-updated","<当前 lastUpdated>","--evidence","changes.md#Implementation","--action","执行代码审查"]
/workflow pause
```

具体必需参数遵循当前 Core CLI；失败按错误修正，不自动重试或跳过门禁。
`task` 操作、暂停、resume、重启、文档修改、方案变化都会撤销当前代码写权限。
如仓库有外部改动，先人工 Inspect，再通过 `task checkpoint --reconcile` 更新观察检查点，
重新 proposal 和批准。旧测试结果仍按 Core 的 current/stale/unknown 规则处理。

## 验证与边界

- `pnpm test`：命令适配层测试，覆盖参数校验、会话隔离、伪造批准、pause、恢复、一次性批准和卸载。
- `pnpm test:dsh`：使用真实 Cordis 4.1 + DSH Tools `0.2.2-rc.3`（含 native 执行器插件）注册
  Schema 并执行工具管线，验证最后一道 guard 不能被后续 allow 监听器覆盖，禁用能力的工具体没有执行。
  人工命令/UI transport 是测试夹具；尚未在 DSH 图形界面安装并做模型端到端验收。
- Core 的 `quality:policy` 包含真实临时 Git 仓库、真实任务阶段/产物门禁、批准/重放、
  外部改动、范围/前像、链接/硬链接、路径和跨 controller 写锁回归。

第一版不自动运行测试、浏览器审查或 CI。验证由人工/CI 在宿主规则允许的环境执行，
通过 Core `verify-begin` / `verify-record` 登记基线和证据；没有证据时保持未验证。
证据文件由可信人工/runner 写入，模型不能通过 `workflow_artifact` 伪造结构化通过状态。
文档里的自然语言“通过”仍需人工核实，不能替代结构化证据。

这是 DSH 工具管线的强制边界，不是 OS 沙箱。绕开共享管线的第三方执行器、可修改部署的
同机进程、人工通过其它终端写入以及插件卸载均在保证范围外。严格隔离仍需叠加受限账户、
容器或沙箱。多文件写入不是事务：遇到部分写入或检查点失败，保留差异并人工核对，不能盲重试。
宿主必须在插件激活失败时停止启动模型任务；插件没有成功加载时，其自身无法替宿主维持 guard。

Core API 和失败恢复细节见 `D:\Project\agent-workflow\docs\host-control.md`。
