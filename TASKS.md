# Knit 开发任务队列

这是开发Knit本身的临时文件式排程，也是本仓库开发任务的唯一状态表。2026-11-02 用户已授权在本工程运行 knit init：`.knit/` 受管元数据与 `.pi/extensions/knit.ts` 桥接已生成，均未提交，去留随下次提交授权一并决定；本队列仍保存在根 tasks/，`.knit/tasks/` 只保存由 Knit 创建的任务。产品元数据已由 M0 选定 SQLite。

初始001–026的执行事实按历史保留，027–043承接一致性审计修复与复验；044–051实现主会话与任务规划补齐（051独立验收通过），052完成Pi 1.5.0兼容验证，053修复复验发现的锁重入回滚缺陷。全部任务已完成，无pending项。后续执行进度只以本表为准；各任务文件只存范围、验收和执行事实，不重复维护status。

## 当前一致性复核

2026-11-02 对已提交基线 `50936d71a6fb414dec7edfb793e4510f81889ac4` 完成任务、设计与实现交叉核对，发现16项偏差（8 P1／7 P2／1 P3）。[审计报告与证据](validation/design-implementation-audit/README.md)记录原001–026逐项映射；027–042承接修复，043独立复验。原任务历史completed保留；当前不能据此前结论宣称无未处理数据保护／实现缺口。027–042修复已由043独立复验通过（[复验报告](validation/audit-fix-verification/report.md)：typecheck/build/pack:check通过、全量229项×3轮全过、16项发现逐项验收），Linux首版就绪结论恢复；复验发现的029锁重入回滚缺口[B003](BLOCKERS.md)已由[053](tasks/053-lock-reentry-rollback.md)实施修复并完成规定验证（全量236/236），主 Agent 已复核代码与验证证据。053另发现的成功混合申请单token缺口单列B004，当前未证实主流程可触达，修复前不新增同动作混合键重入业务路径。远端新增044–052主会话工作流任务；提交／发布仍需用户授权。

## 本轮首版交付补齐

用户已确认将主会话任务识别与创建、澄清与实施规划、每轮上下文，以及小任务单文件／复杂任务多文件资料一并纳入首版。044明确共同契约，045–049分别实现资料、加载、宿主注入、创建和规划，050验证安装升级集成，051独立验收自然语言全链路。另增052核对Pi 1.5.0更新日志、CLI／RPC／宿主公开能力，落实必要适配并评估有利的新能力；可独立审当前基线，为新工作流提供版本化约束。各项范围、实际依赖和完成条件见任务文件；本轮仅创建开发排程并进行只读核对，未实施功能或创建产品Task。

027–043保留原16项审计发现的修复职责。043通过不能代替新增能力验收；当前首版就绪还须044–050交付并由051独立核实，以及052确认目标Pi版本兼容，与既有必需门槛共同满足。编号仍按原规则优先推进，新增任务不要求把全部旧任务串为硬依赖；实际阻塞按具体接口判断。

## Agent 执行方式

1. 阅读根 [AGENTS.md](AGENTS.md)、本文件、[BLOCKERS.md](BLOCKERS.md) 和候选任务。按编号从小到大优先推进，编号是开发顺序，不是“上一项未完成就不能看下一项”的硬链。
2. 一次只有一个执行者。开始可推进任务前改为 in_progress，在任务文件记录执行者／Session和时间。遇到他人in_progress先核实其已停止再接手；文件表不是系统锁，不自行并发。
3. 根据任务的实际依赖核对具体产物和接口，而非只看前一项状态。所需模块已独立可用时可记录依据后使用；尚缺时先做能独立完成的部分，按明确暂定接口编写后续代码或隔离测试，不伪造真实效果。
4. 普通错误能在当前授权范围内修复就直接修。确有环境、能力、依赖或待用户取舍阻塞时，保存已做工作，将本项标blocked，并在BLOCKERS.md登记根因、证据、影响和待决定事项；任务文件补伪代码／暂定接口和后续补做步骤。不在现场反复问用户或无限重试。
5. 记录后继续扫描后续任务。依赖同一阻塞且暂时无法实现的任务，引用同一阻塞编号，写清能做／待补部分后继续跳过；可独立推进的领域、契约、模板、查询、测试或文档照常开发。不得把关键安全、授权或真实效果要求降级成假成功。
6. 实施并做相称验证，记录实际命令、环境、证据和未验证项，同步受影响设计。伪代码只表示待实现，最小测试替身只证明局部逻辑；必需实现／验证仍缺失时保持blocked，不能标completed。
7. 一项交付与必需验证全部达到才改completed，然后继续下一项，无需重复请示。扫描到尾后，仅对有新事实／依赖已补齐的阻塞回头复验；需用户选择的等待明确决定，暂定接口不等于用户选型。
8. 020、026、043、051用独立检查上下文，模型可以相同。检查可先审已有成果、记录缺口，但有必需阻塞就不能宣称阶段／发布验收通过；043与051分别检查原审计修复和新增工作流，不互相替代。这不阻止继续开发其它独立任务。
9. 当前无可推进工作时汇总已完成、伪代码和待用户决定项交接。不要为继续而空转，也不要仅因遇到第一项阻塞就结束整轮。

## 状态约定

- pending：尚未执行，或有明确记录需重新实施。
- in_progress：当前唯一执行项。
- blocked：已记录未解决实现／验证／决定，允许继续其它可推进任务；保留已有工作和伪代码，不代表未做过。
- completed：本任务交付和必需验证真正完成，记录可追溯；伪代码／占位实现不能满足这个状态。

TASKS.md是唯一任务状态表，BLOCKERS.md是阻塞与决定记录，任务文件保存实施事实和伪代码，不重复维护status。这些状态不等同Knit产品status/phase/outcome，也不代表代码已提交或已发布。

## 执行边界

- 用户已授权按队列开发并在阻塞时先用伪代码／暂定接口交接、继续其它工作；需要用户决定的取舍如实留在BLOCKERS.md，不自行当作已批准。
- 不在当前工程或其它真实项目自动git init、commit、push、amend、reset、stash apply、发布npm或部署。既有修改和证据保留；任务内Git初始化／提交／冲突实验仅在隔离夹具进行。
- 不对用户其它真实仓库执行init／提交／迁移。020之前仅临时项目；020通过也不自动授权其它项目操作。
- 真实Pi验证仅做对应任务最小必要调用，沿已授权当前模型，不静默换模；模型不可用时登记阻塞，继续无关代码或用明确测试替身，不以伪响应冒充真实验证。
- 不引Pi SDK／RpcClient，不建模型／鉴权运行时、服务或插件平台。存储由004实证决定；未决定可按MetadataStore暂定契约推进，不暗选后端或双写权威镜像。
- 首版不含Worktree、REX、其它客户端和并行调度。开发跳过阻塞不改变产品运行时遇未知工具／权限／数据安全问题必须停止副作用的规则。

## 顺序任务

| ID | 里程碑 | 状态 | 任务 |
| --- | --- | --- | --- |
| 001 | M0 | completed | [建立工程工具链与包边界](tasks/001-engineering-baseline.md) |
| 002 | M0 | completed | [建立最小协议、schema与内部端口](tasks/002-contracts-and-ports.md) |
| 003 | M0 | completed | [实现本机Pi CLI协议适配](tasks/003-pi-cli-runtime.md) |
| 004 | M0 | completed | [实证比较并确定唯一元数据仓储](tasks/004-metadata-storage-decision.md) |
| 005 | M0 | completed | [验证宿主桥接准入并收敛M0](tasks/005-pi-host-admission.md) |
| 006 | M1 | completed | [实现纯领域状态与检查资格](tasks/006-domain-rules.md) |
| 007 | M1 | completed | [实现文件、占用与操作检查点基础](tasks/007-local-infrastructure.md) |
| 008 | M1 | completed | [实现init与项目受管资料所有权](tasks/008-project-initialization.md) |
| 009 | M1 | completed | [实现Task文件与输入草案操作](tasks/009-task-files-and-inputs.md) |
| 010 | M1 | completed | [实现Session索引、当前选择与上下文计划](tasks/010-session-context.md) |
| 011 | M1 | completed | [实现规范候选到正式规则的闭环](tasks/011-standards-evolution.md) |
| 012 | M1 | completed | [实现快照准备、local启动与worker认领](tasks/012-snapshots-and-workers.md) |
| 013 | M1 | completed | [实现实施、检查、结果接收与恢复续做](tasks/013-stage-execution-and-recovery.md) |
| 014 | M1 | completed | [实现限定提交、归档与确定性收尾](tasks/014-delivery-and-archive.md) |
| 015 | M1 | completed | [完成CLI与生产薄桥接并验收M1](tasks/015-cli-bridge-m1-gate.md) |
| 016 | M2 | completed | [强化快照与逐路径恢复保护](tasks/016-path-restore-and-fingerprints.md) |
| 017 | M2 | completed | [强化占用、取消和中断后的执行安全](tasks/017-cancellation-and-lock-failures.md) |
| 018 | M2 | completed | [验证接收、草案和业务状态的竞争恢复](tasks/018-acceptance-and-state-races.md) |
| 019 | M2 | completed | [验证Git、归档与封存的关键故障](tasks/019-git-and-seal-failures.md) |
| 020 | M2 | completed | [独立检查真实项目使用门槛](tasks/020-m2-independent-gate.md) |
| 021 | M3A | completed | [完善分支接管、对话树和多会话关联](tasks/021-adopt-tree-and-sessions.md) |
| 022 | M3A | completed | [完善初始化升级与指令生效核对](tasks/022-upgrades-and-instructions.md) |
| 023 | M3A | completed | [完善用量、历史和只读诊断查询](tasks/023-usage-history-and-diagnostics.md) |
| 024 | M3A | completed | [完成私有诊断并验收日常使用](tasks/024-developer-mode-m3a-gate.md) |
| 025 | M3B | completed | [完成平台、打包和使用文档](tasks/025-packaging-and-platform-ci.md) |
| 026 | M3B | completed | [独立完成首版发布就绪审查](tasks/026-release-independent-gate.md) |
| 027 | 审计修复 P1 | completed | [按当前成果指纹核实检查与交付资格](tasks/027-revalidate-check-artifacts.md) |
| 028 | 审计修复 P1 | completed | [在运行边界核对实际 Git 分支](tasks/028-verify-live-run-branch.md) |
| 029 | 审计修复 P1 | completed | [允许真实活动运行期间保存与撤回输入草案](tasks/029-allow-active-input-drafts.md) |
| 030 | 审计修复 P1 | completed | [持久化应用草案后的业务状态转移](tasks/030-persist-pending-transitions.md) |
| 031 | 审计修复 P1 | completed | [将全部生效指令版本纳入检查身份](tasks/031-include-effective-instructions.md) |
| 032 | 审计修复 P1 | completed | [落实规定的写入与限定提交凭据扫描](tasks/032-scan-credential-boundaries.md) |
| 033 | 审计修复 P1 | completed | [阻止规范采纳沿符号链接越出项目](tasks/033-contain-standards-writes.md) |
| 034 | 审计修复 P1 | completed | [取消违背首版规则的固定阶段总时限](tasks/034-remove-fixed-stage-deadline.md) |
| 035 | 审计修复 P2 | completed | [补齐 prefer 恢复的身份核对与新会话切换](tasks/035-repair-prefer-session-fallback.md) |
| 036 | 审计修复 P2 | completed | [允许更新尚未完整归档的 completed 任务](tasks/036-reopen-unarchived-completed.md) |
| 037 | 审计修复 P2 | completed | [实现正式规范作为明确授权成果的路径](tasks/037-authorize-standard-artifacts.md) |
| 038 | 审计修复 P2 | completed | [按候选版本与实际效果恢复规范采纳](tasks/038-verify-standard-adoption-effects.md) |
| 039 | 审计修复 P2 | completed | [保留初始化升级中断时的旧受管基线](tasks/039-retain-init-upgrade-baselines.md) |
| 040 | 审计修复 P2 | completed | [收紧既有运行目录及 SQLite 文件权限](tasks/040-enforce-runtime-private-modes.md) |
| 041 | 审计修复 P2 | completed | [在项目状态概览中列出按月归档任务](tasks/041-include-archive-status.md) |
| 042 | 审计修复 P3 | completed | [在 Pi 命令中展示结构化查询结果](tasks/042-show-bridge-query-results.md) |
| 043 | 审计复验 | completed | [独立复验一致性审计修复与当前就绪结论](tasks/043-audit-independent-regression.md)；复验发现029锁重入回滚缺口已登记 B003，不推翻修复结论 |
| 044 | 首版工作流 | completed | [明确主会话工作流与任务规划资料契约](tasks/044-main-agent-workflow-contract.md) |
| 045 | 首版工作流 | completed | [实现任务规划资料与多文件输入生命周期](tasks/045-task-planning-materials.md) |
| 046 | 首版工作流 | completed | [按角色加载任务需求设计与实施计划](tasks/046-role-aware-task-context.md) |
| 047 | 首版工作流 | completed | [实现主会话每轮任务上下文与工作流注入](tasks/047-main-session-context-injection.md) |
| 048 | 首版工作流 | completed | [实现自然语言任务识别授权与创建衔接](tasks/048-conversation-task-intake.md) |
| 049 | 首版工作流 | completed | [实现需求澄清持久规划与实施前核对](tasks/049-discussion-planning-readiness.md) |
| 050 | 首版工作流 | completed | [集成首版工作流模板安装与升级](tasks/050-workflow-template-upgrade-integration.md)；集成验证见 validation/workflow-integration/ |
| 051 | 首版工作流验收 | completed | [独立验收首版自然语言任务与规划全链路](tasks/051-main-workflow-independent-gate.md)；确定性链路 85/85、真实宿主 3 模型轮全过（[validation/main-workflow-gate/](validation/main-workflow-gate/README.md)）；复验发现的 B005 已当轮修复并复验（探针复跑全过），验收通过 |
| 052 | 首版运行时兼容 | completed | [核对Pi 1.5.0公开接口并完成兼容与能力采用评估](tasks/052-pi-1-5-compatibility-and-capabilities.md)；兼容验证见 validation/pi-1.5.0-compat/ |
| 053 | 复验缺陷修复 | completed | [修复锁混合重入失败的对称回滚](tasks/053-lock-reentry-rollback.md)；独立 worker 实施及规定验证完成（基础设施31、主探针47、后果探针8、全量236项全过），主 Agent 已复核代码与验证证据，B003已修复；另记范围外B004 |

## 阶段验收门槛

下表决定能否宣称阶段／真实项目使用／发布就绪，不是阻止后续独立编码的硬门。阶段有阻塞可继续后面任务的可做部分，最终必须回补实现和真实验证。

| 阶段 | 任务 | 必须得到的结果 |
| --- | --- | --- |
| M0 | 001–005 | Node24工程基线、CLI真实能力、唯一存储决定、宿主schema／信任与结果连接准入 |
| M1 | 006–015 | 临时项目可安装闭环：Task／规范／Session／worker／独立检查／限定交付，生成桥接实际验收 |
| M2 | 016–020 | 历史独立检查通过；027–042修复已由043独立复验通过（2026-11-02，[复验报告](validation/audit-fix-verification/report.md)）；029锁重入失败回滚缺陷B003已由053修复并通过规定验证与主 Agent 代码／证据复核；成功混合申请单token缺口另列B004，未证实主流程可触达，修复前不新增同动作混合键重入业务路径；真实项目使用仍受020原有限制约束 |
| M3A | 021–024 | 分支／树／多会话、升级与规则、完整查询用量、私有诊断及日常接续 |
| 首版主会话与规划 | 044–051 | 从自然语言需求进入任务创建／拒绝、澄清、轻重任务规划、实施交接和跨Session接续；实际包内初始化／升级可用，由051独立核实。051验收通过（2026-11-03）：入口／创建／拒绝、澄清与资料持久化、进度与需求变更分流、ready 核对、跨Session接续、每轮注入、真实宿主（pi 1.5.0，3模型轮）工具链路、worker 规划资料装配（B005 修复后复验）全部通过 |
| Pi版本兼容 | 052 | 对比已验证基线与Pi 1.5.0公开变化，完成必要适配及CLI／宿主实际验证，给出新能力采用决定；为047–050交接版本化接口约束 |
| M3B | 025–026、043、051–052 | 保留历史安装／审查证据；027–042修复由043复验，044–050新增工作流由051验收，052确认Pi目标版本兼容，共同核对Linux首版就绪结论；macOS仍按B001延期，不自动发布 |

## 覆盖与依据

既有场景对应DESIGN第16.1节；本轮新增主会话与规划场景由044同步写入规范。前面任务落实能力，后续门槛任务复核实际效果，不能以覆盖表代替验证。

| 首版验收场景 | 主要任务 |
| --- | --- |
| CLI 与存储验证 | [001](tasks/001-engineering-baseline.md)、[002](tasks/002-contracts-and-ports.md)、[003](tasks/003-pi-cli-runtime.md)、[004](tasks/004-metadata-storage-decision.md)、[005](tasks/005-pi-host-admission.md)、[052](tasks/052-pi-1-5-compatibility-and-capabilities.md) |
| 初始化与内部装配 | [008](tasks/008-project-initialization.md)、[015](tasks/015-cli-bridge-m1-gate.md) |
| 输入与阶段 | [006](tasks/006-domain-rules.md)、[009](tasks/009-task-files-and-inputs.md)、[013](tasks/013-stage-execution-and-recovery.md)、[015](tasks/015-cli-bridge-m1-gate.md)、[018](tasks/018-acceptance-and-state-races.md) |
| 规范演进 | [011](tasks/011-standards-evolution.md)、[015](tasks/015-cli-bridge-m1-gate.md) |
| 单任务闭环 | [015](tasks/015-cli-bridge-m1-gate.md) |
| 模型与报告 | [003](tasks/003-pi-cli-runtime.md)、[013](tasks/013-stage-execution-and-recovery.md)、[015](tasks/015-cli-bridge-m1-gate.md) |
| Session 基础索引 | [010](tasks/010-session-context.md)、[013](tasks/013-stage-execution-and-recovery.md)、[015](tasks/015-cli-bridge-m1-gate.md) |
| 基本安装 | [001](tasks/001-engineering-baseline.md)、[015](tasks/015-cli-bridge-m1-gate.md) |
| 状态与开发诊断 | [002](tasks/002-contracts-and-ports.md)、[015](tasks/015-cli-bridge-m1-gate.md)、[024](tasks/024-developer-mode-m3a-gate.md) |
| 身份与冲突 | [007](tasks/007-local-infrastructure.md)、[009](tasks/009-task-files-and-inputs.md)、[014](tasks/014-delivery-and-archive.md)、[019](tasks/019-git-and-seal-failures.md)、[021](tasks/021-adopt-tree-and-sessions.md) |
| 快照与恢复 | [012](tasks/012-snapshots-and-workers.md)、[016](tasks/016-path-restore-and-fingerprints.md)、[020](tasks/020-m2-independent-gate.md) |
| 占用与取消 | [007](tasks/007-local-infrastructure.md)、[017](tasks/017-cancellation-and-lock-failures.md)、[020](tasks/020-m2-independent-gate.md) |
| 接收与崩溃 | [004](tasks/004-metadata-storage-decision.md)、[013](tasks/013-stage-execution-and-recovery.md)、[018](tasks/018-acceptance-and-state-races.md)、[020](tasks/020-m2-independent-gate.md) |
| Git 与已有修改 | [014](tasks/014-delivery-and-archive.md)、[019](tasks/019-git-and-seal-failures.md)、[020](tasks/020-m2-independent-gate.md) |
| 收尾断点与补记 | [014](tasks/014-delivery-and-archive.md)、[019](tasks/019-git-and-seal-failures.md)、[020](tasks/020-m2-independent-gate.md) |
| 原生阶段恢复 | [003](tasks/003-pi-cli-runtime.md)、[010](tasks/010-session-context.md)、[013](tasks/013-stage-execution-and-recovery.md)、[017](tasks/017-cancellation-and-lock-failures.md)、[020](tasks/020-m2-independent-gate.md) |
| 最小诊断与版本 | [007](tasks/007-local-infrastructure.md)、[017](tasks/017-cancellation-and-lock-failures.md)、[020](tasks/020-m2-independent-gate.md)、[023](tasks/023-usage-history-and-diagnostics.md) |
| adopt、树、多会话 | [021](tasks/021-adopt-tree-and-sessions.md) |
| 初始化升级与指令 | [022](tasks/022-upgrades-and-instructions.md) |
| 用量与完整查询 | [023](tasks/023-usage-history-and-diagnostics.md)、[024](tasks/024-developer-mode-m3a-gate.md) |
| 归档历史 | [014](tasks/014-delivery-and-archive.md)、[019](tasks/019-git-and-seal-failures.md)、[021](tasks/021-adopt-tree-and-sessions.md)、[023](tasks/023-usage-history-and-diagnostics.md) |
| 发布验证 | [025](tasks/025-packaging-and-platform-ci.md)、[026](tasks/026-release-independent-gate.md)、[043](tasks/043-audit-independent-regression.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| 主会话每轮任务与工作流上下文 | [044](tasks/044-main-agent-workflow-contract.md)、[046](tasks/046-role-aware-task-context.md)、[047](tasks/047-main-session-context-injection.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| 自然语言任务识别、授权、创建与拒绝 | [044](tasks/044-main-agent-workflow-contract.md)、[048](tasks/048-conversation-task-intake.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| 小任务单文件与复杂任务持久设计／计划 | [044](tasks/044-main-agent-workflow-contract.md)、[045](tasks/045-task-planning-materials.md)、[046](tasks/046-role-aware-task-context.md)、[049](tasks/049-discussion-planning-readiness.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| 多轮澄清、实施前核对与中途需求变化 | [044](tasks/044-main-agent-workflow-contract.md)、[045](tasks/045-task-planning-materials.md)、[048](tasks/048-conversation-task-intake.md)、[049](tasks/049-discussion-planning-readiness.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| 新工作流包内初始化、旧模板升级与跨会话接续 | [046](tasks/046-role-aware-task-context.md)、[047](tasks/047-main-session-context-injection.md)、[050](tasks/050-workflow-template-upgrade-integration.md)、[051](tasks/051-main-workflow-independent-gate.md) |
| Pi 1.5.0兼容、公开接口变化与能力采用 | [052](tasks/052-pi-1-5-compatibility-and-capabilities.md)、[047](tasks/047-main-session-context-injection.md)、[050](tasks/050-workflow-template-upgrade-integration.md)、[051](tasks/051-main-workflow-independent-gate.md) |

设计入口：[DESIGN.md](DESIGN.md)、[ARCHITECTURE.md](ARCHITECTURE.md)、[STATES.md](STATES.md)、[TECHNOLOGY.md](TECHNOLOGY.md)、[OPERATIONS.md](OPERATIONS.md)。审查与已有事实见 [RESEARCH.md](RESEARCH.md)、[整体设计审查](validation/design-audit/README.md)。这些既有材料减少重复调研，不能替代当前实现的验收。

## 给新 Agent 的启动指令

> 先读 AGENTS.md、TASKS.md 和 BLOCKERS.md，按编号优先推进。遇阻塞记录事实、待决定问题和伪代码／暂定接口，标blocked后继续其它可做任务；不要因第一处阻塞停下来，也不要把占位实现当成功。完整实现和验证后才标completed，无可推进工作时再汇总交接。不要自动提交、推送、发布或初始化当前工程的产品状态。
