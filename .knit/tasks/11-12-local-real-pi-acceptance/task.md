---
id: k-b9019179b424
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-12T12:15:10.822Z
title: 本机真实 Pi 验收：当前环境，逐项授权
---

# 本机真实 Pi 验收：当前环境，逐项授权

## 目标

在用户当前这台 Mac、当前安装的 Node 26 与当前 Pi/Rex 环境上，对当前 main 源码（基线见范围与边界）做一轮全新的本机完整自用验收。工程校验、安装初始化、任务管理、真实阶段闭环、通知、取消恢复、Worktree/调度、隔离 Git 交付与最终报告均要有可追溯证据；不是公共发布资格或跨平台认证。

用户原生消息 `a6c7f822` 已明确授权全权选择合适方式完成本任务、最后记录结果，并自行决定其它目录、模拟项目及是否委派 DeepSeek。R1–R9/23 场景的真实终端、模型、安装联网及隔离 Git 操作均在该持续授权内，不再逐批追问。注册名沿用初始名称，授权口径以本版为准；创建不冒充批准，批准来自真实用户消息。

第二轮（2026-11-14）已在基线 `2a2f6a0` 重做全部 23 场景，结果为 22 pass、R7.S1 fail；报告保留在 round2/，不改写为通过。失败是主检出无法按绑定查找已 handoff 的 Worktree 任务，真实主桥接 use/context 均报任务不存在。已按持续收口授权单独修复（k-3a7f2483b0d8，产物 `21a2b92`），正式 DeepSeek 检查 `run-4844d766c52b` pass（12 场景、14 路径）；最终源码在两个真实终端各 npm test 798/798。

第三轮沿用全部 23 个完成条件，按包含此修复的新基线重新验收。第一、二轮只保留历史证据；本轮结果和基线放 round3/，不预填旧结果。R5 已获用户消息 `387707d9` 同意采用现行通知分流规则，保持本版不变。

## 范围与边界

- 只验证当前 Mac 与 Node 26：本轮开始前重新采集 macOS、Node、npm、Pi、Rex 的实际版本并记入基线，以实测为准。Node 24 不属必验、延期或本机通过阻塞项，也不宣称验证它，不改 package engines。
- 不验证其它机器、其它 Node 主版本/Linux/Windows、不建设多模型矩阵、不公开 publish/deploy、不操作真实远端项目。当前源码、模型/Node 配置与用户已有终端不修改。
- 真实 provider/model 只用本机已认证的选择；当前 `pi --list-models deepseek` 确认 `magpie / group/deepseek` 可用，本轮优先用它。主会话在持续授权内自主选择并记录实际模型，绝不读取/复制/输出密钥或伪造 token/usage。
- 第三轮使用新的隔离根 `/tmp/knit-self-acceptance3.kFgIO0`，分源码导出、普通/Rex 构建副本、安装前缀与功能 Git 项目。第一、二轮隔离根和夹具保留不动；不配置全局 Git 身份；`pack:install` 必须显式 `--prefix` 新根内目录，不使用真实全局默认位置。
- 同一 Git tree 的独立导出供两个实际新终端执行：普通 Terminal 与 Rex 分开留命令/退出码/测试数/日志和终端真实性证据；宿主 bash/清除 REX 变量不冒充普通 GUI Terminal，也不以替身 renderer 代替 Pi/Rex 实际画面。
- 第三轮基线为本地 main 的 `ff318899a985ea2ba14f1619aa94479a40ce7298`（修复产物 `21a2b92`，资料 `3cfac13`，归档 `ff31889`）。`origin/main` 仍为 `f68c6c3`，其后 6 个本地提交尚未推送。验收期间当前仓库不新增提交；本机 config 与未完成任务资料不进入 `git archive` 源码导出。测试总数以本轮实际日志为准，历史 719/739/782/798 均不是本轮结果。
- 第一轮记录的阻塞已处理：旧场景任务 k-185ace3b9556 与 macOS 收口操作 op-d2b8f5b40d91 已走公开命令恢复并归档；尾斜杠目录交付、worktree 内 task close／task implement 路由、策略恢复随重试已在 `e717f95`、`46bd914` 修复。本轮在新夹具上重新验证这些行为，不改第一轮夹具的凭据或 checkpoint，不 force。
- 外层 verification=self 沿用；真实闭环中 independent 的夹具任务必须由正式独立检查上下文验证，不能用主会话/--scope 绕过。发现生产问题只记证据、单独确认修复范围；修代码后受影响场景另建新基线结果。
- 第一轮正式准备包 worker 已结束并接收，worker/ 工程脚本和导出核对器沿用不改。第三轮由主会话直接执行真实终端、Pi/Rex 与模型/恢复/Worktree/Git；一次一个执行者，不与其它执行者并行改本任务产物。
- fail/blocked/not_verified 如实留在逐场景矩阵；全部必验 pass 才可正常实施记录/关闭。权限、界面、模型缺口不以日志文本、旧 todo、替身 hook 或编译结果冒充通过。全部通过后，本任务资料与 validation/ 证据的本地提交和归档按用户消息 `9698c2d8` 的收口授权处理；推送另行确认。未通过时不提交、不归档。

## 影响路径

- validation/local-real-pi-acceptance-2026-11/**：本轮脱敏报告/矩阵/摘要证据；worker/ 和 main/ 分开，已验 worker 文件不由主会话改写。
- 本任务 task.md/plan.md/research/ 经 Knit 接口管理；隔离根内的源码、.knit/、Git/Worktree 只作夹具，不作为当前仓库产品实现。
- 不包含当前仓库 src/、assets/、受管配置、全局环境或其它真实项目。

## 完成条件

下列 23 个场景已获本次全权验收授权，是本轮必验条件；各自记录真实结果与证据，不以阶段包完成替代全任务通过。

### Requirement: 当前 Mac 与 Node 26 的可复核基线

#### Scenario: 冻结本机源码与运行环境
- GIVEN 影响基线的实现/检查已结束，待验源码包含用户希望验收的补修结果
- WHEN 记录 Mac/架构、Node/npm/Pi/Rex、CLI 实际入口、Git HEAD 与未提交改动指纹、源码/构建/安装包指纹
- THEN 形成可复核的唯一执行基线，真实终端与安装 CLI 使用本机 Node 26
- AND 不要求 Node 24，不把旧验收证据标成本轮通过，也不修改当前项目 Git 历史

#### Scenario: 普通终端与 Rex 的完整工程校验
- GIVEN 两个经授权的新验收终端使用同一冻结基线和 Node 26，构建/测试不与其他执行者交叉写入
- WHEN 在新的普通 Terminal 实际执行 npm run typecheck、npm run build、npm test、npm run pack:check 和显式临时 --prefix 的 npm run pack:install，并在新的 Rex 验收终端另行执行一次 npm test
- THEN typecheck、build、完整测试、pack:check、pack:install 全部实际通过，两次 npm test 均有命令、退出码、测试总数和日志证据
- AND 以本轮实际测试总数为准，不预填任何历史数字，不把宿主 shell 冒充已目视操作的 GUI 终端

### Requirement: 隔离安装与初始化可用于个人项目

#### Scenario: 当前产物的独立安装入口
- GIVEN 由冻结源码生成的本地 tarball 和经授权的独立临时安装前缀
- WHEN 从 tarball 安装并用安装出的 knit 在仓库外查询版本、初始化项目和执行 doctor
- THEN 安装 CLI、安装凭据与生成桥接解析到待验产物，Node 为本机 26，必要的包文件均包含
- AND 不要求系统 PATH 中预先存在 knit，不安装 Node 24，不覆盖用户全局安装，不执行 npm publish

#### Scenario: 初始化与重跑保留用户规则
- GIVEN 含空格/中文路径、已有用户 AGENTS.md 内容的隔离项目
- WHEN 使用 init、重复 init、init --check，并在受管块有人工差异时核对默认保留与显式 --force 的备份行为
- THEN init 本身不启动 Pi/模型、不安装依赖、不提交 Git，用户非受管规则保留，只读预检不写文件，差异与备份可追溯
- AND 生成桥接与 CLI 入口、workflow、标准索引可用，未伪造信任批准

### Requirement: 任务输入、业务顺序与配置规则不失真

#### Scenario: 任务准备门与场景验收
- GIVEN 隔离项目中新建的候选任务，包含 blocking 或不满足场景格式的 independent 完成条件
- WHEN 分别尝试 ready、补全 GIVEN/WHEN/THEN 场景并经明确确认后再次 ready
- THEN 未解决 blocking/无效场景被拒绝，确认后的任务按实际输入摘要进入合法阶段，成功确认不以创建任务代替

#### Scenario: 输入更新、记录与稳定身份
- GIVEN 具有输入摘要和记录的隔离任务，并有可复用的自有活动 run
- WHEN 分别执行 record、clarify/change、pending 草案和重命名；活动 run 更新输入时验证 runId 守卫及 stale_input 收尾
- THEN 记录不冒充需求变更，pending 不提前生效，改名不更换稳定 taskId，未声明活动 run 的更新被拒绝，过期输入不冒充有效成果
- AND 在复用的真实 run 上验证关键 stale_input/保留成果行为；更广的冲突组合以本轮自动化回归证据覆盖

#### Scenario: 依赖顺序、工作流与规范资料
- GIVEN 隔离项目有多个任务、明确影响路径、依赖/优先级与候选规范
- WHEN 验证 list/search、parent/priority/depends/order/next、workflow validate/context，以及候选规范审阅/采纳
- THEN 就绪与执行顺序遵循依赖和稳定业务排序，工作流无效配置被明确拒绝，规范采纳可追溯，活动/归档查询不混淆
- AND 此类配置变更只发生在隔离项目，不让 worker 写当前仓库硬保护资料，也不把日志升级为业务权威

### Requirement: 当前真实 Pi 的日常闭环成立

#### Scenario: 信任、桥接、任务选择与主会话上下文
- GIVEN 已授权启动的新 Pi 主会话使用待验安装产物，项目按宿主实际信任规则加载桥接
- WHEN 在真实交互中观察 start、/reload、普通讨论/明确不建任务/明确建任务，以及 task use/clear 后的下一轮上下文
- THEN 桥接成功加载；是否建任务由用户选择，同一事项明确不建不重复追问；选择/清除任务后的上下文与实际任务一致，不重复堆叠或误用旧任务
- AND 非交互 --approve、替身 hook 或单纯编译结果不替代真实交互证据

#### Scenario: 实现、接收与独立检查闭环
- GIVEN 有明确验收场景的极小隔离任务及本次持续授权覆盖且已确认可用的模型
- WHEN 执行真实 implement、核实实际接收、在独立上下文 check 并核实检查接收
- THEN 真实请求使用选定模型，产生 run/agent/session/usage/产物，实际改动满足场景，独立检查有来源与结果，任务合法推进至交付前状态
- AND 主会话汇总成果，状态查询或 --wait 本身不被当作接收凭据，也不自动提交/交付

#### Scenario: 只读观察与重复接收
- GIVEN 可复用的真实 run、会话记录与接收结果
- WHEN 通过桥接/CLI 查询 status、session/history、doctor/storage/usage 并重复查询和接收已处理结果
- THEN 查询不增加模型轮次、不改变业务状态或凭据，重复接收不重复推进，累计用量按实际观测统计，未知值不伪填为零
- AND 日志不包含认证秘密，来源不明改动不会无条件混入任务 scope

### Requirement: 通知按现行分流规则投递，Rex 展示真实可用

#### Scenario: 被动通知只展示并可重现
- GIVEN 真实 Pi 主会话里有一个完成且结果已接收、属于被动范围的 run：`knit_run` 带 `wait` 且工具结果已返回终态，或首次观察时已收尾
- WHEN 观察器扫描到该 run，之后再次扫描，并执行 /reload 或续接后查看会话记录
- THEN 通知以带展示文案的 knit.notice custom entry 可见，只出现一次，reload／续接后可重现；它不作为消息进入后续 LLM 上下文，也不因此新开模型轮次
- AND 有真实 GUI 画面、原生会话记录与轮次证据，不仅依赖 entry renderer 的替身测试；两种被动来源至少实测一种，实测的是哪一种写入矩阵

#### Scenario: 跟踪中的完成与需处理通知唤醒主会话
- GIVEN 同一真实会话经 `knit_run` 派发且不等待、因而处于跟踪中的 run，以及一个可控的需处理负例（失败、取消或结果待接收）
- WHEN 跟踪中的 run 完成且结果已被接收；另行观察需处理负例；之后重复扫描并主动查询 status/session
- THEN 两类通知都以 follow-up 消息进入上下文并各唤醒主 Agent 一次；完成通知写明结果已接收并给出任务级下一步；重复扫描不重复投递，去重条目不渲染第二张卡片，主动只读查询不补写通知或触发轮次
- AND 桥接只把下一步交给主 Agent，不代为派发下一阶段；分类以 DESIGN §9.3 现行规则为准（失败、取消、结果待接收，以及本会话跟踪中的 run 完成且已接收）

#### Scenario: Rex 与普通终端的运行呈现
- GIVEN 仅控制用户批准的新验收标签/块，真实 Rex 可用，普通终端不伪造 Rex 环境
- WHEN 在 Rex 的 auto 呈现和普通终端的 local/auto 回退各观察一轮真实阶段执行，并查看展开/收起及终态
- THEN Rex 新建独立运行呈现并可目视观察，普通终端按本地执行工作，presentation 的请求/选择/回退原因与真实环境一致
- AND Rex 不可用、显式 local、连接失败等更广组合有本轮自动化证据，不关闭或控制已有用户/Agent 终端

### Requirement: 取消、原生恢复与快照恢复可控

#### Scenario: 自有 run 取消与可用原生记录续接
- GIVEN 隔离 run 正在执行且自己的 Pi 原生文件已实际落盘
- WHEN 取消该 run，确认它的执行者/进程已结束，在本次持续授权内明确记录恢复调用后 resume
- THEN 只停止该 run，scope/阶段/修复次数和来源记录不重置，新 run 使用实际可用的原生记录恢复，任务继续到正确阶段
- AND 记录 pid/终态、旧/新 runId、nativeAvailable/文件证据，不因为路径字符串存在就宣称可恢复

#### Scenario: prefer 下原生不可用自动新会话续做
- GIVEN 已结束的隔离 run，原生记录在仅该夹具范围内可逆地变为不可用并保留备份
- WHEN 在原客户端以 prefer 恢复策略、在本次持续授权内明确记录恢复调用后 resume
- THEN 自动新会话读取任务资料续做，保留恢复来源且不重置阶段/修复次数/scope；不可用原因与实际采用方式有证据
- AND 不移动/删除用户全局 Pi 会话或密钥，不在旧执行者仍活跃时制造恢复冲突

#### Scenario: 快照逐路径恢复有指纹与删除守卫
- GIVEN 真实 run 的实施快照和仅在隔离夹具中的修改/新建/已暂存文件
- WHEN 先 show/预览，再分别使用错误和正确 expect 指纹，以及显式 index/remove-created 参数
- THEN 无 expect/错误 expect 不执行恢复，正确授权只恢复选定路径，index 与后来新建路径按显式参数处理，未选路径和其他改动保留
- AND 不对当前 Knit 工作区执行恢复或删除操作

### Requirement: 本机默认 Worktree 与调度链路成立

#### Scenario: 创建、交接与执行路由
- GIVEN 新隔离主检出具有稳定项目身份，任务明确授权 worktree on，初始化/依赖准备命令经过核对
- WHEN 创建/自动准备任务 Worktree 并执行真实阶段，从主检出与 Worktree 分别查询同一 taskId
- THEN Git 关联、任务资料交接、branch/binding、CLI/桥接路由与实际 executionRoot 一致，允许路径交接且保护资料不被夹带，主检出与 Worktree 不产生两个执行者
- AND 使用本机实际空格/中文路径，不扩展为其他文件系统或其他操作系统认证

#### Scenario: 两个极小任务的调度冒烟
- GIVEN 隔离项目有两个互不重叠影响路径的就绪任务，授权最多两个并行阶段，未授权自动提交/合入
- WHEN 执行 Worktree schedule 并观察计算、派发、接收与检查推进
- THEN 在上限内推进到可交付前状态，稳定顺序和接收事实可复核，不自动执行未经授权的提交/合入/清理
- AND 重叠路径、未知影响、接收串行及中断等更广排列有本轮自动化证据，不为排列额外批量调用真实模型

#### Scenario: 本机路径移动与修复不换身份
- GIVEN 所有自有执行均已结束，隔离项目/Worktree/session 定位有已记录基线
- WHEN 在本机可逆移动自有夹具，先执行 worktree repair 预检，再明确执行 apply，并核对路径别名/中文/空格情况
- THEN 只读预检不写绑定，可证明的 Git/身份关联被正确修复，taskId/projectId/session 来源不变，无法证明的关联明确拒绝
- AND 不移动当前真实 Knit 仓库，不制造 APFS/Linux 等未实际验证的跨文件系统结论

### Requirement: Git 交付、合入与归档严格遵守授权

#### Scenario: 只读交付计划与无效授权守卫
- GIVEN 已完成且可交付的隔离任务、完整 refs/heads/... 目标和提交前 HEAD/index 基线
- WHEN 执行 deliver --plan / worktree merge 预检，并在隔离夹具中验证缺失、错误或非本会话授权
- THEN 预检不提交/合入/归档，无效 Agent 授权在副作用前被拒绝，合法性以本会话真实原生用户消息及本机完成凭据核对
- AND 不伪造 user 引用或会话文件，不把 cli_unverified 当成 verified

#### Scenario: 真实隔离交付与任务历史
- GIVEN 本次持续授权已明确包含夹具 Git 操作，成果和任务资料可分别提交，有与 scope 无关的可保留哨兵改动
- WHEN 先展示一次产物提交文案，再执行一次本地 deliver，核对提交树、接收/封存记录及活动/归档/历史查询，并在隔离副本核对 rebind
- THEN 成果与任务资料分开、逐任务历史保留，未授权/无关改动不混入提交；归档与业务完成各有实际证据，clone 后不把旧本机检查/完成资格当成新机凭据
- AND 不提交当前 Knit 工作区、不配置全局 Git 身份、不 push；未经新授权不 force close 或重复失败操作
- AND 新隔离文件控制例和带尾斜杠目录选择例各测试一次；合法目录选择同样应满足提交守卫，失败保留 operation/树指纹并使本场景判 fail，不以文件控制例通过掩盖目录缺陷

#### Scenario: Worktree 合入与清理保全资料
- GIVEN 自有 Worktree 执行已结束、任务符合合入/清理守卫，主检出当前分支与完整目标一致
- WHEN 分别预检并经明确授权 worktree merge --apply / cleanup --apply，核对 dirty 目标或未保全资料时的拒绝
- THEN 合入/任务资料/branch/binding 交回目标，清理前任务资料及 Session 引用保全，默认保留分支，无授权不删除未合入分支/脏改动
- AND 只作用于夹具，结束后仍能读取所需历史/原生恢复来源，不把真实终端关闭等同于 run 结束

### Requirement: 证据完整才能宣布本机验收完成

#### Scenario: 场景矩阵与业务收尾
- GIVEN R1–R8 的本轮实际结果、模型用量、权限记录与经脱敏证据均已核对
- WHEN 汇总环境/产物指纹、R编号场景矩阵、命令/退出码、run/session/接收来源、已知问题和边界
- THEN 必验场景全部 pass 才能宣布当前这台 Mac + Node 26 本机自用验收通过；fail/blocked/not_verified 不改名为通过，发现问题时保留证据并按新基线复验
- AND 最终报告落在 validation/local-real-pi-acceptance-2026-11/；正式 worker 路径按实际接收凭据收尾，主会话直接实施路径才用 task implement 记录实施/验证，再正常 close；不产生虚假完成，验收期间当前项目不新增提交，通过后的本地提交/归档按范围与边界的授权口径处理

## 授权与执行安排

- 第一轮授权 `user:a6c7f822`（正文 SHA-256 `6da4a5319904fdb3b101a6e98db5b6f716d777e12a72957a6f58762d59968ff8`）来自原执行会话 01a1d060。后续各轮由主会话 01a1d51b 执行，夹具 Git 操作的授权引用用本会话真实用户消息 `387707d9`（决定重做验收）与 `9698c2d8`（收口授权），由核心 resolveAuthorization 从本会话原生记录核验；不补造用户消息/原生会话/完成/检查凭据。
- 实际优先模型为 `magpie / group/deepseek`；主会话只用代表性闭环并如实计实际 run/session/usage，不为排列批量调模型或无限修复。
- 仓库不存在 validate 脚本；R1 的同等工程目的改用实际存在的 typecheck/build/test/pack:check/pack:install --prefix，不新增脚本、不改 engines/模型配置。第一轮 worker 准备的工程脚本原样复用，用 `KNIT_FROZEN_TREE`、`KNIT_ISO_ROOT`、`KNIT_EXPORT_BASELINE` 指向第二轮基线与新隔离根；第三轮的基线清单与证据由主会话放在 round3/，不改写 worker/、第一轮 main/ 与第二轮 round2/ 文件。
- 详细分工、终端命令、夹具与证据收口见本任务 plan.md（第二轮安排在其末尾）。必验失败/缺口时保留阻塞和结果，不强制 close。


## 记录

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

已从原生用户 a6c7f822 核验完整持续授权 verified=true；R1–R9/23 必验保持，原 1 blocking/2 assumed 已正式澄清。固定 2d68014 源码、Mac27.2.1/Node26.3.0 与新根 /tmp/knit-self-acceptance.l9v2Ka，实际优先 magpie/group/deepseek。先正式 P0 worker 准备导出/工程脚本，结束接收后主会话做真实 Terminal/Pi/Rex/模型/恢复/Worktree/Git。尚无本轮工程或真机通过结果。

P0 run-8d8e0996ecbf 执行者已停止，正式 accept-7a8146026879 implementation_accepted；manifest 因 bash 生成需明确 include，主会话逐817个 Git blob/mode/size核对与2d68014一致、总摘要4ab40c37…一致后正常接收。只有准备/语法/导出自检完成，23必验尚未通过；self自动stage deliver不等于业务完成。将用Node26.3.0在新普通Terminal和新Rex真正执行脚本，保持worker产物不变。

本轮实际工程：普通Terminal窗口19728 /dev/ttys007 Node26.3.0，739 tests/738 pass/1 fail；Rex新session01a1d131… /dev/ttys008 Node26.3.0，739/737/2 fail。均ENOTEMPTY清理负例（观察器节拍，Rex另含cli_version诊断），不自动修源码；typecheck/build/pack:check/临时prefix安装通过，tgz SHA6ade10…817导出fptr一致。Rex Remote Control关闭拒绝GUI选择，未开启或绕过，R5目视项保持未验证。安装init/check只读/用户规则保留/default差异保留/force资料备份实测；备份路径核对另记（原helper把absolute backup join错，非产品缺失）。真实Pi窗口19738观察真实信任弹窗，选择session-only、reload、普通问答4；Agent模拟输入不是新增真人授权。极小fixture k-18bcd5aa9c11 implement run-1a8b42c28c1b/check run-f1a06ddddf91 均真实magpie/group/deepseek、native落盘、正常接收，19字节hello通过；正常close forced=false、三提交60f7ca5/a63df68/0671319归档，real user:a6c7f822 verified=true，sentinel保留。另新目录fixture k-54b1f0abce9f 用evidence/合法尾slash自有两文件，正常self实现与close，deliver op-7b7dd61d7dba 重现hook_changed_selected：成果f72cd78已实际写入两叶文件，资料/归档null，未改checkpoint/force/重试。R1.S2及R8.S2当前fail，全任务仍未完成；其余未执行/未目视如实继续，不用旧719/739覆盖。

继续执行：新cancel300夹具 k-3810e59ca5e0/run-71173384afd7 真实running→cancelled，stage Pi与worker均exited、native ffe4329e…实际落盘；正常resume准备run-3e011db7d0ee并启动，恢复沿同一真实native session，首工具write cancel-recovered.txt，10字节recovered换行、正常接收，来源/阶段/scope未重置。早前slow45 run-1cff8852ec0a未及时取消，仅作真实被动knit.notice GUI/idle证据，不伪称取消覆盖。snapshot真实原快照预览/错误expect守卫正确；初helper误用裸SHA（非产品失败），按preview完整file:hash:mode指纹后restore/index及显式remove-created均成功，未选文件保留，index最终空。R7自有中文/空格Worktree创建/交接/路由/实际执行：k-c54ad46f83b7/runa231d1f9762a(one.txt)、k-5973fe1927c2/run513382f12249(two.txt)已真实正常接收并推进deliver；初config模型应combined magpie/group/deepseek、影响声明应plan.md，unknown provider/group、unknown_impact、dirty_source均为夹具配置/守卫真实结果，明确修正而不修源码。两任务close在各worktree被implementation_stale拒绝，merge/cleanup预检blocked_task_open；资格根因尚需只读核对，不force/改凭据/以已接收认定可交付。当前R1工程fail、R8合法尾slash目录fail、RexGUI远控权限blocked仍存在；主会话继续记录未覆盖/缺口，业务不关闭。

DeepSeek只读诊断已落盘research/worktree-close-routing-diagnosis.md：两个Worktree实施事实与现行输入/scope/文件SHA/mode均匹配；CLI/桥接close把worktree同时作为executionRoot和evidenceRoot，读不到shared main runtime而报implementation_stale。只读正确双根组合allowed，公共入口缺失路由；不是凭据真的过期。原始证据a6-stale-evidence.json及close/merge/cleanup拒绝输出保留，不force、不补造凭据或修生产代码。

2026-11-14 续接核对（主会话 01a1d51b，依用户消息 9698c2d8 处理收口阻塞；原执行会话 01a1d060 的会话文件自 11-13 10:17 起无写入，本任务无活动 run）。本条只补记阻塞缺陷的修复与隔离复验，不改变本任务结论：必验场景未全部 pass，业务不关闭。

已修复并各自独立检查通过、本地提交归档（未推送）的生产缺陷：尾斜杠目录交付与旧检查点重试补认、worktree 内 task close／task implement 路由（k-e7876542ec29，提交 e717f95）；策略变化后 needs_attention 提交步骤的恢复（k-2af2e1208325，提交 46bd914）。旧 macOS 收口操作 op-d2b8f5b40d91 已用公开 deliver --retry --recover-policy 加原授权恢复并归档（c7d70be／2dff2a3）；旧场景任务 k-185ace3b9556 已按真实提交复核范围、重新独立检查通过并归档（d7909bf／f68c6c3）。

隔离复验（当前仓库 dist，HEAD 2dff2a3，不是本任务冻结基线 2d68014 的安装包，也不在新的普通 Terminal／Rex 验收终端里执行）：
- R8.S2 尾斜杠目录例：新夹具 /tmp/knit-b901-recheck/目录交付 复验-XYZlRk，任务 k-db7a66d981ff 以 evidence/ 登记，deliver op-6c647fdb4efc completed，产物提交 1c94607 只含 evidence/a.txt、evidence/b.txt，资料 4654237、归档 61bcadd，哨兵 unrelated.txt 保留未提交。原始输出存 validation/local-real-pi-acceptance-2026-11/main/a7-directory-recheck-2026-11-14.json。原夹具操作 op-7b7dd61d7dba 未重试、未改动。
- Worktree close：test/worktree-routing.test.mjs 的「CLI task close」「CLI task implement」4 例通过（worktree 内与主检出各一）。原夹具任务 k-c54ad46f83b7、k-5973fe1927c2 未重新 close，合入与清理未执行。
- 全量 npm test（782 例）：Rex 782/782；普通 Terminal.app 首次 781/782（test/run.test.mjs「prepare 只发布请求」锁目录轮询里 find 与目录删除竞态），重跑 782/782。原 R1 的两类 ENOTEMPTY 清理失败（test/bridge-query.test.mjs 观察器节拍与 cli_version 诊断）本轮未重现，测试清理代码未改，偶发原因仍在。

仍未满足、需要用户决定或到场的事项：
- R1.S2：冻结基线上的结果仍是普通 738/739、Rex 737/739；按新基线复验需要重新导出、在新的普通 Terminal 与 Rex 终端各跑一遍并含 pack:check、pack:install。测试清理偶发失败未修。
- R5 目视项：Rex Remote Control 权限关闭，未开启也未绕过，保持未验证。
- R8.S2、R8.S3 与 R7 的 worktree 收尾：只有上面的隔离复验，未在验收基线的安装产物上重做。
- 真实 Pi 会话对桥接新通知分流（k-b9ea41e9eec0）的 /reload 观察未做。
本任务的原授权不含当前项目提交、推送、归档；本轮也未对本任务资料与 validation/local-real-pi-acceptance-2026-11/ 做任何提交。

2026-11-14 第二轮验收已执行，报告 validation/local-real-pi-acceptance-2026-11/round2/REPORT.md：22 个场景 pass、R7.S1 fail。基线 2a2f6a0，828 文件；新普通 Terminal 与新 Rex 的 npm test 各 782/782，typecheck/build/pack:check/临时 prefix 安装通过。真实通知 wait 被动展示、非 wait 完成唤醒、取消唤醒、reload/去重；原生续接和缺失文件 prefer 新会话；活动输入 stale_input、快照；文件与尾 slash 目录交付、Worktree close/repair/merge/cleanup、clone/rebind 均已留证。共 9 个真实 stage run，均已结束。R7.S1 失败为主检出无法按绑定定位已 handoff 任务：task list 隐藏活跃任务，status 报不存在，真实主桥接 knit_task use/knit_context 同样失败，实际 Worktree 内查询正常。复现 fixture k-d7b23bf7c326，真实 Pi session 01a1d867-3251-71d0-8810-6f99ff7bb1c5，窗口 27094。按用户 9698c2d8 的持续收口授权另建独立修复任务 k-3a7f2483b0d8（12 场景、independent、摘要 adf30ac5404a），不在本验收任务里改生产代码。修复后换基线复验；本任务保持 open，不写完成凭据，不 force；当前项目本轮未新增提交/推送。

### 交付记录

<!-- knit:delivery:op-5084d5c02be3 -->
- 操作: op-5084d5c02be3
- 时间: 2026-11-14T13:03:35.175Z
- 分支: refs/heads/main
- 授权来源: user:9698c2d8
- 调用: bridge
- 工作提交: 76b92debb6cd658a7b0c95f741d995e00e0bb45e
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-12-local-real-pi-acceptance

<!-- knit:progress:end -->
