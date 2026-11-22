---
id: k-053fe369b3ec
title: 优化按 ID 查找任务性能、运行时状态文件改为原子写入并清理遗留代码
status: delivered
stage: null
verification: self
parent: k-d123fec5fa11
dependsOn:
  - k-84165a4f76ee
  - k-e03319df1da4
  - k-0821df285a6f
priority: P2
createdAt: 2026-11-22T06:32:51.759Z
---

## 目标与范围

清理三处小而明确的底层结构债，防止归档任务增长后拖慢高频热路径并消除运行时状态文件半写损坏隐患：

1. **优化按 ID 查找任务，避免高频热路径每次全量解析归档目录**：
   - 现状：`src/application/task-store.ts` 的 `findTask(root, id)` 直接调用 `scanTasks(root)`，每次查找都会读取、解析、Schema 校验并计算 `.knit/tasks/` 和 `.knit/tasks/archive/<YYYY-MM>/` 下**全部**活跃与已归档任务的 SHA-256。`waitRun` 每秒轮询一次都会全量扫归档；`src/cli/run.ts` 的 `statusLines` 在调用方已经加载出任务的情况下又调用了一次 `findTask`，导致 `knit context <id>` 每轮会话把全仓库归档任务解析两遍。
   - 做法：
     - 将 `scanTasks` 按需拆为活跃与归档范围（或 `findTask` 优先只扫描活跃任务目录，命中即返回；未命中时再扫描归档目录），确保活跃任务的 `run status`、`run wait`、`context` 等高频热路径不读取历史归档；
     - 为 `statusLines` 传入已有的任务目录（`stored.dir`），消除重复 `findTask` 调用。
2. **统一运行时状态文件走 `atomicWrite`**：
   - 现状：`pane.json`（`run-process.ts`）和 `outcome.json`（`run-session.ts`）已使用 `atomicWrite`，但 `worker.json`（`src/application/run-control.ts`）、`before.json`（`src/application/run-prepare.ts`）、`after.json`（`src/application/run-finish.ts`）仍直接调用 `writeFileSync`，存在进程中断时写出半截 JSON 的风险。
   - 做法：将上述 3 处运行时 JSON 文件写入统一改为 `atomicWrite`（权限保持合理值，如 `0o600` 或 `0o644` 与现有读取一致，写完不留 `.knit-tmp-*` 残留）。
3. **清理历史遗留的未用抽象 `NodeProcessPort`**：
   - 现状：`src/infrastructure/process.ts` 中的 `NodeProcessPort` 与 `ManagedProcess` 在整个 `src/` 中零引用，仅剩旧单元测试 `test/process.test.mjs` 在调用，是瘦身重构后遗留的死代码。
   - 做法：移除 `src/infrastructure/process.ts` 中的 `NodeProcessPort` 和 `ManagedProcess` 及其在 `test/process.test.mjs` 中对应的测试（保留 `gitSync`、`procStartTicks`、`recordedProcess`、`processTable`、`processTreePids`、`signalProcessTree` 及它们的测试）。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 不改变任何已归档任务按 ID 查找的结果（活跃未命中时仍能查到归档任务），不改变 `worker.json`、`before.json`、`after.json` 的 JSON 结构。

## 完成条件

### Requirement: findTask 优先查活跃目录且 statusLines 不重复扫描

#### Scenario: 查找活跃任务时不读取归档目录，查找已归档任务仍可命中

- GIVEN 临时项目夹具同时包含活跃任务与已归档任务（含一个写坏或额外放置的归档目录用于观察）
- WHEN 调用 `findTask(root, 活跃任务 ID)` 与 `findTask(root, 归档任务 ID)`，以及运行 `knit context <活跃任务 ID>` 和 `knit run status <活跃任务 ID>`
- THEN 查找活跃任务不扫描归档目录即返回结果，查找归档任务仍正常命中，`statusLines` 不再额外调用 `findTask`

### Requirement: 运行时 JSON 原子写入且清理未用 NodeProcessPort 后全量测试通过

#### Scenario: worker.json、before.json、after.json 使用 atomicWrite 且全套测试通过

- GIVEN 完整派发、审查通过与取消流程
- WHEN 检查运行时文件写入路径并运行 `npm run typecheck` 与 `npm test`（macOS 普通终端与 Rex 终端各一次）
- THEN `worker.json`、`before.json`、`after.json` 均通过 `atomicWrite` 写入且无临时文件残留，`src/infrastructure/process.ts` 不再包含未使用的 `NodeProcessPort`，全部测试通过

## 待澄清

## 相关资料

- `src/application/task-store.ts` — `scanTasks`、`findTask` 与 `taskDirectories`
- `src/application/run-control.ts` — `worker.json` 写入与 `waitRun` 轮询
- `src/application/run-prepare.ts` — `before.json` 写入
- `src/application/run-finish.ts` — `after.json` 写入
- `src/cli/run.ts` — `statusLines` 中重复调用 `findTask` 处
- `src/infrastructure/atomic.ts` — 现有原子写入实现 `atomicWrite`
- `src/infrastructure/process.ts` — 遗留的 `NodeProcessPort`
- `test/process.test.mjs` — `process.ts` 单元测试

## 结果

已完成三项优化与清理：1）findTask 改为优先遍历活跃任务目录命中即返回、未命中再查归档，waitRun 直接携带任务目录以消除 run wait 额外查库；2）worker.json、before.json、after.json 统一改为 atomicWrite 原子发布（0600，无临时文件残留）；3）移除未使用的 NodeProcessPort 与 ManagedProcess 并将进程树测试改用原生 spawn。完成条件全部满足。npm run typecheck 通过，macOS 普通终端与 Rex 终端 npm test 各 409/409 通过（含全部 7 项跨文件系统用例），文件访问跟踪确认活跃查找枚举归档目录零次。
