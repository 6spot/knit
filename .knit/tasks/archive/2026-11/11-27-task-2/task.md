---
id: k-85750899cc3a
title: 单 PID 判活替换整机 ps 扫描并优化 waitRun 轮询开销
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T09:03:09.022Z
---

## 目标与范围

背景：
- 在 macOS 等非 Linux 平台上，`src/infrastructure/process.ts` 中的 `procStartTicks` 和 `recordedProcess` 每次都调用 `processTable()` 执行整机 `ps -eo pid=,ppid=,pgid=,lstart=,comm=`（约 40+ ms），而非先用 `pidAlive(pid)` 短路并按目标 PID 定向查询 `ps -p <pids>`（约 2–4 ms）。
- `src/application/run-control.ts` 中的 `aliveAmong` 每次轮询（间隔 50ms）也扫描整机 `ps -eo`；`stopRunProcesses` 链路连续触发 4–5 次整机 `ps -eo`；`signalProcessTree` 未排除调用方自身所在 PGID。
- `waitRun` 每次轮询都重复执行 `readWorkflow(root)`（完整 YAML AST 解析与 Tarjan 环检测）及 `findTask(root, taskId)`（扫描任务目录并重解析 `task.md`），即使等待期间只需监控目标任务的 `record.json` 和 worker 存活状态。

范围：
1. **单/批量 PID 针对性查询替换整机 `ps -eo`**（`src/infrastructure/process.ts`）：
   - 增加单/多 PID 的身份查询能力（Linux 仍直接读 `/proc/<pid>/stat`；非 Linux 平台先用 `pidAlive` 过滤，对存活目标仅调用 `ps -p <pids> -o pid=,ppid=,pgid=,lstart=,comm=` 并复用 `parseProcessTablePs` 解析）。
   - 保留沙箱降级语义：当 `/bin/ps` 不可用（例如 macOS `sandbox-exec` 禁止执行 `/bin/ps`，返回非 0 退出码或 `result.error` 且未解析出进程信息，而 `pidAlive(pid)` 仍为 `true`）时，明确区分「进程不存在」与「进程表不可用」，确保 `recordedProcess` 与 `aliveAmong` 仍正确回退 `pidAlive(pid)`，不把仍在运行的进程误判为已退出。
   - `procStartTicks(pid)` 与 `recordedProcess(file)` 改为先 `pidAlive` 短路，再走单 PID 身份查询，不再扫描整机 `processTable()`。
   - `processTreePids(rootPid, table?)` 与 `signalProcessTree(rootPid, signal, knownPids?, table?)` 支持复用已获取的进程表（保持既有调用签名向后兼容），避免 `processChains` / `stopProcesses` 重复扫描整机进程表。
   - `signalProcessTree` 在向进程组发信号前排除当前进程自身所在 PGID（若 `table.get(process.pid)?.pgid` 与某目标 `pgid` 相同则跳过 `kill(-pgid, signal)`，仍对目标 `knownPids` 逐个发信号，避免共享进程组时误杀调用方自身）。
2. **`waitRun` 与进程回收热路径减负**（`src/application/run-control.ts`）：
   - `waitRun` 将 `readWorkflow(root)` 提到 `poll` 循环外只执行一次，无效时直接提前返回。
   - 首次通过 `readRunTask(root, taskId)` 定位到任务的实际目录（`storeRoot` + `dir`）后，后续轮询直接读取该目录下的 `record.json` 检查对应批次未结束的 run 及 worker 存活状态；仅在 `record.json` 读取/解析失败（如任务被归档或移动）或等待结束/超时返回前，才再次调用 `readRunTask(root, taskId)` 返回最新完整任务信息。
   - `aliveAmong(processes)` 改为先用 `pidAlive` 过滤，全部退出时直接返回 `[]`（0 次 `ps`）；对仍存活且带 `start` 的进程只按这些 PID 做单次批量定向查询并核对 `sameProcessStart`，保留 `ps` 不可用时的 `pidAlive` 回退。
   - `processChains` 仅调用一次 `processTable()` 并传给 `processTreePids`，减少重复整机扫描。
3. **测试补充**（`test/process.test.mjs`、`test/run-control.test.mjs`）：
   - 在 `test/process.test.mjs` 补充单/批量 PID 身份查询、不存在 PID 零误判、macOS 沙箱禁止 `/bin/ps` 时 `aliveAmong` 与 `recordedProcess` 回退验证，以及 `signalProcessTree` 排除自身 PGID 不自杀的回归测试。
   - 在 `test/run-control.test.mjs` 补充 `waitRun` 跨多轮轮询正常等待结束、进程消失、超时及任务在等待期间状态变更的回归测试（确保行为与退出条件不回归）。

不在范围内：
- 不修改状态推进规则、快照/改动对比、交付或授权核对逻辑。
- 不更改 `worker.json` / `pane.json` 文件格式或 `ps` 身份格式（`lstart|comm`）。

## 完成条件

- `procStartTicks`、`recordedProcess`、`aliveAmong` 在非 Linux 平台不再调用整机 `ps -eo`，且对已退出 PID 直接通过 `pidAlive` 短路返回。
- macOS 沙箱禁止 `/bin/ps` 场景下，`recordedProcess`、`aliveAmong`、`processTreePids`、`signalProcessTree` 保持既有回退行为不把活进程误判为退出。
- `signalProcessTree` 在目标与调用方共享 PGID 时不向自身进程组发信号，仅终止目标 PID。
- `waitRun` 不再在每轮轮询中重复解析 `workflow.yaml` 和扫描全量任务目录，返回语义与边界（正常结束、全部进程退出、超时、任务或流程无效）保持不变。
- `npm run typecheck`、`npm run build` 和全量 `npm test` 全部通过（涉及共享底层 `src/infrastructure/process.ts`）。

## 待澄清

无。

## 相关资料

- [src/infrastructure/process.ts](src/infrastructure/process.ts)
- [src/application/run-control.ts](src/application/run-control.ts)
- [test/process.test.mjs](test/process.test.mjs)
- [test/run-control.test.mjs](test/run-control.test.mjs)

## 结果

完成单/批量 PID 定向查询替换整机 ps -eo（保留 macOS 沙箱 /bin/ps 禁用回退）、进程树扫描复用快照及 signalProcessTree 自 PGID 保护；waitRun 改为直接轮询 record.json 并按 statSync 缓存 workflow.yaml（保留配置损坏即时报错）。npm run typecheck && npm run build && npm test 全部通过（557/564 通过，0 失败，7 项跨文件系统测试跳过）。
