# Knit 运行细则

本文件补充 [DESIGN.md](DESIGN.md) 的运行规则；模块与唯一写入方见 [ARCHITECTURE.md](ARCHITECTURE.md)，枚举／转移见 [STATES.md](STATES.md)，依赖版本见 [TECHNOLOGY.md](TECHNOLOGY.md)。首版独立 CLI、Pi／local／REX、项目薄桥接与 Worktree 已实现至 Linux 候选。

## 1. 内部模块与项目桥接

Knit 按源码中的固定装配表使用客户端、runtime 与执行宿主，配置只选择已实现 ID。不会从 `plugins[].module`、项目路径或任意包名导入代码，不提供第三方插件安装与授信流程。新增能力由系统代码维护、构建与测试。

`knit init --pi` 自动生成项目 `.pi/extensions/knit.ts` 薄桥接；客户端开关由注册表生成，当前只有 `--pi`，不带开关时默认 `--pi`。它仅使用 Pi 公开 API，转交原生会话、当前模型、事件、命令／工具和上下文计划；业务处理调用本机 Knit CLI，不嵌入任务和规范逻辑。

桥接文件是可入库的固定模板，按其自身文件位置定位项目。`.knit/.runtime/installation.json` 保存本机 Knit CLI 位置与安装版本，`init-manifest.json` 保存模板版本、文件所有权、指纹、逐项结果及 `preparing/ready/failed`。本机路径不写进共享桥接；只有 ready 且匹配时桥接才处理调用，缺失或不匹配则提示 init。模板随安装包发布在 `assets/templates/`：`.knit/` 项目资料（config、workflow.yaml、agents、standards）与 `pi/extensions/knit.ts` 桥接；实现位于 `src/application/`（InitializationService，任务008），配置校验在 `src/application/config.ts`。

`knit start` 先核对项目桥接、受管入口和本机安装信息；用户修改过的受管代码或冲突先报告差异，不静默覆盖。用户直接运行 Pi 时由 Pi 自身加载项目扩展，Knit 不能拦截其他项目扩展代码。项目配置本身不构成执行任意模块或脚本的授权，验证命令仍遵守任务范围。

| 本机资料 | 用途 |
| --- | --- |
| 用户级行为配置 | 首版不提供 ~/.knit/config.json 覆盖，保留项目与调用层配置，不增加全局模型优先级 |
| `~/.knit/locks/` | 本用户、本机占用记录 |
| 项目 `.knit/.runtime/` | 私有安装映射、初始化清单、会话、绑定、run 和快照，Git 忽略 |

init 维护两类文件：配置、流程配置、阶段提示词和规范属于项目资料，默认只补缺、已有内容沿用；显式 `--force` 时与当前模板不同则按模板覆盖，覆盖前备份原文件到 `.knit/.runtime/init-backup/<时间戳>/<相对路径>`（目录 0700），内容已一致则不重写、不建备份；桥接代码及入口标记块属于受管内容，与旧基线一致时可更新，人工改动或未知来源须报告差异。上次清单记录、当前模板不再生成而项目里仍存在的文件作为“模板已移除文件”在计划与结果中报告，默认只报不删，`--force` 也不删除；先准备资料与本机映射，最后发布桥接并置 ready；中断按逐项结果核实，不能把部分初始化作为成功。安装 ready 不替代 Pi 原生项目信任；可信项目中新 Pi 可自动加载，已有会话 `/reload` 或重启，未受信时说明原因，不默认加 `--approve` 绕过。子 worker 使用明确资源参数，默认不加载主桥接。

实现（REX 自动呈现）：`run prepare`／`start`（`--stage <id>`）按调用级 `--rex`／`--local` > 项目 `execution.host` > `auto` 解析宿主；`--rex` 与 `--local` 同用报 `invalid_request`。`auto` 仅在派发前检查 `REX_SESSION`／`REX_BLOCK`、`rex` CLI（`REX_BIN_DIR` 或 PATH）与 `REX_REQUIRED_METHODS`，通过则使用 REX，否则回退 local 并记录原因；显式或配置 `rex` 不可用返回 `rex_unavailable`，不回退。prepare 落盘 `presentation`、`presentationSource`、`presentationFallbackReason`，start 与 resume 只读已落盘值；活动 run 的呈现不可变。`run list`／`run status`／`knit status --run` 展示实际宿主、来源与回退原因；`run check --scope` 仍拒绝 REX。Rex 终端内的 `knit_run` 不传 `--rex` 也按同一配置／环境规则自动生效。浮层创建即最小化；run 到达终态（completed／aborted／error，含恢复发现）时宿主按 `rex.json` 关联关闭本次 layer（`layerId` 优先，缺失时按 `blockId` 反查），取消／失败走同一路径，关闭失败只忽略、不改变 run 终态。为保留报告补报窗口，StageRunner 对 worker 传 `closeOnSettle=false`（settle 后 worker 不自退），补报窗口结束后由核心 `terminate()` 关层并终止阶段 Pi；取消时 bridge 接受 stop 后仍以 `cancelGraceMs` 宽限强制收敛。`closeOnSettle=false` 只在直接使用 launcher 时表示保留浮层（测试／调试）。

实现（Rex 启动回退与诊断，任务 k-836997c84864）：`presentationSource=auto` 选中 Rex 后，若 worker 在启动超时（默认 30 秒）内从未报到（state.json／bridge 都没有状态；含块内进程在报到前退出、浮层装配抛错），且本 run 没有阶段副作用（工作区相对基线无变化、原生会话无新增条目、没有 Rex 结果、未取消且未丢占用），StageRunner 关闭本次浮层后在同一 run、同一原生会话与 Session 锁内以 local 重启：request 不变，run state 记 `presentation: local` 与 `presentationFallbackReason: rex_worker_not_started`，事件 `presentation_fallback`；`run status`／`status --run` 按 state 展示实际呈现与回退原因。显式 `--rex` 与 `execution.host=rex` 不回退，失败原因为 `rex_start_failed:rex_worker_not_started[:<子原因>]`（装配抛错为 `rex_start_failed:<代码>`，原始消息首行写进 result 摘要）；worker 已报到后的失败一律不回退。根因诊断写 `runs/<run-id>/rex-diagnostics.json`（`kind: rex_start_failed`）：原始错误、块／层 ID、块进程状态（`last_exit`）与 worker 报到情况，以及关闭浮层前用 `rex capture -b <block> --trim` 取的屏幕尾部（浮层内 Pi 的 stderr）和 Rex CLI 自身 stderr，尾部上限 4000 字符；诊断只作辅助证据，不参与状态机，与本地启动诊断 `diagnostics.json` 分文件，回退后两者可并存，由 `status --run` 的 `rexDiagnostics` 展示。

## 2. 占用与解除

首版只协调本用户、本机 Knit 的执行。项目与锁目录要求本地文件系统；已识别 NFS／SMB 或确实不能满足原子占用／身份核实条件时阻塞写操作。实现（任务026）：正式 `task new`／`task ready` 核对 Git 工作区、HEAD、本地分支、未完成 merge/rebase/cherry-pick/revert/bisect、index 冲突与 `.knit/.runtime` 跟踪；doctor 同时报告项目根文件系统与已知云同步根。已知云同步根内的本地目录由 doctor 告警，不仅因目录名阻塞。跨机并发及外部编辑器、Git 进程不受 Knit 锁控制，阶段边界仍要核对实际状态。

同一用户各项目使用本机共享锁根 `~/.knit/locks/`：projects/<执行目录摘要>/（工作树租约）、tasks/<任务键摘要>/、states/<主检出根摘要>/ 与 sessions/<客户端及原生身份摘要>/，目录0700、owner文件0600；不是用户级行为配置、服务或跨机锁。实际写操作按需建立，init --check／status／doctor 只读时不创建。这样同一原生会话不会因项目各有独立锁目录而绕过占用。

锁域（任务 k-f0d9a8952aff）：三种资源分开占用，任务不被长租约占用。

| 锁 | 键 | 持有者与时长 | 等待 |
| --- | --- | --- | --- |
| 工作树租约（scope 沿用 `project`） | 执行目录：主检出路由为规范化主检出根，已交接 worktree 路由为该 worktree 路径 | 阶段 worker 整阶段持有；快照恢复、worktree 合入／清理、交付与归档、初始化、规范采纳、gc 等整树操作在操作期间持有 | 不等待，占用即 `lock_busy` |
| 任务锁（`task`） | `<主检出根>::<任务 ID>` | 任务写入与 run 接收的毫秒级临界区 | 短等待 ≤1 秒后 `lock_busy` |
| 状态锁（`state`） | 规范化主检出根（元数据库所在），worktree 内的写入也用主检出根 | `task new`／`update`／`ready`／`implement`／`close`／`rename`／`order`／`apply-pending`、`run prepare` 与 run 接收的毫秒级临界区，串行化跨任务的创建、输入与阶段写入 | 同上 |
| Session 锁（`session`） | 客户端与原生身份 | 阶段 Session 整阶段 | 不等待 |

「任务正在被处理」由 run 状态表达，不由锁表达：worker 只持工作树租约（与 Session 锁），运行期间其它会话可登记任务、更新其它任务、写记录与材料。`task update` 在目标有未收敛 run 时必须声明 `--run <id>`（缺省读环境变量 `KNIT_RUN`，显式参数优先；worker 启动阶段 Pi 时注入本 run ID），未声明或声明不符报 `task_busy: run <id>` 且不写文件；声明后按现有状态机直接改输入（`change` 回 start，`clarify` 就地），收尾按摘要判 `stale_input`。`--pending` 保留为显式选项：只存草案、不改输入、不需要 `--run`。`task rename` 与 `task implement` 在活动 run 中同样以 `task_busy` 拒绝；`task record` 与 `task material save／delete` 不要求声明。`run prepare` 不取工作树租约：在任务＋state 锁内复用同任务同阶段的活动 run，没有可复用 run 时只读检查执行目录租约，被占用（且不可自动回收）即 `workspace_busy` 拒绝、不生成 run；锁外先等待最多 2 秒的租约交接（上一 worker 已发布终态但尚在释放）。只读检查只减少无效 run，不承诺强互斥：两个 prepare 与 worker 取租约之间仍有竞态窗口，最终互斥由 worker 取租约保证（失败为 `lock_busy`）。`task_busy` 与 `workspace_busy` 在 CLI JSON 中是同名 reasonCode，outcome 为 `blocked`，退出码 1。顺序固定为工作树租约 → 任务锁 → Session 锁 → 状态锁（`orderKeys` 只在末尾追加 state 档位，已有顺序不变）；state 锁残留与其它范围一样按进程核实自动回收，`knit locks`／`doctor` 显示 state 范围。

不同 worktree 的执行目录键不同，可各自运行任务阶段并分别接收；同一执行目录仍一次一个 worker，主检出路由保持一次一个。多任务调度是显式命令 `knit run schedule`，不建常驻守护进程，也不做跨机调度：项目 `worktree.default: on` 才启用；`schedule:<规范化项目根>` 项目锁保证同一项目同时只有一个调度循环，与工作树租约不同键，不阻塞正常入口。`scheduler.maxConcurrent` 统计 run 仓储中 `claimed`／`preparing`／`running` 的 run（含手动派发），`scheduler.maxAttempts` 限制同一任务同一阶段在一次循环内的派发次数；按 DESIGN §3.11 就绪集、稳定顺序与 `plan.md` 影响路径重叠检查派发，未知影响的任务独占运行。派发失败、run 失败或接收失败只把该任务记入待处理，本轮不重派、不阻塞其它任务；`SIGINT` 停止派发与接收并保留活动 run，不自动取消。Git 身份作为每次核验事实，不因初始化仓库或分支变化改锁键；路径别名先解析为同一根。Session 执行锁以客户端、原生 ID 与必要实例身份为跨项目键，不用随 run 改变的文件目录作键。新建前预分配原生 ID，获得锁后让 CLI 使用该 ID 并核对实际返回。工作树租约在前、任务锁次之、Session 占用再次、状态锁在后，同类多键排序，mkdir 已存在即失败并按 token 释放本次已取锁。原生恢复失败时释放旧 Session 锁再锁候选新 ID，项目占用保持；不同时持有两把不同 Session 锁倒序等待。owner.json 保存协议、token、动作／run、机器／启动标识、PID 与开始时间，心跳原子更新，释放核对 token。基础设施实现（任务007）：`src/infrastructure/locks.ts` 用 mkdir 抢占、owner 文件原子写、AcquiredLock 按 keys 顺序保存每个 owner 的 token 与版本；token 字段兼容首键，混合重入的释放及心跳逐键核对 ownerTokens。同实例嵌套句柄共享已成功写入的心跳版本，外部改写仍报版本冲突，失败申请逆序撤销本次新增引用与资源；旧单 token 句柄保持原调用约定；进程身份含 /proc/<pid>/stat starttime 排除 PID 复用；实现与验证证据见该任务记录。

实现（任务018，k-f0d9a8952aff 收窄）：`task update`／`task apply-pending`／`task close` 在任务＋state 短锁内按真实 run 仓储复核活动／结果／验收操作；活动 run 中 update 要求 `--run`，apply 与 close 在未收敛时拒绝。`run prepare` 与关闭共用任务＋state 短锁；接收同样取任务＋state 短锁（不取也不重入工作树租约），使用 `runs/<run>/acceptance.json` 检查点，Task／scope／check／binding 半写入可重入收敛。`task record` 等纯记录只取任务短锁。实现（任务022）：init 以 `init-manifest.json` 上次 `baselineSha256` 区分旧受管基线与人工改动；旧基线按新模板更新，人工／未知来源冲突不覆盖，`--force` 显式覆盖；项目模板文件默认沿用，`--force` 时与当前模板不同则按模板覆盖并先备份。清单模板版本高于当前安装包时拒绝降级。安装映射每次按当前 CLI 入口重写。桥接模板以进程级 Symbol guard 在重复加载／reload 前停止旧观察器，ready 不授予 Pi 项目信任。`task adopt` 在任务＋state 短锁内重新核对当前分支、Task 版本、活动 run 与未完成 delivery 操作；只可改绑到当前检出分支，start 与配置阶段保持，deliver 按 verification 回到最近检查阶段或工作阶段，清 `lastCheckRunId` 但保留检查历史文件。原生选择事件的分支与当前分支不一致时报告 `branch_changed` 并不生效；run 状态投影保存发起分支，桥接轮询发现分支不一致时跳过通知。实现（任务017）：取得项目锁前创建锁根并核对本地文件系统，已知 NFS／SMB／FUSE 类型报 `lock_fs_unsupported`，权限不足报 `io_error`，不静默降级。owner 记录 scope／rawKey；`knit locks` 只读列出 `scope/hash`、进程核实与心跳；`knit unlock` 必须给 owner token，token 不符永远拒绝，alive／unknown 另需 `--force`，删除前再次核对 token，旧 token 不能删除新占用。worker 持有执行目录工作树租约期间每 5 秒心跳；心跳版本冲突只记录并停止发布完成，不自动换锁。阶段在执行目录锁之后取得 `pi:<nativeSessionId>` Session 锁，按同一 `heartbeatIntervalMs` 心跳；worker 崩溃后该锁与执行目录锁一样按下文自动回收规则处理。实现（多任务并行，任务 k-2cbd2f312298）：worker 取锁前只读 binding 与执行路由确定执行目录键，取锁后重读 binding、重算路由并核对请求 `expected.executionDir`／执行分支；路由或执行目录变化失败 `route_changed`，不冻结输入、不进入阶段。结果接收只取任务＋state 短锁，外部 `run accept` 不与任何工作树租约相互阻塞，worker 持租约时也直接接收。不同 worktree 的 run 可并行，同一执行目录的第二个 worker 失败 `lock_busy`。

| 操作 | 占用范围 |
| --- | --- |
| 代码实施／验证（阶段 worker） | 执行目录工作树租约：主检出路由为主检出根，已交接 worktree 路由为 worktree 路径；同一执行目录一次一个，不同 worktree 可并行 |
| run 准备与结果接收 | 任务锁＋状态锁（短）；prepare 另只读检查执行目录租约 |
| 任务创建、输入更新、ready、实施记录、关闭、改名、顺序、草案应用 | 任务锁＋状态锁（短），不等待长阶段 |
| task record 的进度、经过、验证与运行引用；材料保存／删除；草案保存与撤回 | 任务锁（短），允许与长阶段并行 |
| 快照恢复、worktree 合入与清理、交付与归档、初始化、正式规范采纳、gc | 工作树租约（主检出），保证仓库级写入；worker 持租约时 `lock_busy` |
| Session 关联与查询元数据 | 对应短时元数据占用，不推进 stage |

记录只改记录区，输入 update 声明 clarify/change 与说明。clarify 保持当前阶段，摘要变化使检查 stale；当前 deliver 一旦选定目标检查失效就回最近检查阶段或工作阶段并清 completed，change 回 start。摘要未变不迁移。运行中直接改输入须声明 `--run`，旧 run 收尾判 `stale_input`；只想等终态后再应用时显式用 `--pending` 存草案，不借记录绕输入。挂起输入只保留当前草案及基线摘要；按 DESIGN3.6 的 --apply-pending／--withdraw-pending 和 --expect-pending 校验处理。应用前核实旧执行／结果和基线，撤回只留原因且可在活动 run 中进行。任务关闭先收敛本任务活动／未知运行及待接收事实，撤回未生效草案；关闭与启动／接收共用该任务短临界区，旧结果不重开任务。

实现（任务009）：`src/application/task-service.ts` 的 TaskService 提供 new/rename/list/record/ready/update/close；输入摘要在 `src/contracts/task-inputs.ts`（inputsDigestOf 排除记录区标记内正文；草案版本摘要含生成它的更新操作 ID，同内容重建得新版本）。task.md 读写用 `src/application/task-document.ts`（YAML Document frontmatter，记录区标记 `<!-- knit:progress:start/end -->`，结构错误报 io_error 不静默修复）。占用：record/withdraw/草案保存用任务短锁（scope=task，按稳定 ID），rename/ready/update-direct/apply/close 在任务＋state 短锁内重核版本。封存中 record 返回未保存（sealed）不写文件；封存标记由 deliver/archive 落盘。binding 新增 confirmedInputsDigest（ready 冻结）与 pendingDraft（至多一份）；run 活跃状态与 runsSettled 收敛核对待 run 仓储（任务012/013），当前由调用方传入。更新（任务 k-836997c84864）：CLI／桥接注入 `RunActivityService` 后 `task close` 由核心直接核对活动／未知 run 与待接收结果，`--runs-settled`（桥接 `runsSettled`）保留为兼容参数、无操作，也不能绕过核对；未注入仓储的库调用无法自证，仍须显式传 `runsSettled: true`。

实现（任务010）：`src/application/session-service.ts` 的 SessionService 提供 attach／verify／list／useTask／clearTask／resolveSelection／history；索引存 DESIGN9.5 字段，按（客户端、原生 ID、阶段 id）定位，Knit Session ID 为 `s-`+12hex。原生有效路径用 `src/adapters/pi/native-entries.ts` 的 parentId 回溯核实，只有路径上的最后选择事件生效；树切换后旧条目不在路径上，不复活索引快照。未落盘选择只记 `persisted:false` 待确认，`available` 仅在原生文件身份核实后置位；文件从已落盘变为缺失时为 missing，不冒充可恢复。临时 cwd／项目迁移由 cwd 比对返回未生效，不误选。`src/application/context-planner.ts` 的 ContextPlanner 生成分层输入：任务输入区与正式规范／阶段提示词计入 inputsDigest，记录区、未生效草案、候选规范只作背景并列入 excluded；阶段提示词文件缺失时列入 excluded，用核心默认 agent 指令，不阻断执行。`knit session` 与 `knit context` 命令提供同能力；`inputs.json` 落盘与桥接原生条目写入分别归 012/013 与 015。

实现（任务011）：`src/application/standards-service.ts` 的 StandardsService 提供 list／propose／review／apply／pending／migrate。任务 k-5dd19bb9b84c 起候选写入项目级 `.knit/standards/candidates.md` 的 `<!-- knit:candidate:start/end -->` 标记块（`src/contracts/standards.ts` 解析／渲染），不要求 taskId，也不要求任务存在；`sourceTaskId`／`source` 只标注来源。项目候选与记录不改变正式规范摘要或需求摘要。审阅回执存 `standards_reviews`，项目作用域记录以 `project` 为键、按候选集合摘要匹配，不要求分支一致；候选增删或正文变化后重新提示。延期／拒绝有理由即可继续，无候选不要求新增。采纳在工作树租约（主检出）与项目候选短锁内核对回执、目标与文件版本，机械追加规则并补 `standards/index.md` 引用；重复采纳幂等。旧任务 `standards.md` 只读兼容，`standards list --task` 仍可按任务与分支查看旧回执；`standards migrate` 幂等迁入项目候选且不改写原文件。交付／归档不再检查候选，未审阅候选不阻塞。`TaskService.ready` 同时冻结 `confirmedStandardsDigest`；`ContextPlanner` 输出 `standardsDigest` 与 `effectiveInputsDigest`（任务输入区 + 正式规范），正式规则变化据此使相关检查 stale，记录与候选不参与。

实现（任务012）：`src/application/run-coordinator.ts` 的 RunCoordinator 提供 prepare／start／status：prepare（可能先自动准备 worktree）在任务＋state 短锁内生成 `request.json`（含预期 inputs／standards／effective 摘要、模型、工具策略、恢复引用与 acceptanceOperationId）和 planned `launch.json`，不取得工作树租约、不改业务产物；同任务／阶段已有活动 run 时复用，不生成替代运行；没有可复用 run 而执行目录租约被占用时 `workspace_busy` 拒绝，不生成 run。start 先落盘 starting 与 PID／boot／starttime 句柄，再启动 `src/worker/knit-worker.ts`；已 confirmed 或句柄存活时只观察原运行，句柄缺失／死亡且未认领时置 failed，重复 start 不增加尝试，只有 `--retry` 才重试同一 run。worker 以 `mkdir claim` 原子认领，自行取得执行目录执行占用（任务 k-2cbd2f312298：主检出根或已交接 worktree 路径），重新核对路由、任务阶段／分支、草案与预期摘要，冻结 `inputs.json`／`instructions.json`；implement 由 `src/application/snapshot.ts` 建立 `snapshot/`（tracked 工作区与 index OID、未忽略 untracked、模式／指纹、缺失路径、HEAD 起点），超限或 Git 覆盖未知时 manifest 置 failed，不能冒充 ready。就绪后 state 为 preparing + `prepared:true`；012 验收用 `--prepare-only` 在此退出，默认实现由 013 继续持锁执行阶段。`events.jsonl` 只作观察，status 不以其作为完成证据。 实现（任务 k-da9973a69c20）：`run prepare` 在首个配置阶段前按 `worktree.default`（缺省 off）或调用级 `--worktree on|off` 自动确保 worktree，顺序为脏守卫 → `worktree create` → `worktree handoff` → `worktree prepare`；已交接的绑定按现有路由使用；自动 create 中断的绑定在策略 on 下续做交接／准备，不删除绑定。脏守卫排除当前任务资料与 Knit 运行／锁／worktree 容器，任务之外有改动返回 `worktree_dirty_source`；自动路径不接受 `--allow-dirty`。确保失败不写 request、不建 run；成功后 request 记录生效策略与 worktree 执行目录。

实现（任务013／可配置流程改造）：`src/application/stage-runner.ts` 从 prepared 继续：按请求中的阶段 id 读取生效流程，登记独立子 Session（阶段不同即不同原生对象），优先恢复请求指定原生记录，缺失／不匹配时同客户端预分配新 ID 新建；Pi 运行时按阶段声明的 `tools` 能力白名单装配工具，不写或写 `all` 时全部放开，写 `[]` 时全部禁用（`--no-tools`），声明 `external`／`network` 才相应放开扩展、MCP、技能与网络。提示词缺省或文件缺失时用核心默认 agent 指令，不阻断执行。等待 `agent_settled` 后才取最终文本，保存原生条目范围、本 run 增量用量和不可变 `result.json`。报告先校验固定字段 `summary`／`validation`／`blockers`，再按阶段 `report` 校验声明字段；`paths` 类型（通常为 `changedPaths`）必须与实际 Git 可见差异完全一致，否则失败并带实际路径。实现（任务 k-b9df107db53a）：仅报告本身不通过时（缺 JSON／截断／schema 不合、`changed_paths_mismatch`（不含外部改动）、缺少 `changedPaths`、声明字段类型或结论不符、`report_verdict_missing`、`check_scope_incomplete`），worker 在同一原生会话最多补报 `limits.reportRetries` 次（默认 1，0 关闭），提示列出实际 vs 报告对照与缺失 coverage；补报轮只重发报告，期间工作区新改动、HEAD／敏感区变化、取消或占用丢失仍按原语义失败，补报不增加阶段访问、修复预算或 `maxAttempts`。`src/application/run-acceptance.ts` 按固定 `acceptanceOperationId` 复核当前输入／正式规范／scope／分支与 Task 阶段，再机械写 `scope.json`、`checks/<run>.json`、Task stage 与 binding：实施结果累积 scope 并记录 lastImplement；阶段报告被接收后按 `onVerdict` 或顺序流转，最后一个阶段进入 deliver；声明回退的阶段累计访问并按 `maxVisits` 停止，超限写 `repair_round_limit`；检查阶段有实际修改时随接收并入 scope，检查凭据绑定并入后的 scope 摘要与实际 `changedPaths`／`selfVerified`／`checkerChangedPaths`。实现（任务 k-b88e4a80906d）：阶段能力不含 `write` 时，`finalizeCompleted` 在来源归属后以“实际差异减外部改动”为本 run 写入，非空即 `failed: write_without_capability:<paths>`（结果与工作区保留，不接收）；接收侧对无归属信息的旧结果同样以 `needs_attention: write_without_capability` 拒绝。`completionDecision` 在最新检查带 `checkerChangedPaths` 时返回 `check_self_modified`（`deliver` 预检同样拒绝）；`run check --task` 在任务位于 deliver 时按 `recheckRequested` 回到检查阶段再派发。完成凭据照实记录所引用检查的 `checkerChangedPaths`，交付产物／资料提交的“验证”行与 `run status`／`status` 显示“independent（检查者修复 N 个路径，修复部分为自检）”。未授权周期写 `repair_not_authorized`，`run prepare --new-repair-cycle` 才显式开新周期。结果待同步时 `run resume --run` 只接收不重跑；旧执行已终止且无有效结果时用原／新会话续做同一阶段。`run cancel` 落盘按 run 的取消意图，worker 在模型前／等待中／发布前观察并收敛为 cancelled，旧取消文件不作用于新 run；原生引用不可恢复只把 Session 标 opening，不否定已完成结果；`result.json` 写入失败置 failed，不发布完成。

实现（任务014）：`src/application/delivery-service.ts` 的 DeliveryService 提供 deliver／archive。两者先落盘操作意图、完整 refs/heads 目标、授权来源与默认分支候选；直接 CLI 无来源只记显式调用，Agent 调用无 authorizationRef 拒绝。项目规则来源核实文件章节与 SHA-256，用户消息引用只保存声明，核心不冒充语义授权。默认分支候选按 `delivery.defaultBranch`、本地 `origin/HEAD`、unknown 顺序观察，不授权也不因 unknown 阻断明确目标。preflight 重核当前分支、任务／绑定分支、无待应用草案、运行与待接收结果已收敛、完成凭据或任务要求的检查仍有效且输入／正式规范／scope 摘要未变；规范候选未审阅不阻塞，规范处理不重新绑定任务。deliver 先收束 closed/completed，再以 scope 业务路径形成产物提交，以任务目录和已采纳规范目标形成资料提交；提交后核对父节点、真实 OID、实际 name-status 范围，并比较无关 index 与工作区指纹。hook 改动选中或无关文件、范围不符时保留提交并置 needs_attention，不移动任务；显式 `--retry` 先核验原提交再继续，不重复提交。记录区追加交付记录后才写 `.knit-sealed` 固定摘要；封存中 task record 返回未保存。移动到 `archive/YYYY-MM/<原目录>` 后更新绑定，归档提交包含旧路径删除与新路径新增但不含封存标记；提交失败保留“已移动、待提交”。取消／替代 archive 只归档资料，不产生工作提交或空 commit。回执丢失按操作 ID 在 Git 历史中核实已生效提交，不重做。实现（任务020）：提交前保存 before／expectedPaths／expectedTree；恢复要求 HEAD、父节点、message、路径集合与提交树一致。删除／重命名路径已在 index 删除时不重复 add，只进入 commit pathspec。归档核验失败不落盘错误 archiveCommit，清理额外历史后同一操作可恢复真实提交；work 提交后的外部额外提交拒绝归档。

实现（任务015）：`src/cli/status.ts`、`src/application/status-service.ts`、`src/application/diagnostics.ts` 提供 status／doctor／storage 只读投影；`status --events` 只输出事件行直到 run 终态，不接收结果。`src/cli/start.ts` 在项目 cwd 启动本机 Pi，不自动批准项目信任。`src/cli/resume.ts` 支持按 run／operation／task 恢复；operation 仅对交付操作重入或已 planned 的操作放弃，未知效果保持待核实。`src/application/informal-check.ts` 执行显式 `--scope` 的只读检查，不建 Task／binding；检查前后比较 Git 与范围指纹，有副作用即失败。`src/application/model-selection.ts` 按显式参数或项目 `phases` 选择模型，缺失显式阻塞。桥接模板注册 `knit_status`、`knit_task`、`knit_context`、`knit_run`、`knit_deliver`、`knit_standards`，参数 schema 由 `src/contracts/bridge-tools.ts` 构建期派生为 `dist/contracts/bridge-tools.json`；桥接只读安装包内派生 JSON。桥接在 session_start 登记主会话、恢复有效选择，按 run 发起方原生 ID 用一次 `run list --active --with-status` 只读查询仍需处理的 run（活动 5 秒／空闲 30 秒退避，串行不重入），按会话条目去重投递；忙时 follow-up，关闭观察不取消 worker。所有桥接 CLI 调用异步执行，`execute` 透传中止信号；`knit_run wait=true` 异步轮询，用户中止即返回当前状态且不取消 run。每轮上下文只调一次 `knit session context`（与 session_start 预热共享在途请求）；有缓存时超过 300ms 用缓存并标注可能过期，续接首轮无缓存时等待当轮结果（上限 2s），刷新失败保留上一轮分节并记诊断。`--dev` 只向 stderr 输出白名单 JSON，worker 诊断继承同一 stderr，不建日志文件。

prepare 先持久化 run/operation ID；持有调用的桥接或直接 CLI 入口保存 ID 后确认 start，之前无模型副作用。`run prepare` 可能先准备 worktree（创建目录、交接任务资料、执行 `worktree.copy`／`postCreate`），该环境副作用在 request 落盘前发生；失败按 worktree 组件保留回执与现场，重试续做，不产生 run。这是入口内部协议，无需用户重复确认或手动执行 prepare/start 两条命令。取消按对象 ID 与 owner token 保存，终态裁定同一短锁排序。新 run ID／操作 token 隔离旧取消，不设请求级路由；确定性操作核实效果后 needs_attention，不回滚或改变业务 outcome。

收尾短锁封存记录，封存中补记返回未保存（sealed），不写任务、不转存、不留修改，主 Agent 不能声称已记。封存结束后按原 Task ID 重试为档案新资料修改，不随当前选择转移，说明未含于原提交；是否提交按已有授权，不重开业务。任务锁按稳定 ID 定位，移动仍为同一对象。禁止持短锁等执行占用，多个键固定排序；外部编辑器不受控，写回仍核对版本。

心跳默认每 5 秒更新（`limits.heartbeatIntervalMs`），超过 `limits.heartbeatStaleMs`（默认 30 秒）无更新仅表示可疑：`knit locks` 每条标 `heartbeat=正常／超时／未知`，`doctor` 的 locks 检查分列 alive 中心跳正常与超时的数量并列出超时锁 ID。自动认定原进程终止，必须有同机器、启动标识和进程开始时间等证据，排除 PID 复用；权限不足、无法核实的身份或未写完整的 owner 信息均视为未知。时间戳、旧 PID、窗口消失和心跳超时单独都不足以解锁。取得多个锁失败时，按 token 释放本次已取得的锁。

进程身份：Linux 读 `/proc/<pid>/stat` starttime（时钟节拍，精确）；其它平台（macOS）回退 `ps -eo pid=,ppid=,pgid=,lstart=,comm=`，身份为 `lstart|comm`。lstart 只精确到秒，追加启动命令后同秒 PID 复用为不同程序时可区分；同秒复用且命令相同仍无法区分（已知限制）。升级前只记 lstart 的旧 owner 与新格式比较时只比 lstart，不因格式差异误判死亡。

自动回收（任务 k-6f0616f3779d）：`acquire` 遇到锁目录已存在时先核实 owner，同时满足以下条件才回收：owner 记录完整、`machineBootId` 与本机当前启动周期相同、owner 进程核实为 `not_alive`，且 owner 登记的附属进程（`attached`，worker 把阶段 Pi 登记到执行目录锁与 Session 锁）也都核实为 `not_alive`。回收在锁目录内 `mkdir .reclaiming` 守卫（并发回收者互斥，守卫残留超过 60 秒视为回收者崩溃并清除），守卫内复核 token 未变后把整个锁目录原子改名进锁根 `reclaimed/<时间>-<scope>-<hash>-<随机>/`，改名后确认守卫仍在（否则还原重试），再按原流程 mkdir 重建；回收区写 `reclaim.json`（原 owner、回收者 pid／动作、时间、原因 `owner_not_alive`），只保留最近 50 条。`alive`、`unknown`（跨启动周期、owner 缺失／损坏、权限不足）或附属进程仍在／无法核实时仍报 `lock_busy`，不回收。回收后的诊断：`knit locks` 列出最近回收记录，`doctor` 的 locks 检查给出本项目回收次数与最近一次；run prepare、worker 与阶段 Session 锁回收另写 run 事件 `lock_reclaimed`，`--dev` 输出同名诊断事件。`run resume --run` 不再因已可回收的旧工作树租约拒绝续做，其余情形拒绝信息带锁 ID、owner 与 unlock 命令。活动 run 同样核实：`run prepare`（含 `run implement` 等派发入口）遇到同任务同阶段的活动 run 时，若无结果、worker 句柄与登记的阶段 Pi 在同一启动周期内都核实为 `not_alive`，按 resume 语义把旧 run 收敛为 `failed`（`worker_exited_before_result`；有取消请求则 `cancelled`，事件 `recovered_without_result` 记 `by: prepare`）后新建 run 真实启动；未显式指定恢复会话时续用旧 run 的原生会话，新阶段取 Session 锁时一并回收旧 Session 锁。worker 或阶段 Pi 存活／无法核实（含跨启动周期）时仍复用原活动 run，不另起执行。

`lock_busy` 错误信息与 `details` 带锁 ID、owner 动作、pid、token、心跳时间、进程核实结论（附属进程未结束单独标出）与下一步命令：alive 提示等待或 `knit run cancel`；unknown／owner 缺失提示核实后 `knit unlock <lock-id> --expect-token <token> --force`；not_alive 但附属进程未结束提示先终止残留进程。

`knit doctor` 显示锁、run、已知子进程与核实结果，不运行客户端桥接或验证命令。已确认终止的旧运行由下次取锁自动回收占用（见上文条件）；仍活着的运行先 `cancel`，必要时由用户终止相应进程树并重新核实。

逃生入口为 `knit unlock <lock-id>`：`lock-id` 即 `knit locks` 列出的 `scope/hash`，命令按锁目录反查 scope 与原始键，不再需要 `--scope`／`--key`（旧的 `--scope <s> [--key <k>]` 写法保留）。仍必须给 `--expect-token <token>`；`--from-list` 便捷确认只在 owner 已核实 `not_alive` 且不带 `--force` 时直接使用列表中的 token，与 `--expect-token` 同用时两者须一致，alive／unknown 必须显式抄写 token。正常解除只处理已证实终止的占用；无法核实（unknown）或仍 alive 时需 `--force --expect-token <token>`，由用户确认已手动处理旧进程。`knit locks --dir <项目>` 只列该项目的锁：主检出根（工作树租约与 state 锁）、`<根>::` 任务键、`schedule:<根>`、本项目 worktree 容器路径，以及本项目 run 阶段进程记录中的 Session 或与本项目锁同一 owner 进程的 Session 锁。Agent 工具不自动强解。

强解不能证明外部工具已经停下，也不能撤销其副作用。worker 在心跳、工具边界和写回前校验 token；丢失占用后停止新动作，旧回执不得推进任务。已经发出的 shell 不受 token 撤销保护。新运行仍需核对文件、Git、工具终态与快照，不能把解锁当作原运行成功或已安全取消。

已知 iCloud/File Provider、Dropbox 等同步根采用平台可取得的根路径与规范化实际路径尽力识别，不扫描个人文件或读取服务凭据；检测不完整，未命中不代表安全。Git 忽略不阻止云同步，不能同步／跨机并发使用活跃 runtime，SQLite WAL 和文件锁均不因此获得跨机互斥。建议使用非同步目录或验证已排除 runtime；doctor 不自动移动数据或修改云配置。此告警归 M2 最小诊断，M3A 完善展示；不新增云服务集成。

实施前核对行为场景：主会话把完成条件写在固定 `## 完成条件`，用 `### Requirement: 名称`／`#### Scenario: 名称` 与顶格大写 GIVEN／WHEN／THEN／AND（关键字可加粗），每个 Scenario 至少 WHEN 和 THEN。`task ready` 有结构错误报 `scenarios_invalid`、independent 无场景报 `scenarios_required`，附前 3 条问题（有错误时）与格式示例，拒绝时不冻结输入或推进 start；self／none 可用自由列表。合格时输出数量，`clarify_blocking` 与依赖门不变。延期验收留在目标与边界；旧格式不迁移，已有项目通过显式 `knit init --force` 覆盖流程与提示词。

阶段提示从本 run 冻结任务输入解析 Rn.Sm 编号、Requirement／Scenario 名与步骤。实施按场景产出并在 validation 按编号记录验证；检查对照 WHEN 与 THEN，只有声明 scenarios 且任务有场景时要求逐场景报告。歧义或冲突停止并交回，不自行改变行为契约。

### 2.1 阶段运行边界

阶段 worker 不是操作系统沙箱，不拦截 shell 调用；它在阶段前后各取一次事实并比较（实现：`src/application/stage-baseline.ts`，由 `stage-runner.ts` 在启动阶段 Agent 前冻结、在报告校验前核对）。

| 核对项 | 基线记录 | 收尾处理 |
| --- | --- | --- |
| HEAD 提交与符号引用 | `git rev-parse HEAD`、`git symbolic-ref HEAD` | HEAD 不同即 `failed: head_moved_during_stage`；`boundary.commits` 为 `git rev-list <基线>..HEAD`；不接收、不并入 scope、任务不前进 |
| index 摘要 | `git ls-files -s -z` 的 SHA-256 | 变化写 `boundary.indexChanged`，单纯暂存不判失败 |
| 工作区 | 基线时 Git 可见脏路径的内容指纹 | 实际差异 = 基线脏路径 ∪ 当前脏路径 ∪ `git diff --name-only <基线提交>` 的指纹差，再整体剔除 `.knit/tasks/**`（报告里如实列出这些路径也不算不一致），之后按下文来源归属分类；阶段内提交过的路径也出现在 `actualChangedPaths`；其余 `.knit/**`（规范、候选、配置、流程、提示词）出现即 `failed: protected_path_modified`，已授权为成果的正式规范除外 |
| Git 敏感区 | `.git/hooks/**`、`.git/config`、`.git/info/**`（共用 Git 目录，含 worktree）内容与权限 | 有变化即 `failed: protected_runtime_modified:<paths>` |
| runtime 敏感区 | `.knit/.runtime/` 下 `checks/`、`completions/`、`implementations/` 内容，`installation.json`、`init-manifest.json`，其它已终态 run 的 `request／result／inputs／instructions` 与 `snapshot/**` stat | 同上；完整路径列表在 `boundary.protectedPaths`，失败原因最多列 20 条 |
| 忽略区 | `git status --ignored` 的目录级条目（不含 `.knit/.runtime`、`.knit/worktrees` 与项目内锁根），每条取自身与直接子项 stat 摘要 | 变化写结果 `ignoredChanges`（added／removed／modified），`run status`、`status --run` 与桥接通知显示，不判失败 |

不在敏感区内：本 run 自有目录、`pi-sessions／sessions` 会话目录、`task-list` 列表缓存、`metadata.db`、`tasks/<id>/scope.json` 与 `tasks/<id>/residue.json`（由接收写）、本 run 的 `attribution.json`（`run accept` 确认写）、诊断与恢复记录。并发的合法 Knit 写入按路径归属排除（任务写入只取短锁，不被工作树租约挡住）：基线时仍活动（claimed／preparing／running，或接收失败待重收）的其它 run 目录及其新建检查凭据由其自身 worker／接收写入；基线后新建的 run 目录及其检查凭据来自其它工作树的并行派发；其它任务的完成／实施凭据由 `task close`／`implement`／`update` 写入；本任务凭据只放行删除（运行中输入更新使其失效）。终态 run 的 gc 删除需要主检出租约：阶段在 worktree 执行时不计，在主检出执行时出现即视为越权。

任务资料归属（任务 k-f0d9a8952aff）：`.knit/tasks/**`（`task.md`、`plan.md`、`design.md`、`research/` 与归档目录）整体从 `changedPaths` 剔除，不判越界，也不引入写入 journal 或 actor 归属；只按路径与摘要判定。谁写、怎么写（接口或直接编辑）都一样：输入区变化由 `inputsDigest` 在接收时检出并判 `stale_input`，记录区与材料变化不影响摘要、不使 run 失败。推荐经 `knit_task`／`knit_material`（或同名 CLI）写任务资料，接口做版本核对、输入摘要与阶段守卫；直接编辑不留 actor 记录，并发写入只能靠内容差异与 Git 状态辨认。同区段并发写靠 `expectSha256`／`expectDigest` 失败重试，记录区为追加。由此 worker 直接改自己任务的验收标准也不会判越界，但输入区改动必然触发 stale，这是已接受的取舍。阶段基线（`stage-baseline.ts`）与成果路径计算共用同一剔除规则（`attributedChangedPaths`），交付提交后的工作区核对同样不把并发任务资料写入当作 hook 副作用。

结果接收与来源归属（任务 k-fdfd8c171736）：worker 收尾在上述剔除后的实际差异上做来源归属，再决定结果。

1. 读取本 run 原生会话（起点为阶段开始前的最末条目），收集 `write`／`edit` 成功调用的 `path` 参数，按执行目录解析为项目相对路径；会话不可读、起点不在文件中时 `attribution.source=unavailable`，全部差异按来源不明处理。worktree 执行目录 `source=isolated`，差异全部视为本 run 写入。
2. 报告 `changedPaths` 中：有差异且工具写入 → `attributedPaths`；有差异但非工具写入 → `unattributedPaths`；无差异但属任务残留 → 指纹未变且原 run 工具写入为 `inheritedPaths`，否则 `unattributedPaths`；既无差异也非残留 → `failed: changed_paths_mismatch`。
3. 未列出的差异中：工具写入 → `failed: changed_paths_mismatch`；非工具写入 → `externalChanges`；会话不可读时 → `unattributedPaths`。
4. 接收（`run-acceptance.ts`）：有未确认的 `unattributedPaths` 时 `needs_attention: unattributed_paths:<paths>`，run state 收敛为 `failed`（`acceptance_` 前缀，不占用任务）；`run accept <runId> --include <path>... --exclude <path>... [--reason] [--by]` 在任务＋state 短锁内写 `runs/<run>/attribution.json` 后重新接收；`--include`／`--exclude` 只接受该 run 结果里的来源不明路径，其它路径以 `path_not_unattributed` 拒绝，不写确认记录。并入集合为已归属 ∪ 继承 ∪ 确认并入；发布时指纹只核对已归属与继承路径，确认并入的按当前指纹进入 scope，外部改动与被排除路径不核指纹。接收检查点记录 `residueConsumed`，收敛时从 `tasks/<id>/residue.json` 移除。
5. 失败／取消结果接收时把 `actualChangedPaths` 与 `actualEntries` 记为残留（`toolWritten` 取自结果的 `attribution`）；结果缺失、确认已死后由 `run resume`／`prepare` 收敛的旧 run，以快照比较当前工作区记来源不明残留。阶段内换分支（`branch_mismatch_after_run`）不记残留。
6. 交付预检（`deliver --plan` 与交付前计划）列出本任务各 run 的 `externalChanges`、被确认排除的路径与未处理残留，作为提醒；产物提交仍只含 scope 路径。

逐场景报告核对：默认 check 声明 `scenarios: string[]`，每项如 `R1.S1 pass：相关测试通过`，结论只取 pass／fail／not_verified，证据非空，分隔用全角或半角冒号。所有结论都须覆盖全部场景，总 pass 要求全部 pass。worker 收尾与接收共用函数，条目非法（未知／重复编号或缺证据等）报 `report_field_value:scenarios`；漏项含字段缺失报 `check_scenarios_incomplete:<编号列表>`；pass 矛盾报 `check_scenarios_inconsistent:<编号列表>`。三者走下述补报机制，提示列问题编号、名称与格式；coverage 仍每项一个路径，缺路径仍报 check_scope_incomplete。未声明或无场景不核对；task implement 与非正式 check --scope 不核对场景覆盖。

报告补报（任务 k-b9df107db53a）：报告校验失败只涉及报告本身时，worker 在发布 failed 前于同一原生会话追加纠正提示，要求只重发最终报告 JSON；local 与 Rex 共用同一报告校验与补报规则。补报最多 `limits.reportRetries` 次（默认 1，0 关闭），不新建 run、不增加阶段访问／修复预算／`maxAttempts`，也不改工具能力。补报轮开始前冻结工作区签名，结束后有新改动即 `failed: report_retry_worktree_changed:<paths>`；期间 HEAD 移动、敏感区改动、取消或占用丢失仍按原失败语义终止，不能用补报掩盖。每轮失败都在 `result.reportIssue` 记录失败原因、实际路径、报告路径、缺失 coverage 与人读对照；`reportRetries` 与 `reportRetryUsage` 记录补报次数和额外用量，`usage` 与原生 entry range 覆盖全部轮次。补报仍失败时保留原 `failureReason`，最终报告失败语义不变。

失败结果保留现场：阶段内提交不回滚、不 reset，敏感区改动不还原；基线摘要写入 run `state.json` 的 `baseline` 与结果 `baseline`，边界事实写结果 `boundary`。用户处理提交或敏感区改动后重新派发。首版不提供“接纳阶段内提交为成果”的出口，也不对整个 ignored 目录做内容指纹（成本过高），深层文件原地改写不保证出现在 `ignoredChanges`。

### 2.2 凭据完整性与阶段调用边界

实现（任务 k-28296c22647a，审计 S8、中等问题 4／5）：`src/infrastructure/credential-seal.ts`、`src/application/stage-context.ts`，由 `run-store.ts`、交付与各收尾命令入口调用。上表的敏感区核对把阶段内改写受管资料判为失败；下列规则处理阶段外读取时的采信与阶段内的直接调用。

| 对象 | 写入 | 读取失败处理 |
| --- | --- | --- |
| `checks/<run-id>.json`、`completions/<task-id>.json`、`implementations/<task-id>.json` | 顶层 `integrity: { alg: "hmac-sha256", mac }`；MAC 覆盖版本前缀、种类、文件名与去掉 `integrity` 的键排序 JSON | `credential_tampered`（MAC 不符、签名结构非法、本机密钥缺失或已更换）／`credential_unsigned`（旧格式缺签名，需重建）；交付、`task close`、检查资格以该原因拒绝，`status` 展示忽略该凭据 |
| run 自有 `result.json`、`acceptance.json` | 同上（worker／接收服务写入） | 接收以 `needs_attention`（原因 `credential_tampered` 或 `credential_unsigned`）停下，不按伪造结果或检查点推进任务、不写检查凭据；`run status` 等展示读取不要求签名 |
| `.knit/.runtime/delivery-hooks.json` | 交付完成后写 hooks 目录快照 | 签名无效按无基线，现有 hook 全部列为新增 |

密钥：`~/.knit/keys/<project-hash>`（账号主目录；`project-hash` 为规范化主检出根的 SHA-256 前 32 位），32 字节随机、文件 0600、目录 0700，首次写凭据时以 `O_EXCL` 创建，并发创建者读取先到者；读取不创建。`KNIT_KEYS_ROOT` 仅供隔离测试覆盖密钥根（`npm test` 指向本次运行新建的临时目录，结束即删除），阶段进程环境（`isolatedEnv` 与 Rex 启动参数）剔除它。换机、删除或重建密钥后旧凭据全部按 `credential_tampered` 失效；升级前的无签名凭据按 `credential_unsigned` 处理。重建方式：independent 重新派检查，主会话实施重新 `task implement`，已关闭任务按完成失效重新 `task close`。不做一次性信任迁移。这是防阶段 Agent 伪造的本机完整性，不防同一账号下读得到密钥的恶意进程。

阶段调用边界：worker 启动阶段 Pi（local 的 `isolatedEnv`、Rex 的 `/usr/bin/env` 参数）时同时注入 `KNIT_RUN` 与 `KNIT_STAGE_RUN_ID`，两者同值为本 run ID，子进程继承。核心在下列入口检测到非空 `KNIT_STAGE_RUN_ID` 即报 `stage_context_forbidden`（CLI reasonCode `needs_review`，退出码 1），在写文件与取锁之前：

| 命令 | 检测位置 |
| --- | --- |
| `deliver`（非 `--plan`）、`archive` | CLI 入口与 `DeliveryService` |
| `worktree merge --apply`、`worktree cleanup` | CLI 入口与对应服务 |
| `task close` | `TaskService.close` |
| `unlock` | CLI 入口 |
| `gc --apply` | `GcService.apply` |
| `run accept` | CLI 入口（含 `resume <op>` 的接收分支）；worker 内部接收不经该入口 |

不复用 `KNIT_RUN` 的原因：`KNIT_RUN` 是 `task update` 缺省声明的 run（OPERATIONS §2），用户可在自己的终端设置它声明活动 run；用它做拒绝标记会让主会话在同一终端无法交付。`KNIT_STAGE_RUN_ID` 只由 worker 注入，语义单一。worker 自身的结果接收在 worker 进程内进行，worker 进程本身不带该变量（只传给阶段 Pi），不受影响。环境标记不是沙箱：刻意清除变量的 shell 仍可调用 CLI，此时交付提交导致的 HEAD 移动由基线判 `head_moved_during_stage`，伪造凭据由上表完整性校验拒绝。

## 3. 实施快照与显式恢复

每次正式 implement 的可信 worker 程序取得执行占用后，在 `.knit/.runtime/runs/<run-id>/snapshot/` 建立 preparing 对照，ready 后才调用阶段模型／写代码，失败保留 failed。占用由该执行者一直持有，不从 CLI 交接。保存仓库／分支、HEAD、index、脏路径、类型／模式、工作和暂存内容、未忽略的未跟踪内容及指纹；新增路径起点为不存在。前后核对源码、有效输入、HEAD 与 index，变化即重核。Task 记录在短锁内捕捉版本，后来的合法纯记录不会使快照准备反复失败。

快照写入按内容去重（manifest schemaVersion 2）：tracked 工作区文件／符号链接的字节与 `HEAD:<path>` 的 blob 完全一致（Git blob SHA-1 相同）时只记 `source:"head"` 与 `headOid`，不复制到 `snapshot/files/`；index blob 与 HEAD 树 OID 相同时记 `indexSource:"head"` 与 `indexHeadOid`，不复制到 `snapshot/index/`。引用省略的字节记入 `savedBytes`，不计入 `bytes` 与上限。submodule、类型变化（file↔symlink）与未忽略 untracked 不引用，仍完整复制；没有 HEAD 的仓库也全量复制。manifest 兼容读取 schemaVersion 1：缺少这些字段即全量副本语义，恢复行为不变。快照不通过自动 stash 写入新的 Git 快照对象，也不创建 `refs/knit/bases` 基线引用；不隐式 stash，不改写工作区／index。快照默认上限 64 MiB 按实际保存内容计（tracked 工作区副本＋独立 index blob＋未忽略 untracked 文件），不是单文件上限；引用 HEAD 的字节不计费。超出或保存失败时阻塞实施并列出路径与处理选择，不悄悄降级为不完整快照。大仓库在缩减内容或调高 `limits.snapshotsMaxBytes` 前无法开始正式实施。快照先写入 `snapshot.tmp-*` 临时目录，完成后原子改名；重建（failed 或半成品重试）时先回收同 run 中断残留的临时目录。

快照 manifest 版本迁移（v1→v2）：v2 只新增可选字段（条目的 `source:"head"`／`headOid`、`indexSource:"head"`／`indexHeadOid` 与顶层 `savedBytes`），没有删除或改名字段。读取规则：声明 schemaVersion 为 1 或 2 时都按本节解释；v1 条目缺少 `source`（及 `indexSource`）即内容已完整存于 `snapshot/files`（及 `snapshot/index`），恢复按副本读取，语义与 v2 前一致；缺少 `savedBytes` 按 0 展示，不参与恢复。声明版本为数值且大于 2 时属于未知较新版本：报 `version_conflict`（含 found、期望版本与 manifest 路径），阻塞快照重建与写入，`snapshot show`／`snapshot restore` 只报告错误、不返回 manifest 内容，也不覆盖原文件。schemaVersion 缺失、非数值或结构不符按损坏报 `io_error`，不当作格式演进。当前不提供迁移器：v1 数据可被 v2 读取器完整解释（缺字段即全量副本），重写 v1 快照只改变存储表示、不增加可恢复性，故没有重写收益；后续若出现必须改变字段语义的版本，再按第 6 节补充按版本的迁移说明与校验器。

恢复 HEAD 基线引用时按 manifest 记录时的 OID 执行 `git cat-file blob` 并用原有 SHA-256 核对字节，不依赖恢复时的 HEAD（amend 后对象仍存在即可恢复）。`cat-file` 失败（例如对象已被 `git reflog expire`＋`gc --prune=now` 清除）报 `snapshot_baseline_unavailable`（含路径），不静默跳过、不部分恢复。因此快照只引用 blob OID：仍需恢复的快照不得 prune 其引用对象；本任务不开启自动 GC，清理策略归后续存储能力。

任务源文件的直接修改默认排除 ignored 路径和嵌套仓库；确需修改的 ignored 文件先明确路径并纳入快照。已授权命令生成的缓存、依赖和构建输出记录为副作用，不承诺文件快照覆盖。子模块按独立项目处理，数据库和网络服务同样不在文件回退范围。运行目录使用本用户私有权限（目录 0700、文件 0600，或平台等价 ACL），快照、请求和原生记录不入 Git。

取消或失败后保留现场与快照，先展示实际差异、可恢复路径和未覆盖副作用。首版不自动 reset、stash apply 或整仓还原。`knit snapshot show <run-id> [--path <path>]` 只读查看，不直接输出疑似凭据。

恢复路径必须位于当前项目，拒绝越界和通过父级符号链接写入其他位置。恢复使用 `knit snapshot restore <run-id> --path <path>` 或对应工具，默认给出预览；用户明确执行时附 `--expect <path=当前指纹>`（单路径可省略路径前缀），在取得工作树租约（主检出）并核对当前分支、仓库和工具终态后逐路径处理；worker 持租约时 `lock_busy`，先等其结束或取消。当前工作区指纹或 index 状态变化即停止；同一文件的恢复单位是整个文件，不支持分块或自动三路合并。默认只恢复工作文件；恢复暂存内容须另外指定 `--index`，只写选中路径的 index 条目并核对快照 index 摘要。删除本次新建文件须指定 `--remove-created`，目录不递归删除，其他路径与后续修改保留。恢复记录在取得工作树租约前先行写入（锁外失败也留诊断），run cancel 也不持有该锁；并发恢复或取消交错时可能返回 version_conflict／stale_input，重试即可收敛。

实现（任务016）：新建快照在 `snapshot/index/` 保存与工作区版本不同的 index blob，并在 manifest 的每条 entry 记录 `indexDigest`；没有该字段的旧快照仍可 `snapshot show`，但 `--index` 明确拒绝，不猜旧 index 字节。`snapshot show` 只输出 base、counts、路径、模式、摘要与 index OID，不输出文件正文。恢复指纹为 `file:<sha256>:<Git mode>`、`symlink:<sha256(目标)>` 或 `absent`，模式变化也算当前版本变化。文件按快照模式新建或原子替换；符号链接先写临时链接再 rename，不跟随目标；二进制按原始字节复制。`--index` 用保存的 blob 计算并 `git update-index --cacheinfo`，只改选中路径，保留无关 index／暂存内容。Task 的 `task.md` 不按普通文件覆盖：选中路径识别为 Task 文档时，先取工作树租约，再读取快照输入区并经 `task update` 合并，保留 frontmatter、记录区与后来记录；任务移动、关闭或归档则拒绝。快照包含 `.knit/tasks/**` 中被跟踪或未忽略的文件；这些路径不计入 run 成果，但仍可显式恢复：`task.md` 经 `task update` 合并输入区，plan 等材料按普通文件处理，运行后被并发写入时指纹不符即停止。源码恢复成功后清空绑定 `lastCheckRunId`；任务原为 deliver 时按检查规则回到 check。每次执行在 `.knit/.runtime/restores/<operation-id>.json` 留下 running／completed／needs_attention 记录和逐路径结果，异常不自动回滚已写路径，按记录与现场继续核实。`.knit/.runtime/` 与 `.git/` 不进入普通源码恢复，子模块和目录覆盖不支持。

Task 管理资料的旧版本只作对照，不能以通用 restore 整份覆盖后来记录和业务状态；输入恢复经 task update 保留记录。本机 runtime、索引和原生 Session 不由源码 restore 覆盖。每次真实恢复记录独立操作并使旧检查不再适用于新目标。

`git stash create` 能保存已跟踪文件和暂存对照，但通常不包含未跟踪文件；仅有未跟踪文件时可能不产生对象。它可作为用户另行选择的操作，不作为完整备份证明。

### 3.1 run 恢复与下一步出口

实现（任务 k-836997c84864）：`knit run resume <run-id>` 与顶层 `knit resume <run-id|--run|task-id>` 共用 `src/cli/run-control.ts`。协调器 `resume` 先按旧规则收敛旧 run（结果待同步则只接收不重跑；worker 与阶段 Pi 都确认已死且无结果则收敛为 failed／取消意图下为 cancelled），生成新 run 后默认立即执行与 `run implement` 相同的 start 流程（落盘 starting、启动 worker、等认领与 prepared 确认），返回 `started`、`confirmed`、启动后的 `launch` 与 `state`；启动失败（launch failed）以 `needs_attention` 返回并退出码 1。`--no-start` 保留只准备的旧行为（launch 停在 planned，之后 `run start <run-id>`）；`--wait` 只观察新 run 到终态（不接收）。桥接 `knit_run action=resume` 调同一命令，`wait: true` 时轮询新 run 终态。恢复的会话选择策略（prefer／new）不变，呈现沿用旧 run 的 request。

`knit status <task>` 与 `knit context --task <id>` 返回任务级确定性 `nextAction`（`kind`／`summary`／`commands`／`runId`），只读已落盘事实，同一现场总给同一条；给出的命令仍由核心按授权／阶段／锁／版本重新核对。按优先级取第一条：

1. `binding_missing`：本机没有可用绑定（无绑定行或确认摘要为空；clone／换机后常见）→ `knit task rebind <taskId>`：按 task.md 重建确认摘要与证据落点（self／none 回首个工作阶段，independent 回检查阶段），不伪造 run 或凭据；旧检查／完成凭据需按当前成果重新取得；
2. 未收敛的 run（最近一条）：`run_not_started`（只准备未启动 → `run start`）、`run_active`（worker 存活或无法核实 → 等待或 `run cancel`）、`run_pending_acceptance`（结果已发布未接收 → `run accept`）、`run_stage_alive`（worker 已退、阶段 Pi 仍在 → `run cancel --terminate` 后 `run resume`）、`run_worker_exited`（无结果 → `run resume`）；终态但接收操作缺失同样是 `run_pending_acceptance`；
3. `pending_draft`：应用或撤回待应用草案；
4. `lock_residue`：无活动 run 时仍在的执行目录锁（owner 已不在或无法核实）→ `knit locks` 核实后 `unlock <id> --expect-token <token>`（非 not_alive 加 `--force`）；可自动回收时一并说明；
5. `run_needs_attention`：最近 run 的接收停在 needs_attention（非 stale_input）→ 原因、该 run 的 `nextActions` 与可用命令（来源不明路径给 `run accept --include`／`--exclude`）；
6. `inputs_changed`：确认摘要与当前输入不一致或最近 run 判 stale_input（含审计中 deliver 阶段输入被改、`ready` 报 `phase_mismatch` 的场景）→ `task update --kind clarify`（补充；deliver 时回到需要证据的阶段）或 `--kind change`（目标／范围变化，回到 start）；
7. `stage`：按当前阶段推进（start → `task ready`；工作阶段 → `run prepare`＋`run start`；deliver → `task close --outcome completed` 与 `deliver --plan`，independent 且检查者修复过时 → 再派 `run check`）。

任务已关闭或归档时 `nextAction` 为 null。桥接每轮上下文、`knit_status <task>` 与 `knit_context` 同步显示同一条（`下一步（<kind>）: …` 加命令行）。

## 4. 主会话工作流与任务规划资料

主会话按 DESIGN §4.2 分类用户请求：是否创建 Knit 任务由用户决定；新事项先问任务选择再展开需求，不按类型或预估大小跳过；暂不创建时继续讨论，转到实施前再确认；明确不创建时同一事项持续有效，不重复追问。创建任务不等于需求确认或实施授权；用户明确“按这个做”等可同时确认范围与授权实施，仅认可思路且实施意愿不明时补问。普通讨论、只读调查、代码审阅、非正式小修改和用户明确不跟踪的修改直接在当前会话完成，新正式需求经用户要求或持续授权后 `task new`，已有任务继续用当前选择或 `--task` 定位，补充／范围变化走 `task update --kind`。授权来自用户明确指令或既有持续授权，不逐轮重复询问；授权不覆盖提交、推送、发布或迁移。不建任务时使用宿主通用工具／子 Agent；Knit `run` 只服务正式任务，宿主没有委派能力时直接执行并说明限制，不暗建任务。

正式任务创建时确定 `verification`：`none` 仅由用户明确选择，`self` 为默认（实施自检＋范围验证），`independent` 需要当前有效的正式检查。`task verification` 只在讨论阶段调整，作为输入变化并使旧完成／检查资格失效。建任务不附带实施、提交或发布授权。

复杂任务讨论中按需创建任务目录内资料：`plan.md`（步骤产出、真实依赖、受影响结构／接口、验证、风险与未完成标记）、`design.md`（重要取舍与依据）、`research/`（调查材料与入口摘要）；简单任务只用 task.md，不堆空文件。读取、更新、冻结与交接生命周期由核心统一接口实现，业务状态不另建第二套权威。

实施前核对：必需的目标／完成条件／规划齐备且无阻碍实施的待决项才 `task ready`（省略 id 时用主会话已落盘的选择 `--session <id>`，两者都缺拒绝为 `task_id_required`）；可选文件缺失不阻挡简单任务。task.md「待澄清」区段存在顶格 `- [blocking] ` 项时，核心以 `clarify_blocking` 拒绝 ready，消息含未决数量与前 3 条（单条截断）；无区段、空区段或只有 `[assumed]` 项放行，既有任务无需迁移。先与用户确认并折入目标与完成条件、删除已解决行后再 ready。阶段提示装配时再次读取必需资料，失败则报告sourceId与路径并终止本次执行；可选背景不可读取仍可省略。实施中进度勾选与证据追加由主会话直接更新 plan.md 或 `task record`；阶段执行器在报告中说明进度，由主会话写回，不直接改 `.knit/`。进度更新不产生草案、不使检查失效；方案中要求性内容变化等同 `task update --kind`，活动 run 期间保存为草案待终态应用。收尾核对以实际成果与验证为准，不按计划复选框判定业务完成。

每轮主会话上下文由桥接在模型调用前注入：当前任务稳定 ID 与 stage、业务摘要、待决项（「待澄清」的 `blocking`／`assumed` 计数）、待应用草案与活动运行摘要、下一步规则及资料入口；无任务时给出入口规则。注入为当前快照不叠加历史，写动作仍经核心核对授权／阶段／锁／版本；实现见任务047，规则见 DESIGN §9.6。

历史检索只在用户明确表达查历史、查上次决定／处理／修改或追溯问题的意愿时执行，不按固定关键词或任务编号判定，也不因话题相关自动检索；需求澄清期间的取证检索是例外，可主动核对既有决定、约束或冲突并须引用来源。入口为 `knit task search <query...> [--scope task|archive|run|git] [--limit n]` 或桥接 `knit_task action=search`；默认检索全部范围、最多 20 条（上限 100）。实现（任务 k-322284b57ad9）：`src/application/history-search.ts` 直接读取任务资料、`.knit/.runtime/runs/`（兼容 `.knit/runs/`）与 `git log --all --grep`，不打开元数据库、不写任务或 runtime、不建索引／缓存。命中返回 `path:line`、`run:<id>` 或 `commit:<sha>`；无匹配返回空数组并说明未找到。相关记录只代表内容或时间相关，因果结论仍须复现、对照或验证证据。

任务列表默认只回答“还有哪些活没做完／没归档”：实现（任务 k-c06c5a41092f）`knit task list` 按 进行中（`open`）／待归档（`closed` 且 outcome 非取消）／已取消（`cancelled`／`superseded`）分段，行内固定四列（优先级、ID、阶段显示名、标题），列宽按显示宽度补齐；`--archive` 按月分组列归档（`--month` 过滤），归档行给日期、ID、结论与标题，跨机历史与档案异常只在末尾汇总。`TaskService.list` 仍返回 `{active, archived}`，`task next`、依赖阻塞与父子判定不变；`--json` 默认带 `scope="active"` 与 `archivedCount`，归档数组只在 `--archive` 时返回。列表读取成本按分区记账（任务 k-3d730c8907b3）：活跃分区逐活跃 task.md 取 dev／inode／size／mtimeNs；归档分区只 stat `tasks/archive` 与各月份目录（O(月份)，不逐条 stat 归档 task.md）。归档条目、problems、父子关系与依赖归档状态随归档索引复用，指纹变化只重扫该分区；缓存命中时 `task list`／`task next` 与 `knit status` 项目概览只做月份级归档 stat。Knit 自身归档／还原／改档写 `.knit/.runtime/task-list/archive.invalidation` 显式失效标记，并与分区指纹一起参与比较；绕过 Knit 原地改写或删除已归档 task.md（不改变月份目录的直接子项）时不自动失效，正常归档后不再改内容。缓存只在进程内，不落盘。

## 5. 用量、存储与诊断

默认 `agent.resume: "prefer"` 优先由原客户端加载原生记录；旧记录无法恢复时自动新建会话，读取当前任务要求、正式规范、进度、已有执行事实与当前代码续做。先确认旧执行和工具结束，核对任务／目录及模型；不把模型不可用或未知工具状态当作换会话的理由。报告新建原因和旧来源，新会话可用后更新阶段引用；新建失败不循环创建。Task ID、阶段、修复次数和累计成果保持，由核心维护，不能接受模型自报值来重置或迁移；参见 DESIGN 第 9.4 节。

首版只观测 token、费用与耗时，不按累计 token 或固定运行总时长自动取消。主 Agent 可分步推进、利用原生上下文管理和恢复能力继续大任务；是否拆分正式任务仍按用户授权。未来主动预算停止若确有需求再设计，首版配置不提供该开关。

每个 run 只计本次新调用，使用调用／消息标识去重；恢复时读取旧历史不重新计算其消费。保存原生用量与归一口径：inputTokens 是含缓存的总输入，outputTokens 为输出，totalTokens 为两者之和；cacheReadTokens／cacheWriteTokens 为输入子集，不能再次相加。若原始 input 已含缓存则不重复加入，若分开报告则先合成总输入。无法无歧义映射时标 unknown，并保留原字段。

例如总输入 10,000、其中缓存读取 9,000、输出 1,000，累计总量是 11,000，不是 20,000。缓存与普通输入的价格不同，费用由实际计价来源另算；未知费用不作零，也不影响任务继续。显示范围为 Knit run，不把它冒充主会话或供应商账户总账。

用户取消、真实错误／阻塞、修复轮次上限和原生工具自身明确条件仍生效。锁心跳每 5 秒更新；心跳超过 30 秒只进入 doctor／locks 调查，不自动停止或强解。阶段取消先发 clear_queue／abort；实现（任务017）在 5 秒宽限后仍无稳定终态时终止本次 Pi 及完整后代进程树（工具可能另建进程组），以 `agent_aborted` 收敛并保留 `stage-process` 记录。`run cancel --terminate` 对已核实且 worker 已退出、阶段 Pi 仍存活的旧执行显式终止同一进程树；不把 RPC ack 当作已结束。

knit storage 统计 runtime、run（含快照）、原生会话、diagnostics 的字节，默认 512 MiB 提示；另列 refs/knit/bases/* 数量（HEAD 策略未实现，当前不创建基线引用，通常为 0）、关联 run 是否存在。引用可能共享 Git 对象，首版不把每个引用的可达大小相加冒充额外占用；创建时间无依据则 unknown，不用 commit 日期代替。Git 对象整体大小可单列，不能全归给 Knit。实现（任务023）：`session history` 的用量按唯一助手条目 ID 去重，input 含 cacheRead／cacheWrite，未知 token／费用返回 null；status / doctor / storage 仍只读，不自动 gc。

doctor --json 只读检查 schema、状态契约、文件／Git 回执、候选与检查、绑定、锁、快照、内部模块、初始化、安装 CLI 版本（`installation-version`：入口包版本／`installation.json` 与仓库 `package.json`、入口与本地 dist 摘要是否一致，不一致提示改用本地 dist）和容量。离线不能证明活跃原生分支时标未知，不把索引快照当当前选择。禁用外部 diff/textconv、pager 和 fsmonitor hook，不跑项目验证、桥接或自动修复；不输出环境值、原始提示词、工具输出和凭据。

status 始终显示总耗时、最近模型／工具活动距今时间与心跳。心跳、元数据和诊断事件不刷新活动时间；等待模型可能长期无输出，有输出也不证明有效进展。只提示，不做自动空转检测或超时取消。 `status --run <run-id> --json` 只读返回该运行、终态版本、来源定位和待同步事实，不接受结果或重派。桥接可用可销毁定时器观察本会话发起的 run，默认5秒，切会话／树或关闭时停止；通知前核对原上下文和原生已有通知，规则见 DESIGN 第9.3节。

元数据已选定 SQLite（Node24 内置 node:sqlite，M0 实证）。事务只覆盖内部 Session/binding/operation 更新，不跨模型、Git hooks 等等待；项目文件锁、执行占用、Git 和原生记录的核验仍保留，不维护 JSON 权威镜像。

### 5.1 提交目标与授权来源

所有会创建提交的 deliver/archive 显式给 --branch <refs/heads/...>；拒绝短名、current 或与 Task 绑定／实际分支不符的值。prepare/start、暂停恢复及 Git 写入前重核，不创建或切换分支。--branch 确认目标，不能当作人类授权证明。

桥接 Agent 声明 authorizationRef；终端代调可 --authorization-ref <ref>。来源是原生用户指令引用，或项目规则文件（如 AGENTS.md）中 Git 交付约定的路径／版本。策略生成或 Agent 自行编辑不等于用户认可；主 Agent 须确认原授权和当前约束。直接 CLI 无引用时只记录显式调用声明，不伪记身份或消息已验证；Agent 经 CLI 仍需已有授权。

实现（任务 k-28296c22647a）：桥接 `knit_deliver` 的 `user:` 引用必须是 `user:<条目 ID>` 或 `user:sha256:<正文 SHA-256 前 12–64 位>`，桥接把 `ctx.sessionManager.getSessionFile()` 经 `deliver --session-file` 交给核心；核心逐行读取该 JSONL，只认 `type: message` 且 `message.role: user` 的条目（正文为字符串或 text 块以换行拼接），按条目 ID 精确匹配或按正文摘要前缀匹配。找不到即 `authorization_unverified`（创建操作前拒绝，不动 Task／index）；找到时 `authorization` 记 `verified: true`、规范化引用 `user:<条目 ID>`、会话文件路径、条目 ID 与正文摘要。会话文件取不到时桥接拒绝用户类引用（`user:`／`native:`／`message:`／自由文本，与核心同口径）；`workflow:` 等项目策略来源不受影响。桥接对非 plan 动作不论引用写法都传 `--session-file`，因此桥接传入的 `native:x`、`message:x` 或裸自由文本同样按用户消息核对、未命中即 `authorization_unverified`，不会以 `verified: false` 被接受并误标 `cli-unverified`。直接 CLI（不带 `--session-file`）保持原口径，操作记 `invocation: cli-unverified`，交付结果与人读输出带 `caller: cli-unverified`，最终记录写“调用: cli-unverified”；桥接带会话佐证时为 `bridge`。核心只核对用户消息存在，授权语义仍由主 Agent 判断。

默认分支候选检测顺序：显式 delivery.defaultBranch 完整本地 ref；否则读取本地 refs/remotes/origin/HEAD 并映射为本地 ref；再否则 unknown。显式配置格式非法则报告配置错误，不忽略回落。无 origin 的本地仓库不猜 main/master，不联网补 HEAD。缓存可能过时，检测仅用于展示／审计，不授予权限，也不让 unknown 阻塞已明确授权的当前目标。

operation 保存实际与确认分支、默认分支候选及来源、调用者、authorizationRef、来源摘要／定位，以及已认可的策略版本。实现（任务019）：首次创建操作即固定 archivePath；工作／归档提交后核对父节点、实际路径集合、提交树模式／blob 与无关 index／worktree；hook 拒绝、改 index、扩范围或改选中内容均保留已产生的提交并 needs_attention（这些核验在 `delivery.hooks: run` 时生效；缺省 `skip` 下交付、合入与清理操作全程的 Git 命令（含 add／reset／merge --abort／branch -D）以 `-c core.hooksPath=<私有空目录>` 执行，仓库 hooks（含 post-index-change、reference-transaction）不运行，`deliver --plan` 与交付结果的 `hooks.changes` 列出自上次交付以来新增或修改的 hook，见 DESIGN §10.2）。move 已完成但检查点丢失时按目标 Task ID 与封存摘要恢复，目标冲突不覆盖；显式 retry 重核已生效提交。核心验证引用存在、版本及分支一致性；授权文本是否充分仍由主 Agent 判断，不新建授信／审批平台。来源变化先重核，已有授权覆盖则不重复询问，adopt 不附带提交许可。

实现（任务 k-c5f416d61c3d）：父子关系只写子任务 frontmatter `parent`；`task new --parent` 在创建用的 state 锁内、`task parent`／`--detach` 在任务＋state 锁内按稳定 ID 核对目标存在、未归档、未结束与成环；归档任务关系冻结，不再挂接或解除，归档父任务不接收新子任务；结构变化不使输入摘要或检查资格失效。父任务完成在任务锁内扫描直接子任务：仍有 `open` 子任务返回 `children_incomplete`，缺 `--reason` 返回 `parent_acceptance_missing`，验收说明写入完成凭据。`task list` 默认只列未归档任务并按进行中／待归档／已取消分段，行内只给优先级、稳定 ID、阶段显示名与标题；父子结束进度与逐项阻塞由 `knit status <taskId>`／`task next` 给出，归档条目用 `task list --archive` 按月查看。
实现（任务055–057）：`task close --outcome completed` 在任务锁内按 `verification` 核对当前输入、成果和完成凭据；业务完成不要求 Git 提交、回执或归档，完成凭据写 `.knit/.runtime/completions/<task-id>.json`。`deliver <id...>` 支持批量逐项处理，先以 `--plan` 只读预检业务产物／任务资料分类、已暂存业务路径及任务资料、跨任务同路径冲突；有冲突时不执行。任务资料的用户暂存内容也在服务取得占用后、创建操作与修改Task前重核；拒绝时保留index、HEAD及Task。重试仅接受当前HEAD和预期路径／blob匹配的未完成操作暂存检查点；资料部分暂存始终停止，不能借retry覆盖新改动。每个任务先提交业务产物（`Knit-Stage: artifact`），再写最终记录并单独提交任务资料（`Knit-Stage: metadata`），随后封存、移动和归档提交；多个任务不合并为整仓提交。任一项失败保留已生效提交和后续任务现场，按操作 ID 与显式 retry 继续，不重复提交。
实现（任务 k-1d796caf7d12）：`deliver` 接受 `--message-file`（单任务给路径；批量用 `<taskId>=<path>` 可重复；`--plan` 同样读取、校验并预览首行、正文行数与来源）。文案在创建操作前按 UTF-8、首行 1–72 字符、空行分隔正文、正文非空且 ≤4000 字符、总量 ≤8 KB、`Knit-` 保留键等规则校验；失败返回 `message_empty`／`message_subject_invalid`／`message_body_missing`／`message_too_long`／`message_trailer_conflict` 等稳定原因，不创建操作、不暂存、不改 Task。产物提交使用主会话文案并追加 `Knit-Task`／`Knit-Operation`／`Knit-Stage`／`Knit-Verification` trailer；无文案回落事实模板并记录 `message_source: template`。资料／归档使用确定性模板，含任务标题、结束结果、验证依据与产物／资料提交短哈希。文案按阶段持久化，重试复用已保存文本并把新文件记为 `message_ignored_on_retry`；恢复按 trailer 识别并兼容旧 `knit: <stage>` 单行格式。实现（任务 k-da9973a69c20）：`deliver` 在 `delivery.mode: "merge"` 或显式 `--merge` 时先按既有 `worktree merge` 守卫合入并转交任务资料／绑定，再执行原有产物／资料／归档提交；合入必须先于交付，因为 worktree 路由下任务资料在主检出缺席且 merge 拒绝已归档任务。`worktree.cleanup: "after-merge"` 或显式 `--cleanup` 在交付完成、授权与工作区干净时调用既有 `worktree cleanup`；清理失败保留 worktree／分支并把 `cleanup` 留在 `result.worktree.pending`，再次 `deliver` 只补清理、不重复提交。配置作为对应步骤的授权来源记录 `config:.knit/config.json@<sha256>`；无 worktree 时合入记为 `noop`。结果新增可选 `worktree.merge`／`worktree.cleanup`／`worktree.pending` 字段，旧操作记录缺省。
实现（任务 k-795f3804775e）：`task implement <id> --path <路径> --validation <验证>` 在任务＋state 短锁内记录主会话／用户实施事实（活动 run 中以 `task_busy` 拒绝）到 `.knit/.runtime/implementations/<task-id>.json`：执行者、输入摘要、成果路径指纹、实际验证与未验证项；至少一条路径和一条验证，缺任一项按 `invalid_request` 拒绝。记录只写在 `open` 任务上；`task ready`、输入更新、非等价改名或分支接管清理旧记录。成果路径或任务输入变化使 `self` 完成返回 `implementation_stale`／`inputs_not_confirmed`。`task close --outcome completed` 的 `self` 先接受当前有效的实施记录，不再要求先行到达 `deliver`；没有证据而用户明确要求时，`--force` 跳过完成资格核对，但必须给 `--reason`，凭据写 `forced`／`forcedReason`／未验证项，`independent` 拒绝 force。`deliver` 对 forced 凭据照常交付，产物与资料模板正文记录强制完成原因；`doctor` 对未归档已完成任务缺完成凭据只告警，不改业务状态。

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
实现（任务 k-802d3edc053c）：`priority`／`dependsOn`／`order` 写入 task.md frontmatter，缺省 P2、无依赖、`order=null`；三者不参与需求摘要，调整不改写输入或使检查 stale。`src/domain/schedule.ts` 提供排序、依赖阻塞与重排纯函数；`task list`／`task next` 共用同一排序与阻塞判定，优先级内已调整的按 order、未调整的按 createdAt，创建时间相同才用稳定 ID；`task list` 默认视图按该顺序分段展示、不重排，阻塞只在汇总行计数，逐项原因见 `task next`。`task ready` 与 implement 的 `run prepare` 在推进／启动前核对依赖，未满足返回 `dependency_unmet` 并列出原因；依赖自环、缺失与成环在 `task depends`／`task new --depends-on` 时拒绝。`task order` 在 state 锁内只重排目标优先级分组，`--before`／`--after` 跨级参照返回 `order_reference_priority_mismatch`；只写该分组的 order，不修改 createdAt，其它优先级与同级未涉及任务的先后不变。
