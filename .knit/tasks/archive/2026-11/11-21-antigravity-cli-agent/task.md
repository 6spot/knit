---
id: k-b2ac5d4c4c11
title: 工作流派发支持选择 Agent 并接入 Antigravity CLI
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-20T16:48:41.760Z
---

## 目标与范围

这是主任务。总体设计和最终验收放在这里，由子任务分别交付实现和验证记录。[子任务清单](plan.md)

工作流在 `stages` 的环节内选择执行客户端。实现、审查等环节可分别设置 `agent: pi` 或 `agent: antigravity`。派发时优先使用环节显式设置的 `agent`，省略时沿用派发入口传来的主会话客户端。普通终端直接运行 `knit run start`、没有主会话信息时，缺省用 Pi。首版由现有 Pi 主会话入口派发，Antigravity CLI（`agy`）作为执行者接入。

环节沿用 `model` 和 `thinking`。Pi 按本次派发覆盖、环节、工作流顶层、主会话的顺序取值。`agy` 按本次派发覆盖、环节配置取值，未填的参数由 `agy` 取默认值。`agy` 使用自己的模型 ID，`thinking` 映射为 `--effort`。`knit workflow validate` 按 Agent 校验显式配置，给出未知 Agent、模型格式或思考等级错误的行号。

主会话继续通过 `knit_run start` 派发。Worktree 准备好后，工具在派发成功时返回，主会话可以结束当前轮次。主会话在 Rex 里时，自动打开窗格，选定的 Agent 在任务 Worktree 里工作。普通终端直接走后台。Rex 窗格打开失败，或确认窗格中的执行者尚未接手任务且窗格已关闭时，回退到同一个 Agent 的后台模式。

Pi 桥接在后台用 `knit run wait` 等待结果。Knit 写好报告或失败原因、保存本次执行的终态后，桥接向发起派发的主会话发送一条带结果和下一步的消息。主会话空闲时，消息自动在原会话触发新一轮，主会话继续处理结果。主会话仍在当前轮执行时，消息在该轮结束后送达。Pi、`agy`、Rex 和后台执行共用这条通知链路。主会话通过工具主动取消时，取消结果由该工具直接返回。`run status` 与 `run wait` 从执行记录读取实际使用的 Agent，历史记录缺少 Agent 字段时按 Pi 读取。

`agy` 在 Rex 窗格里保留原生交互，用户可以看到执行过程、在同一会话追加要求和处理工具权限确认。`agy` 的回执区分提交报告、等待用户输入、权限阻塞。Rex 路径在 `Stop` 事件的 `fullyIdle` 为真时读取本轮回执，后台也用同样的回执判定结果。等待审批、用户输入和补报期间，执行保持进行中。沿用角色提示、任务交接和报告校验，校验失败时在原会话补报一次。

Pi 和 `agy` 共用 `tools` 配置。省略或写 `tools: all` 时开放全部工具类别，客户端自身的权限审批照常生效。`tools: []` 禁用全部工具。显式列表是该环节的能力上限，可声明 `read`、`write`、`exec`、`external`、`network`。`agy` 通过本次会话的权限设置和命令沙箱落实该上限及 Worktree 的写入边界，原生审批在此范围内生效。`network` 约束工具发起的联网，模型服务按客户端配置连接。适配器无法落实所需限制时，派发前指出缺少哪项限制。

执行者启动失败、必要操作因权限阻塞、补报仍不合格，或窗格在提交报告前关闭时，Knit 记录具体失败原因。后台收到权限阻塞回执时，记录可取得的 `denied_actions`，包括 CLI 返回 `SUCCESS` 的情形。`run cancel` 停止执行者及其子进程后结算执行。

### Knit 共用执行流程与 Agent 适配器

把目前随 Pi 执行实现的 Knit 通用职责归入共用执行流程。共用流程根据环节选 Agent，准备 Worktree 和交接内容，管理 Rex 窗格、后台回退、进程登记和取消。后台执行与窗格执行复用报告保存、校验、补报一次和结算的实现，执行记录及 `run status`、`run wait` 使用统一结果。

适配器负责客户端的参数校验、`tools` 能力到实际权限的映射、启动和原生会话交互。Pi 的 RPC、窗格扩展和会话文件读取归 Pi 适配器。`agy` 的 `Stop` 钩子和后台消息协议归 Antigravity 适配器。两者通过统一接口提供启动状态、报告、会话记录和失败原因，并能向原会话发送补报要求、停止执行。执行者按 `agent` 在内置适配器表登记，通过同一个入口接入共用流程。

执行结果与结束时机由 Knit 统一提供。Pi 主会话桥接继续从 `run wait` 取结果，负责通过 Pi 的宿主接口在原会话中投递消息并触发新一轮。Pi 和 `agy` 的执行结果都走这条链路。以后新增执行者时，实现同一适配接口并登记，即可复用派发、报告处理和主会话通知。

首版接入保留 `tools: [read, write, exec]`。以 macOS 外层沙箱和独立命令进程的复验为实施依据，接入任务覆盖通用命令、CLI 状态写入保护、外部工具及联网入口、原生审批和取消。命令进程的运行边界由 Knit 管理，`agy` 会话保留模型连接和转录。[运行隔离复验](research/agy-isolation.md)

### 实机验收安排

接入前在临时 Git 仓库用本机 Rex 和 `agy` 1.5.13 核对会话权限、命令沙箱和原会话补报。实测覆盖 `read`、`write`、`exec` 的放行与拒绝，以及 `external`、`network` 缺席时的限制。声明这两项能力后的放行实测延后。

接入交付后，在临时仓库用真实模型走一次 Pi 实现、`agy` 审查。让发起派发的 Pi 主会话在审查完成前结束当前轮次并保持空闲。有效报告落账后，主会话无需人工输入就开始下一轮，读取审查报告并根据结果继续任务。记录会话标识、权限确认、报告、`run status`、结束通知和主会话唤醒后的处理。两次实机验证分别通过子任务进行。

## 完成条件

主任务按下列场景核对子任务的回归、独立审查和实机验证记录。代码子任务用模拟客户端覆盖 Pi 和 `agy` 的窗格及后台执行。独立审查核对四条路径共用报告校验与补报、取消、执行结算和通知，两条 Rex 路径共用窗格管理与后台回退。共用执行流程通过同一个适配接口调用执行者。

### Requirement: 按环节选择 Agent，保留派发、交互和唤醒体验

#### Scenario: 老工作流沿用 Pi 派发

- GIVEN 原有工作流未配置 `agent`，Pi 主会话在 Rex 中，任务有未记录 Agent 的历史执行
- WHEN 主会话派发实现或审查环节
- THEN 本次由 Pi 按现有规则选模型和思考等级，在 Rex 窗格工作并通知主会话，历史执行仍可以按 Pi 查阅
- AND 普通终端直接派发时缺省用 Pi，窗格启动失败时的后台执行通过现有回归检查

#### Scenario: Pi 实现后由 Antigravity CLI 审查并唤醒主会话

- GIVEN Pi 已完成实现，审查环节配置 `agent: antigravity` 和 `tools: [read, write, exec]`
- WHEN Pi 主会话在 Rex 派发审查，派发工具返回后，主会话结束当轮并保持空闲
- THEN 窗格中的 `agy` 按适用的模型和思考等级运行，在任务 Worktree 里收到角色和 Pi 的实现报告，能读写允许的文件并运行测试
- AND 用户能追加要求并处理原生权限确认，等待期间执行保持进行中，报告格式不符时在同一个会话补报一次
- AND 报告及终态写入后，Pi 桥接发送一条含实际 Agent 和结果的后续消息并触发原主会话新一轮，主会话开始处理结果和下一步，全程无需手动查状态或再发消息
- AND 普通终端派发和 Rex 尚未接手任务时的后台回退都使用 `agy`，省略的模型和思考等级由 `agy` 取默认值

#### Scenario: 配置有误或 Antigravity CLI 执行未完成

- GIVEN 一个配置了 `agent: antigravity` 的环节
- WHEN 配置和执行分别遇到非法参数、无法落实的工具限制、启动失败、权限阻塞、补报失败、提前关窗或取消
- THEN `knit workflow validate` 给出配置错误的行号，无法落实的工具限制在派发前报错。模拟客户端回归核对 `tools: []`、`tools: [read]` 和 `tools: [read, write, exec]` 下传的工具权限与命令沙箱配置
- AND 已派发的执行失败时，`run status` 与 `run wait` 显示实际 Agent 和失败原因，主会话收到一条能触发续跑的结束消息。主会话主动取消时，执行者及其子进程停止，取消结果随工具返回

## 待澄清

## 相关资料

- 当前派发入口见 `src/cli/run.ts`，派发准备和执行见 `src/application/run-prepare.ts`、`src/application/run-execute.ts`。现有 Pi 执行逻辑见 `src/adapters/pi/`，窗格进程跟踪见 `src/application/run-process.ts`。设计见 `docs/design/DESIGN.md`。
- 本机 `agy` 1.5.13 临时 Git 仓库实验确认，`--input-format stream-json --output-format stream-json` 可以在一次进程中收两轮消息，结果的 `conversation_id` 相同。`--add-dir` 能加载自定义角色。`--model` 接收 `agy models` 列出的 ID，`--effort` 接收 `low|medium|high|xhigh|max`。
- 可行性实测确认，后台审批拒绝可以随 `SUCCESS` 返回 `denied_actions`，显式拒绝由工具事件给出。Rex `Stop` 钩子能读取真实报告并在同一会话补报一次，补报通过 Knit 校验。`fullyIdle` 与 `terminationReason` 需要结合当轮回执和工具错误使用。[可行性实测](../11-21-agy-feasibility/research/agy-feasibility.md)
- Rex 窗格入口见 `src/application/run-pane.ts`，Pi 在窗格内获取报告的实现见 `src/adapters/pi/pane-worker.ts`。现有主会话唤醒见 `assets/templates/pi/extensions/knit.ts` 的 `notifyWhenEnded`，它用 `deliverAs: "followUp"` 和 `triggerTurn: true` 发送执行结果。通知、等待和窗格回归见 `test/bridge-notice.test.mjs`、`test/run-wait.test.mjs` 和 `test/run-pane.test.mjs`。
- Google CLI 文档提供 [交互启动](https://antigravity.google/docs/cli/reference/)、[Stop 钩子](https://antigravity.google/docs/hooks/)、[Headless 模式](https://antigravity.google/docs/cli/headless/) 和 [权限规则](https://antigravity.google/docs/permissions?tab=cli)。文档中的 `Stop` 事件提供 `terminationReason`、`fullyIdle` 和 `transcriptPath`。主会话完成通知由接入后的端到端实机验收验证。

## 结果

三个完成场景均已核对，四个子任务已交付。工作流支持逐环节选择 Pi 或 Antigravity，旧工作流及历史执行继续按 Pi 处理。接入独立审查通过；首次审查发现独立命令进程组在结算后仍存活，返工后由跟踪器回收。实机修复随 3cd9e5e 交付。Rex 中 Pi 实现后由 Gemini 3.8 Flash (Low) 审查，完成一次性命令和文件审批，在同一会话补交 pass；原 Pi 主会话收到唯一结束通知后自动读取报告并关闭夹具。最终普通终端与 Rex 的 npm test 各 402 项通过，0 失败、0 跳过，类型和打包检查通过。显式开放 external 和 network 的真实模型运行留待后续验证。
