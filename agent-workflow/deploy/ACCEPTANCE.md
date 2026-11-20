# V4 acceptance

## 0.9.0 Core execution and spec integration
- Controlled code writes use `workflow_apply`; native write/edit and shell are denied while ordinary unbound sessions retain native reads.
- Stage briefs and status expose spec impact/dependency readiness; live baseline drift revokes approval.
- Pause persists a reason and keeps the task bound; reminder exhaustion pauses for human recovery.
- Lifecycle fixture, 14 plugin tests and native DSH tool registry test pass. Desktop GUI and real model acceptance still require isolated profile reload.


## 0.7.0 启动与常驻 Core 增量
- run 在解析工作区前发布进度，随后更新来源查询、初始化、准备上下文及就绪/失败。
- Web client 通过 DSH Conversation 和 Chat Slot 显示单张进度卡；日志记录可忽略，不属于模型 surface。
- 已验证打包的浏览器入口能通过 ModuleLoader 注册组件并渲染阶段文字；实际桌面显示仍待重载后验收。
- AsyncWorkflowController 每实例常驻一个工作区进程，重复 doctor 的 PID 一致；Core 任务/路由/来源 CLI 仍保留。
- 回归覆盖未解析工作区时已发进度、失败更新不唤起模型、run 阶段顺序、完整门禁与 Windows 进程释放。
- GUI/真实模型验收仍需在独立 Profile 重载新版插件后执行；本次不修改运行配置。

## 0.6.0 工具访问增量
- 已通过真实 Cordis/DSH Tools 管线回归：原生读取与已配置查询可执行，普通写入不进入模型工具列表。
- 混合工具只读参数同时受 Schema 与执行 guard 约束；宿主 scope 禁用和 pre-execute 拒绝不被覆盖。
- 无法复制的混合工具启用条件保持关闭。DSH 自身 scope 注册工具无法被 restrict 隐藏，部署时须避免局部写入注册。
- apply 在批准前隐藏、批准后可见、批次消耗后隐藏；原有 Core 门禁保持有效。
- 自动验证依赖 0.2.2-rc.3；桌面 0.2.2-rc.5 的安装包源码已核实相关 API，尚未完成 GUI/真实模型端到端验收。
- 本次未修改运行 Profile；部署前合并已核实查询工具的精确名称，再在独立 Profile 验收。

## 操作顺序
1. 构建并检查 Core、插件，生成 bundle；核对 SHA256SUMS，在生成目录安装 Core 依赖，在独立 DSH Profile 加载。
2. 确认 native 执行器、模型可用和目标仓库；运行 doctor，处理实际失败，确认仅配置项目 AGENTS 允许的检查器。
3. lookup 一个真实需求与一个真实缺陷，确认来源类型，确认原任务没有变化；分别 run，观察来源→分析→方案。
4. 模型用 search 定位代码、rules 只加载命中规范；提交 proposal 后必须停止。status 查看完整方案和范围，人工 approve 后仅批准的一批能写入。
5. 审查发现需返工时提交 changes-required，确认回 Plan 并重新批准；普通修正、暂停和重启均不能继承写权限。
6. Verify 只有真实当前基线的检查证据才能通过；人工行为测试分别登记。检查器缺失、失败或旧证据应阻断。
7. 模拟重复提交与重启，确认不重复写入或推进；不明结果先核对差异、reconcile，再 recover。确认 Git Inspect 没有 Git 写操作。

## 本次现场
- DSH UI 可访问性树识别桌面版本为 0.2.2-rc.5；尚未据此证明 API 兼容。
- 尝试进一步检查安装状态时，点击报告 coordinate input geometry is unavailable；激活后截图报告 FrameArrived timed out。
- 未修改运行 Profile、未安装/重启桌面、未提交业务修改；未完成 GUI/真实模型闭环。
- 没有真实缺陷编号；真实需求 XQ202610210005 的只读 Provider 查询在 V3 已通过，不能替代 V4 桌面验收。
- V4 自动回归使用真实 Core/DSH Tools/native 执行器，模型与命令 transport 仍是夹具。最终结果写入维护任务 verify.md。
