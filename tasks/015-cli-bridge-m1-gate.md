# 015 完成CLI与生产薄桥接并验收M1

- 里程碑：M1
- 执行角色：实现与验证 Agent
- 顺序参考（非硬依赖）：[014 实现限定提交、归档与确定性收尾](014-delivery-and-archive.md)
- 实际依赖：[001](001-engineering-baseline.md)、[002](002-contracts-and-ports.md)、[003](003-pi-cli-runtime.md)、[005](005-pi-host-admission.md)、[008](008-project-initialization.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)、[011](011-standards-evolution.md)、[012](012-snapshots-and-workers.md)、[013](013-stage-execution-and-recovery.md)、[014](014-delivery-and-archive.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

把现有用例接成可安装的首版临时闭环，生成的真实桥接通过验收。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第4.1、7、9.1–9.3、16节。
- [TECHNOLOGY.md](../TECHNOLOGY.md)：第3、6.1节。
- [STATES.md](../STATES.md)：命令映射与只读边界。

## 实施范围

- 完整接线首版已实现命令／工具，逐条核对DESIGN4.1；至少start、任务／context、运行／恢复／取消、交付、status与基础doctor/storage真实可用。尚属M3A的完整查询能力明确返回边界，不能用一组unsupported空壳通过M1；schema同源，主Agent日常调用不需用户手敲。
- 实现本宿主可销毁结果观察器、status --run只读查询、来源／原生去重核对与follow-up投递；关闭观察不取消worker。
- M1仅--dev结构化stderr，正确分离stdout／stderr，白名单脱敏，不自动建诊断日志。
- 在临时项目从npm pack本地安装，init生成实际桥接，完成讨论确认→实施→独立检查→规范审阅→限定提交归档；校验原生恢复／文件续做。

## 交付物

- 可本地安装运行的临时闭环
- M1门槛报告、真实生成桥接的schema／信任／消息连接证据

## 完成前必须验证

- 复核DESIGN16.1全部M1行及005待最终产物验收项；至少一个真实Pi/local闭环，不以fake代替。
- --json单响应、--events终态与脱敏诊断分离；查询不接收结果或重派，无误投／重复监听。
- 包内有worker／模板和协议资源，无研究、原生历史、缓存或凭据。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- M1只用于隔离临时仓库；未过020不得声称可在真实项目安全使用。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - CLI：新增 `src/cli/start.ts`（项目 cwd 启动本机 Pi，不自动批准信任）、`src/cli/status.ts`（status／doctor／storage、`status --events` 只读观察）、`src/cli/resume.ts`（按 run／operation／task 恢复，planned 操作取消）、`src/cli/dev.ts`（`--dev` 白名单 JSON stderr）；`src/cli/run.ts` 增加 `run implement/check`、`run check --scope`、`assist`、模型配置解析与 `--wait`；`task adopt`、`--runs-settled`、`session verify --file`；`src/cli/knit.ts` 注册与全局选项。
  - 应用层：新增 `status-service.ts`、`diagnostics.ts`、`informal-check.ts`、`model-selection.ts`；`TaskService.adopt`；`SessionService.verify` 可带实际文件；`StageRunner` 拒绝把主会话当阶段子会话；`RunCoordinator` 状态投影增加发起方／时间／最后事件，诊断时 worker stderr 继承；`TaskService.record` 追加记录区（014 后补发现）。
  - 基础设施：`SqliteMetadataStore` 只读模式；`NodeProcessPort` 可选 stderr 继承与 detached streams（worker 启动后父 CLI 可退出而不等待阶段）；`RunCoordinator` 只读列表现不写库。
  - 桥接与包：`assets/templates/pi/extensions/knit.ts` 重写为真实薄桥接（Session 登记／选择恢复、`knit_status`／`knit_task`／`knit_context`／`knit_run`／`knit_deliver`／`knit_standards`、5 秒观察器、通知去重、follow-up、`/knit` 与 reload）；`src/contracts/bridge-tools.ts` 同源 schema；`scripts/build-bridge-schema.mjs` 构建期派生 `dist/contracts/bridge-tools.json`；`scripts/pack-check.mjs` 检查 worker／schema／模板；`package.json` clean build 与 schema 生成。
  - 测试与证据：`test/m1-cli.test.mjs` 9 项；`validation/m1-bridge/` 真实安装包、桥接闭环、原生恢复／兜底、reload、规范与诊断证据。
  - 文档：DESIGN 16.1 M1 行、OPERATIONS 实现段、STATES 状态观察、ARCHITECTURE 入口实现、TASKS 状态。
- 实际验证命令与结果：`npm test` 158/158；`npm run typecheck` 通过；`npm run pack:check` 通过。
  - 本地安装：`npm pack` → `/tmp/knit-015-final2` 的 `npm install`；`knit init --client pi` ready；`knit doctor` 通过（config／manifest／installation／bridge／worker／bridge schema／Git／Pi）；`knit storage` 只读；`knit start -- --version` 真实输出 1.4.0。
  - 真实桥接闭环（真实 Pi 1.4.0／`magpie/auto/glm-5.3-flash`）：主会话经 `knit_task use` 写入选择并保持 `kind=main`；`knit_run implement` 产生 `run-0474f5a46603`（创建 `answer.txt`，completed，`implementation_accepted`）；`knit_run check` 产生 `run-567f4f6f2c65`（verdict pass，`check_pass`）；`knit_deliver` 产生 `op-0d0368b2bcb8`，工作提交 `a331f5b`、归档提交 `a676614`，任务移动到 `archive/2026-11/11-02-final-bridge`。零推送。
  - 桥接通知：两个终态均在 RPC 会话收到一次通知；重复轮询未重复投递；`status --run` 不接收结果。另在真实主会话执行 `sleep 55` 期间收到 implement 终态，busy follow-up 在忙态结束后实际触发新回合并回答 run 状态，确认不是仅 UI 文本。`/knit-reload` 返回 handled，会话不变，随后 `knit_status` 工具调用成功。
  - 规范：`knit_standards propose` 生成 `c-c4bf51cc551b`，`review` 生成 `r-184cf59478c0`（deferred），`standards pending` 为 `review_matched`。
  - 原生恢复：显式 `--resume-session` 使用旧 check 原生文件，`resumeAction=resume` 并完成；删除该文件后同请求 `create_new`／`session_file_missing`，新会话读取当前任务继续，未重置阶段。
  - 假模型测试覆盖：非正式 `--scope` 不建 binding、检查副作用失败；`status --events` 终态且不接收；`assist` 不推进；`--dev` stdout 单响应、worker 诊断仅 stderr；`cancel --operation` planned 放弃、running 待核实；桥接 schema 同源。
- 任务书必需验证逐项：
  - 复核 DESIGN 16.1 全部 M1 行：初始化/装配（本地安装桥接加载、reload）、输入/阶段（现命令接线，013 真实链路）、规范演进（propose/review/apply 已有 011，本项桥接 propose/review）、单任务闭环（本项真实桥接 implement→check→deliver→archive）、模型与报告（真实模型、usage、原生范围）、Session 基础索引（主/子、选择、verify）、基本安装（本地包）、状态与开发诊断（status/doctor/storage/--dev）逐项核对并记录边界。
  - 005 待最终产物验收项：真实生成桥接加载／工具 schema／信任后调用通过；worker→核心 result→只读 status→桥接轮询→来源／去重→通知真实通过；查询不接收结果；关闭观察只停定时器（代码与 session_shutdown）；真实忙态 `sleep 55` 中 follow-up 投递并触发新回合（[busy-followup.txt](../validation/m1-bridge/busy-followup.txt)）。
  - 至少一个真实 Pi/local 闭环：见上，不以 fake 代替。
  - `--json` 单响应、`--events` 终态与脱敏诊断分离：单测与真实桥接工具输出验证。
  - 包内 worker／模板／协议资源，无研究、原生历史、缓存或凭据：pack:check 必需项与禁止项通过；tar 检查无研究／测试／原生 JSONL／凭据。
- 证据位置：`validation/m1-bridge/`（README、report.json、doctor/storage、run 状态与结果、Session、归档任务、标准、真实恢复/兜底、reload 与桥接输出）；临时项目 `/tmp/knit-015-final2`（原生历史留在项目，不复制）。
- 实施中纠正的事实：① `run` 曾把发起方 `--native` 默认当作阶段恢复目标，导致 worker 复用主会话并覆盖 main 记录；已改为只有显式 `--resume-session` 才恢复，StageRunner 另加 main_session_reuse 守卫。② 桥接在 session_start 登记时原生文件尚未落盘，记录长期 opening；增加 agent_settled／观察轮询 verify，并支持 `session verify --file` 带入实际路径。③ 主会话记录曾被阶段子会话覆盖，已通过 ① 的真实闭环确认主／子分离。④ `doctor` 从 CLI 入口推导 worker/schema 时少上溯一层，已修正。⑤ `run list` 只读查询曾打开可写库，已改只读。⑥ `start` 的 `--` 参数曾丢失，改为按原始 argv 分隔符透传。⑦ `TaskService.record` 后补覆盖交付记录，已改追加。⑧ `reasonForError` 未映射 external_effect_unknown，取消 running 操作误报 error，已修正。⑨ `NodeProcessPort` 的 worker 管道让 `run implement` 意外等待整个阶段；改为 detached streams 并 unref，桥接工具立即返回 run ID，观察器负责终态通知。
- 未解决问题／决定：① `task close completed` CLI 仍要求调用方显式 `--runs-settled`，未从 run 仓储自动推导；核心不把声明当事实。③ 非正式 `run check --scope` 使用 fake 验证；真实正式检查已通过，非正式真实模型留作日常使用回归。④ `status` JSON 投影未加独立版本化 schema；桥接只读使用，M2 再收敛。⑤ 推送、合并、冲突解决、完整崩溃矩阵与真实项目保护不在 M1，按 016–020 继续。
- 对下一项的交接：016 可复用 `status --events`、只读 store、`ModelSelection` 与桥接 schema 派生；M2 需补 `task close` 运行收敛自动核验、`status` 投影 schema 与完整快照恢复；当前工作区未提交，交付仍按用户授权。

优先扫描下一编号（阻塞时可继续跳过）：[016 强化快照与逐路径恢复保护](016-path-restore-and-fingerprints.md)。
