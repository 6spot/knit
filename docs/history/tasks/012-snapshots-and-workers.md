# 012 实现快照准备、local启动与worker认领

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[011 实现规范候选到正式规则的闭环](011-standards-evolution.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让可信worker持有执行占用、冻结输入并在正式写代码前建立恢复对照。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第5.6、13节。
- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：第5、7节。
- [OPERATIONS.md](../../design/OPERATIONS.md)：第2–3节。
- [STATES.md](../../design/STATES.md)：初始化、launch与run准备。

## 实施范围

- 实现prepare/start内部握手、launch状态和进程实例；入口取得ID后确认，不要求用户重复许可。
- worker原子认领request，自行持锁，冻结inputs/instructions，正式implement先建立snapshot ready。
- 快照保存tracked工作与index层、未忽略untracked、模式／指纹和不存在起点；超限／未知覆盖不能假装完整。
- 写必要state/events并保证日志非权威；启动响应丢失查原句柄，不再生成替代运行。

## 交付物

- local host、worker入口与RunCoordinator准备路径
- M1基本完整快照和启动故障测试

## 完成前必须验证

- 无ID前无模型／业务写；无CLI→worker长锁交接；未ready不启动正式代码。
- 部分启动、重复start和父观察断开不重复运行；并行纯记录保留而不破坏快照冻结。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- M2继续强化故障注入，不得因此在M1省略基本快照／身份保护。
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
  - `src/contracts/run.ts`：新增 run 资料 schema——request（身份、阶段、purpose、发起方、预期 inputs／standards／effective 摘要、模型、工具策略、恢复引用、acceptanceOperationId）、launch（planned/starting/confirmed/failed、attempts、PID/boot/starttime 句柄、worker 实例）、inputs、instructions、snapshot manifest、state。
  - `src/infrastructure/run-store.ts`（新）：`.knit/.runtime/runs/<run-id>/` 原子写 request/launch/inputs/instructions/state；`mkdir claim` 原子认领；events.jsonl 追加；私有权限；重试清理。
  - `src/application/snapshot.ts`（新）：Git index 条目（mode/OID）、tracked 工作区副本、未忽略 untracked、符号链接、执行位、缺失路径、HEAD 起点；`.knit/.runtime/` 排除；超限／unmerged index／Git 失败置 failed；ready 才 rename 为 `snapshot/`。
  - `src/application/run-coordinator.ts`（新）：prepare 只发布请求与 planned launch，同任务／阶段活动 run 复用；start 落盘 starting+句柄后启动 worker，已 confirmed／句柄存活只观察，句柄缺失或死亡未认领置 failed，`--retry` 才重试同一 run；status 只读投影。
  - `src/worker/knit-worker.ts`（新）：认领后自行取得项目执行占用，复核任务阶段／分支、草案、预期摘要，冻结 inputs/instructions；implement 建快照 ready 后 state=preparing + prepared:true 并释放占用退出；失败写 failed state/result/event。
  - `src/cli/run.ts`（新）与 `src/cli/knit.ts`：run prepare/start/status/list，`--json` 协议输出与错误非零退出。
  - `src/application/task-service.ts`：修正 ready 冻结摘要时机——原实现取转移前文档摘要，导致刚确认任务与当前输入摘要不一致；现按 ready 后文档（含 status/phase）计算 `confirmedInputsDigest`。
  - `test/run.test.mjs`（新 10 项）。
- 实际验证命令与结果：`npm test` 127/127（run 10 + standards 6 + session 7 + task 17 + init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run pack:check` 通过；`npm run typecheck` 通过。临时真实项目（/tmp/knit-012-e2e，已清理）用真实 CLI 实测：init → task new → task ready（输入摘要 4254032c94df）→ 修改 tracked、暂存 staged、新增 untracked、删除 tracked、忽略 ignored → `run prepare`（run-b56ee3ac8799，planned，无 state/inputs/占用）→ `run start`（confirmed、prepared、snapshot ready）→ inputs.inputsDigest 4254032c94df、standards d4d82dc4ff79、effective 893c26cbed2d → snapshot coverage 全 true、tracked 4／untracked 13／absent 1（gone.txt）、ignored 与 `.knit/.runtime` 未收录、run.sh 100755 → 再次 start attempts 仍 1、reused=true → 项目锁目录空 → 零 Git 提交、零模型调用。
- 任务书必需验证逐项：
  - 无 ID 前无模型／业务写：prepare 后仅 request/launch/events，无 state/inputs/snapshot，任务文件未变；start 才 spawn，worker 全程不调用模型。
  - 无 CLI→worker 长锁交接：prepare 不取得项目执行占用；worker 认领后自行取锁，测试中预占项目锁时 worker 以 lock_busy 失败，释放后显式 retry 同一 run 成功。
  - 未 ready 不启动正式代码：012 不执行阶段模型／代码；worker 仅在 inputs/instructions 冻结且 implement 快照 ready 后置 prepared:true。013 从该点继续。
  - 部分启动、重复 start 和父观察断开不重复运行：假 worker 秒退 → failed worker_exited_before_claim，attempts=1；再次 start 不增尝试；`--retry` 才 attempts=2 且 runId 不变；CLI 父进程退出后再次 start 仍 attempts=1、reused=true；句柄缺失置 failed handle_missing，不启动第二个 worker。
  - 并行纯记录保留而不破坏快照冻结：start 与 task record 并发，记录保存成功、inputs 摘要与 effective 摘要不变、快照仍 ready、任务记录保留。
  - 基本快照和启动故障测试：tracked/index/untracked／模式／符号链接／缺失起点／ignored 排除；超限 snapshot_too_large；Git 不可用 snapshot_unknown；unmerged index 拒绝。
- 实施中纠正的事实：ready 原先把转移前文档摘要写成冻结值，任何 ready 后立即核对都会 stale；已改为按 ready 后文档计算。快照复制文件权限固定 0600，原模式只存 manifest，恢复由 016 按 manifest 还原。worker 在 012 验收的 `--prepare-only` 下于 prepared 后释放占用退出；013 已把默认路径改为同一 worker 持锁继续阶段，prepared 仍不等于 running。
- 未解决问题／决定：① 013 的阶段执行与模型调用尚未实现，需从 `state.prepared` 继续并在执行期间持项目占用；② 模型 provider/model 目前由 prepare 显式传入，配置／主会话解析归 013/015；③ snapshot 还原、逐路径核对与外部改动保护归 016；④ run 未进 SQLite 索引，status 以文件为准，013 接收结果时再更新 binding/operations；⑤ 项目 `limits.snapshotsMaxBytes` 尚未接入，012 用默认 64 MiB 与 worker `--max-bytes`。
- 对下一项的交接：013 从 `RunStore.readState(runId).prepared === true` 继续，复用 `inputs.json` 的 effectiveInputsDigest 与 `snapshot/manifest.json`；阶段执行期间保持项目执行占用，终态写 result 后由核心按 `request.acceptanceOperationId` 接收；启动失败先读 launch 句柄与 state，不另建 run；worker 已支持的 `--locks` 仅测试隔离用。

优先扫描下一编号（阻塞时可继续跳过）：[013 实现实施、检查、结果接收与恢复续做](013-stage-execution-and-recovery.md)。
