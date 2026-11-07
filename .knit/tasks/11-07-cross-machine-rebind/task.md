---
id: k-434714cbbb68
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P2
dependsOn:
  - k-836997c84864
order: 20
createdAt: 2026-11-07T11:44:09.525Z
title: 跨机 rebind 与可交付资格权威口径
---

# 跨机 rebind 与可交付资格权威口径

## 目标与边界

### 背景与问题

binding、scope 与凭据都存在被 ignore 的 SQLite 和 `.runtime` 里，task.md 上的 stage 没有任何东西支撑。审计复现：clone 后进行中的任务（`stage: deliver`）：

- `run check` 报"任务缺少绑定"；
- `task close` 报 `inputs_not_confirmed`；
- `task ready` 报 `phase_mismatch`；
- `task adopt` 与 `task implement` 都成功，但之后 `close` 仍然失败；
- 唯一出路是提交一次虚构的 `change` 输入更新，退回 start。

STATES 第 141 行写了"跨机按 verification 重建完成资格"，但没有命令能做。这也和"task.md 是业务状态唯一权威"的说法自相矛盾。

### 交付范围

1. 新命令 `knit task rebind <taskId>`（桥接 `knit_task action=rebind`）：
   - 为没有 binding 的任务按 task.md 建立 binding；
   - 当前输入摘要作为待确认摘要；
   - stage 不是 start 时，降到"最近一个需要证据的阶段"：self 回到首个工作阶段，independent 有实施记录时回到检查阶段；
   - 原 stage 和降级原因写进记录区；
   - 不伪造 run 或凭据。
2. 自动发现：`status`、`task list`、桥接上下文遇到"task.md 非 start 但无 binding"时，标记 `binding_missing`，`nextAction` 指向 `task rebind`。
3. `task implement` 在无 binding 时一并建立 binding，并按主会话实施记录建立资格，使 self 任务在登记实施后可以 close。
4. 文档统一口径：业务意图（目标、验收、stage 名义）以 task.md 为准；可交付资格（scope、凭据、确认摘要）是本机事实，换机后必须重建。改写 AGENTS／DESIGN 第 3 节和 STATES 中"唯一权威"的相关表述。

### 非目标

- 不把凭据或 scope 提交进 Git。
- 不做跨机同步服务。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- rebind 不消耗 `stageVisits` 预算

## 完成条件

- 自动化测试：clone 后 deliver 阶段的 self 任务 → `task rebind` → `task implement --path …` → `close` 成功；independent 任务 rebind 后回到检查阶段，`run check` 可派发。
- `status` 对无 binding 任务给出 `binding_missing` 与 `nextAction`。

## 输入引用

- 审计 S6。
- `src/application/task-service.ts`（adopt、implement、close）、`src/application/context-planner.ts:390`、`docs/design/STATES.md:141`、`docs/design/DESIGN.md` 第 3 节。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
