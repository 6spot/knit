# Knit 状态与转移

本文定义首版需要持久化的业务状态和执行协议；架构见 [ARCHITECTURE.md](ARCHITECTURE.md)，操作细则见 [OPERATIONS.md](OPERATIONS.md)。当前规则已实现至 Linux 候选；macOS 后续验证。元数据物理实现已定为单一 SQLite 库（M0 实证），不改变这里的权威与守卫。

## 1. 状态边界

首版围绕下列对象实现，不为每个观察值建立独立状态机。

| 对象 | 权威与职责 | 状态／判断 |
| --- | --- | --- |
| Task | Git 项目中的 task.md | status、stage、outcome、branch |
| run | 一次 worker 尝试的请求与执行回执 | 启动、准备、执行、取消及终态 |
| Session 引用 | 本机索引及所属客户端的原生记录 | opening/available/missing/incompatible |
| 检查凭据 | 核心发布的 scope/check 证据，绑定只存引用 | 当前资格由输入及成果版本推导 |
| 规范候选 | `.knit/standards/candidates.md` 和匹配的审阅回执 | 是否需要提示及本次处理决定 |
| 确定性操作 | 核心操作意图、步骤及实际效果 | planned/running/needs_attention/completed/abandoned |

初始化、快照、占用和兼容性属于执行协议，保留必要结果，不另做产品工作流。桥接监听器和模块实例只是实现资源，不进入持久状态契约。开发者模式是输出开关，也不增加业务状态。

原始证据发布后不改；unknown、stale、suspect 等是观察，不得据此伪写成功或失败。模型判断语义与授权，核心校验身份、摘要、版本和实际效果。

## 2. 初始化与准备

init 清单使用 preparing/ready/failed，无清单表示尚未初始化。只读检查不修改状态；开始写入前保存文件计划，项目资料只补缺，受管代码按旧基线更新，冲突保留人工内容。所有必需项核实后才 ready；失败重试先核对已生效步骤。

ready 不等于每条命令前置条件满足。非 Git 项目可 init；正式代码阶段和提交仍要求有效 HEAD、分支及干净的 Git 操作状态。未知较新版本只读诊断，不猜迁移。

快照 preparing → ready 或 failed。可信 worker 程序可以先启动、取得占用并准备快照；正式 implement 只有快照 ready 后才调用阶段模型／开始写代码。不做 CLI 到 worker 的执行锁交接。

## 3. Task 与输入变更

open 时无 outcome；closed 必有 completed/cancelled/superseded。closed/completed 的 stage 为 deliver；取消／替代保留停止位置。业务结束与 Git 收尾分别判断。

| 事件／入口 | 守卫 | 转移与效果 |
| --- | --- | --- |
| TaskCreated：task new | 用户授权、身份唯一、有效 Git HEAD／分支（DESIGN14.1） | open/start，不自动实施 |
| DiscussionConfirmed：task ready | 主 Agent 确认目标、条件与资料齐备；task.md「待澄清」无 `[blocking]` 项（有则 `clarify_blocking` 拒绝）；前置依赖全部完成 | start → 配置的第一个阶段；降级流程直接进入 deliver，保存确认输入引用 |
| InputsUpdated：task update --kind clarify | 未完整归档且非 cancelled/superseded；原目标、条件和范围不变，主 Agent 提供说明 | 当前阶段保持；摘要变化使检查 stale，原为 deliver 则 independent 回最近检查阶段、self／none 回最近工作阶段并清 completed |
| InputsUpdated：task update --kind change | 未完整归档且非 cancelled/superseded；新增、删除或改变目标、条件、范围、业务约束 | 回 open/start，清 completed，旧检查失资格 |
| PendingApplied：task update --apply-pending | 草案摘要与基线输入均匹配，旧执行已结束且结果事实收敛 | 按草案保存的 kind 应用 InputsUpdated，清本份草案，不发模型 |
| PendingWithdrawn：task update --withdraw-pending | 含更新操作 ID 的草案版本摘要匹配、有撤回理由 | 清本份草案并留记录，冻结输入／stage 不变；不作用于后来草案 |
| InputsUpdateProposed：运行中 update | 已有活动 run，不改其冻结输入 | 保存 kind、理由、预期原摘要和拟修改内容，待工具终态后应用 |
| RecordWritten：task record | 只改记录、未封存、短锁内核对版本 | 不改有效输入或 stage，不使检查失效 |
| StageAccepted：阶段接收 | Task 为 open 且当前阶段在生效流程中，execution 报告及实际成果有效 | 按 `onVerdict` 或顺序进入下一阶段；最后一个阶段完成进入 deliver；累积 scope 与 lastImplement；阶段访问达到 maxVisits 时停止并报告 repair_round_limit |
| CheckAccepted：检查阶段接收 | 最新获准检查及目标版本匹配 | 检查阶段有实际修改时随接收并入 scope；pass → deliver；changes_requested → `onVerdict` 目标或顺序下一阶段；blocked 保留本阶段或按配置跳转 |
| RecheckRequested：run check --task | 当前为检查阶段/deliver 或未归档 completed，相关收尾已处理 | 进入最近检查阶段；工作阶段明确拒绝 phase_mismatch，不自动跳过 ready／实施 |
| BusinessClosed：deliver 或 task close | 按 verification 核对当前目标、成果与验证；父任务还要求直接子任务全部结束并给出总体验收说明；不要求 Git 提交／回执／归档 | closed/completed/deliver；完成凭据另存，Git 收尾后做 |
| TaskEndRequested：task close | 明确取消／替代，无该任务活动／未知 run 或未核实 Git 效果；待接收结果先核实事实并收敛 | closed 及相应 outcome，不默认提交部分源码 |

前置依赖（DESIGN §3.11）：`task ready` 与工作阶段的 `run prepare` 在推进／启动前核对 `dependsOn`，未满足时拒绝（`dependency_unmet`，列出未满足项），不改变 stage 与冻结输入；优先级、父子层级与用户明确指定都不绕过。依赖结构错误（缺失／自依赖／成环）在设置依赖时拒绝；已取消、替代或已归档但未完成的前置保留为具体阻塞原因，由用户显式调整。检查、交付、记录与只读查询不受此门禁影响。

需求澄清（DESIGN §4.2）：「待澄清」区段与 `- [blocking] `／`- [assumed] ` 标记不是独立状态，仍是 task.md 输入。`task ready` 只机械核对顶格 `- [blocking] ` 行：存在时拒绝（`clarify_blocking`，消息含数量与前 3 条），无区段、空区段或只有 `[assumed]` 时放行；`assumed` 是否已确认属主 Agent 语义判断。解决后折入目标与完成条件并删除该行，摘要变化按 clarify 处理；不新增需求状态机，也不统计提问轮数。

clarify 包括解释原要求、纠正表述、补充定位或验证资料；新增引用若带来新约束则应为 change。核心不做自然语言分类，主 Agent 负责声明与理由。规范化后的有效摘要未变时不使检查 stale；clarify 不重置修复计数。

任务规划资料（DESIGN §3.4）：plan.md 步骤勾选与证据追加、research/ 追加为进度更新，不改有效输入、不产生草案、不使检查失效；方案文件中被输入引用的要求性内容变化等同 InputsUpdated，活动 run 期间按 InputsUpdateProposed 保存草案。plan 的未完成步骤与证据不参与业务 stage 推导，不从复选框自动认定业务完成；规划资料不建立独立状态机，业务状态仍只在 task.md frontmatter 与元数据仓储。

核心操作使选定目标的检查 stale 时，若当前 stage=deliver，independent 回到最近检查阶段、self／none 回到最近工作阶段并清 completed；clarify、adopt、restore 和生效规范变化使用同一规则，不保留不可交付的 deliver。其他阶段不因 clarify 回讨论，摘要未变不迁移。run check 是显式复查入口；非正式 check --scope 不推进正式 Task。已完整归档的资料维护不自动重开。

外部编辑造成的失效在只读查询中报告“应检查、状态待同步”，查询不改 task.md；下一写动作先在占用内收敛 stage，不允许提交。

待应用变更在旧工具终态后按原 kind 应用；前后版本不匹配先核对。未应用或未明确撤回时阻止后续代码阶段与交付，当前 run 仍按冻结旧范围运行。记录中出现的新要求应经 update 应用，不能偷变 worker 指令。

adopt 不创建或切换分支。必须没有活动或状态未知的 run、没有未核实的 Git 效果，且输入已收敛一致。满足这些守卫后：start 与配置阶段保持，检查阶段待复查，deliver 按 verification 回到最近检查阶段或工作阶段并清 completed；分支变化使旧检查失去交付资格但保留历史。实现（任务021）：只允许改绑当前检出分支；项目＋任务锁内复核分支、文件、run 与未完成 delivery 操作；选择记录分支不一致时报告 `branch_changed`，不把旧树选择投到新分支。原 Session 保留，恢复核实新分支上下文。取消／替代只接管收尾，完整归档不自动重开。

## 4. 自动修复计数

binding 只保存 repairCycleId、repairRounds、stopReason，不建立独立链文件或 active/paused/finished 状态机。新授权周期计数为 0；开始修复轮时累计，重复通知与内部 retry 不重复计数，普通 resume 不重置。

达到项目上限、用户暂停或真实阻塞时写 stopReason，主 Agent 不自动续跑。用户明确开启新修复周期或确认新范围后才分配新 ID；clarify 不构成重置理由。取消旧 run 只影响其对应周期，不能暂停后来新开的周期。实现（任务013）：检查 `changes_requested` 在有周期时累计，达到 `workflow.maxRepairRounds` 立即写 `repair_round_limit`；无授权周期时写 `repair_not_authorized`，`run prepare --new-repair-cycle` 显式开新周期。

## 5. run 启动与执行

run 只代表 worker 执行；阶段来自生效流程配置（默认模板为 implement／check），交付由主会话直接协调确定性工具。context 和确定性 deliver 不创建 run。

准备入口先持久化 run ID／owner token 并把 ID 返回调用方；桥接确认拿到 ID 后才允许执行。准备尚未确认时不调用模型、不改项目业务文件、不做 Git 收尾。CLI 表面仍为一条 run 命令，内部复用 prepare/start；准备中断只留下可查询、可明确放弃的未启动意图。重发 start 按同 ID 认领，不产生第二个实例。

launch 使用 planned/starting/confirmed/failed。starting 响应丢失先查匹配的 claim 和实例，不重启；无法证明有无旧运行时显示 unknown。OS 进程已启动不等于 Agent 已开始。worker 自行取得执行占用，重新核实预期输入，冻结 inputs 并完成必要准备。实现（任务012）：`RunCoordinator` 在 `run-*` 目录落盘 request／launch，start 记录 PID+boot+starttime 句柄；已 confirmed 或句柄存活只观察，句柄缺失／死亡未认领置 failed，`--retry` 才重试同一 run。worker 认领后置 preparing；implement 快照 ready 后 state 为 preparing + `prepared:true`，阶段模型与代码执行由 013 继续。

```mermaid
stateDiagram-v2
    [*] --> claimed
    claimed --> preparing
    preparing --> running: 占用 输入 快照 会话参数与指令就绪
    running --> completed: 合法报告和本 run 证据持久化并接收
    running --> cancelled: 取消已登记，执行中观察后按工具终态收敛
    claimed --> failed: 可确认失败
    preparing --> failed: 可确认失败
    running --> failed: 可确认失败
    failed --> completed: 结果已完成而仅因接收失败置 failed，接收成功后收敛
```

实现不设独立的 finalizing/cancelling 中间状态：取消意图落盘 run 目录的 `cancel.json`，由阶段执行观察并按工具终态直接收敛为 cancelled；结果已完成而此前仅因接收失败（`acceptance_` 前缀）置 failed 的，接收成功后收敛为 completed，真实执行失败不被覆盖。

Pi 的 agent_end 可能位于自动重试之间，不能独作终态；以公开 prompt 完成／agent_settled 及真实工具终态为边界。result 先持久化，state 再收敛，均由 worker 写，终态不覆写。检查阶段的 changes_requested 可是执行 completed；只有阶段接收才推进 Task。

崩溃后核心在 reconcile 操作中记录核实结论，不能伪造 completed 报告。正常结果按固定 acceptanceOperationId 幂等接收。结果已有而业务写回未完成时显示“执行已结束、状态待同步”，先恢复接收，不重复实施。实现（任务018）：接收先原子写 `runs/<run>/acceptance.json`（来源 target、binding before/after、scope、check、输入／规范摘要），再写 Task／scope／check／binding，最后完成 operation 并移除检查点；重入按当前事实与来源／目标对比，漂移转 needs_attention，不覆盖后来 Task、草案或输入；同一操作的 scopeAfter 已落盘而 binding 未写时按检查点收敛，不误判为外部 scope 漂移。 Task 关闭与该任务启动／接收在同一任务短临界区核对 status、stage 与版本；迟到旧结果保留为执行事实，不能重开 cancelled/superseded、覆盖其 outcome 或继续自动修复。

status 展示总耗时、最近模型／工具活动距今多久以及心跳情况。心跳和诊断事件不算业务活动；有输出不等于有进展，无输出不等于卡死。首版不做语义空转检测、自动取消或总时长停止。实现（任务015）：status 用只读元数据库投影耗时、最后事件与项目锁心跳；`--events` 只观察事件到终态，不接收结果；桥接每 5 秒按发起方原生 Session 查询未结束 run，并按会话内通知条目去重。

## 6. 对象级取消

首版仅支持 cancel --run 和 cancel --operation，不设请求级取消路由。执行前已有目标 ID；桥接明确执行取消时持久化对象意图，不先杀掉调用进程。普通 CLI --wait 退出与单独观察取消只停止观察。

run 以 runId 和 owner token 固定目标；新恢复使用新 run ID。重复取消返回同一结果，旧取消不影响新 run。先发布终态或结果则返回已结束，先登记取消则停止新调用；实现（任务017）在 5 秒宽限后仍未稳定时终止本次 Pi 的完整后代进程树并发布 cancelled result，`--terminate` 可显式处理 worker 已退出但阶段 Pi 仍存活的旧 run。取消宽限只适用于已登记的本 run，不设固定总运行预算；旧取消 token 不作用于新 run。

确定性操作先有 operation ID 与本次执行 token。取消停止未开始步骤，核实在途 Git／文件效果后进入 needs_attention（reason=cancelled）；不自动撤销 commit/move，也不改变 Task outcome。恢复同操作取得新执行 token，迟到取消不作用于新尝试。意图已转达不等于目标已停止。

## 7. Session 与活动选择

| 状态 | 含义 |
| --- | --- |
| opening | 原生引用尚未确认达到可恢复条件，与 run 的准备／运行状态分别判断 |
| available | 原生归属、引用和必要持久性已核实 |
| missing | 曾有可恢复记录，当前缺失或不可读取，保留引用及原因 |
| incompatible | 客户端、版本、阶段或身份不匹配，不交另一客户端解释 |

创建未完成或尚未落盘的具体原因记录在本次 run 准备结果中，不再新增 Session 状态。run 已终态而引用仍 opening 时显示不可恢复原因，不冒充进程仍运行。失败尝试不覆盖旧可用阶段引用，不伪造消息触发原生保存。dispose 不删除原生历史。实施与检查不可复用活跃主会话文件。 新会话 opening 期间可在参数／指令就绪后调用模型，available 不是首轮调用的前置条件；只有原生持久化已核实才作为可恢复阶段引用。原生文件由客户端保存，不能为了置 available 伪造一轮模型或直接追加文件。 执行、工具终态和报告均有效时，仅原生引用暂不可恢复不导致重新执行模型；单独记录引用失败原因，不更新可恢复指针，下次按 prefer 兜底。run 自身结果／证据写入失败仍不能宣称完成。

默认 resume=prefer：先核实旧工具结束，再按项目执行锁→客户端原生 ID 锁的顺序取得占用，由原客户端加载并核对原生 ID／历史。旧记录缺失、损坏、不兼容或恢复失败时，保持项目占用、释放旧 Session 锁，再锁预分配的新原生 ID 并自动创建新 Session；旧对象保持原状态与引用，新对象 opening→available 后才更新阶段引用，来源与原因记录在本次准备结果中。新会话读当前任务、正式规范、进度、已有事实和实际代码续做，不重置 stage、修复次数、scope 或检查资格。客户端缺失、模型不可用和旧工具状态未知仍阻塞，新建失败不递归兜底；默认配置变化不改变旧记录归属。

活动选择由当前原生有效路径最后一个匹配项目的选择事件决定，taskId=null 清除；索引只作快照，不能复活早期选择。追加后响应丢失按 operationId 查已写条目；未落盘只记录待确认原因，不增加专用持久化状态。树切换重新核实，不清掉后来选择的别的任务。实现（任务010）：`src/application/session-service.ts` 按 parentId 回溯有效分支，只有 activeIds 上的选择事件生效；未落盘快照 `persisted:false`，解析不把它当权威；原生文件缺失时按曾有记录报 missing，不冒充可恢复。桥接只观察当前发起上下文可核实的 run，轮询／去重／投递按 DESIGN9.3；切会话／树或关闭停止观察但不取消 worker。完成可按已有继续授权触发回合，忙时用 follow-up；核心结果和原生通知分别核实，不承诺模型轮次恰好一次。已有受控回调实验不代替 Knit 真实桥接链路验收。

## 8. 检查资格

检查不是所有任务的必经步骤：任务 `verification=self` 依据实施自检与范围验证完成，`none` 由用户明确跳过并记录未验证项；只有 `independent` 或用户明确要求时才需要正式检查凭据。

最新获准检查的 lastCheckRunId 是唯一候选；仅被忙拒绝的请求不算开始，已接纳后的准备／执行失败不回退旧 pass。失败／取消的检查 run 没有产生新结论，资格回到 missing（补检查），不把更早 pass 复原为 valid；实现见 `src/domain/check.ts`。

| 事实 | 当前资格 |
| --- | --- |
| 无凭据或缺范围 | missing，补足范围并检查 |
| 最新检查尚未结束 | pending，不能借更早 pass 收尾 |
| pass 且身份／输入／成果版本匹配 | valid |
| changes_requested、blocked 或必需证据缺失 | blocked |
| clarify/change、生效规则、成果、分支或 restore 影响选定目标 | stale，复查 |
| 纯记录、运行引用、未生效候选、等价改名／归档移动 | 不变 |

检查证据不等于全部自然语言要求已完成。必需人工验收由主 Agent 按用户要求核对、写入任务记录并据实际确认继续，首版不提供独立人工门槛命令／字段；技术报告不能替用户确认。

scope 按 Task 累积，恢复新起点不清空旧成果。实现（任务013）：`scope.json` 保存路径与当前指纹，实施阶段接收时合并；检查阶段凭据 `checks/<run>.json` 绑定输入／规范／scope 摘要。检查阶段可在既定需求内直接修复明确缺陷：报告 `changedPaths` 与实际 diff 一致且接收通过时，改动并入 scope 并更新检查凭据的 scope 摘要；未声明改动、外部改动或摘要不符时转 `scope_changed`。阶段 run 的结果在报告校验前先过边界核对（DESIGN §5.1）：阶段内提交为 `failed: head_moved_during_stage`、敏感区改动为 `failed: protected_runtime_modified:<paths>`，两者都不接收、不并入 scope、任务阶段不前进；index 与忽略区变化只记录在结果 `boundary`／`ignoredChanges`。规范为授权输出时，冻结旧输入与新产物分开，新规则是否追用于本任务由主 Agent 明确。工作提交后对选定 commit 核实，不把后来工作区新变动算已交付。跨机缺完成凭据时不猜通过：未归档完成任务先按 verification 重建完成资格（self 需可核对的实施，independent 需有效检查；none 需用户明确选择）；取消／替代仅归档资料不套此门槛，Git 已归档历史不自动重开。

## 9. 规范候选与沉淀

规范候选以项目为作用域：`.knit/standards/candidates.md` 的标记块与 `standards_reviews` 回执。无候选无需新增；有候选且无匹配当前候选集合摘要的回执时，`standards pending` 机械提示。决定为 applied/deferred/rejected/mixed；延期／拒绝有理由即可，不强制新规则生效。项目级回执不要求分支一致，分支只作记录；候选增删或正文变化后重新提示。

用户明确的长期规则可直接采纳；Agent 自行采纳需说明依据与适用范围；冲突未决时保存候选并等待用户决定；一次性要求不进入项目候选。旧任务 `standards.md` 只读兼容，`standards list --task` 可按任务与分支查看旧回执，`standards migrate` 幂等迁入项目候选且不改写原文件。

采纳需核实正式规范正文与索引。正式规则修改取得执行占用，其影响按输入／检查规则处理；历史审阅和已归档事实不撤销。交付与归档不因候选未审阅阻塞，不把规范处理重新绑定任务。

## 10. 确定性操作与恢复

操作 planned → running → completed；冲突、失败、取消或未知效果进入 needs_attention，核实后恢复。只有明确撤回且没有未知效果才 abandoned；completed/abandoned 不改回运行中。步骤保留尝试与已核验证据。

| 实际效果 | 恢复行为 |
| --- | --- |
| 仍为 before | 可执行原授权步骤 |
| 已为 after | 补检查点，跳过重复效果 |
| 前后均不匹配 | 保留现场，needs_attention |
| 进程或 Git 效果未知 | 先核实，不重试或假放弃 |

实现（任务019）：交付／归档提交核对父节点、实际路径集合、提交树模式／blob 与无关 index／worktree；hook 拒绝或越界保留已产生提交并 needs_attention，显式 retry 重核不重复提交。SQLite 已选定，可把关联元数据置于短事务；Git、Markdown 和原生历史效果仍逐步核验。事务／短锁不跨模型调用、工具等待或 hooks。记录／选择冲突只影响相关对象，输入或未核实 Git 效果阻相关后续代码及交付。

## 11. 收尾与封存

业务完成与 Git 收尾分开。`task close --outcome completed` 按 verification 核对当前目标、成果与验证后记录业务完成并写完成凭据；不要求 Git 提交。`self` 的实施事实可以是已接收 implement run，也可以是 `task implement` 记录的主会话／用户实施（输入摘要、成果路径指纹与实际验证）；没有证据而用户明确要求时，`task close --force --reason` 跳过核对，凭据记 `forced` 与原因，`independent` 拒绝 force。拥有直接子任务的任务（`children` 非空）还须满足：所有子任务均已结束（归档视为结束），且 `--reason` 给出总体验收依据；未满足分别返回 `children_incomplete`／`parent_acceptance_missing`。子任务完成不自动结束父任务，父任务总体验收由主会话执行。`deliver` 逐任务提交产物、任务资料并归档；archive 只处理可归档资料或继续已有归档，不能绕过完成资格。多个任务可以先完成、最后逐项提交，任务资料与业务产物分开；完成不自动授予提交／推送授权。

| 步骤 | 完成证据 |
| --- | --- |
| preflight | --branch 的完整本地 ref 与绑定／实际分支一致，授权来源可追溯、工具已结束；规范候选未审阅不阻塞；正常完成另需有效完成资格（self／none／independent 按任务 verification；self 接受 run 或主会话实施记录，forced 凭据须带原因）和主 Agent 完成判断 |
| artifact_commit | 限定业务产物路径与目标树，核实真实 OID、范围与 index 保护；无产物则跳过并记原因 |
| metadata_commit | 最终记录后限定任务资料路径；与产物提交分开核对 |
| prepare_archive | 完整结果、验证、产物／资料提交和结束结果进入记录 |
| seal_archive | 短锁内捕捉记录版本、目录与首次归档月份 |
| move_task | ID、目标和文件指纹匹配 |
| archive_commit | 本任务路径及明确引用的真实提交，不能写自身哈希反复提交 |
| finalize | 关联和定位收妥，条件清选择，操作 completed |

deliver 和会提交的 archive 统一要求 --branch <refs/heads/...>，拒绝短名或 current；该参数确认目标，不能冒充用户授权。桥接 Agent 需声明 authorizationRef，CLI 代调可 --authorization-ref，直接调用至少记录调用声明，不能伪记人工已核实。核心核对来源存在／版本，语义授权仍由主 Agent 负责。

认可的项目策略写在项目规则文件（如 AGENTS.md 的交付约定或显式授权来源），模板不默认授予主分支提交许可。默认分支候选按显式 delivery.defaultBranch、本地 origin/HEAD、unknown 识别，不按 main/master 名称猜、不联网探测。operation 记录候选及来源、实际目标与授权来源；unknown 不阻已有明确授权。已覆盖不重复确认，adopt 仍不自动授权提交。详见 OPERATIONS。

封存期间 task record 返回未保存（sealed），不写任务、不自动转存、不制造未提交修改。主 Agent 不得汇报已记录；封存结束后按原记录意图重试，作为档案的新资料修改，明确其未包含在原归档提交，是否提交按已有授权。此补记不重开任务，也不篡改旧交付回执。

需改业务目标时先暂停收尾。未移动且工具已结束时可明确解除封存后重新准备；已移动或结果未知先核实与修复，不自动 reset。

取消／替代仅归档实际资料，不要求未完成代码检查成 pass，不默认提交部分源码，不造空 commit。重试沿同一操作及首次目标，结果分别报告产物提交、资料提交、移动、归档提交和待办。实现（任务014）：操作记录与步骤存 `operations`，回执丢失按操作 ID 在 Git 历史核实；工作／归档提交核对父节点与真实范围，无关 index／工作区变化与 hook 越界置 needs_attention；封存标记存在时 task record 返回未保存，归档提交后移除标记，后补记录追加为新资料。实现（任务019）：首次创建操作即固定 archivePath，跨月不变；提交树模式／blob 也纳入核对；move 已完成而检查点丢失时按目标 Task ID 与封存摘要核实后继续，目标冲突不覆盖。

## 12. 占用与兼容性

本地 mkdir 锁／进程身份与 owner token 规则见 OPERATIONS；心跳可疑只调查，未知工具不放行新代码阶段。强解是显式风险操作，不是机器终态证明；`unlock` 必须匹配 owner token，alive／unknown 另需显式 force，旧 token 不能删除新占用。Session 键按客户端原生 ID，不随项目改变；阶段进程记录独立于 worker，worker 被强杀后仍能核实并阻塞续做。

restore 默认预览，执行核对当前指纹、范围和终态。Task 输入经 update 恢复并保留记录，runtime 和原生 Session 不由普通源码 restore 覆盖；真实恢复清空当前检查与 lastImplement 资格，deliver 按 verification 回 check 或 implement，恢复操作与逐路径结果留在 `.runtime/restores/`。实现（任务016）：快照 index 内容独立保存，恢复只改选中路径，当前模式／内容／index 任一变化即停。未知版本只读报告，首版无自动 gc。

## 13. 入口与验证范围

context 提供讨论输入；task new 由用户决定并可指定 verification；task verification 只在讨论阶段调整完成验证；task ready 推进讨论确认；task update 写入输入显式声明 clarify/change，草案应用／撤回分别校验摘要；run prepare/start --stage 按配置派发阶段，run check 用于复查；交付由主会话协调，deliver 逐任务分离产物与资料提交，archive 归档，task close 按完成资格结束业务且不要求 Git；cancel 仅指明确对象；resume --run 新尝试，resume --operation 先核实已有效果。status/doctor/storage 不推进业务。

测试按不变量和副作用选择：

- 只读查询和内存资源做必要的正常／错误验证，不套持久恢复矩阵。
- 输入、阶段接收和计数覆盖分类、版本冲突、重复接收与相关中断。
- 启动／取消覆盖实例不明、工具终态、完成竞争与旧 token。
- Git／文件移动在关键效果前后注入崩溃，验证无重复提交、无无关 index／文件损失。

M1 开发者模式只做结构化 stderr、白名单与一个业务等价冒烟；私有日志、Pi 会话开关及完整通道验证归 M3A。

归属及里程碑见 DESIGN 第 16 节。M2 的数据保护测试不能推迟到发布阶段。
