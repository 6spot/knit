# Knit 运行细则

本文件补充 [DESIGN.md](DESIGN.md) 的运行规则；模块与唯一写入方见 [ARCHITECTURE.md](ARCHITECTURE.md)，枚举／转移见 [STATES.md](STATES.md)，依赖版本见 [TECHNOLOGY.md](TECHNOLOGY.md)。首版独立 CLI、Pi／local 和项目薄桥接已实现至 Linux 候选；Worktree、REX 等属于后续。

## 1. 内部模块与项目桥接

Knit 按源码中的固定装配表使用客户端、runtime 与执行宿主，配置只选择已实现 ID。不会从 `plugins[].module`、项目路径或任意包名导入代码，不提供第三方插件安装与授信流程。新增能力由系统代码维护、构建与测试。

`knit init --client pi` 自动生成项目 `.pi/extensions/knit.ts` 薄桥接。它仅使用 Pi 公开 API，转交原生会话、当前模型、事件、命令／工具和上下文计划；业务处理调用本机 Knit CLI，不嵌入任务和规范逻辑。

桥接文件是可入库的固定模板，按其自身文件位置定位项目。`.knit/.runtime/installation.json` 保存本机 Knit CLI 位置与安装版本，`init-manifest.json` 保存模板版本、文件所有权、指纹、逐项结果及 `preparing/ready/failed`。本机路径不写进共享桥接；只有 ready 且匹配时桥接才处理调用，缺失或不匹配则提示 init。模板随安装包发布在 `assets/templates/`：`.knit/` 项目资料（config、workflow、agents、standards）与 `pi/extensions/knit.ts` 桥接；实现位于 `src/application/`（InitializationService，任务008），配置校验在 `src/application/config.ts`。

`knit start` 先核对项目桥接、受管入口和本机安装信息；用户修改过的受管代码或冲突先报告差异，不静默覆盖。用户直接运行 Pi 时由 Pi 自身加载项目扩展，Knit 不能拦截其他项目扩展代码。项目配置本身不构成执行任意模块或脚本的授权，验证命令仍遵守任务范围。

| 本机资料 | 用途 |
| --- | --- |
| 用户级行为配置 | 首版不提供 ~/.knit/config.json 覆盖，保留项目与调用层配置，不增加全局模型优先级 |
| `~/.knit/locks/` | 本用户、本机占用记录 |
| 项目 `.knit/.runtime/` | 私有安装映射、初始化清单、会话、绑定、run 和快照，Git 忽略 |

init 维护两类文件：配置、工作流、角色和规范属于项目资料，只补缺；桥接代码及入口标记块属于受管内容，与旧基线一致时可更新，人工改动或未知来源须报告差异。先准备资料与本机映射，最后发布桥接并置 ready；中断按逐项结果核实，不能把部分初始化作为成功。安装 ready 不替代 Pi 原生项目信任；可信项目中新 Pi 可自动加载，已有会话 `/reload` 或重启，未受信时说明原因，不默认加 `--approve` 绕过。子 worker 使用明确资源参数，默认不加载主桥接。

## 2. 占用与解除

首版只协调本用户、本机 Knit 的执行。项目与锁目录要求本地文件系统；已识别 NFS／SMB 或确实不能满足原子占用／身份核实条件时阻塞写操作。实现（任务026）：正式 `task new`／`task ready` 核对 Git 工作区、HEAD、本地分支、未完成 merge/rebase/cherry-pick/revert/bisect、index 冲突与 `.knit/.runtime` 跟踪；doctor 同时报告项目根文件系统与已知云同步根。已知云同步根内的本地目录由 doctor 告警，不仅因目录名阻塞。跨机并发及外部编辑器、Git 进程不受 Knit 锁控制，阶段边界仍要核对实际状态。

同一用户各项目使用本机共享锁根 `~/.knit/locks/`：projects/<项目根摘要>/ 与 sessions/<客户端及原生身份摘要>/，目录0700、owner文件0600；不是用户级行为配置、服务或跨机锁。实际写操作按需建立，init --check／status／doctor 只读时不创建。这样同一原生会话不会因项目各有独立锁目录而绕过占用。

项目执行锁按执行目录取键（任务 k-2cbd2f312298）：主检出路由用规范化主检出根，已交接 worktree 路由用该 worktree 的规范化路径；worker 阶段与 run 结果接收只持有对应执行目录键，prepare、Git 收尾、任务更新与清理仍用主检出键。不同 worktree 的执行目录键不同，可各自运行任务阶段并分别接收；同一执行目录与同一任务仍互斥，主检出路由保持一次一个。worker 未取得执行目录锁的失败路径改用主检出键接收失败事实。不设并发上限、排队、依赖图或跨机调度。Git 身份作为每次核验事实，不因初始化仓库或分支变化改锁键；路径别名先解析为同一根。Session 执行锁以客户端、原生 ID 与必要实例身份为跨项目键，不用随 run 改变的文件目录作键。新建前预分配原生 ID，获得锁后让 CLI 使用该 ID 并核对实际返回。项目执行占用在前、Session 占用在后，同类多键排序，mkdir 已存在即失败并按 token 释放本次已取锁。原生恢复失败时释放旧 Session 锁再锁候选新 ID，项目占用保持；不同时持有两把不同 Session 锁倒序等待。owner.json 保存协议、token、动作／run、机器／启动标识、PID 与开始时间，心跳原子更新，释放核对 token。基础设施实现（任务007）：`src/infrastructure/locks.ts` 用 mkdir 抢占、owner 文件原子写、AcquiredLock 按 keys 顺序保存每个 owner 的 token 与版本；token 字段兼容首键，混合重入的释放及心跳逐键核对 ownerTokens。同实例嵌套句柄共享已成功写入的心跳版本，外部改写仍报版本冲突，失败申请逆序撤销本次新增引用与资源；旧单 token 句柄保持原调用约定；进程身份含 /proc/<pid>/stat starttime 排除 PID 复用；实现与验证证据见该任务记录。

实现（任务018）：`task update`／`task apply-pending`／`task close` 在项目与任务锁内按真实 run 仓储复核活动／结果／验收操作；活动 run 只保存草案，apply 与 close 在未收敛时拒绝。`run prepare` 与关闭共用主检出项目锁，并短暂等待上一 worker 释放；接收按执行目录项目锁使用 `runs/<run>/acceptance.json` 检查点，Task／scope／check／binding 半写入可重入收敛。`task record` 等纯记录仍只取任务短锁。实现（任务022）：init 以 `init-manifest.json` 上次 `baselineSha256` 区分旧受管基线与人工改动；旧基线按新模板更新，人工／未知来源冲突不覆盖，`--force` 显式覆盖；清单模板版本高于当前安装包时拒绝降级。安装映射每次按当前 CLI 入口重写。桥接模板以进程级 Symbol guard 在重复加载／reload 前停止旧观察器，ready 不授予 Pi 项目信任。`task adopt` 在项目＋任务锁内重新核对当前分支、Task 版本、活动 run 与未完成 delivery 操作；只可改绑到当前检出分支，discuss／implement／check 保持，deliver 回 open/check，清 `lastCheckRunId` 但保留检查历史文件。原生选择事件的分支与当前分支不一致时报告 `branch_changed` 并不生效；run 状态投影保存发起分支，桥接轮询发现分支不一致时跳过通知。实现（任务017）：取得项目锁前创建锁根并核对本地文件系统，已知 NFS／SMB／FUSE 类型报 `lock_fs_unsupported`，权限不足报 `io_error`，不静默降级。owner 记录 scope／rawKey；`knit locks` 只读列出 `scope/hash`、进程核实与心跳；`knit unlock` 必须给 owner token，token 不符永远拒绝，alive／unknown 另需 `--force`，删除前再次核对 token，旧 token 不能删除新占用。worker 持有执行目录 project 锁期间每 5 秒心跳；心跳版本冲突只记录并停止发布完成，不自动换锁。阶段在执行目录锁之后取得 `pi:<nativeSessionId>` Session 锁，worker 崩溃后该锁按普通残留处理，需显式 unlock。实现（多任务并行，任务 k-2cbd2f312298）：worker 取锁前只读 binding 与执行路由确定执行目录键，取锁后重读 binding、重算路由并核对请求 `expected.executionDir`／执行分支；路由或执行目录变化失败 `route_changed`，不冻结输入、不进入阶段。结果接收以请求冻结的 `expected.executionDir`（缺省主检出根）作为 project 锁键，外部 `run accept` 因此不与主检出占用相互阻塞；worker 持执行目录锁时直接复用，未取得锁的失败路径改用主检出键。不同 worktree 的 run 可并行，同一执行目录的第二个 worker 失败 `lock_busy`。

| 操作 | 占用范围 |
| --- | --- |
| 代码实施／验证（阶段 worker） | 执行目录执行占用：主检出路由为主检出根，已交接 worktree 路由为 worktree 路径；同一执行目录一次一个，不同 worktree 可并行 |
| run 结果接收 | 请求冻结的执行目录（缺省主检出根）；worker 持锁时复用，未取锁的失败路径用主检出根 |
| Git 收尾、初始化、有效输入或正式规范变更、目录改名、交付与归档 | 主检出执行占用，保证稳定输入与仓库级写入 |
| task record 的进度、经过、验证与运行引用；项目级规范候选和延期／拒绝记录 | 项目候选文件／元数据短锁，允许与长阶段并行 |
| Session 关联与查询元数据 | 对应短时元数据占用，不推进 phase |

记录只改记录区，输入 update 声明 clarify/change 与说明。clarify 保持早期 phase，摘要变化使检查 stale；当前 deliver 一旦选定目标检查失效就回 open/check 清 completed，change 回 discuss。摘要未变不迁移，运行中保存拟修改与 kind，工具终态后再应用，不借记录绕输入。 挂起输入只保留当前草案及基线摘要；按 DESIGN3.6 的 --apply-pending／--withdraw-pending 和 --expect-pending 校验处理。应用前核实旧执行／结果和基线，撤回只留原因且可在活动 run 中进行。任务关闭先收敛本任务活动／未知运行及待接收事实，撤回未生效草案；关闭与启动／接收共用该任务短临界区，旧结果不重开任务。

实现（任务009）：`src/application/task-service.ts` 的 TaskService 提供 new/rename/list/record/ready/update/close；输入摘要在 `src/contracts/task-inputs.ts`（inputsDigestOf 排除记录区标记内正文；草案版本摘要含生成它的更新操作 ID，同内容重建得新版本）。task.md 读写用 `src/application/task-document.ts`（YAML Document frontmatter，记录区标记 `<!-- knit:progress:start/end -->`，结构错误报 io_error 不静默修复）。占用：record/withdraw 用任务短锁（scope=task，按稳定 ID），rename/ready/update-direct/apply/close 在项目执行占用内重核版本。封存中 record 返回未保存（sealed）不写文件；封存标记由 deliver/archive 落盘。binding 新增 confirmedInputsDigest（ready 冻结）与 pendingDraft（至多一份）；run 活跃状态与 runsSettled 收敛核对待 run 仓储（任务012/013），当前由调用方传入。

实现（任务010）：`src/application/session-service.ts` 的 SessionService 提供 attach／verify／list／useTask／clearTask／resolveSelection／history；索引存 DESIGN9.5 字段，按（客户端、原生 ID、角色）定位，Knit Session ID 为 `s-`+12hex。原生有效路径用 `src/adapters/pi/native-entries.ts` 的 parentId 回溯核实，只有路径上的最后选择事件生效；树切换后旧条目不在路径上，不复活索引快照。未落盘选择只记 `persisted:false` 待确认，`available` 仅在原生文件身份核实后置位；文件从已落盘变为缺失时为 missing，不冒充可恢复。临时 cwd／项目迁移由 cwd 比对返回未生效，不误选。`src/application/context-planner.ts` 的 ContextPlanner 生成分层输入：任务输入区与正式规范／角色计入 inputsDigest，记录区、未生效草案、候选规范只作背景并列入 excluded；role 文件缺失时 implement／check 不就绪。`knit session` 与 `knit context` 命令提供同能力；`inputs.json` 落盘与桥接原生条目写入分别归 012/013 与 015。

实现（任务011）：`src/application/standards-service.ts` 的 StandardsService 提供 list／propose／review／apply／pending／migrate。任务 k-5dd19bb9b84c 起候选写入项目级 `.knit/standards/candidates.md` 的 `<!-- knit:candidate:start/end -->` 标记块（`src/contracts/standards.ts` 解析／渲染），不要求 taskId，也不要求任务存在；`sourceTaskId`／`source` 只标注来源。项目候选与记录不改变正式规范摘要或需求摘要。审阅回执存 `standards_reviews`，项目作用域记录以 `project` 为键、按候选集合摘要匹配，不要求分支一致；候选增删或正文变化后重新提示。延期／拒绝有理由即可继续，无候选不要求新增。采纳在项目执行占用与项目候选短锁内核对回执、目标与文件版本，机械追加规则并补 `standards/index.md` 引用；重复采纳幂等。旧任务 `standards.md` 只读兼容，`standards list --task` 仍可按任务与分支查看旧回执；`standards migrate` 幂等迁入项目候选且不改写原文件。交付／归档不再检查候选，未审阅候选不阻塞。`TaskService.ready` 同时冻结 `confirmedStandardsDigest`；`ContextPlanner` 输出 `standardsDigest` 与 `effectiveInputsDigest`（任务输入区 + 正式规范），正式规则变化据此使相关检查 stale，记录与候选不参与。

实现（任务012）：`src/application/run-coordinator.ts` 的 RunCoordinator 提供 prepare／start／status：prepare 在任务短锁外只读生成 `request.json`（含预期 inputs／standards／effective 摘要、模型、工具策略、恢复引用与 acceptanceOperationId）和 planned `launch.json`，不取得项目执行占用、不写业务资料；同任务／阶段已有活动 run 时复用，不生成替代运行。start 先落盘 starting 与 PID／boot／starttime 句柄，再启动 `src/worker/knit-worker.ts`；已 confirmed 或句柄存活时只观察原运行，句柄缺失／死亡且未认领时置 failed，重复 start 不增加尝试，只有 `--retry` 才重试同一 run。worker 以 `mkdir claim` 原子认领，自行取得执行目录执行占用（任务 k-2cbd2f312298：主检出根或已交接 worktree 路径），重新核对路由、任务阶段／分支、草案与预期摘要，冻结 `inputs.json`／`instructions.json`；implement 由 `src/application/snapshot.ts` 建立 `snapshot/`（tracked 工作区与 index OID、未忽略 untracked、模式／指纹、缺失路径、HEAD 起点），超限或 Git 覆盖未知时 manifest 置 failed，不能冒充 ready。就绪后 state 为 preparing + `prepared:true`；012 验收用 `--prepare-only` 在此退出，默认实现由 013 继续持锁执行阶段。`events.jsonl` 只作观察，status 不以其作为完成证据。

实现（任务013）：`src/application/stage-runner.ts` 从 prepared 继续：按 phase 选择 implement／check／advisory 角色，登记独立子 Session（角色不同即不同原生对象），优先恢复请求指定原生记录，缺失／不匹配时同客户端预分配新 ID 新建；Pi 运行时只装配所选模型与工具，implement 与 check 可写（check 限既定范围内修复），advisory 只读（仅服务 assist discuss；交付辅助角色与 assist deliver 已撤除，交付由主会话协调确定性工具）。等待 `agent_settled` 后才取最终文本，保存原生条目范围、本 run 增量用量和不可变 `result.json`。报告按 phase 校验；implement 的 `changedPaths` 必须与实际 Git 可见差异完全一致；check 有实际修改时 `changedPaths` 同样必须与实际 diff 完全一致，否则失败并带实际路径；advisory 改动任何文件即失败。check 以 Git 状态与逐路径指纹比对前后现场，拒绝未声明或无法核实的改动。`src/application/run-acceptance.ts` 按固定 `acceptanceOperationId` 复核当前输入／正式规范／scope／分支与 Task 阶段，再机械写 `scope.json`、`checks/<run>.json`、Task phase 与 binding：implement 累积 scope 并记录 lastImplement；independent 转 check，self／none 转 deliver；check 有实际修改时随接收并入 scope，检查凭据绑定并入后的 scope 摘要与实际 `changedPaths`／`selfVerified`；pass 转 deliver、changes_requested 转 implement 并累计修复轮、blocked 保留 check；模型报告不直接改 Task。修复轮达 `workflow.maxRepairRounds` 立即写 `repair_round_limit`；无授权周期时写 `repair_not_authorized`，`run prepare --new-repair-cycle` 才显式开新周期。结果待同步时 `run resume --run` 只接收不重跑；旧执行已终止且无有效结果时用原／新会话续做同一阶段。`run cancel` 落盘按 run 的取消意图，worker 在模型前／等待中／发布前观察并收敛为 cancelled，旧取消文件不作用于新 run；原生引用不可恢复只把 Session 标 opening，不否定已完成结果；`result.json` 写入失败置 failed，不发布完成。

实现（任务014）：`src/application/delivery-service.ts` 的 DeliveryService 提供 deliver／archive。两者先落盘操作意图、完整 refs/heads 目标、授权来源与默认分支候选；直接 CLI 无来源只记显式调用，Agent 调用无 authorizationRef 拒绝。workflow 来源核实文件章节与 SHA-256，用户消息引用只保存声明，核心不冒充语义授权。默认分支候选按 `delivery.defaultBranch`、本地 `origin/HEAD`、unknown 顺序观察，不授权也不因 unknown 阻断明确目标。preflight 重核当前分支、任务／绑定分支、无待应用草案、运行与待接收结果已收敛、完成凭据或任务要求的检查仍有效且输入／正式规范／scope 摘要未变；规范候选未审阅不阻塞，规范处理不重新绑定任务。deliver 先收束 closed/completed，再以 scope 业务路径形成产物提交，以任务目录和已采纳规范目标形成资料提交；提交后核对父节点、真实 OID、实际 name-status 范围，并比较无关 index 与工作区指纹。hook 改动选中或无关文件、范围不符时保留提交并置 needs_attention，不移动任务；显式 `--retry` 先核验原提交再继续，不重复提交。记录区追加交付记录后才写 `.knit-sealed` 固定摘要；封存中 task record 返回未保存。移动到 `archive/YYYY-MM/<原目录>` 后更新绑定，归档提交包含旧路径删除与新路径新增但不含封存标记；提交失败保留“已移动、待提交”。取消／替代 archive 只归档资料，不产生工作提交或空 commit。回执丢失按操作 ID 在 Git 历史中核实已生效提交，不重做。实现（任务020）：提交前保存 before／expectedPaths／expectedTree；恢复要求 HEAD、父节点、message、路径集合与提交树一致。删除／重命名路径已在 index 删除时不重复 add，只进入 commit pathspec。归档核验失败不落盘错误 archiveCommit，清理额外历史后同一操作可恢复真实提交；work 提交后的外部额外提交拒绝归档。

实现（任务015）：`src/cli/status.ts`、`src/application/status-service.ts`、`src/application/diagnostics.ts` 提供 status／doctor／storage 只读投影；`status --events` 只输出事件行直到 run 终态，不接收结果。`src/cli/start.ts` 在项目 cwd 启动本机 Pi，不自动批准项目信任。`src/cli/resume.ts` 支持按 run／operation／task 恢复；operation 仅对交付操作重入或已 planned 的操作放弃，未知效果保持待核实。`src/application/informal-check.ts` 执行显式 `--scope` 的只读检查，不建 Task／binding；检查前后比较 Git 与范围指纹，有副作用即失败。`src/application/model-selection.ts` 按显式参数或项目 `phases` 选择模型，缺失显式阻塞。桥接模板注册 `knit_status`、`knit_task`、`knit_context`、`knit_run`、`knit_deliver`、`knit_standards`，参数 schema 由 `src/contracts/bridge-tools.ts` 构建期派生为 `dist/contracts/bridge-tools.json`；桥接只读安装包内派生 JSON。桥接在 session_start 登记主会话、恢复有效选择，按 run 发起方原生 ID 每 5 秒只读查询终态并按会话条目去重投递；忙时 follow-up，关闭观察不取消 worker。`--dev` 只向 stderr 输出白名单 JSON，worker 诊断继承同一 stderr，不建日志文件。

prepare 先持久化 run/operation ID；持有调用的桥接或直接 CLI 入口保存 ID 后确认 start，之前无模型或项目业务副作用。这是入口内部协议，无需用户重复确认或手动执行 prepare/start 两条命令。取消按对象 ID 与 owner token 保存，终态裁定同一短锁排序。新 run ID／操作 token 隔离旧取消，不设请求级路由；确定性操作核实效果后 needs_attention，不回滚或改变业务 outcome。

收尾短锁封存记录，封存中补记返回未保存（sealed），不写任务、不转存、不留修改，主 Agent 不能声称已记。封存结束后按原 Task ID 重试为档案新资料修改，不随当前选择转移，说明未含于原提交；是否提交按已有授权，不重开业务。任务锁按稳定 ID 定位，移动仍为同一对象。禁止持短锁等执行占用，多个键固定排序；外部编辑器不受控，写回仍核对版本。

心跳默认每 5 秒更新，30 秒无更新仅表示可疑。自动认定原进程终止，必须有同机器、启动标识和进程开始时间等证据，排除 PID 复用；权限不足、无法核实的身份或未写完整的 owner 信息均视为未知。时间戳、旧 PID、窗口消失和心跳超时单独都不足以解锁。取得多个锁失败时，按 token 释放本次已取得的锁。

`knit doctor` 显示锁、run、已知子进程与核实结果，不运行客户端桥接或验证命令。已确认终止的旧运行可由恢复流程清理占用；仍活着的运行先 `cancel`，必要时由用户终止相应进程树并重新核实。

逃生入口为 `/knit unlock <lock-id>` 或 `knit unlock <lock-id>`：先显示 owner token、存量进程和受影响 run。正常解除只处理已证实终止的占用。无法核实时，用户可交互选择 `--force --expect-token <token>`，明确确认已手动处理旧进程，记录原因和诊断后解除；已证实仍活着的匹配进程不允许强解。Agent 工具不自动强解。

强解不能证明外部工具已经停下，也不能撤销其副作用。worker 在心跳、工具边界和写回前校验 token；丢失占用后停止新动作，旧回执不得推进任务。已经发出的 shell 不受 token 撤销保护。新运行仍需核对文件、Git、工具终态与快照，不能把解锁当作原运行成功或已安全取消。

已知 iCloud/File Provider、Dropbox 等同步根采用平台可取得的根路径与规范化实际路径尽力识别，不扫描个人文件或读取服务凭据；检测不完整，未命中不代表安全。Git 忽略不阻止云同步，不能同步／跨机并发使用活跃 runtime，SQLite WAL 和文件锁均不因此获得跨机互斥。建议使用非同步目录或验证已排除 runtime；doctor 不自动移动数据或修改云配置。此告警归 M2 最小诊断，M3A 完善展示；不新增云服务集成。

## 3. 实施快照与显式恢复

每次正式 implement 的可信 worker 程序取得执行占用后，在 `.knit/.runtime/runs/<run-id>/snapshot/` 建立 preparing 对照，ready 后才调用阶段模型／写代码，失败保留 failed。占用由该执行者一直持有，不从 CLI 交接。保存仓库／分支、HEAD、index、脏路径、类型／模式、工作和暂存内容、未忽略的未跟踪内容及指纹；新增路径起点为不存在。前后核对源码、有效输入、HEAD 与 index，变化即重核。Task 记录在短锁内捕捉版本，后来的合法纯记录不会使快照准备反复失败。

快照写入按内容去重（manifest schemaVersion 2）：tracked 工作区文件／符号链接的字节与 `HEAD:<path>` 的 blob 完全一致（Git blob SHA-1 相同）时只记 `source:"head"` 与 `headOid`，不复制到 `snapshot/files/`；index blob 与 HEAD 树 OID 相同时记 `indexSource:"head"` 与 `indexHeadOid`，不复制到 `snapshot/index/`。引用省略的字节记入 `savedBytes`，不计入 `bytes` 与上限。submodule、类型变化（file↔symlink）与未忽略 untracked 不引用，仍完整复制；没有 HEAD 的仓库也全量复制。manifest 兼容读取 schemaVersion 1：缺少这些字段即全量副本语义，恢复行为不变。快照不通过自动 stash 写入新的 Git 快照对象，也不创建 `refs/knit/bases` 基线引用；不隐式 stash，不改写工作区／index。快照默认上限 64 MiB 按实际保存内容计（tracked 工作区副本＋独立 index blob＋未忽略 untracked 文件），不是单文件上限；引用 HEAD 的字节不计费。超出或保存失败时阻塞实施并列出路径与处理选择，不悄悄降级为不完整快照。大仓库在缩减内容或调高 `limits.snapshotsMaxBytes` 前无法开始正式实施。快照先写入 `snapshot.tmp-*` 临时目录，完成后原子改名；重建（failed 或半成品重试）时先回收同 run 中断残留的临时目录。

快照 manifest 版本迁移（v1→v2）：v2 只新增可选字段（条目的 `source:"head"`／`headOid`、`indexSource:"head"`／`indexHeadOid` 与顶层 `savedBytes`），没有删除或改名字段。读取规则：声明 schemaVersion 为 1 或 2 时都按本节解释；v1 条目缺少 `source`（及 `indexSource`）即内容已完整存于 `snapshot/files`（及 `snapshot/index`），恢复按副本读取，语义与 v2 前一致；缺少 `savedBytes` 按 0 展示，不参与恢复。声明版本为数值且大于 2 时属于未知较新版本：报 `version_conflict`（含 found、期望版本与 manifest 路径），阻塞快照重建与写入，`snapshot show`／`snapshot restore` 只报告错误、不返回 manifest 内容，也不覆盖原文件。schemaVersion 缺失、非数值或结构不符按损坏报 `io_error`，不当作格式演进。当前不提供迁移器：v1 数据可被 v2 读取器完整解释（缺字段即全量副本），重写 v1 快照只改变存储表示、不增加可恢复性，故没有重写收益；后续若出现必须改变字段语义的版本，再按第 6 节补充按版本的迁移说明与校验器。

恢复 HEAD 基线引用时按 manifest 记录时的 OID 执行 `git cat-file blob` 并用原有 SHA-256 核对字节，不依赖恢复时的 HEAD（amend 后对象仍存在即可恢复）。`cat-file` 失败（例如对象已被 `git reflog expire`＋`gc --prune=now` 清除）报 `snapshot_baseline_unavailable`（含路径），不静默跳过、不部分恢复。因此快照只引用 blob OID：仍需恢复的快照不得 prune 其引用对象；本任务不开启自动 GC，清理策略归后续存储能力。

任务源文件的直接修改默认排除 ignored 路径和嵌套仓库；确需修改的 ignored 文件先明确路径并纳入快照。已授权命令生成的缓存、依赖和构建输出记录为副作用，不承诺文件快照覆盖。子模块按独立项目处理，数据库和网络服务同样不在文件回退范围。运行目录使用本用户私有权限（目录 0700、文件 0600，或平台等价 ACL），快照、请求和原生记录不入 Git。

取消或失败后保留现场与快照，先展示实际差异、可恢复路径和未覆盖副作用。首版不自动 reset、stash apply 或整仓还原。`knit snapshot show <run-id> [--path <path>]` 只读查看，不直接输出疑似凭据。

恢复路径必须位于当前项目，拒绝越界和通过父级符号链接写入其他位置。恢复使用 `knit snapshot restore <run-id> --path <path>` 或对应工具，默认给出预览；用户明确执行时附 `--expect <path=当前指纹>`（单路径可省略路径前缀），在取得项目执行占用并核对当前分支、仓库和工具终态后逐路径处理。当前工作区指纹或 index 状态变化即停止；同一文件的恢复单位是整个文件，不支持分块或自动三路合并。默认只恢复工作文件；恢复暂存内容须另外指定 `--index`，只写选中路径的 index 条目并核对快照 index 摘要。删除本次新建文件须指定 `--remove-created`，目录不递归删除，其他路径与后续修改保留。恢复记录在取得项目执行占用前先行写入（锁外失败也留诊断），run cancel 也不持有该锁；并发恢复或取消交错时可能返回 version_conflict／stale_input，重试即可收敛。

实现（任务016）：新建快照在 `snapshot/index/` 保存与工作区版本不同的 index blob，并在 manifest 的每条 entry 记录 `indexDigest`；没有该字段的旧快照仍可 `snapshot show`，但 `--index` 明确拒绝，不猜旧 index 字节。`snapshot show` 只输出 base、counts、路径、模式、摘要与 index OID，不输出文件正文。恢复指纹为 `file:<sha256>:<Git mode>`、`symlink:<sha256(目标)>` 或 `absent`，模式变化也算当前版本变化。文件按快照模式新建或原子替换；符号链接先写临时链接再 rename，不跟随目标；二进制按原始字节复制。`--index` 用保存的 blob 计算并 `git update-index --cacheinfo`，只改选中路径，保留无关 index／暂存内容。Task 的 `task.md` 不按普通文件覆盖：选中路径识别为 Task 文档时，读取快照输入区并经 `task update` 合并，保留 frontmatter、记录区与后来记录；任务移动、关闭或归档则拒绝。源码恢复成功后清空绑定 `lastCheckRunId`；任务原为 deliver 时按检查规则回到 check。每次执行在 `.knit/.runtime/restores/<operation-id>.json` 留下 running／completed／needs_attention 记录和逐路径结果，异常不自动回滚已写路径，按记录与现场继续核实。`.knit/.runtime/` 与 `.git/` 不进入普通源码恢复，子模块和目录覆盖不支持。

Task 管理资料的旧版本只作对照，不能以通用 restore 整份覆盖后来记录和业务状态；输入恢复经 task update 保留记录。本机 runtime、索引和原生 Session 不由源码 restore 覆盖。每次真实恢复记录独立操作并使旧检查不再适用于新目标。

`git stash create` 能保存已跟踪文件和暂存对照，但通常不包含未跟踪文件；仅有未跟踪文件时可能不产生对象。它可作为用户另行选择的操作，不作为完整备份证明。

## 4. 主会话工作流与任务规划资料

主会话按 DESIGN §4.2 分类用户请求：是否创建 Knit 任务由用户决定；普通讨论、只读调查、代码审阅、非正式小修改和用户明确不跟踪的修改直接在当前会话完成，新正式需求经用户要求或持续授权后 `task new`，已有任务继续用当前选择或 `--task` 定位，补充／范围变化走 `task update --kind`。授权来自用户明确指令或既有持续授权，不逐轮重复询问；授权不覆盖提交、推送、发布或迁移。不建任务时使用宿主通用工具／子 Agent；Knit `run` 只服务正式任务，宿主没有委派能力时直接执行并说明限制，不暗建任务。

正式任务创建时确定 `verification`：`none` 仅由用户明确选择，`self` 为默认（实施自检＋范围验证），`independent` 需要当前有效的正式检查。`task verification` 只在讨论阶段调整，作为输入变化并使旧完成／检查资格失效。建任务不附带实施、提交或发布授权。

复杂任务讨论中按需创建任务目录内资料：`plan.md`（步骤产出、真实依赖、受影响结构／接口、验证、风险与未完成标记）、`design.md`（重要取舍与依据）、`research/`（调查材料与入口摘要）；简单任务只用 task.md，不堆空文件。读取、更新、冻结与交接生命周期由核心统一接口实现，业务状态不另建第二套权威。

实施前核对：必需的目标／完成条件／规划齐备且无阻碍实施的待决项才 `task ready`；可选文件缺失不阻挡简单任务。阶段提示装配时再次读取必需资料，失败则报告sourceId与路径并终止本次执行；可选背景不可读取仍可省略。实施中进度勾选与证据追加直接更新 plan.md 或 `task record`，不产生草案、不使检查失效；方案中要求性内容变化等同 `task update --kind`，活动 run 期间保存为草案待终态应用。收尾核对以实际成果与验证为准，不按计划复选框判定业务完成。

每轮主会话上下文由桥接在模型调用前注入：当前任务稳定 ID 与 phase、业务摘要、待决项、待应用草案与活动运行摘要、下一步规则及资料入口；无任务时给出入口规则。注入为当前快照不叠加历史，写动作仍经核心核对授权／阶段／锁／版本；实现见任务047，规则见 DESIGN §9.6。

## 5. 用量、存储与诊断

默认 `agent.resume: "prefer"` 优先由原客户端加载原生记录；旧记录无法恢复时自动新建会话，读取当前任务要求、正式规范、进度、已有执行事实与当前代码续做。先确认旧执行和工具结束，核对任务／目录及模型；不把模型不可用或未知工具状态当作换会话的理由。报告新建原因和旧来源，新会话可用后更新阶段引用；新建失败不循环创建。Task ID、阶段、修复次数和累计成果保持，由核心维护，不能接受模型自报值来重置或迁移；参见 DESIGN 第 9.4 节。

首版只观测 token、费用与耗时，不按累计 token 或固定运行总时长自动取消。主 Agent 可分步推进、利用原生上下文管理和恢复能力继续大任务；是否拆分正式任务仍按用户授权。未来主动预算停止若确有需求再设计，首版配置不提供该开关。

每个 run 只计本次新调用，使用调用／消息标识去重；恢复时读取旧历史不重新计算其消费。保存原生用量与归一口径：inputTokens 是含缓存的总输入，outputTokens 为输出，totalTokens 为两者之和；cacheReadTokens／cacheWriteTokens 为输入子集，不能再次相加。若原始 input 已含缓存则不重复加入，若分开报告则先合成总输入。无法无歧义映射时标 unknown，并保留原字段。

例如总输入 10,000、其中缓存读取 9,000、输出 1,000，累计总量是 11,000，不是 20,000。缓存与普通输入的价格不同，费用由实际计价来源另算；未知费用不作零，也不影响任务继续。显示范围为 Knit run，不把它冒充主会话或供应商账户总账。

用户取消、真实错误／阻塞、修复轮次上限和原生工具自身明确条件仍生效。锁心跳每 5 秒更新；心跳超过 30 秒只进入 doctor／locks 调查，不自动停止或强解。阶段取消先发 clear_queue／abort；实现（任务017）在 5 秒宽限后仍无稳定终态时终止本次 Pi 及完整后代进程树（工具可能另建进程组），以 `agent_aborted` 收敛并保留 `stage-process` 记录。`run cancel --terminate` 对已核实且 worker 已退出、阶段 Pi 仍存活的旧执行显式终止同一进程树；不把 RPC ack 当作已结束。

knit storage 统计 runtime、run（含快照）、原生会话、diagnostics 的字节，默认 512 MiB 提示；另列 refs/knit/bases/* 数量（HEAD 策略未实现，当前不创建基线引用，通常为 0）、关联 run 是否存在。引用可能共享 Git 对象，首版不把每个引用的可达大小相加冒充额外占用；创建时间无依据则 unknown，不用 commit 日期代替。Git 对象整体大小可单列，不能全归给 Knit。实现（任务023）：`session history` 的用量按唯一助手条目 ID 去重，input 含 cacheRead／cacheWrite，未知 token／费用返回 null；status / doctor / storage 仍只读，不自动 gc。

doctor --json 只读检查 schema、状态契约、文件／Git 回执、候选与检查、绑定、锁、快照、内部模块、初始化和容量。离线不能证明活跃原生分支时标未知，不把索引快照当当前选择。禁用外部 diff/textconv、pager 和 fsmonitor hook，不跑项目验证、桥接或自动修复；不输出环境值、原始提示词、工具输出和凭据。

status 始终显示总耗时、最近模型／工具活动距今时间与心跳。心跳、元数据和诊断事件不刷新活动时间；等待模型可能长期无输出，有输出也不证明有效进展。只提示，不做自动空转检测或超时取消。 `status --run <run-id> --json` 只读返回该运行、终态版本、来源定位和待同步事实，不接受结果或重派。桥接可用可销毁定时器观察本会话发起的 run，默认5秒，切会话／树或关闭时停止；通知前核对原上下文和原生已有通知，规则见 DESIGN 第9.3节。

元数据已选定 SQLite（Node24 内置 node:sqlite，M0 实证）。事务只覆盖内部 Session/binding/operation 更新，不跨模型、Git hooks 等等待；项目文件锁、执行占用、Git 和原生记录的核验仍保留，不维护 JSON 权威镜像。

### 5.1 提交目标与授权来源

所有会创建提交的 deliver/archive 显式给 --branch <refs/heads/...>；拒绝短名、current 或与 Task 绑定／实际分支不符的值。prepare/start、暂停恢复及 Git 写入前重核，不创建或切换分支。--branch 确认目标，不能当作人类授权证明。

桥接 Agent 声明 authorizationRef；终端代调可 --authorization-ref <ref>。来源是原生用户指令引用，或 .knit/workflow.md 中 Git 交付约定的路径／版本。策略生成或 Agent 自行编辑不等于用户认可；主 Agent 须确认原授权和当前约束。直接 CLI 无引用时只记录显式调用声明，不伪记身份或消息已验证；Agent 经 CLI 仍需已有授权。

默认分支候选检测顺序：显式 delivery.defaultBranch 完整本地 ref；否则读取本地 refs/remotes/origin/HEAD 并映射为本地 ref；再否则 unknown。显式配置格式非法则报告配置错误，不忽略回落。无 origin 的本地仓库不猜 main/master，不联网补 HEAD。缓存可能过时，检测仅用于展示／审计，不授予权限，也不让 unknown 阻塞已明确授权的当前目标。

operation 保存实际与确认分支、默认分支候选及来源、调用者、authorizationRef、来源摘要／定位，以及已认可的策略版本。实现（任务019）：首次创建操作即固定 archivePath；工作／归档提交后核对父节点、实际路径集合、提交树模式／blob 与无关 index／worktree；hook 拒绝、改 index、扩范围或改选中内容均保留已产生的提交并 needs_attention。move 已完成但检查点丢失时按目标 Task ID 与封存摘要恢复，目标冲突不覆盖；显式 retry 重核已生效提交。核心验证引用存在、版本及分支一致性；授权文本是否充分仍由主 Agent 判断，不新建授信／审批平台。来源变化先重核，已有授权覆盖则不重复询问，adopt 不附带提交许可。

实现（任务 k-c5f416d61c3d）：父子关系只写子任务 frontmatter `parent`；`task new --parent` 在创建项目锁内、`task parent`／`--detach` 在项目＋任务锁内按稳定 ID 核对目标存在、未归档、未结束与成环；归档任务关系冻结，不再挂接或解除，归档父任务不接收新子任务；结构变化不使输入摘要或检查资格失效。父任务完成在任务锁内扫描直接子任务：仍有 `open` 子任务返回 `children_incomplete`，缺 `--reason` 返回 `parent_acceptance_missing`，验收说明写入完成凭据。`task list` 活跃分区按稳定执行顺序逐行展示，子任务行以 `↳` 前缀并标注父任务稳定 ID；父任务行标注子任务结束进度，`knit status <taskId>` 给出父任务与子任务状态。
实现（任务055–057）：`task close --outcome completed` 在任务锁内按 `verification` 核对当前输入、成果和完成凭据；业务完成不要求 Git 提交、回执或归档，完成凭据写 `.knit/.runtime/completions/<task-id>.json`。`deliver <id...>` 支持批量逐项处理，先以 `--plan` 只读预检业务产物／任务资料分类、已暂存业务路径及任务资料、跨任务同路径冲突；有冲突时不执行。任务资料的用户暂存内容也在服务取得占用后、创建操作与修改Task前重核；拒绝时保留index、HEAD及Task。重试仅接受当前HEAD和预期路径／blob匹配的未完成操作暂存检查点；资料部分暂存始终停止，不能借retry覆盖新改动。每个任务先提交业务产物（`knit: artifact`），再写最终记录并单独提交任务资料（`knit: metadata`），随后封存、移动和归档提交；多个任务不合并为整仓提交。任一项失败保留已生效提交和后续任务现场，按操作 ID 与显式 retry 继续，不重复提交。

## 6. 数据版本与升级

项目 schemaVersion:1 声明共享布局、配置与任务字段，init 清单另有版本。本机 metadata、run 证据、快照与占用按 protocolVersion:1；SQLite 使用对应数据库 schema 版本，M0 已确定物理格式。进度／诊断自带版本，不能冒充状态证据。首版没有用户配置覆盖层。

读取先验证版本。未知较新版本允许列出路径、版本与错误，阻塞写入和执行；不猜测字段、不降级覆盖。缺失版本或已知旧版由 doctor 列出，只有具备明确迁移路径时才能备份后迁移；首版没有历史格式就不实现通用迁移器。

后续升级提供按版本的迁移说明与校验器。迁移前确认没有存活／未知运行，保存原文件与迁移记录；失败保留备份和现场。旧 run 原样保留，由兼容读取器解释，不改写其终态；后续执行使用新 run ID。升级后核对 Knit 版本、本机映射、生成桥接及原生客户端兼容性，冲突先保留并报告；原生 Session 由所属内部适配确认。

## 7. 开发者模式

开发者模式默认关闭，只观察，不改变模型、权限、检查、取消、恢复或自动工具／模型次数；不启 fake，不开原生客户端网络 debug，不进业务摘要。诊断是可丢弃信息，不作回执。

| 里程碑 | 能力 |
| --- | --- |
| M0 实验 | 验证脚本可向 stderr 输出稳定 stepKey、reasonCode、摘要和仓储调用／事务计数，用于候选比较，不先建完整日志设施 |
| M1 | knit --dev <命令> 与桥接本次调用标志；只做结构化 stderr，不自动保存文件，不提供 Pi 会话开关 |
| M3A | 私有 JSONL 保存、Pi /knit dev on/off 当前会话开关、完整通道／文件失败验证；不是 M1 前置。实现（任务024）：写命令按 `.runtime/diagnostics/<command>/<pid>-<time>.jsonl` 分片，只读命令不建目录；文件 0600、目录 0700；桥接开关仅当前会话，reload 默认关闭 |

M1 stdout／--json 保持业务协议，stderr 为诊断。白名单只含对象 ID、步骤、模块／存储版本、声明 kind、摘要、reasonCode、状态决定、耗时和可观察仓储／事务计数；不是 OS 物理 I/O 测量。decision.proposed 与 effect.applied/verified 区分计划和事实，不按 token／输出字符记日志。

即使 M1 也不收集环境值、凭据、完整配置、正文、提示词、工具原文、HTTP 头／体；token 只记指纹，路径尽量项目相对。桥接分离 stderr，不自动注入模型或触发额外回合。普通终端可能合并 stderr，直调可自行重定向到私有文件；它的观察退出也不等于执行取消。

M1 只保留一个同 fake 输入的开关等价冒烟，比较业务摘要、成果／Git 内容和模型／工具次数，忽略时间、随机 ID 与诊断字段，不做全事件矩阵。M0 比较与 M1 排查可直接收集 stderr，无须等待持久日志。

M3A 才启用 .runtime/diagnostics/<对象ID>/<写入者ID>.jsonl，每进程独立片段，文件 0600、目录 0700、Git 忽略；只读 status/doctor/init --check 即使 --dev 也不建目录或日志。日志可删，不影响恢复；专用诊断失败只提示，不吞真实元数据写入错误。

Pi 会话开关仅影响当前原生会话后续调用，切会话、fork 或 reload 默认关闭，不写项目／用户配置，不改已启动 worker 的请求。CLI --dev 仅本次及其 worker，不继承 Pi 开关。

诊断版本为 diagnosticVersion:1，M3A 按 event/stepKey、输入版本和对象关系对齐，忽略墙钟、耗时、随机 ID、token 指纹与 diagnosticsRef；不另做 compare 命令。完整日志仍不自动进模型上下文，用户明确排查时按需读取。
实现（任务 k-802d3edc053c）：`priority`／`dependsOn`／`order` 写入 task.md frontmatter，缺省 P2、无依赖、`order=null`；三者不参与需求摘要，调整不改写输入或使检查 stale。`src/domain/schedule.ts` 提供排序、依赖阻塞与重排纯函数；`task list`／`task next` 共用同一排序与阻塞判定，优先级内已调整的按 order、未调整的按 createdAt，创建时间相同才用稳定 ID；`task list` 活跃分区直接按该顺序逐行展示，父子关系以 `↳` 与父任务 ID 标注，不重排执行顺序。`task ready` 与 implement 的 `run prepare` 在推进／启动前核对依赖，未满足返回 `dependency_unmet` 并列出原因；依赖自环、缺失与成环在 `task depends`／`task new --depends-on` 时拒绝。`task order` 在项目锁内只重排目标优先级分组，`--before`／`--after` 跨级参照返回 `order_reference_priority_mismatch`；只写该分组的 order，不修改 createdAt，其它优先级与同级未涉及任务的先后不变。
