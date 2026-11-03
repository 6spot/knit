# 017 强化占用、取消和中断后的执行安全

- 里程碑：M2
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[016 强化快照与逐路径恢复保护](016-path-restore-and-fingerprints.md)
- 实际依赖：[003](003-pi-cli-runtime.md)、[007](007-local-infrastructure.md)、[012](012-snapshots-and-workers.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

验证跨进程并发与真实取消边界，未知旧工具不能被新会话兜底绕过。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [OPERATIONS.md](../../design/OPERATIONS.md)：第2、4节。
- [STATES.md](../../design/STATES.md)：运行、取消与Session锁。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第5、6节。
- [validation/pi-cli-1.4.0/MATRIX.md](../../../validation/pi-cli-1.4.0/MATRIX.md)：取消与SIGKILL实验。

## 实施范围

- 覆盖共享项目／Session锁、预分配原生ID、兜底换锁顺序、owner token和多实例竞争。
- 实现取消意图持久化、正常RPC clear_queue/abort与稳定工具终态，处理取消／完成裁决和迟到旧token。
- 处理SIGKILL、PID复用、权限不足、网络盘／原子条件不足、未知工具及外部daemon边界；不自动强解。
- 完善doctor/unlock的核实、expect-token和强解限制；心跳仅调查，无固定总时长自动停止。

## 交付物

- 取消／占用故障收敛
- 受控真实工具中断、原生恢复和无残留进程证据

## 完成前必须验证

- 只结束观察不取消执行；模型正在执行工具时取消有实际终态，不只看ack。
- 强杀CLI后检查仍存活子进程，清理自有进程后才续做；无法确认则保持阻塞。
- 同内容新草案／新run／新操作不被旧取消误伤，生命周期无额外预算停止。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不建设跨机协调、系统沙箱或未知工具接管平台。
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
  - `src/infrastructure/locks.ts`：owner 记录 scope／rawKey；只读 `list()` 返回稳定 `scope/hash`、进程核实与路径；`unlock()` 必须匹配 owner token，alive／unknown 需显式 force，删除前二次核对 token；锁根本地文件系统核对（NFS／SMB／FUSE 拒绝），权限不足显式失败。
  - `src/infrastructure/process.ts`：`processTable`／`processTreePids`／`signalProcessTree`，取消时清理工具自建进程组的完整后代，不只杀 Pi 主进程组。
  - `src/application/stage-runner.ts`：项目锁后取 `pi:<nativeSessionId>` Session 锁；写 `stage-process.json`（worker／Pi PID、boot、starttime、原生 ID）；取消后 5 秒宽限，超时终止完整进程树；取消时补记实际原生文件；项目内阶段会话文件查找修正。
  - `src/application/run-coordinator.ts`：status 暴露取消意图、stage-process 与核实结论；cancel 增加 worker／stage 裁决、显式 `--terminate`、无结果且确认死亡时收敛 cancelled；resume 在旧阶段 Pi 存活／未知时保持 `run_active`，确认结束后关闭旧活动态再续做。
  - `src/contracts/run.ts`、`src/infrastructure/run-store.ts`：新增 `RunStageProcessSchema` 与原子读写。
  - `src/worker/knit-worker.ts`：项目锁 5 秒心跳，心跳失败停止发布完成；StageRunner 传入同一锁管理器。
  - `src/adapters/pi/runtime.ts`、`native-file.ts`、`application/session-service.ts`：暴露 Pi PID；阶段会话文件从项目 `.knit/.runtime/pi-sessions/` 查找；Session 锁键改为客户端原生 ID（跨项目互斥，不随 fallback 变目录）。
  - `src/cli/locks.ts`（新）、`src/cli/knit.ts`、`src/cli/resume.ts`、`src/cli/status.ts`、`src/cli/output.ts`、`src/application/diagnostics.ts`：`locks`／`unlock`（token、force、lock-id）、`cancel --terminate`、状态显示取消／阶段进程、doctor 锁残留与心跳调查、错误映射。
  - `test/infrastructure.test.mjs`、`test/stage.test.mjs`、`test/m1-cli.test.mjs`、`test/fixtures/fake-pi.mjs`：新增跨进程锁竞争、token／force 解锁、旧 token、权限不足、进程树；取消不响应 abort、工具自建进程组、强杀 worker 后阶段 Pi 残留与清理、同内容新 run、锁 CLI 等测试。
  - `validation/m2-safety/`：真实取消、取消后原生恢复、自动故障夹具证据。
  - `OPERATIONS.md`、`DESIGN.md`、`STATES.md`、`ARCHITECTURE.md`：补 017 实现语义与边界。
- 实际验证命令与结果：
  - `npm run -s build`：通过。
  - `npm run -s typecheck`：通过。
  - `npm run -s pack:check`：通过。
  - `npm test`：**172/172**。
  - `node --test test/infrastructure.test.mjs`：21/21（含真实跨进程、权限、进程树）。
  - `node --test test/stage.test.mjs`：13/13（含取消不响应 abort 5.8s 终止、SIGKILL worker 后 resume 拒绝与清理）。
  - `node --test test/m1-cli.test.mjs`：10/10（含 locks/unlock CLI）。
  - 真实 Pi e2e `/tmp/knit-017-real`：模型 `magpie/auto/glm-5.3-flash` 执行 `sleep 120`；`run cancel --terminate` 567ms 后 status／result 为 cancelled，Pi 955649、bash 955713、sleep 955715 均无残留；随后 `run resume` 复用旧原生会话完成新 run，`resumeAction=resume`。
- 证据位置：`validation/m2-safety/README.md`、`report.json`、`real-cancel/`（cancel/status/result/stage-process/events/process-before/process-after/tool-session）、`real-recovery/`（resume/status/result/stage-process/done2）、`automated/`（sigkill-worker、locks-unlock）。真实夹具 `/tmp/knit-017-real`。
- 任务书必需验证逐项：
  - 只结束观察不取消执行：沿用 015 的 detached worker；新增 SIGKILL worker 测试证明旧 Pi 可独立存活，观察断开不等于执行结束。
  - 工具正在执行时取消有实际终态：真实 `sleep 120` 取消后 status=cancelled、result=cancelled/agent_aborted、stage-process=exited，进程表无残留；仅看 RPC ack 的路径未作为完成依据。
  - 强杀 CLI／worker 后检查存活子进程：自动测试确认无响应 stdin 关闭的旧 Pi 仍存活，`resume` 返回 `run_active`；清理 Pi 进程组与残留项目／Session 锁后才允许续做；锁定 token 由 `unlock` 显式校验。
  - 同内容新草案／新 run／新操作不被旧取消误伤：取消文件按 run ID；测试让新 run 写同路径同内容仍 completed；cancel --operation 只放弃 planned；重复取消返回 already_terminal。
  - 生命周期无额外预算停止：未新增固定总时长自动取消；只有显式取消、心跳失主或真实错误终止。
- 未解决问题／决定：
  1. 取消宽限从设计草案的 30 秒收敛为当前实现 5 秒后终止进程树；若显式 `--terminate` 则立即清理已核实的 Pi 后代。文档已回写，未保留旧 30 秒描述。
  2. Session 锁键改为 `client:nativeSessionId`（跨项目），旧版本按项目＋Knit ID 的残留锁不自动迁移，按普通锁记录由 `knit locks`／`unlock` 处理。
  3. worker 被强杀时项目／Session owner 文件依赖显式 token unlock，不自动强解；阶段进程记录缺失或损坏时 resume 保守阻塞。
  4. 取消与完成发布仍有微窗口：若完成结果先发布则完成胜出，取消意图保留为事实，不覆盖已完成结果；未实现跨进程取消短临界区。
  5. 只清理本 run 记录的 Pi 后代进程，不接管外部 daemon 或非后代进程；未在真实 NFS／SMB 上执行，远程文件系统按类型直接拒绝。
- 对下一项的交接：018 可复用 `stage-process`／取消意图／显式 token unlock；接收与草案竞争不应把 `cancel_requested` 当业务完成回执，旧 run 终态只由 result 与 acceptance 事实决定。

优先扫描下一编号（阻塞时可继续跳过）：[018 验证接收、草案和业务状态的竞争恢复](018-acceptance-and-state-races.md)。
