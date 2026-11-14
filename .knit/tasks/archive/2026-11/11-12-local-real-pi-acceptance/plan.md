# 本机完整自用验收执行计划

## 当前口径

- 需求权威：本任务 task.md，R1–R9 共 23 个必验场景。
- 用户原生消息 a6c7f822 已批准全权验收、最后记录结果，目录/模拟项目/是否委派 DeepSeek 均由主会话决定；核心授权核验 verified=true，正文摘要 6da4a5319904fdb3b101a6e98db5b6f716d777e12a72957a6f58762d59968ff8。不再逐批追问，不制造会话授权证据。
- 当前 Mac 27.2.1 arm64、Node 26.3.0、npm 11.16.0、Pi 1.5.2、Rex 0.1.0-preview.14/API 12；只验证 Node 26，不验证 Node 24、不据此修改 engines。
- 已普通推送的源码 HEAD：2d6801411158253beda3d5016ab0b781d12b37c8。25 笔提交实际核验，本机配置、未完成任务资料及本轮规划不导入被验源码。
- 新隔离根：/tmp/knit-self-acceptance.l9v2Ka/，realpath /private/tmp/knit-self-acceptance.l9v2Ka/。旧 /tmp/knit-macos 与旧证据不覆盖。
- 本轮优先模型 magpie / group/deepseek 已由当前 pi --list-models deepseek 确认可用；只记录名称和实际 usage，不输出密钥或复制 auth.json。10–14 次是原估算，不预填调用次数，不为排列批量调用模型。
- 当前仍是准备阶段：没有新的 npm test/build/pack/install/init、真实 GUI 复验或本任务模型 run 结果。下述包要按实际逐项更新，旧 719/739 日志不算本轮。

## 分工与单执行者

按 W2/W3，将稳定的工程脚本准备包 P0 派本正式任务 implement worker（magpie / group/deepseek）。这是本次阶段的明确子目标，不是让 worker 一次完成全部 23 场景。

**P0 worker 仅准备，不启动真实 GUI/功能模型，不提交任何 Git：**

1. 只读核对 HEAD、生产改动、实际 npm scripts；在新隔离根从指定 Git tree 导出源码并记录每个导出文件内容/mode。普通工程与 Rex 测试使用不同副本，同一 tree。
2. 在 validation/local-real-pi-acceptance-2026-11/worker/ 输出导出清单 JSON、normal-engineering.sh、rex-tests.sh 和 README.md；除该目录及已声明临时根外不写。
3. normal-engineering.sh 使用明确 Node 26 bin PATH，记录环境/TTY/时间和每步命令/退出码，执行 npm ci（副本中）、typecheck/build/test/pack:check/pack:install -- --prefix 新根内 install-prefix；原始日志只写新隔离根，主会话后续脱敏汇总。
4. rex-tests.sh 使用第二份等价源码与 Node 26，同样记录时间/TTY/实际 Rex 定位、npm ci/npm test 的退出码和日志；不得通过写假 REX_* 创建环境，不依赖旧日志。
5. 语法检查 shell 脚本；可用最小无副作用自检，但不得执行全套工程测试/安装或 GUI 操作。记录准备结果、命令、摘要、局限；未实际执行的 npm 测试/GUI/模型场景保持 not_verified。
6. 不改生产 src/assets/test/package/config/.knit/standards/workflow/prompts，不改受保护运行/完成/check 数据，不使用 Pi SDK/RpcClient、不补模型鉴权运行时，不帮忙修发现的生产缺陷。
7. 在阶段报告中说明：P0 准备完成 ≠ 本任务完成。changedPaths 只列真实 worker 产物；validation 仅列实际执行的准备/语法检查。其余 A1–A8 由主会话接收该包并确认 worker 停止后实施。

主会话可在 worker 运行时做不改变其目标或实施文件的只读取证；不并行写本任务产物，不在活动 run 中偷偷改 task.md。worker 文件接收后保持原样，主会话另写 main/。

## A0 — 基线、工具与授权

- 核验真实原生授权、实际活动执行、HEAD/index、源码树、配置排除指纹、工具版本与模型名称。
- 保存 UTC/本地时间、Node real execPath、CLI 来源、包/tarball/build/template 指纹；不能只根据路径宣称真实可用。
- 接收 P0 后核对导出全部内容/mode、脚本只作用于新根、Node 26 和临时 prefix、不含假测试结果。
- 旧场景任务资格与 macOS 收口 needs_attention 保留，不因此对当前工作区 reset/stash/强制归档或改 checkpoint。

## A1 — 实际普通 Terminal 与 Rex 工程校验（R1）

- 主会话创建并只控制新的普通 macOS Terminal 验收窗口，以及新的 Rex 验收 session/tab/block。
- 在两种实际终端运行已核对脚本，分别记录窗口/块定位、命令/退出码/全套测试数/日志/实际画面或工具证据。
- 当前没有 npm run validate：按现存 typecheck/build/test/pack:check/pack:install 执行，不新增脚本；pack:install 必须传临时 --prefix，因为默认会真实全局安装。
- Bash 或 unset REX_* 不冒充实际普通 GUI Terminal；终端/截图权限不足如实 blocked/not_verified，不关闭/改写旧用户终端或全局设置。
- 同一源码 tree 的不同副本避免构建/测试交叉；本轮两份测试均需实际退出码、计数和原始日志。

## A2 — 安装、init、任务/配置（R2/R3）

- 用新 prefix 里的安装 CLI 在仓库外查询版本/init/doctor，核对安装凭据、桥接解析及包白名单。
- 创建带空格/中文和用户 AGENTS.md 的新项目，验证 init 重跑/--check/受管块人工差异保留与显式 --force 备份；init 不启动模型、不装依赖、不提交 Git、不伪造信任批准。
- 先做纯 CLI 准备门、record、clarify/change/pending、身份/依赖/排序/workflow/standards；活动 runId/stale_input 用 A3 的真实 run 复用，不能以纯伪造回执替代。
- 配置/规范变更仅在功能夹具内，当前项目硬保护资料不改。

## A3 — 真实 Pi 与独立检查闭环（R4）

- 从实际安装 CLI start，在新真实 Pi 主会话按宿主实际信任机制加载桥接并观察 /reload、普通讨论、不建/建任务、use/clear 后上下文。
- Agent 自动输入的验收提示注明是测试输入，不能伪称真人长期授权；Git 权限只引用本会话真实 a6c7f822。
- 一个极小独立验收任务实际 implement→receive→independent check→receive，核对模型/run/native/usage/产物/合法阶段。
- 复用 run 查询状态/session/history/doctor/storage/usage 和重复接收；未知用量不填零、只读查询不增加轮次或推进。

## A4 — 通知与真实 Rex 呈现（R5）

- 同一真实会话观察 idle/busy 被动进度/成功/取消通知、去重、reload/恢复重现；核对 native knit.notice 和后续真实模型上下文/轮次。
- 可控真实需处理负例观察 followUp/triggerTurn 与去重；主动查询不补成功通知。
- 观察 Rex auto、普通 local/auto fallback 的新运行呈现、展开/收起与终态；不是替身 renderer 探针，不控制已有用户/Agent 终端。

## A5 — 取消、原生恢复与快照（R6）

- 取消自有 run 后核实执行者/PID/终态和原生文件已落盘，再按持续授权 resume；记录旧/新 run/source/scope/阶段/修复计数。
- 仅在夹具可逆停放其自己的 native 记录，观察 prefer 沿原客户端新会话续做，结束后恢复备份；不移动用户全局 Pi 会话/auth。
- 真实 snapshot show、无/错/对 expect、index/remove-created；只恢复选中夹具路径，当前 Knit 工作区不恢复/删除。

## A6 — 默认 Worktree、调度和路径移动（R7）

- 极小任务 worktree on，核对创建/交接/准备命令、projectId/taskId/branch/binding/executionRoot 和主检出/工作树一致路由。
- 两个互不重叠小任务，最多 2 个并行阶段推进至交付前；不自动提交/合入/清理。
- 全部自有执行结束后可逆移动夹具，repair 预检只读，再按明确持续授权 apply；记录可证关联与拒绝，不移动当前 repo 或扩展 OS/文件系统认证。
- 更广排列只以本轮自动回归覆盖，不额外批量调真实模型。

## A7 — 隔离 Git 交付/合入/归档（R8）

- 只在新隔离 Git 仓库提交初始夹具、设置本地 fixture identity。当前仓库不提交本轮证据、不 push、不发布部署。
- 完整 refs/heads/...、可交付凭据、HEAD/index 和无关哨兵；预检只读、无/错/非本会话授权须在副作用前拒绝。
- 有效 Agent 权限引用真实 user:a6c7f822 与当前原生 sessionFile；不补造 JSONL/user/check/completion，不把 cli_unverified 标作 verified。
- 主会话展示一次本包实际产物提交文案，再本地正常 deliver，逐任务成果/资料/归档历史分开核对；克隆副本 rebind 不继承旧本机完成资格。
- 文件控制例与带尾斜杠目录选择例各在新夹具独立运行一次，核验 expectedPaths/expectedTree、实际 commit tree、operation 及原文件。已知 selectedPath 尾 slash 缺陷若重现即 R8.S2 fail，不改 checkpoint 或用叶粒度逃避合法目录测试。
- Worktree merge/cleanup 先 plan 再 apply，核对 dirty/未保全资料拒绝、默认留分支与 Session 引用保全；绝不 force 或移除未合入脏改动。

## A8 — 逐场景矩阵与最终结论（R9）

- 保存每场景 pass/fail/blocked/not_verified、时间、操作、环境/包 SHA、命令/退出码、真实 run/native/session/usage/接收、图片/终端真实性与原始证据位置。
- worker 不覆盖、main/ 分开汇总；敏感信息不得入库，原始日志保留在新临时根，报告引用必要脱敏摘要。
- 全部必验 pass 才正常记录实施/关闭；任一 fail/blocked/not_verified 留任务未完成和阻塞说明。报告生成/阶段 completed/旧日志不等于本机通过。
- 业务完成、后续当前项目成果提交/资料提交/归档分别处理；本轮没有新的当前项目 Git 操作授权。

## 停止与恢复

- 真实权限/界面/模型不可用时记录证据和受影响场景，已授权且独立的其它场景可继续，不擅自改全局权限/鉴权运行时。
- 发现生产缺陷或守卫拒绝不自动修源码、改凭据、强制结束；隔离夹具原文件恢复并保留 operation/source。需要产品修复再单独确认。
- worker 未结束不接手；恢复只在旧执行者确认停止后做，不忙轮询，不虚构被接受结果。

## 第二轮（2026-11-14，主会话 01a1d51b）

依据用户消息 `387707d9`：两处偶发测试失败已修（k-0893a9b03544，`039bd19`），R5 已改为现行通知分流规则，按当前代码重做全部 23 个场景。第一轮各包（A1–A8）的做法与守卫沿用，下面只写与第一轮不同之处。

- 基线：本地 main `2a2f6a0`；新隔离根 `mktemp -d /tmp/knit-self-acceptance2.XXXXXX`；第一轮隔离根与夹具不动。
- 执行者：全部由主会话执行，不再派准备包 worker；worker/ 下的工程脚本原样复用，经 `KNIT_FROZEN_TREE`／`KNIT_ISO_ROOT`／`KNIT_EXPORT_BASELINE` 指向新基线，新基线清单放 round2/。
- 终端：普通 Terminal.app 新窗口与新的 Rex 会话都由主会话创建，只控制这两处；用户已打开 Rex Remote Control，目视项用 Rex 客户端动作与截图取证，客户端拒绝时原样记录并判 blocked。
- 真实 Pi：在新的验收终端里用安装前缀内的 CLI 启动；Agent 代输的提示注明是验收输入，不冒充真人授权。
- R5：
  - 被动：`knit_run` 带 wait 返回终态后观察只展示的条目，再 /reload 看重现。
  - 唤醒：`knit_run` 不带 wait 派发，完成并接收后观察 follow-up 消息与新轮次；另做一个取消或失败负例。
  - 证据取原生会话 JSONL（条目类型、有无新增 assistant 轮次）加终端画面。
- R7／R8：新夹具上重做 worktree 创建、调度、close、merge／cleanup，以及文件控制例与尾斜杠目录例的交付。
- 授权引用：夹具 Git 操作用本会话 `user:387707d9`；真实 Pi 验收会话内由 Agent 代输的消息不作为授权来源。
- 证据：第二轮文件统一放 `validation/local-real-pi-acceptance-2026-11/round2/`，第一轮 main/、worker/ 不改写；最终矩阵与报告为 `round2/REPORT.md`。
- 收尾：23 个场景全部 pass 才 `task implement` 登记并 close；否则保持 open 并写明未过项。


## 第三轮（2026-11-14，补齐 Worktree 主检出查询后）

第二轮保留 22 pass / R7.S1 fail 的原报告，不将失败覆盖成通过。独立修复任务 k-3a7f2483b0d8 已以 21a2b92 / 3cfac13 / ff31889 正常本地交付归档；DeepSeek run-4844d766c52b pass（12 场景、14 路径），最终普通 Terminal 与 Rex 各 npm test 798/798。

- 本轮基线：main ff318899a985ea2ba14f1619aa94479a40ce7298。使用新隔离根 /tmp/knit-self-acceptance3.kFgIO0；源码导出、两份工程副本、安装前缀、功能夹具均新建。
- 完成条件沿用全部 23 个场景；只澄清补修后的源码基线和证据位置。task update --kind clarify 已确认摘要 c6bf1e67a9f6，阶段保持 implement、context ready=true；无需重复 task ready 或回退阶段。
- 工程脚本仍原样复用 worker/ 下的 normal-engineering.sh、rex-tests.sh、export-check.mjs；通过 KNIT_FROZEN_TREE/KNIT_ISO_ROOT/KNIT_EXPORT_BASELINE 指向新提交与 round3/export-manifest.json。
- 只控制本轮新建的普通 Terminal 和 Rex 标签/块，真实 Pi 的 session-only 信任与 Agent 代输验收输入沿用同一授权边界。真实 stage 模型仍 magpie/group/deepseek。
- 原生缺失恢复时，在旧执行停止后通过公开 task record 写明实际取消与停放事实，避免新会话无法得知外层恢复而重复等待；不改输入、请求、凭据或 checkpoint。
- Worktree 夹具预先提交 /.knit/worktrees/ ignore 规则，避免创建第一个 Worktree 后的自动 ignore 文件阻挡第二个。两任务调度后核对实际并发事实；主检出真实 Pi 必须 use/context 成功且下一轮上下文来自实际 Worktree。
- 脚本准备辅助工具 /tmp/knit-accept3/stage-fixtures.py 只向新隔离根复制第二轮已实际执行过的辅助脚本并替换新前缀/指纹；每个新 taskId/runId/native ID 必须取自本轮结果，不能复用旧值。
- 本轮报告与证据放 validation/local-real-pi-acceptance-2026-11/round3/，不改第一轮 main/、worker/ 与第二轮 round2/。
- 本轮验证期间当前仓库不新增提交；全部必验 pass 才正常登记实施/关闭；提交、归档、推送按用户实际授权分别处理。
