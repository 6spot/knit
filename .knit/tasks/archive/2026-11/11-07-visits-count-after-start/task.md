---
id: k-3cdf35cd9d45
status: closed
stage: deliver
outcome: completed
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

### 跨机交接（2026-11-07）

交接到另一台机器执行：新机器没有本机 binding，stage=implement 时 `task ready` 会报 `phase_mismatch`（审计 S6）。因此把 frontmatter 改回 start，在新机器上重新 ready；输入未改。

### 实施与接收（2026-11-10）

- run-dacba35099cb（implement，magpie group/deepseek）completed 并自动接收（implementation_accepted），7 个路径。派发时 Rex 呈现启动失败（`rex_launcher_error`：`session.describe_block` 返回 `session_not_found`，主会话所在 Rex session 已不存在），按 `execution.host: auto` 回退 local 执行，未影响结果。
- 实现：`TaskFacts.started`（`binding.lastRunIds` 非空）；`inputsUpdated(kind=change)` 未开始时回 start 并清空 `stageVisits`，已开始保留；`pendingResolved` 复用同一函数。STATES 第 3 节、DESIGN §3.8／§4／§5.3 同步。

### 主会话核验

- 读完 `src/domain/task.ts`、`src/application/task-service.ts` 与文档 diff；核对 `lastRunIds` 只在 `run-acceptance.ts` 两处接收路径追加，失败／取消不追加；`binding?.lastRunIds?.length ?? 0` 兼容旧绑定缺字段。
- 全量 `npm test`（清除 Rex 呈现环境）：701/701 通过。新增 5 个测试覆盖：领域层未开始／已开始、准备期多次 change 不触发 `repair_round_limit`、已开始累计到上限、失败 run 不算开始、旧绑定缺 `lastRunIds`。
- 未验证：取消 run 路径没有单独的集成测试（与失败 run 共用“仅接收时追加”的判定）；未在 k-f0d9a8952aff 现场重放。

### 待确认

- “开始 = 至少一次被接收的 run”仍是 `[assumed]`（Agent 建议，待确认），按总计划 §6 授权照推荐项实施；用户若改口径，只需调整 `stageFactsOf` 的 `started` 取值。

### 交付记录

<!-- knit:delivery:op-a0d0ec712c3d -->
- 操作: op-a0d0ec712c3d
- 时间: 2026-11-10T10:54:15.723Z
- 分支: refs/heads/main
- 授权来源: user:b527d46a
- 调用: bridge
- 工作提交: 4c9b73e73810e6d9320070fe81866f1367883283
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-visits-count-after-start

### 任务资料提交记录

<!-- knit:metadata-commit:op-a0d0ec712c3d -->
- 任务资料提交: 195adfc47b02b87a33e5b8b485ef56bcf21666c7
- 归档目标: .knit/tasks/archive/2026-11/11-07-visits-count-after-start

<!-- knit:progress:end -->
