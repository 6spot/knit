# 设计、任务与实现一致性复核（2026-11-02）

本轮发现 **16 项独立偏差：8 项 P1、7 项 P2、1 项 P3**。已建立 [027–042 修复任务](../../docs/history/TASKS.md)及 [043 独立复验任务](../../docs/history/tasks/043-audit-independent-regression.md)。001–026 的历史 completed 保留，但其历史验收不能作为当前不存在缺口的证据；在这些发现收敛前，不沿用“首版已无未处理数据保护／实现缺口”的就绪结论。

本次交付是审计报告、可复现证据和后续排程，**尚未修复这些产品缺陷**。状态仅记入根 TASKS.md，不在本报告或任务文件另建一份状态机。

## 范围与证据基线

- 代码基线：`50936d71a6fb414dec7edfb793e4510f81889ac4`，使用 git archive 创建独立副本，链接已安装依赖后构建；源码与 dist 属于同一基线。
- 环境：Linux 6.12 aarch64、Node v24.21.0、npm 11.19.0。
- 依据：AGENTS.md、TASKS.md、BLOCKERS.md，以及 DESIGN／ARCHITECTURE／STATES／TECHNOLOGY／OPERATIONS 的首版要求；结合相关源码、测试、验证记录和已有产品任务逐项核对。
- Linux 首版范围。B001 已明确延期的 macOS、Worktree、REX、其它客户端及并行调度不作为新缺陷；没有扩大首版范围。
- 原工作区另有产品任务 `k-4bd444339302`（check-report-fence）在修改 stage.ts／stage.test.mjs 及其 task.md。没有覆盖其修改，也没有另建围栏容错任务；本报告对并发修改中的源码不作稳定构建结论。
- 三个独立只读上下文分别审业务状态／上下文／规范、worker／运行／恢复、初始化／路径／交付。主执行者交叉核对、去重并执行隔离探针；源码核实与动态证据分开标记。

## 主要发现及任务

P1 表示能破坏检查／输入／写入／执行关键约束，应优先修复；P2 表示明确的流程、恢复或可见性缺口；P3 为入口展示缺口。编号为建议执行顺序，依赖仍按实际接口判断。

| 发现／任务 | 优先级 | 偏差 | 证据等级 |
| --- | --- | --- | --- |
| [F027／027](../../docs/history/tasks/027-revalidate-check-artifacts.md) | P1 | 按当前成果指纹核实检查与交付资格 | 动态复现 + 源码核实 |
| [F028／028](../../docs/history/tasks/028-verify-live-run-branch.md) | P1 | 在运行边界核对实际 Git 分支 | 动态复现 + 源码核实 |
| [F029／029](../../docs/history/tasks/029-allow-active-input-drafts.md) | P1 | 允许真实活动运行期间保存与撤回输入草案 | 动态复现 + 源码核实 |
| [F030／030](../../docs/history/tasks/030-persist-pending-transitions.md) | P1 | 持久化应用草案后的业务状态转移 | 动态复现 + 源码核实 |
| [F031／031](../../docs/history/tasks/031-include-effective-instructions.md) | P1 | 将全部生效指令版本纳入检查身份 | 动态复现 + 源码核实 |
| [F032／032](../../docs/history/tasks/032-scan-credential-boundaries.md) | P1 | 落实规定的写入与限定提交凭据扫描 | 动态复现 + 源码核实 |
| [F033／033](../../docs/history/tasks/033-contain-standards-writes.md) | P1 | 阻止规范采纳沿符号链接越出项目 | 动态复现 + 源码核实 |
| [F034／034](../../docs/history/tasks/034-remove-fixed-stage-deadline.md) | P1 | 取消违背首版规则的固定阶段总时限 | 源码核实，未动态复现 |
| [F035／035](../../docs/history/tasks/035-repair-prefer-session-fallback.md) | P2 | 补齐 prefer 恢复的身份核对与新会话切换 | 源码核实，未动态复现 |
| [F036／036](../../docs/history/tasks/036-reopen-unarchived-completed.md) | P2 | 允许更新尚未完整归档的 completed 任务 | 领域动态复现 + 应用层源码核实 |
| [F037／037](../../docs/history/tasks/037-authorize-standard-artifacts.md) | P2 | 实现正式规范作为明确授权成果的路径 | 源码核实，未动态复现 |
| [F038／038](../../docs/history/tasks/038-verify-standard-adoption-effects.md) | P2 | 按候选版本与实际效果恢复规范采纳 | 动态复现 + 源码核实 |
| [F039／039](../../docs/history/tasks/039-retain-init-upgrade-baselines.md) | P2 | 保留初始化升级中断时的旧受管基线 | 源码核实，未动态复现 |
| [F040／040](../../docs/history/tasks/040-enforce-runtime-private-modes.md) | P2 | 收紧既有运行目录及 SQLite 文件权限 | 动态复现 + 源码核实 |
| [F041／041](../../docs/history/tasks/041-include-archive-status.md) | P2 | 在项目状态概览中列出按月归档任务 | 动态复现 + 源码核实 |
| [F042／042](../../docs/history/tasks/042-show-bridge-query-results.md) | P3 | 在 Pi 命令中展示结构化查询结果 | 源码核实，需修复时宿主验证 |

### F027 按当前成果指纹核实检查与交付资格

检查接收和交付比较持久化 scope 摘要，没有对其路径重新采样。外部编辑后，旧 pass 仍能通过 validCheck。currentEntry 还沿 stat 读取内容，scopeDigest 没有文件类型／执行位，chmod 0644→0755 不改变摘要。

- 依据：DESIGN §5.3、§5.6、§11；STATES §8（成果变化使检查过期）。
- 位置：`src/application/run-acceptance.ts:191、src/application/delivery-service.ts:911–936、src/application/scope.ts:24–65、src/infrastructure/fingerprint.ts`。
- 实际证据：data-probes.log：scope-current-content-validation.acceptedAfterExternalEdit=true；probes.json：scope-mode-change.fingerprintChanged=false。
- 场景、修复边界与完成验收见 [027](../../docs/history/tasks/027-revalidate-check-artifacts.md)。

### F028 在运行边界核对实际 Git 分支

request.expected.branch 来源于任务文件；worker 与接收只比较两份已记录值，未与实际检出分支比较。绑定 main 的任务在 unrelated 分支仍能启动并完成阶段。

- 依据：DESIGN §3.5、§14.1；STATES 的分支接管与运行身份约束。
- 位置：`src/application/run-coordinator.ts:204、src/worker/knit-worker.ts:199、src/application/run-acceptance.ts:187`。
- 实际证据：stage-probes.log：task-run-branch.started=true、taskBranch=main、head=unrelated。
- 场景、修复边界与完成验收见 [028](../../docs/history/tasks/028-verify-live-run-branch.md)。

### F029 允许真实活动运行期间保存与撤回输入草案

update／withdraw 在草案分支之前取得项目执行锁。真实 worker 持该锁时草案保存直接报 lock_busy；已有 prepareOnly 夹具保存草案时已释放锁，未覆盖真实活动状态。

- 依据：DESIGN §3.6；STATES §3 InputsUpdateProposed；项目长占用与任务短锁约定。
- 位置：`src/application/task-service.ts:685–688、838–843；src/worker/knit-worker.ts:172`。
- 实际证据：stage-probes.log：active-run-input-draft.saved=false、reason=lock_busy。
- 场景、修复边界与完成验收见 [029](../../docs/history/tasks/029-allow-active-input-drafts.md)。

### F030 持久化应用草案后的业务状态转移

applyPending 计算了 transition，却渲染仅合并正文的 merged，未把 transition 写回 frontmatter；同时清空草案并返回新阶段。动态观察响应为 discuss、磁盘仍为 implement、草案已清空。

- 依据：DESIGN §3.6；STATES §3 输入应用后的 phase／status 转移。
- 位置：`src/application/task-service.ts:814–815；src/domain/task.ts:onPendingResolved`。
- 实际证据：probes.json：pending-phase-persistence.responsePhase=discuss、diskPhase=implement、pendingCleared=true。
- 场景、修复边界与完成验收见 [030](../../docs/history/tasks/030-persist-pending-transitions.md)。

### F031 将全部生效指令版本纳入检查身份

workflow、role、runtime 分节带摘要并标 countsTowardInputs，但 effectiveInputsDigest 仅由任务输入与正式规范计算。只改 check 角色后分节指纹改变，整体摘要保持不变，交付资格也没有另行核实这些版本。

- 依据：DESIGN §5.3、§8.1；ARCHITECTURE 上下文计划与恢复指令生效清单。
- 位置：`src/application/context-planner.ts:140–190、306；src/application/delivery-service.ts:923`。
- 实际证据：probes.json：role-instructions-digest.roleDigestChanged=true、effectiveDigestChanged=false。
- 场景、修复边界与完成验收见 [031](../../docs/history/tasks/031-include-effective-instructions.md)。

### F032 落实规定的写入与限定提交凭据扫描

任务／规范写入及限定提交调用链没有规定扫描。合成私钥标记能写入任务；为合成内容建立匹配 scope/pass 后交付 completed 且创建工作提交，排除了027的旧检查问题。

- 依据：DESIGN §5.6（约346行）及 §15.1 第6项；规定的 token／私钥模式扫描。
- 位置：`src/application/task-service.ts:402、src/application/standards-service.ts:337、src/application/delivery-service.ts:655；相关配置写入入口`。
- 实际证据：data-probes.log：synthetic-credential-boundaries.taskWritten=true、deliveryState=completed、workCommitCreated=true；内容全部为审计合成标记。
- 场景、修复边界与完成验收见 [032](../../docs/history/tasks/032-scan-credential-boundaries.md)。

### F033 阻止规范采纳沿符号链接越出项目

采纳目标仅做字符串校验，再 join 到项目根；未核实父目录真实路径。父目录链接到另一个临时目录时，apply 成功并修改外部 rules.md。

- 依据：DESIGN §14.1；ARCHITECTURE §6；规范目标必须位于项目内。
- 位置：`src/application/standards-service.ts:318、337；src/application/standards.ts:110；src/infrastructure/atomic.ts`。
- 实际证据：data-probes.log：standards-parent-symlink.applied=true、outsideChanged=true。
- 场景、修复边界与完成验收见 [033](../../docs/history/tasks/033-contain-standards-writes.md)。

### F034 取消违背首版规则的固定阶段总时限

StageRunner 默认 promptTimeoutMs=900000。该值限制整个阶段；到期 runtime 返回未收敛，runner dispose 并失败，dispose 会 abort／必要时终止 Pi。合法持续活动超过15分钟也会因此被停止。

- 依据：DESIGN §5.9；OPERATIONS §4（约91行）：只观测，不按固定运行总时长自动取消。
- 位置：`src/application/stage-runner.ts:147、238、314；src/adapters/pi/runtime.ts:223、237；dispose 路径`。
- 实际证据：源码调用链核实；本轮未等待15分钟，未将缩短时限的建议场景当作已运行证据。
- 场景、修复边界与完成验收见 [034](../../docs/history/tasks/034-remove-fixed-stage-deadline.md)。

### F035 补齐 prefer 恢复的身份核对与新会话切换

runtime 仅要求 sessionId 非空，未与恢复目标／预分配身份比较；实际启动恢复失败直接失败，未沿同客户端新建。预检 fallback 创建新原生会话却沿用旧 knitSessionId 和 source，形成多个原生对象共用稳定身份，getByKnitId 查询有歧义。

- 依据：DESIGN §9.4 第3–5项；STATES §7 的原生恢复／fallback。
- 位置：`src/adapters/pi/runtime.ts:156；src/application/stage-runner.ts:178、225、452、464；src/infrastructure/sqlite-metadata-store.ts:138`。
- 实际证据：源码调用链核实；本轮未动态执行身份不符、启动失败和文件缺失三种 RPC stub 场景。
- 场景、修复边界与完成验收见 [035](../../docs/history/tasks/035-repair-prefer-session-fallback.md)。

### F036 允许更新尚未完整归档的 completed 任务

closedGuard 对全部 completed 返回 outcome_completed，onInputsUpdated 与草案应用沿用该拒绝，没有规定的未归档 completed 入口。纯领域探针返回 allowed=false／outcome_completed。

- 依据：DESIGN §3.6（约164行）；STATES §3：未完整归档且非 cancelled/superseded 的输入更新。
- 位置：`src/domain/task.ts:68–71、103；src/application/task-service.ts:736`。
- 实际证据：probes.json：completed-input-update-domain.decision.allowed=false、reason=outcome_completed；应用层归档条件由源码核实。
- 场景、修复边界与完成验收见 [036](../../docs/history/tasks/036-reopen-unarchived-completed.md)。

### F037 实现正式规范作为明确授权成果的路径

runner 无条件拒绝 .knit 下修改，含正式规范；上下文没有授权规范输出与冻结旧规范版本的表示，接收把当前规范变化统一判 stale_input。原011范围要求该能力，未发现延期决定。

- 依据：DESIGN §5.3；STATES §8（约133行）；ARCHITECTURE §8（约140行）：旧规范作输入、新规范作授权成果。
- 位置：`src/application/stage-runner.ts:331–333；src/application/run-acceptance.ts:174 附近；src/contracts/context-plan.ts`。
- 实际证据：源码及原任务范围交叉核实；本轮未执行授权规范输出 fake runtime 场景。
- 场景、修复边界与完成验收见 [037](../../docs/history/tasks/037-authorize-standard-artifacts.md)。

### F038 按候选版本与实际效果恢复规范采纳

正文包含任务ID／候选ID来源行就提前返回 alreadyApplied，未核对候选版本和索引。候选同ID改为v2后仍保留v1；正文成功、索引未发布时重试也不补索引，交付收尾只查来源标记。

- 依据：DESIGN §8.2；STATES §9–10；OPERATIONS 规范正文／索引更新与幂等要求。
- 位置：`src/application/standards-service.ts:321–349；src/application/delivery-service.ts:951–955`。
- 实际证据：data-probes.log：adoption-index-recovery.alreadyApplied=true、indexRepaired=false；adoption-candidate-version.alreadyApplied=true、containsV2=false。
- 场景、修复边界与完成验收见 [038](../../docs/history/tasks/038-verify-standard-adoption-effects.md)。

### F039 保留初始化升级中断时的旧受管基线

新执行先以空 items 覆盖清单，桥接发布前旧基线只留在进程内 previous。此时中断后重试，旧桥接失去已知基线，会被判为未知来源冲突。

- 依据：DESIGN §14.1（约640行）：按旧基线升级，中断按逐项清单继续。
- 位置：`src/application/initialization.ts:240、289、350`。
- 实际证据：初始化清单发布顺序的源码核实；本轮未注入中断或构造 preparing 清单重试。
- 场景、修复边界与完成验收见 [039](../../docs/history/tasks/039-retain-init-upgrade-baselines.md)。

### F040 收紧既有运行目录及 SQLite 文件权限

mkdir(mode) 不会修正既有目录；SQLite 仓储未指定／修正数据库权限。在 umask022、预建0755 runtime 下，初始化和仓储打开后 runtime=755、metadata.db=644、WAL=644。RunStore.create 的私有处理不能覆盖这些入口。

- 依据：OPERATIONS §3（约75行）：目录0700／文件0600；ARCHITECTURE 私有本机索引与运行资料。
- 位置：`src/infrastructure/sqlite-metadata-store.ts:47；src/application/initialization.ts:263；WAL／SHM 创建与现有目录路径`。
- 实际证据：probes.json：preexisting-runtime-permissions.runtimeMode=755、databaseMode=644、walMode=644。
- 场景、修复边界与完成验收见 [040](../../docs/history/tasks/040-enforce-runtime-private-modes.md)。

### F041 在项目状态概览中列出按月归档任务

status 枚举 archive 后不会继续递归年月目录下的任务，只检查月目录自身 task.md。task list 能找到已归档任务，按ID status 也能定位，但项目 status.tasks 中遗漏该任务。

- 依据：DESIGN §12 的项目／任务状态查询与归档可追溯要求；CLI status 既有 tasks 概览契约。
- 位置：`src/application/status-service.ts:174 附近 listTasks；对照 src/application/task-service.ts:taskDirectories`。
- 实际证据：probes.json：archived-task-status.listedByTasks=true、listedByStatus=false、taskStatus 可返回同一ID。
- 场景、修复边界与完成验收见 [041](../../docs/history/tasks/041-include-archive-status.md)。

### F042 在 Pi 命令中展示结构化查询结果

两个 slash 命令 handler 只读取 error、data.error、reasonCode 或 stderr，完全不渲染成功响应的 data。task list／status 成功时只能得到通用完成／无输出提示，无法从该入口读取实际任务或状态。

- 依据：DESIGN §3 的当前任务选择与 §12 的查询入口；首版 Pi 桥接使用约定；具体显示按现有CLI数据契约。
- 位置：`assets/templates/pi/extensions/knit.ts:290–346；src/cli/status.ts、src/cli/output.ts`。
- 实际证据：桥接 handler、core JSON返回与通知分支源码核实；本轮未执行真实宿主显示验证。
- 场景、修复边界与完成验收见 [042](../../docs/history/tasks/042-show-bridge-query-results.md)。

## 原任务逐项对照

此表记录本轮核对结果与修复关联，不改写历史执行事实。“未新增确定偏差”只表示本轮没有足够证据登记新问题，不表示穷尽所有故障。

| 原任务 | 主题 | 本轮核对与后续 |
| --- | --- | --- |
| [001](../../docs/history/tasks/001-engineering-baseline.md) | 工程工具链与包边界 | typecheck、build、pack-check 通过；未新增确定偏差。 |
| [002](../../docs/history/tasks/002-contracts-and-ports.md) | 协议与内部端口 | 契约与消费链交叉核对；规范成果及指令身份需随031／037补齐。 |
| [003](../../docs/history/tasks/003-pi-cli-runtime.md) | 本机Pi适配 | 固定阶段总时限、恢复身份／fallback：034／035。 |
| [004](../../docs/history/tasks/004-metadata-storage-decision.md) | 元数据仓储 | SQLite选型及唯一仓储保留；私有模式遗漏：040。 |
| [005](../../docs/history/tasks/005-pi-host-admission.md) | 宿主桥接准入 | 只读核对公开API路径；slash成功查询不展示data：042。本轮未重跑真实宿主准入。 |
| [006](../../docs/history/tasks/006-domain-rules.md) | 领域规则 | 草案持久化、检查过期、completed更新：027／030／036。 |
| [007](../../docs/history/tasks/007-local-infrastructure.md) | 文件／锁／检查点 | 活动草案长锁、路径边界、私有权限：029／033／040。 |
| [008](../../docs/history/tasks/008-project-initialization.md) | 初始化／所有权 | 升级中断清单丢基线、既有runtime权限：039／040。 |
| [009](../../docs/history/tasks/009-task-files-and-inputs.md) | 任务文件／输入 | 草案长锁、状态未落盘、凭据写入、completed更新：029／030／032／036。 |
| [010](../../docs/history/tasks/010-session-context.md) | Session／上下文 | 有效指令摘要、恢复身份：031／035；当前查询展示归042。 |
| [011](../../docs/history/tasks/011-standards-evolution.md) | 规范闭环 | 越界写、授权规范成果、采纳版本／索引恢复：033／037／038；扫描归032。 |
| [012](../../docs/history/tasks/012-snapshots-and-workers.md) | 快照／worker | 实际分支身份未核实：028；成果指纹类型／执行位归027。 |
| [013](../../docs/history/tasks/013-stage-execution-and-recovery.md) | 阶段执行／恢复 | 检查身份、分支、指令、停止、恢复：027／028／031／034／035／037。 |
| [014](../../docs/history/tasks/014-delivery-and-archive.md) | 交付／归档 | 旧scope资格、凭据扫描、completed更新、采纳效果、归档概览：027／032／036／038／041。 |
| [015](../../docs/history/tasks/015-cli-bridge-m1-gate.md) | CLI／桥接M1验收 | 历史真实Pi证据保留；当前桥接显示缺口042，需043重新综合验收。 |
| [016](../../docs/history/tasks/016-path-restore-and-fingerprints.md) | 路径／恢复／指纹 | scope模式／类型与规范父链接边界：027／033；不把已修恢复任务重复登记。 |
| [017](../../docs/history/tasks/017-cancellation-and-lock-failures.md) | 取消／锁／中断 | 活动草案被长锁挡住、固定总时限、恢复切换：029／034／035。 |
| [018](../../docs/history/tasks/018-acceptance-and-state-races.md) | 接收／状态竞争 | 真实活动草案、落盘转移、过期资格、completed分支：027／029／030／036。 |
| [019](../../docs/history/tasks/019-git-and-seal-failures.md) | Git／封存故障 | 当前成果版本、提交扫描、采纳部分效果核实：027／032／038。 |
| [020](../../docs/history/tasks/020-m2-independent-gate.md) | M2独立门槛 | 历史通过保留；新增数据保护问题使当前结论需按027–040修复后重验。 |
| [021](../../docs/history/tasks/021-adopt-tree-and-sessions.md) | adopt／树／多会话 | adopt本身不替代真实分支核实；028／035。 |
| [022](../../docs/history/tasks/022-upgrades-and-instructions.md) | 升级／指令 | 旧基线中断恢复与生效指令整体身份：031／039。 |
| [023](../../docs/history/tasks/023-usage-history-and-diagnostics.md) | 用量／查询／诊断 | 按月归档任务概览遗漏041；slash查询显示042。用量／只读诊断未新增确定偏差。 |
| [024](../../docs/history/tasks/024-developer-mode-m3a-gate.md) | 开发者模式M3A验收 | 白名单诊断实现保留；runtime／SQLite权限040影响私有性声明，043复验。 |
| [025](../../docs/history/tasks/025-packaging-and-platform-ci.md) | 打包／平台 | 基线包检查通过；Linux实际环境见下，macOS已由B001延期，本轮不补造平台结果。 |
| [026](../../docs/history/tasks/026-release-independent-gate.md) | 独立发布就绪审查 | 历史completed保留；新增16项推翻当前“无未处理缺口”的外推，需043独立重新给出结论。 |

## 实际验证

| 验证 | 本轮结果 | 证据 |
| --- | --- | --- |
| npm run typecheck | 退出0 | [日志](baseline-typecheck.log) |
| npm run build | 退出0 | [日志](baseline-build.log) |
| PI_EXECUTABLE=/__knit_audit_no_real_pi__ node --test test/*.test.mjs | 202项：201通过、0失败、1跳过 | [日志](baseline-suite.log) |
| node scripts/pack-check.mjs | 退出0，包检查通过 | [日志](baseline-pack.log) |
| 文件／领域探针 | 6个观察场景运行完成 | [脚本](probes.mjs)、[原始结果](probes.json) |
| fake Pi真实worker探针 | 2个观察场景运行完成 | [脚本](stage-probes.mjs)、[原始结果](stage-probes.log) |
| 交付／规范副作用探针 | 5个观察场景运行完成 | [脚本](data-probes.mjs)、[原始结果](data-probes.log) |

补充探针使用测试框架承载观察场景：日志中的 pass 只表示探针成功执行，产品是否违背要求以 AUDIT_RESULT／JSON 观察值判定。它们不是修复后的回归断言，也没有替代真实宿主验收。

正式基线全套测试通过仍漏掉上述路径，典型原因是只断言响应而未重读磁盘、只比较缓存摘要、用 prepareOnly 代替真实worker持锁、只测完整成功重试。后续任务要求补与业务后果直接相关的回归断言。

## 复现方法

以下操作应在独立检出基线且已装好依赖的临时副本执行。ROOT 为该副本绝对路径；三个脚本只对其 dist／模板／测试夹具读取，副作用实验均在另建的临时仓库，结束后删除。data-probes 的合成凭据标记不含真实密钥。探针依赖基线测试helper标记；修复后测试重构时应将场景迁入正式回归测试。

```sh
npm run typecheck
npm run build
PI_EXECUTABLE=/__knit_audit_no_real_pi__ node --test test/*.test.mjs
node scripts/pack-check.mjs
node /path/to/validation/design-implementation-audit/probes.mjs /absolute/path/to/ROOT
node /path/to/validation/design-implementation-audit/stage-probes.mjs /absolute/path/to/ROOT
node /path/to/validation/design-implementation-audit/data-probes.mjs /absolute/path/to/ROOT
```

## 限制与去重

- 真实Pi冒烟在稳定基线验证中被显式跳过；本轮没有对真实模型／宿主重新给出通过结论，也没有改变原有验证记录。首轮直接在活动工作区的测试超时／构建产物竞争不作为产品缺陷。
- F034、F035、F037、F039、F042 有明确源码与规范证据，本轮没有动态执行其完整场景；各修复任务保留这一限制和必需验证。F036动态验证领域拒绝，归档应用层条件由源码核实。
- 数据保护问题使用临时Git仓库／合成内容，不操作真实项目提交或外部仓库。未运行 npm publish、push、真实仓库 commit 或迁移。
- 待接收结果与草案相互等待的恢复窗口、取消后部分成果scope等疑点没有独立登记为确定缺陷；需要新证据时再扩充，不能从静态猜测外推。
- 既有围栏容错、已归档快照总量／执行位安装问题及已明确延期范围不重复建任务。
- 043 在027–042有实际修复产物后，以独立上下文复验要求、真实路径和证据，再更新当前就绪结论。
