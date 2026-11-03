# 018 验证接收、草案和业务状态的竞争恢复

- 里程碑：M2
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[017 强化占用、取消和中断后的执行安全](017-cancellation-and-lock-failures.md)
- 实际依赖：[004](004-metadata-storage-decision.md)、[006](006-domain-rules.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

保证重复调用和跨文件／事务中断不会丢输入、重复推进或复活已结束任务。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [STATES.md](../../design/STATES.md)：Task输入、修复计数、run接收和操作恢复。
- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：第6–8节。
- [DESIGN.md](../../design/DESIGN.md)：第3.6、5.6、10.1节。

## 实施范围

- 对选定仓储的真实生产路径注入失败，覆盖result已落盘而业务未写回、固定acceptanceOperationId重入。
- 覆盖pendingInput的基线冲突、同内容新版本、apply/withdraw互斥、活动run中撤回和输入失效。
- 覆盖Task关闭／新启动／迟到接收竞争、取消／替代草案撤回、已归档不隐式重开。
- 覆盖最新失败检查不回退旧pass、scope跨run累积、Session变更不重置修复计数。

## 交付物

- 生产接收与状态竞争修复
- 双进程／崩溃重入的最小充分测试和事实记录

## 完成前必须验证

- 文件实现不能半更新后宣称成功；SQLite事务只覆盖内部元数据，不持事务等Git／模型。
- 旧回执保留但不覆盖新目标／结束outcome；有效结果待同步先接收，不再跑一次模型。
- 纯记录／候选／诊断不改需求摘要，模型自报phase／次数无权覆盖。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不保留第二套镜像仓储或大而全事件日志平台。
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

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`。
- 开始／结束时间：2026-11-02（本会话）。
- 实际修改：
  - `src/contracts/acceptance.ts`（新）：接收检查点 schema（来源／目标状态、binding before/after、scope、check、输入／规范摘要）。
  - `src/infrastructure/run-store.ts`：`acceptance.json` 原子读写／移除。
  - `src/application/run-acceptance.ts`：接收前落检查点；按来源／目标与 binding／scope／check 现状幂等收敛；漂移、关闭、归档、check 冲突转 needs_attention 并保留检查点；重复接收返回既有 target phase；operation 完成后清理检查点。
  - `src/application/run-activity.ts`（新）：按真实 run 终态、result、acceptance operation 计算 active／settled。
  - `src/application/task-service.ts`：update／apply／withdraw／close／ready 在项目＋任务锁内重读权威；修复 pendingKind 恒为 null；活动 run 只保存草案；apply 要求真实收敛；close 对所有 outcome 要求收敛；旧草案摘要不能撤回后来草案；直接更新不能绕过草案。
  - `src/application/run-coordinator.ts`：prepare 使用项目＋任务锁并短期等待上一 worker 释放；resume 在旧项目锁未释放时继续拒绝。
  - `src/cli/task.ts`：TaskService 注入 RunActivityService；JSON 错误统一 exit 1（修复 `task close` 等错误响应曾 exit 0）。
  - `test/stage.test.mjs`、`test/task.test.mjs`、`test/delivery.test.mjs`、`test/fixtures/accept-once.mjs`（新）、`test/run.test.mjs`：独立进程接收失败重入、活动 run 草案／关闭／撤回、迟到结果、scope 累积、最新失败检查、CLI 退出码与夹具清理。
  - `validation/m2-state-races/`：CLI 事实与测试输出。
  - `DESIGN.md`、`STATES.md`、`ARCHITECTURE.md`、`OPERATIONS.md`：回写 018 语义。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm run -s pack:check`：通过。
  - `npm test`：**178/178**（任务完成时；2026-11-02 任务020复验后全套为 **194/194**）；含新增“接收检查点”“输入草案竞争”“scope 跨 run”“活动 run 未收敛”“任务关闭后迟到”“最新检查失败”。任务020复验修正：`failed`／`cancelled` 已裁决终态不再永久阻塞 close／deliver；`completed` 仍要求 result 与 completed 接收回执（`run-activity.ts` 的 `runSettled`，交付与 Task 服务共用）。
  - `node --test --test-name-pattern "接收检查点" test/stage.test.mjs`：1/1；真实独立 Node 子进程 `test/fixtures/accept-once.mjs` 在 Task 写入后令 binding 保存失败，父进程按检查点重入，只追加一次 run／scope。
  - 真实 CLI 夹具 `/tmp/knit-018-cli`：task `k-4acee072e3a0`、run `run-35929a94ec42`；prepare-only 后 `task update` 返回 `pending_saved`；`task close --runs-settled` 返回 error／needs_review 且 exit 1；`--withdraw-pending` 成功并保留输入区。
  - `node --test --test-name-pattern "输入草案竞争" test/task.test.mjs`：1/1。
  - `node --test --test-name-pattern "scope 跨 run" test/stage.test.mjs`：1/1。
  - `node --test --test-name-pattern "最新检查失败" test/delivery.test.mjs`：1/1。
  - `node --test --test-name-pattern "任务关闭后迟到" test/stage.test.mjs`：1/1。
- 证据位置：`validation/m2-state-races/README.md`、`report.json`、`cli/`（task/run 回执、活动草案/关闭/撤回、exit 码、task-after）、`tests/`（五项命令输出）；临时夹具 `/tmp/knit-018-cli`。
- 任务书必需验证逐项：
  - result 已落盘、业务未写回：独立进程在写 Task 后失败，检查点保留；重入收敛，Task 不二次推进，binding／scope 只追加一次。
  - 固定 acceptanceOperationId 重入：重复 accept 返回 duplicate；operation completed 后不重新计算或重跑模型。
  - 文件半更新不宣称成功：只有 operation completed 后检查点才移除；失败操作保持 needs_attention，重入按来源／目标核对。
  - SQLite 不跨 Git／模型：接收检查点只在短项目锁内做文件／元数据写回；没有持有事务等待模型、Git 或工具。
  - pending 基线冲突／同内容新版本／apply-withdraw 互斥／活动撤回／输入失效：单元测试均覆盖；活动草案由真实 runActivity 判断，不信任 CLI 自报。
  - 关闭／新启动／迟到接收：prepare 与 close 共用项目＋任务锁；活动 run 未收敛 close 拒绝；关闭后的 completed 迟到结果只保留事实、不改 frontmatter；旧回执不清除新 outcome。
  - 最新失败检查不回退旧 pass：旧 pass 文件保留，但 binding 指向 blocked 时 deliver 拒绝。
  - scope 跨 run 累积、Session 变更不重置修复计数：测试覆盖。
  - 纯记录／候选／诊断不改需求摘要、模型自报不覆盖 phase／次数：沿用既有 inputsDigest 排除规则与接收只信请求／结果事实。
- 未解决问题／决定：
  1. `acceptance.json` 是文件检查点，不和 SQLite 组成跨介质事务；已覆盖进程在任一步退出后的重入，未模拟 SQLite WAL 断电损坏。
  2. 检查点 schemaVersion 1 暂无迁移；旧版本／损坏检查点按 io_error 拒绝，不猜目标。
  3. `RunActivityService` 只在 CLI 注入；直接调用 TaskService 的库使用者仍可自行传 runActive／runsSettled，服务无法在没有仓储时证明。
  4. `run prepare` 对残留项目锁等待 15 秒后仍报 lock_busy，不自动强解；需 `knit locks`／`unlock` 核实。
  5. `task close` 现在对 completed／cancelled／superseded 都要求 `--runs-settled`，比旧任务记录的“仅 completed”更严格；已回写 STATES／OPERATIONS。
  6. 接收重复调用依据 operation reason 推导 target phase，若未来出现新的 acceptance reason 需同步更新 `acceptedPhase`。
- 对下一项的交接：019 可复用 `acceptance.json` 来源／目标检查点、RunActivityService 与项目＋任务锁；Git／归档操作不要把验收检查点当提交回执，封存与归档仍需独立核实。

优先扫描下一编号（阻塞时可继续跳过）：[019 验证Git、归档与封存的关键故障](019-git-and-seal-failures.md)。
