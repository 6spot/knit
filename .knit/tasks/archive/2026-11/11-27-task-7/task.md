---
id: k-b48ffc5cd430
title: 加固派发结算任务锁、saveTask 冲突捕获与续聊阻断结构化标记
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T10:57:31.594Z
---

## 目标与范围

背景：
- `src/application/run-prepare.ts` 目前仅在工作流包含多执行器阶段时才加 `withTaskRunLock`，单执行器工作流完全无锁；而且所有任务读取与状态检查（`findTask`、`currentStatus`、未结束执行检查、`nextStep`）都在锁外完成，存在并发 `knit run start` 各自读到旧快照并重复派发的竞态。
- `src/application/run-control.ts` 的 `startingWorker` 仅在 `run.batchId !== undefined` 时返回 `true`，导致单执行器在持锁派发、尚未写出 `worker.json` 的窗口内，可能被 `waitRun` / `cancelRun` / `status` 误判为进程已退出；同时 `src/application/run-finish.ts` 对单执行器写回未加 `withTaskRunLock`。
- `src/application/task-store.ts` 的 `saveTask` 在手检 SHA-256 与调用 `atomicWrite` 之间存在 TOCTOU 窗口；当 `atomicWrite` 抛出 `InfrastructureError("version_conflict")` 时未捕获，异常直接冒泡，导致 `finishRun` 依赖冲突数组触发的 3 次重试机制失效。
- `src/domain/progress.ts` 的 `preventsResume` 仅通过中文错误文案正则（`执行者提交了改动|执行者改了受保护的文件|执行清理失败`）判断是否禁止续聊，一旦文案调整就会静默放开本应阻断的续聊会话。

范围：
1. **统一 `prepareRun` / `finishRun` 任务锁与单执行器启动期保护**（`src/application/run-prepare.ts`、`src/application/run-finish.ts`、`src/application/run-control.ts`）：
   - `prepareRun` 在初步确认任务存在且目录在 Git 仓库内（避免为不存在的 ID 创建 `.lock` 文件）后，无论工作流是否包含多执行器阶段，一律进入 `withTaskRunLock(root, taskId, 0, ...)`；在锁内重新读取 `findTask(root, taskId, { includeWorktrees: false })` 并完成全部状态校验、依赖校验、未结束执行检查、`nextStep` 计算、Worktree 与交接准备、落盘记录以及 `startWorker`。
   - `finishRun` 统一经 `withTaskRunLock(root, taskId, 5000, persist, ...)` 执行落盘，且 `persist` 内总是重新读取 `findTask(root, taskId)` 与 `prepareRun` 互斥（含单执行器）。
   - `startingWorker(root, taskId, run)` 去掉 `run.batchId !== undefined` 限制：只要 `run.endedAt === null && !existsSync(join(root, RUNS_DIR, run.id, "worker.json")) && taskRunLockHeld(root, taskId)` 即视为正在启动，覆盖单执行器与并行批次。
2. **`saveTask` 捕获 `InfrastructureError("version_conflict")`**（`src/application/task-store.ts`）：
   - 在调用 `atomicWrite` 写入 `record.json` 与 `task.md` 时捕获 `InfrastructureError` 且 `error.code === "version_conflict"`，将其转换为既有的冲突提示数组（`${stored.dir}/${file} 在读入之后被改过，没有写入；重新运行一次`）返回，不让版本冲突作为未捕获异常冒泡；其它非 `version_conflict` 错误照常抛出。
3. **`resumeBlocked` 结构化标记与历史兼容**（`src/contracts/task.ts`、`src/application/run-finish.ts`、`src/domain/progress.ts`、`docs/design/DESIGN.md`）：
   - 在 `TaskRunSchema` 新增可选布尔字段 `resumeBlocked: opt(bool())`（从 `@earendil-works/pi-schema` 导入 `bool`）。
   - `finishRun` 在检测到违规提交（`changes.head !== null`）、修改受保护文件（`guarded.length > 0`）或执行清理失败（`cleanupFailure !== null`）时写入 `resumeBlocked: true`；其余正常或普通失败（如模型超时、报告不合规、被取消等）省略该字段（不额外污染 `record.json`）。
   - `src/domain/progress.ts` 中 `preventsResume(run)` 优先检查 `run.resumeBlocked === true`，对 `resumeBlocked === undefined` 的历史记录继续兼容既有的中文失败前缀正则，并在 `resumableRun` 中使用该判断（确保违规后不能借更早记录恢复同一原生会话）。
   - 同步更新 `docs/design/DESIGN.md` 中 `record.json` 的运行记录字段说明与任务锁说明。
4. **测试补充**（`test/run-prepare.test.mjs`、`test/run-control.test.mjs`、`test/progress.test.mjs`、`test/task-lifecycle.test.mjs`）：
   - 补充单执行器派发持锁互斥（锁被占用时 `prepareRun` 拒绝而非覆盖）、锁内重读最新状态（避免旧状态重复派发）及不存在任务 ID 不创建 `.lock` 文件的测试。
   - 补充单执行器 `startingWorker` 在持锁且尚无 `worker.json` 期间返回 `true`（`waitRun` / `cancelRun` / `status` 不误判为进程已退出）的测试。
   - 补充 `saveTask` 在 `atomicWrite` 抛出 `version_conflict` 时返回冲突列表（及 `finishRun` 遇冲突自动重试成功）的测试。
   - 补充 `resumeBlocked: true` 在违规提交/受保护文件改动/清理失败时写入并阻断续聊（即使 `failure` 文案改变仍阻断），普通失败不阻断续聊，以及无 `resumeBlocked` 字段的历史记录继续按既有规则阻断的测试。

不在范围内：
- 不改动 `clarifyStateOf` 代码围栏、`task.md` CRLF、`savePitfall` 权限或 `archiveTask` 跨卷移动（留作 2b 单独任务）。
- 不修改非 `version_conflict` 的磁盘/权限错误处理语义。

## 完成条件

### Requirement: 单执行器与多执行器统一受任务锁与启动期保护
`prepareRun`、`finishRun` 与 `startingWorker` 对单执行器和并行批次提供一致的并发互斥与启动窗口保护。

#### Scenario: 单执行器派发在锁内重读状态并与并发派发互斥
- GIVEN 一个仅含单执行器阶段的流程与已确认任务
- WHEN 任务锁已被持有时调用 `prepareRun`（或并发两次派发）
- THEN 第二次调用被拒绝且提示任务正在准备或结算，不会覆盖记录或重复启动执行者
- AND 对不存在的任务 ID 调用 `prepareRun` 不会在 `.knit/.runtime/` 创建 `.lock` 文件

#### Scenario: 单执行器持锁启动期不被误判为进程已退出
- GIVEN 单执行器执行记录已写入（`endedAt: null`）且 `worker.json` 尚未落盘，同时任务锁仍被派发进程持有
- WHEN 调用 `startingWorker`、`waitRun` 或查看状态
- THEN 识别为正在启动中，不会误判为进程意外退出

### Requirement: saveTask 将 atomicWrite 的版本冲突转为可重试冲突列表
`saveTask` 捕获 `atomicWrite` 的 `version_conflict`，使调用方（尤其是 `finishRun`）能够按既有冲突语义重试或友好拒绝。

#### Scenario: TOCTOU 窗口发生 version_conflict 时返回冲突提示并支持 finishRun 重试
- GIVEN `saveTask` 预检查通过后，在 `atomicWrite` 写入 `record.json` 或 `task.md` 瞬间文件被并发改写触发 `InfrastructureError("version_conflict")`
- WHEN 调用 `saveTask` 或 `finishRun`
- THEN `saveTask` 不抛异常，返回对应文件的冲突提示数组
- AND `finishRun` 捕获冲突后自动重新读取并重试落盘成功

### Requirement: 违规或清理失败通过结构化字段 resumeBlocked 阻断续聊
`TaskRun` 使用结构化 `resumeBlocked` 标记阻断续聊，并向后兼容不含该字段的历史记录。

#### Scenario: 违规或清理失败写入 resumeBlocked 并稳定阻断续聊
- GIVEN 一次执行发生提交改动、修改受保护文件或执行清理失败
- WHEN `finishRun` 结算该执行
- THEN 记录的 `TaskRun` 包含 `resumeBlocked: true`
- AND `resumableRun` 即使在 `failure` 文案变化时也拒绝恢复该会话及更早的同会话记录

#### Scenario: 普通失败与历史记录保持既有兼容行为
- GIVEN 普通失败（如报告不合规、被取消）的新记录，或不含 `resumeBlocked` 字段的历史违规记录
- WHEN 调用 `resumableRun`
- THEN 普通失败不设置 `resumeBlocked` 且不阻断续聊，历史违规记录仍按既有失败前缀兼容阻断

### Requirement: 全量构建、文档与测试验证通过
类型检查、编译、设计文档同步与全量测试全部通过。

#### Scenario: 完整验证回归
- WHEN 运行 `npm run typecheck && npm run build && npm test`
- THEN 类型检查、编译和所有非跳过用例全部通过，且 `docs/design/DESIGN.md` 与实现一致

## 待澄清

无。

## 相关资料

- [src/contracts/task.ts](src/contracts/task.ts)
- [src/application/run-prepare.ts](src/application/run-prepare.ts)
- [src/application/run-finish.ts](src/application/run-finish.ts)
- [src/application/run-control.ts](src/application/run-control.ts)
- [src/application/task-store.ts](src/application/task-store.ts)
- [src/domain/progress.ts](src/domain/progress.ts)
- [docs/design/DESIGN.md](docs/design/DESIGN.md)
- [test/run-prepare.test.mjs](test/run-prepare.test.mjs)
- [test/run-control.test.mjs](test/run-control.test.mjs)
- [test/progress.test.mjs](test/progress.test.mjs)
- [test/task-lifecycle.test.mjs](test/task-lifecycle.test.mjs)

## 结果

完成单/多执行器统一任务锁与启动期保护（含非法任务 ID 不建锁）、saveTask 捕获 version_conflict 并对 task.md 冲突时已写出的 record.json 做条件回滚，以及 TaskRun 新增结构化 resumeBlocked 字段并兼容历史记录；同步更新 docs/design/DESIGN.md。经过 1 轮返工修复 task.md 冲突残留僵尸记录问题后复审通过，npm run typecheck && npm run build && npm test 580/587 通过（0 失败，7 项跨文件系统测试跳过），独立审查 pass。
