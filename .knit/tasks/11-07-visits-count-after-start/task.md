---
id: k-3cdf35cd9d45
status: open
stage: implement
outcome: null
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: 10
createdAt: 2026-11-07T05:34:28.319Z
title: 阶段访问计数只在开始后生效：准备期改需求不消耗修复预算
---

## 目标与边界

### 背景与问题

`stageVisits` 在 `ready` 进入阶段时累加（`src/domain/task.ts:209` `enterStage`），而 `update --kind change` 会回到 `start`（`src/domain/task.ts:315`）并保留访问计数。准备期每改一次需求就消耗一次进入预算：

- 现场：`k-f0d9a8952aff` 在尚未执行任何 run 前，4 次 `change` 把 `stageVisits.implement` 推到 3，`maxVisits`（`workflow.maxRepairRounds: 2`）只允许进入 3 次，`task ready` 被 `repair_round_limit` 拒绝。
- `repairRounds` 不受影响：它只在 `repairRoundCompleted` 之后累加（`src/application/run-acceptance.ts:470`），本来就是开始后才计。

### 交付范围

- 新增“已开始”事实：任务至少有过一次被接收的 run（`binding.lastRunIds` 非空）。
- 未开始时，`inputsUpdated(kind=change)` 清空 `stageVisits`；已开始后维持现状。
- `pendingResolved` 走同一转移，自动获得相同行为。
- 补文档与测试；不改配置与默认值。

### 非目标

- 不改 `repairRounds`、`maxVisits` 刻度或 `workflow.maxRepairRounds` 默认值。
- 不自动迁移或重置已有任务的计数；`k-f0d9a8952aff` 已手工复位并留有备份。
- 不改 `newRepairCycle` 语义。

## 关键决定

- 计数从第一次接收 run 开始；准备期改需求不占预算。
- 用“未开始时重置”而不是“准备期完全不计数”，保住首次进入占一格的现有刻度，不偷偷放宽修复轮次。
- “已开始”按已接收 run 判定；派发但未接收（失败、取消）不算。

## 完成条件

- 无已接收 run 的任务：连续 N 次 `update --kind change` 加 `ready` 不触发 `repair_round_limit`，`stageVisits` 不增长。
- 已有接收 run 的任务：`change` 回 start 后 `ready` 正常累加；超过 `maxVisits` 仍报 `repair_round_limit`。
- 只有失败或取消 run、没有接收 run 的任务，仍按未开始处理。
- 旧 binding 缺 `lastRunIds` 时按未开始处理，不报错。
- 单元测试覆盖未开始与已开始两条路径；`npm test` 通过。

## 实施要点

- `src/domain/task.ts`：`TaskFacts` 增加 `started?: boolean`；`inputsUpdated` 在 `kind === "change" && !started` 时返回 `OPEN(ANCHOR_START, {}, stopReasonOf(task))`，清空访问计数；`pendingResolved` 复用该函数即可。
- `src/application/task-service.ts`：`stageFactsOf` 从 binding 填 `started: binding.lastRunIds.length > 0`；`updateDirect` 与 `applyPending` 都经它取事实。
- 元数据无需 schema 变更：`lastRunIds` 已存在（`src/contracts/metadata.ts:14`），旧记录缺省为空。
- 文档：`STATES.md` 第 3 节说明计数起点；`DESIGN.md` 第 5.3 节附近同步。
- 测试：在现有状态机测试文件中覆盖“未开始多次 change 不涨计数”“已开始 change 仍计数并可达上限”两组。

## 风险与回滚

- “已开始”按已接收 run 判定；若把启动失败也算开始，基础设施问题会消耗预算。当前选择更宽松。
- 旧任务缺 `lastRunIds` 时按未开始处理，可能多给一次重置；只影响计数，不影响业务状态。
- 回滚只需还原 `inputsUpdated` 的重置分支。

## 输入引用

- 用户决定：修复轮次只在任务开始后才计次，开始前不计次。
- 现场记录：`k-f0d9a8952aff` 的业务进度区“阻塞与复位（讨论期）”；binding 备份在 `.knit/.runtime/binding-backup-k-f0d9a8952aff.json`。
- [docs/design/STATES.md](../../../docs/design/STATES.md) 第 3 节
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) 第 5.3 节

## 依赖与交接

- 无硬前置。与 `k-f0d9a8952aff` 的锁与归属改动没有代码依赖，可独立实施。

## 待澄清

- [assumed] “开始”定义为任务有过至少一次被接收的 run；派发但未接收（失败、取消）不算。（Agent 建议，待确认）

## 待讨论与待验证事项

无 `[blocking]`。实施时核对：`lastRunIds` 在取消与失败路径上是否确实不追加；旧 binding 缺字段的读取路径。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
