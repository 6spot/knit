---
id: k-0524fc52e81b
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P2
dependsOn:
  - k-836997c84864
order: 40
createdAt: 2026-11-07T11:44:10.490Z
title: 桥接异步化与安装版本诊断
---

# 桥接异步化与安装版本诊断

## 目标与边界

### 背景与问题

桥接 `.pi/extensions/knit.ts` 的调用全部用 `spawnSync`，会卡住 Pi 主线程：

- 每轮用户消息前同步调 3 次 CLI：`session resolve`、`status`（实测 0.8 秒）、`material list`；
- 观察器每 5 秒跑一次 `run list`（0.44 秒），每个 run 再跑一次 `status`；
- `knit_run wait=true` 用 `Atomics.wait` 忙等最多 180 秒，期间 TUI 完全卡住，无法取消。

另外，桥接调用的是 `installation.json` 指向的全局安装 CLI，开发时容易用错版本还不知道。

### 交付范围

1. 桥接所有 CLI 调用改为异步（`execFile`／`spawn` + Promise），工具 `execute` 透传 `signal`，支持中止。
2. `wait=true` 改为异步轮询，用户中止时结束等待（不取消 run），并返回当前状态。
3. 每轮上下文：合并为一次 CLI 调用（新增 `knit session context <knitSessionId>`，一次返回选择、状态、资料与 nextAction），上限 300ms，超时用上一轮缓存并标注"可能过期"。
4. 观察器：串行、不重入；改用一次 `run list --active --with-status`；无活动 run 时退避到 30 秒。
5. `doctor` 与桥接诊断：显示 cliEntry 的版本与当前仓库 `package.json` 版本或 dist 摘要是否一致；在 Knit 自身仓库开发时提示使用本地 dist。
6. 同步桥接模板（`assets/templates/pi/extensions`）与受管基线。

### 非目标

- 不引入 Pi SDK 或 RpcClient（遵守 AGENTS 开发约定）。
- 不改工具参数结构。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 每轮上下文超时用缓存而不是阻塞等待

## 完成条件

- 自动化测试或可重复测量：上下文注入一次调用；`wait` 期间可中止；观察器无活动 run 时降频。
- 受管基线与模板一致，`knit init` 生成的桥接通过既有 bridge 测试。

## 输入引用

- 审计中等问题 1、6。
- `.pi/extensions/knit.ts:63,195-240,340-400,420-500,915-1000`、`assets/templates/pi/extensions`、`src/cli` session 命令。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 当前位置

实施完成并已接收（run-da8c20e7e342），主会话自检通过，待交付。

## 关键经过

- run-fbfdaa59b1bf：完成大部分实现后被取消。worker 在阶段环境里跑 `node --test test/bridge-query.test.mjs` 两次各挂约 55 分钟；主会话同一文件 48 秒跑完，差别是 worker 环境带 `KNIT_STAGE_RUN_ID`。续做说明写在本任务 `plan.md`。
- run-da8c20e7e342：在已有改动上续做完成。结果 completed，接收先停在 needs_attention（13 个路径由 bash/python 写入，未被归因）。主会话逐文件审过 diff 后用 `run accept --include` 并入 scope。
- 主会话审 diff 时发现并直接修了两处观察器问题：
  - `run list --active` 把所有失败／取消的历史 run 都算作“仍需观察”（本仓库当时 26 个），每次观察都重建它们的状态视图。改为失败／取消与完成同口径：结果处理完后只在 `--since` 之后出结果时返回一次。
  - `scanRuns` 在查询失败时也推进 `lastScanAt`，失败期间出结果的 run 会被漏掉。改为查询成功后才推进。
- 两处修正各补一条测试；`DESIGN.md` 第 634 行与 `--active`／`--since` 的选项说明同步。
- 未改需求，未删减完成条件；未引入 Pi SDK／RpcClient，工具参数结构不变。

## 结果与验证

交付内容：

- 桥接 CLI 调用全部异步（`runProcess`），工具 `execute` 透传 `signal`。
- `knit_run wait=true` 异步轮询；中止时结束等待、不取消 run，返回当前状态。
- 新增 `knit session context`，每轮上下文一次调用；300ms 内拿不到结果用上一轮缓存并标注“上下文可能过期”。
- 观察器串行、不重入，用一次 `run list --active --with-status`；有未到终态 run 时 5 秒，没有时 30 秒。
- `doctor` 新增 `installation-version`；桥接诊断记录 `cli_version`。
- `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts` 逐字节一致。

实际跑过的验证（2026-11-10，主会话，去掉阶段环境变量）：

- `npm test`：711 项全过，耗时约 269 秒。此前一次全量运行有 1 项失败（`真实模型冒烟：受控工具取消`，180 秒内没等到模型调用工具）；该用例依赖真实模型，单独重跑 5 项冒烟全过，随后的全量运行也全过，本任务没有改动它覆盖的代码。
- 完成条件对应的用例：
  - 上下文注入一次调用、超时用缓存：`test/bridge-query.test.mjs`「每轮上下文只调一次 session context」。
  - `wait` 期间可中止：同文件「wait=true 期间中止」。
  - 观察器降频：同文件「观察器：无活动 run 退避到 30 秒」。
  - 观察过滤修正：`test/m1-cli.test.mjs`「run list --active：结果已处理完的失败 run 与完成 run 同口径」、`test/bridge-query.test.mjs`「观察器：run list 查询失败不推进扫描时间」（后者连跑 3 次均过）。
- `cmp` 两份桥接一致；`git diff --check` 无问题；`knit doctor` 的 `installation-version` 为 ok。

未验证：macOS 上的行为；真实 Pi TUI 里中止 `wait=true` 的手感（只有 stub 宿主测试）。

## 运行引用

- run-fbfdaa59b1bf（implement，已取消）
- run-da8c20e7e342（implement，结果 completed，接收 accept-3869a240d269）

### 交付记录

<!-- knit:delivery:op-0ba605488214 -->
- 操作: op-0ba605488214
- 时间: 2026-11-10T16:33:00.242Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 调用: bridge
- 工作提交: 1d27ec7dd8584b3fd57baad66702abc30afa3940
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-bridge-async

<!-- knit:progress:end -->
