---
id: k-0524fc52e81b
status: open
stage: start
outcome: null
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

<!-- knit:progress:end -->
