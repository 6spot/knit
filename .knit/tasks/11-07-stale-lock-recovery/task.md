---
id: k-6f0616f3779d
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 30
createdAt: 2026-11-07T11:44:05.686Z
title: 崩溃锁自动回收、心跳与 unlock 可用性
---

# 崩溃锁自动回收、心跳与 unlock 可用性

## 目标与边界

### 背景与问题

审计复现：`kill -9` 杀掉 worker 后，project 锁与 session 锁一直残留。`knit locks` 已判 `not_alive`，`doctor` 也报 stale 2，但：

- `task new`、`run implement`、`resume` 全部返回 `lock already held`；`resume` 明确拒绝"旧执行的项目锁尚未释放"。
- `knit unlock <lockId>` 帮助里有位置参数，实际报 `required option '--scope'`，必须手工拼 `--scope`、`--key`（原始路径）和 `--expect-token`。
- owner 的 `heartbeatAt` 一直停在获取时刻，`heartbeatStaleMs` 不参与判定。
- macOS 上进程身份回退到 `ps lstart`，只精确到秒，同秒 PID 复用会误判 alive／not_alive。

### 交付范围

1. 自动回收：acquire 遇到 EEXIST 时检查 owner。同一 `machineBootId` 且进程核实为 `not_alive`，就原子回收（改名进回收区后重建），写诊断事件与锁回收记录。`unknown` 仍 busy。
2. 心跳：持锁的 worker 按 `heartbeatIntervalMs` 刷新 `heartbeatAt`；`doctor`／`locks` 显示心跳是否超时。超时本身不触发回收，仍以进程核实为准。
3. macOS 进程身份：`lstart` 加上启动命令（或其它更细粒度标识）一起比对，降低 PID 复用误判；Linux 维持 `/proc` 方案。
4. `unlock <lockId>` 位置参数可用：从锁列表反查 scope 与 key，仍要求 `--expect-token`（可加 `--from-list` 便捷确认）；`locks` 接受 `--dir` 只列本项目。
5. `lock_busy` 错误带 owner 动作、pid、核实结论与下一步命令。
6. 同步 OPERATIONS 锁章节与 `doctor` 文案。

### 非目标

- 不改锁域拆分：属于前置任务 `k-f0d9a8952aff`。
- 不做跨机或网络文件系统上的锁回收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 自动回收只在同一启动周期（bootId 相同）且进程确认已死时进行，其它情况仍需人工 `unlock`

## 完成条件

- 自动化测试：worker 被 SIGKILL 后，下一次 `task new`／`run implement` 自动回收并成功；回收事件可在诊断中查到。
- owner 进程仍存活时不回收；owner 身份 unknown 时不回收。
- `knit unlock <scope/hash> --expect-token <t>` 成功；`knit locks --dir <d>` 只列本项目。
- 心跳在长阶段中前进，`doctor` 能区分心跳正常与超时。

## 输入引用

- 审计 S1。
- `src/infrastructure/locks.ts:180-400`、`src/infrastructure/process.ts:13-30,177-250`、`src/application/run-coordinator.ts:150-170,712-727`、`src/cli` 中 locks／unlock 命令。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
