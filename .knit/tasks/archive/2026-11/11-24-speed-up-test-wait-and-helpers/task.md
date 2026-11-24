---
id: k-518fec960508
title: 改造测试等待机制与公共夹具，降低集成测试子进程开销
status: delivered
stage: null
verification: independent
parent: k-8f1c264937ee
dependsOn:
  - k-ef4500bb69c6
priority: P2
createdAt: 2026-11-23T23:26:25.930Z
---

## 目标与范围

落地 `docs/research/file-granularity-and-test-review.md` 第 5.3–5.4 节中“Batch 1a”的底层提速改造：消除 `waitRun` 固定整秒空等与 `stopProcesses` 固定 5 秒测试等待，同时收敛并加速 `test/helpers/` 公共夹具，让所有集成测试立刻摆脱反复 CLI 冷启动与重复 `git init` 的开销。

**为什么做**：
全量 `npm test` 耗时约 100–120 秒，其中大量时间耗费在：① `waitRun` 硬编码 1000ms 轮询，假执行者 80ms 跑完也要空等整秒；② `stopProcesses` 写死 5000ms `SIGTERM → SIGKILL` 宽限期；③ `readyTask()`/`doneTask()` 每次夹具准备拉起 2–3 个 `knit` CLI 子进程，`runProject()`/`gitProject()` 每条用例重复跑约 10 次 `git` 子进程。

**改动范围（范围内）**：
1. **等待与停止机制提速**（`src/application/run-control.ts`、`src/application/run-process.ts`）：
   - `waitRun` 改为短间隔退避轮询（例如 `50ms → 100ms → 200ms → 500ms → 1000ms` 上限）或同时支持显式可选 `pollMs` 选项，兼顾生产低占用与快速完成时的毫秒级响应，不改变超时语义、返回结构与取消行为。
   - `stopProcesses` 允许传入可选宽限期参数（或在受控测试入口/环境变量支持较短宽限期，生产默认严格保持 5000ms），供 `test/run-cancel.test.mjs` 的 `stubborn` 场景缩短等待时间而不改变 `SIGTERM → SIGKILL` 行为。
2. **公共测试 Helper 收敛与提速**（`test/helpers/` 及引用受影响的测试文件导入路径）：
   - 将 `test/helpers/setup.mjs`（6 行）与 `test/helpers/deliver.mjs`（20 行）并入 `test/helpers/run.mjs`（helper 从 9 个收至 7 个），更新所有受影响测试文件的导入路径。
   - `gitProject`/`runProject`（`test/helpers/git.mjs` / `test/helpers/run.mjs`）：每进程懒初始化一次只读基础 Git 模板仓库（含 `git init`、`maintenance.auto=false`、测试身份配置与初始提交），每个用例通过 `cpSync` 复制到独立临时目录（进程退出时清理模板目录），保证用例间完全隔离且不污染工作区。
   - `readyTask`/`doneTask`：改用已构建的应用层函数（如 `createTask`、`readyTask`、`closeTask`）直接构造夹具，不再每次拉起 2–3 个 `knit` CLI 子进程；保留命令行入口测试（`test/task-*.test.mjs` 等）的真实 CLI 覆盖。
3. **验证不变量不削弱**：确保改动前后 `run-wait`、`run-cancel`、`deliver-worktree`、`run-start`、`run-worktree`、`bridge-notice` 等全部受影响测试行为等价、全部通过，并记录改造前后的测试耗时对比。

**边界（范围外）**：
- 本任务**不做** `test/work-choice.test.mjs`、`test/run-pane.test.mjs` 的矩阵重构，也不改 `test/antigravity.test.mjs` 的 `/private/tmp` 路径（这些在后续子任务 `k-47bf688a1643` 处理）。
- 不合并 68 个测试文件本身（在 Batch 5 处理）；除更新被合并 helper 的导入路径和适配短等待参数外，不擅自删减现有测试用例断言。
- 不修改受保护路径（`.knit/standards/`、`.knit/agents/`、`.knit/workflow.yaml`、`.knit/config.json`）。
- 不运行 `npm run pack:install`。

**验证与交付**：
- 运行 `npm run typecheck` 与全量 `npm test`（若运行环境缺失 `rg` 或受沙箱限制，如实报告受影响的具体用例及原因，其余测试须全绿；同时对修改直接相关的 `run-wait`、`run-cancel`、`deliver-worktree`、`run-worktree`、`run-start`、`bridge-notice` 等单跑核实通过并记录耗时）。
- 需独立审查（`verification: independent`），审查重点核对：生产默认宽限期与轮询行为未破坏、`cpSync` 模板仓库无用例间状态泄漏、所有删掉的 helper 引用无残留。
- 完成后改动留在任务分支，待审查通过并由用户授权后交付合并。

## 完成条件

### Requirement: 执行等待与进程停止支持快速响应且不破坏生产语义
#### Scenario: 短执行不再整秒空等且取消宽限期保持生产默认 5000ms
- WHEN 执行者更新 `waitRun` 轮询策略与 `stopProcesses` 宽限期配置，并运行 `test/run-wait.test.mjs`、`test/run-cancel.test.mjs`、`test/bridge-notice.test.mjs`
- THEN 生产默认行为与超时间隔语义保持不变（`stopProcesses` 默认仍为 5000ms，`waitRun` 超时与结束判定完全一致），快速结束的执行不再被迫整秒空等，相关测试全部通过。

### Requirement: 公共测试夹具收敛并消除重复 CLI 与 Git 初始化开销
#### Scenario: helper 从 9 个收至 7 个且模板仓库与应用层夹具完全隔离
- WHEN 将 `test/helpers/setup.mjs` 与 `test/helpers/deliver.mjs` 并入 `test/helpers/run.mjs`，并将 `gitProject`/`runProject` 改为进程内模板仓库 `cpSync`、`readyTask`/`doneTask` 改为直接调用应用层函数
- THEN 仓库内不再存在 `test/helpers/setup.mjs` 与 `test/helpers/deliver.mjs` 及对其的失效导入，所有集成测试夹具仍保持用例间独立临时目录隔离且不污染当前工作区。

### Requirement: 回归验证通过并如实报告提速效果
#### Scenario: 类型检查与测试回归通过且无断言削弱
- WHEN 运行 `npm run typecheck` 与 `npm test`（并记录代表性慢测试如 `deliver-worktree.test.mjs`、`run-worktree.test.mjs`、`run-cancel.test.mjs`、`run-wait.test.mjs` 的实测耗时）
- THEN 类型检查通过，受本次改动影响的全部测试通过（如有环境限制如沙箱或缺失 `rg` 须如实写明受影响用例，不得虚报），且核心夹具耗时较改造前明显下降。

## 待澄清

## 相关资料

- `docs/research/file-granularity-and-test-review.md#53-五大耗时根因精准定位` — 耗时根因数据
- `docs/research/file-granularity-and-test-review.md#54-测试文件收敛与提速改造方案68-29-文件-39` — Helper 收敛与夹具改造方案
- `src/application/run-control.ts` — `waitRun` 轮询实现
- `src/application/run-process.ts` — `stopProcesses` 进程树停止与宽限期实现
- `test/helpers/` — 公共运行、Git 与待合并的交付／setup 测试夹具目录

## 结果

已完成 Batch 1a（测试等待机制与公共夹具提速），3 个完成条件均已满足并通过独立审查（r-3a17ef7d29cf，verdict: pass）。主要改动：waitRun 改为短退避轮询（50→100→200→500→1000ms）并支持 pollMs，stopProcesses 保持生产默认 5000ms 并支持可选 graceMs / KNIT_STOP_GRACE_MS；合并 test/helpers/setup.mjs 与 deliver.mjs 至 run.mjs（helper 9→7），gitProject/runProject 改用进程内模板仓库 cpSync，readyTask/doneTask 改调应用层函数；主会话在非沙箱复验时捕获并修复了新增用例 test/run-cancel.test.mjs 中直属子进程未回收竞态（补齐 exit.signal === "SIGKILL" 等待与断言）。

已验证：npm run typecheck 通过；独立审查在沙箱中验证未受限的全部测试全绿（deliver-worktree 28/28、run-worktree 21/21、run-wait 9/9、bridge-notice 5/5、其余 49 个测试文件全过）；主会话在无沙箱环境复验 process.test.mjs（7/7）、run-cancel.test.mjs（6/6，5.30s）、run-start.test.mjs（19/19）、run-wait.test.mjs（9/9）、deliver-worktree.test.mjs（28/28 + 7 跨文件系统 skip）全部通过；代表性单跑提速显著（run-worktree 16.3s→7.1s，deliver-worktree 39.2s→27.2s，run-wait 15.2s→10.3s，run-start 23.5s→16.1s，run-cancel 7.4s→5.3s）。

未验证：1）未在本会话重复跑完尚未降级的 test/work-choice.test.mjs（本机缺 rg，留待 Batch 1b 彻底降级改造）、test/antigravity.test.mjs、test/run-pane.test.mjs 以及 Rex 终端双跑；2）deliver-worktree.test.mjs 中 7 条跨文件系统用例因未设 KNIT_TEST_CROSS_DEVICE_DIR 跳过。
