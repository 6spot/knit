---
id: k-e91ce642ede0
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: independent
createdAt: 2026-11-03T15:08:55.694Z
title: 集成 Rex 交互式 Pi Worker（浮窗、双向通信与恢复）
---

## 目标与边界

为 Knit 增加可选的 Rex 交互式 Worker 执行模式：主 Pi Agent 通过 Knit 派发 Worker 后，在 Rex 中创建运行真正 Pi TUI 的独立浮动终端；用户可以最小化、展开并直接与实际执行任务的子 Agent 对话，主 Agent 仍能监测状态、接收语义进度、处理阻塞、发送指令和获取实际结果。

本任务记录用户已明确的整体需求。本轮仅登记和完善定义，不编码、不启动 Worker、不操作 Rex、不开展真实模型验收。后续由 Planner 阅读架构、验证真实能力并在本任务目录保存必要的 plan.md／design.md／research/；确认技术边界后再拆成可独立验收、逐项执行的实施任务。下文的候选拆分不是已确定的代码结构或已完成的研究。

### 已确认的交互目标

- 主 Agent 派发 Worker 后自动创建 Rex 原生 Floating Layer；浮窗运行真正的 Pi TUI，默认最小化到右下角，提供可识别的 Worker 标签。
- 点击标签展开原有 TUI；支持焦点切换、最小化、恢复。最小化期间 Worker 继续运行，展开或收起不创建新 Agent，不影响主 Agent 使用。
- 多 Worker 的窗口、Run、Worker 和 Session 身份准确关联、相互隔离；窗口数量不改变 Knit 的并发许可。
- 用户在浮窗内直接向当前实际执行任务的 Pi Agent 输入，支持补充指令、阻塞补充信息、继续对话及打断当前推理或操作，保留原有上下文。不能用互不相关的两个 Pi 实例模拟交互。
- Worker 与原生 Pi Session 稳定关联，支持原生记录持久化、识别、恢复和继续执行。主 Agent 退出或切换会话不应无故取消已启动 Worker；重新进入后可以核实并重新关联。
- 主 Agent 与 Worker 支持派发、语义进度、阻塞／决策请求、定向补充指令、原 Session 继续、完成结果、查询和取消。事件与结果必须关联正确的 Knit Run。
- 优先事件驱动，避免频繁模型轮询及不必要的 Token 消耗；普通进度不应无意义地触发主 Agent 新一轮推理。

### 已确认的技术路线与架构约束

- Knit Core 统一管理 Task、Run、Session、状态、执行约束和验收；Pi CLI 1.5+ 执行真正的 Agent并管理模型、工具和原生 Session；Pi Extension 使用官方公开 API 监听事件、接收指令和报告状态；Rex API 管理浮动终端、最小化、焦点及窗口。
- 保留 CLI 优先。Local 继续使用现有 Pi CLI RPC；Rex 使用 Pi CLI 交互式 TUI与受控通信。具体进程组织、通信协议和 Host／Runtime 边界由 Planner 按实证确定。
- 不使用 Pi SDK 的 createAgentSession() 重建 Runtime，不因使用公开 Extension API 引入另一套 SDK Agent 执行体系，不依赖非公开 Pi 内部行为作为长期稳定接口。
- 沿用现有任务协议、Session 设计、项目执行锁、输入冻结、恢复和结果验收。不建立第二套调度器或 Run／Session 状态机，不把 Rex 变成强制依赖。
- 不自行构建 Rex 已有的终端 UI，不增加不必要的守护进程、数据库、网络服务或复杂配置，不为未知需求预先建设抽象平台。第二种实现确需提炼接口时说明依据。
- 浮窗内的信息不得无条件绕过正式需求、冻结输入、授权、锁与验收。与任务输入相关的变化仍按 Knit 的 clarify／change 和既有阶段规则处理。
- 允许调整 Rex Host 与 Pi Runtime 的适配边界，须说明原因并保证 Local 不退化；可见多 Worker 也必须遵守已有项目／任务并发约束。

### 生命周期与恢复要求

正确处理正常完成、失败、取消、Worker 异常退出、Pi 当前回合中断、进程终止、浮窗最小化／展开／关闭、Rex 断连／重连、主会话结束／恢复、原生 Session 恢复，以及多 Worker 隔离。

浮窗生命周期、Worker 生命周期和单次 Run 生命周期不能等同。窗口展示操作不得造成错误业务状态、重复执行或结果丢失；Pi 回合中断不能被直接当作 Worker 进程终止。恢复前核实进程身份和原执行是否结束，执行重复保护并保留来源。原生记录由 Pi 写入，未实际落盘不能宣称可恢复；日志和窗口存在不能代替权威状态或验收回执。

## 完成条件

实现后必须在真实 macOS + Rex + Pi CLI 1.5+ 环境验证以下场景，并记录版本、操作、观察证据及结果。单元测试、Mock 和独立代码检查不能替代真实交互验收。此要求是该任务最终完成条件；本轮不启动该验收，不能沿用其它历史验收延期来宣布本任务完整通过。

| 场景 | 必须达到的结果 |
| --- | --- |
| 派发 Worker | 自动创建对应 Rex 原生浮动终端并运行实际 Pi TUI |
| 最小化 | 右下角显示可识别入口，Worker 执行不中断 |
| 展开、焦点及恢复 | 恢复原有 TUI／Session，不额外创建 Agent |
| 直接输入 | 消息进入实际执行任务的子 Agent，身份和上下文正确 |
| 主 Agent 补充指令 | 定向送达对应 Worker，并在原 Session 继续 |
| 语义进度 | 主 Agent 收到实际进度，普通进度不无意义触发模型轮次 |
| 阻塞和决策 | Worker 请求信息，收到补充后能按任务约束继续 |
| 多 Worker | 窗口、Session、Run 与消息无串线，并发约束仍有效 |
| 主会话退出 | 已启动 Worker 不因主会话结束无故终止 |
| 主会话恢复 | 核实进程和原生记录，重新关联原 Worker，避免重复启动 |
| 取消、回合中断和异常 | 区分回合与进程，状态准确，不重复验收、不丢结果 |
| 窗口关闭及 Rex 断连重连 | 按明确的生命周期语义处理，不误记业务完成／失败或重复执行 |
| Local 模式 | 原有执行、恢复、结果回传及验收能力保持可用 |
| 约束保护 | 浮窗输入仍遵守需求冻结、授权、执行锁、阶段与验收规则 |

- Planner 先形成有来源和版本依据的能力矩阵，区分参考项目已实现能力、Knit 现有能力、适配工作与待验证缺口；必要缺口未解决时如实阻塞。
- 给出窗口／Worker／Run／Session 身份关联、消息归属、结果回执和恢复的方案；依据真实能力解释 Host／Runtime 边界及 Local 兼容性。
- 验证按副作用和不变量选择，涵盖正常交互与上述生命周期异常；使用独立检查评估高风险边界，并如实区分本地／隔离测试与真实验收。
- 如参考或适配开源代码，核查真实许可，遵守 MIT 等实际适用许可的版权、许可文本和署名要求。

## 输入引用

- 用户本轮提供的《Knit 集成 Rex 交互式 Worker》完整需求，包含目标、技术路线、交互、生命周期、架构边界、验收场景及仅创建任务的授权。
- 参考项目：https://github.com/sutekimeppou/pi-rexagents 。用户要求重点研究 src/rex.ts、src/child.ts、src/controller.ts、src/transport.ts、src/state.ts。本轮仅登记研究入口，未核验其当前源码、版本和能力，不能把用户列举的能力写成已验证事实。
- 用户提及 Rex 演示录屏；交互效果以可访问录屏及已明确的文字要求为参考。本轮未据录屏开展验收。
- [仓库入口](../../../AGENTS.md)、[工作流](../../workflow.md)、[设计](../../../docs/design/DESIGN.md)第 2、7、10、15.2 节、[架构](../../../docs/design/ARCHITECTURE.md)、[状态](../../../docs/design/STATES.md)、[运行约定](../../../docs/design/OPERATIONS.md)、[技术选型](../../../docs/design/TECHNOLOGY.md)、[术语](../../../docs/design/GLOSSARY.md)。
- 当前源码入口：src/application/stage-runner.ts、src/application/stage.ts、src/application/run-coordinator.ts、src/application/run-acceptance.ts、src/worker/knit-worker.ts、src/adapters/pi/runtime.ts、src/adapters/pi/resume.ts、src/adapters/local/、src/application/session-service.ts、src/contracts/、src/ports/README.md，以及 assets/templates/pi/extensions/knit.ts 与项目 .pi/extensions/knit.ts。

## 待验证事项与候选实施拆分

### 待验证的技术问题

- 核实真实 Pi CLI 1.5+ 的原生 Session 创建、指定 ID、resume、fork、TUI、Extension 事件、消息输入和中断接口；确认公开支持范围与适用版本，不能按参数名称猜测。
- 阅读并固定 pi-rexagents 参考版本，研究真实浮层创建、最小化、独立 TUI、Unix Socket、主子通信、订阅和重连实现。区分可直接复用、需适配及 Knit 额外要求；核查实际许可。
- Rex 当前官方 API 能否支持默认右下角 Worker 标签、展开／收起、焦点、多窗口与关闭事件；Rex 版本、连接方式与能力探测怎样表达。可见窗口与实际进程的关联证据是什么。
- Pi TUI 的可交互进程组织怎样与当前 RPC Runtime、阶段报告、使用量、取消和结构化验收兼容；不预设把 TUI 强行套进 RPC 的实现。
- 主子通信采用何种最小本地受控通道，如何鉴别来源、隔离 Run、处理重复／乱序／迟到消息、断连和结果持久化；是否适配参考项目的 Unix Socket 由研究决定。
- 主 Agent 退出后由谁持有进程和通信资源，重新进入如何发现并核实；窗口关闭、用户中断一轮、Worker 存活但 Run 已结束等情形如何映射现有业务语义，不新增重复状态机。
- 同一原生 Session 能否跨后续 Run 继续，何时必须新 Run、重新冻结输入或经过正式 clarify／change；主 Agent 与用户同时输入怎样保持身份及执行边界。
- 如何做到普通进度被动汇入，关键决策／阻塞／终态按规则通知主 Agent，并避免依赖轮询模型或日志推断。

### 供 Planner 评估的拆分方向

下列仅是规划入口，不在本轮创建实施子任务或决定协议。Planner 验证后按可独立验收的交付物拆分，记录依赖和必要上下文；可以调整边界并说明原因。

1. 能力验证与架构方案：真实 Pi／Rex／参考项目核查，身份及通信契约，Local／Rex 边界与阻塞项。
2. 交互式 Pi Worker：CLI TUI 与公开 Extension 的最小可运行链路，原生 Session、结构化结果及 Local 兼容。
3. 主子双向通信：定向指令、进度、阻塞、决策、取消和实际结果，关联与重复保护。
4. 生命周期与恢复：主会话退出、重连、原生恢复、回合／Run／进程区别和身份核验。
5. Rex 原生浮窗交互：创建、默认最小化、展开、焦点、多窗口隔离和 UI 生命周期；可按研究结论与上游最小启动联调。
6. 真实环境集成验收：上述完整场景、Local 回归与独立检查，保留证据及实际限制。

## 进展

- 本轮只创建并完善任务定义。尚未开始技术研究、方案确认、编码或真实环境验收。
- 任务创建不代表候选协议、进程结构或拆分方案已经通过能力验证；后续 Planner 从 discuss 阶段推进。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
