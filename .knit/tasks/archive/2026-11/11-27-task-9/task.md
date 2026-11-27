---
id: k-94c83d095af3
title: 补齐归档列表筛选、运行排障观测与 Pi 桥接动作
status: delivered
stage: null
verification: self
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T11:33:35.466Z
---

## 目标与范围

补齐 Knit 日常检索、运行排障可观测性与 Pi 桥接工具的实用缺口，严守轻核心定位（`docs/design/DESIGN.md` 第 11 节），不新增重型子命令：

1. **`knit task list` 归档排序与筛选（`src/cli/task.ts`）**：
   - `--archive` 列表改按 `createdAt` 降序排列（最新在最前；相同时间按 `id` 升序兜底）；普通活跃任务列表保持原 `priority` 升序 + `createdAt` 升序的树形展示不变。
   - 新增 `--limit <数量>`（必须为正整数，否则报错退出，退出码非 0）：限制展示的任务条数；当实际匹配任务数超过 `limit` 时，在任务列表末尾追加一行提示 `仅显示前 <limit> 条，共 <total> 条`（损坏目录提示与未合并任务分支提示保留在后，不被截断）。
   - 新增 `--grep <关键词>`（不区分大小写，匹配任务 `id` 或 `title`，支持活跃与归档列表）：过滤后只展示命中任务；活跃列表中父任务未命中时沿用既有规则作为顶层显示并保留 `父:<id>` 标记；传入 `--grep` 且无任何命中时输出 `没有匹配的任务`（未传 `--grep` 且为空时保持输出 `没有任务`）。

2. **运行状态与上下文排障观测（`src/application/session-context.ts`）**：
   - `buildTaskStatus` 为每个成员补充 `workerLog` 字段（仅当 `.knit/.runtime/runs/<runId>/worker.log` 存在时为其相对路径，否则 `null`）。
   - `statusLines` 展示并行成员（`member.run.batchId` 非空）时，仅在 `member.report !== null` 时输出 `报告: ${member.report}`，避免执行中或失败未产出报告时打印指向不存在文件的路径。
   - `runLines` 在以下两种故障场景且 `member.workerLog !== null` 时输出 `日志: ${member.workerLog}`：
     - 已结束且失败（`run.endedAt !== null && run.failure !== null`）；
     - 进程已异常退出（`run.endedAt === null && !member.starting && !member.worker`）。
   - `nextLine` 在任务状态为 `delivered` 或 `cancelled` 时返回 `下一步: 任务已结束，可取消选中（knit context --unuse）`。

3. **`knit task show <id>` 信息补齐（`src/cli/task.ts`）**：
   - 当任务对应的 Worktree 存在且包含 `.git` 时，展示 `Worktree: <path>（<branch>）`。
   - 当 `clarify.blockingItems.length > 0` 时，在 `待澄清:` 行之后逐条缩进列出具体 blocking 项（`  - <item>`）。
   - 当 `record.runs.length > 0` 时，展示紧凑的 `执行历史（<N> 次）:` 区块，每条一行包含执行 ID、环节（并行成员附 `/<executor>`）、Agent 与结果摘要（`进行中` / `失败: <failure>` / `结论: <verdict>` / `正常结束`）。

4. **`knit standards list` 展示规范大小（`src/cli/project.ts`）**：
   - 每条规范末尾追加正文 UTF-8 大小提示（`< 1024` 字节显示 `<N> B`，`>= 1024` 字节显示 `<N.N> KB`，以 `Buffer.byteLength(standard.body, "utf8")` 计算），便于发现过长规范对上下文的占用。

5. **Pi 桥接动作补齐（`assets/templates/pi/extensions/knit.ts`）**：
   - `knit_task` 的 `action` 新增 `"show"` 与 `"cancel"`：
     - `show`：要求 `taskId`，调用 `knit task show <taskId>`；
     - `cancel`：要求 `taskId` 与非空 `reason`，调用 `knit task cancel <taskId> --reason=<reason>`；
     - `list`：支持可选 `limit`（number）与 `grep`（string），透传 `--limit=<limit>` 与 `--grep=<grep>`。
   - `knit_run` 的 `cancel` 支持可选 `runId`（string），透传 `--run=<runId>`。
   - 同步更新工具 `description` 与 JSON Schema `parameters`（不修改仓库根下已生成的 `.pi/` 副本）。

6. **文档与测试同步**：
   - 同步更新 `docs/design/DESIGN.md` 中涉及 `task list`、`task show`、`standards list`、`run status` / `context` 与 Pi 桥接的相关说明。
   - 检查既有测试对 `--archive` 排序、`statusLines`、`task show`、`standards list` 的断言并合理适配，补齐所有新增行为的单元测试。

## 完成条件

- `knit task list --archive` 默认按 `createdAt` 降序返回；`--limit` 校验正整数并在截断时输出 `仅显示前 N 条，共 M 条`；`--grep` 对活跃与归档列表均支持不区分大小写的 `id`/`title` 匹配。
- `session-context`（`knit context` / `knit run status` / `knit run wait`）：并行成员无 `report.md` 时不输出空壳 `报告:` 行；运行失败或进程异常退出且存在 `worker.log` 时输出 `日志:` 行；`delivered`/`cancelled` 任务展示 `下一步: 任务已结束，可取消选中（knit context --unuse）`。
- `knit task show <id>` 展示有效 `Worktree`、具体 `blocking` 项清单以及非空 `执行历史（N 次）:` 摘要。
- `knit standards list` 在每条规范后附带 B / KB 大小。
- `assets/templates/pi/extensions/knit.ts` 支持 `knit_task` 的 `show`、`cancel`、`list(limit, grep)` 与 `knit_run` 的 `cancel(runId)`，且通过桥接测试。
- `docs/design/DESIGN.md` 已同步更新。
- 验证通过：`npm run typecheck`、`npm run build` 和全量 `npm test`（因修改共享 Pi 桥接模板）均全部通过（跨卷测试如环境无挂载卷允许跳过）。

## 待澄清

## 相关资料

- `src/cli/task.ts`
- `src/cli/project.ts`
- `src/application/session-context.ts`
- `assets/templates/pi/extensions/knit.ts`
- `docs/design/DESIGN.md`
- `test/task-lifecycle.test.mjs`、`test/context.test.mjs`、`test/standards.test.mjs`、`test/bridge.test.mjs`、`test/bridge-run.test.mjs`、`test/run-control.test.mjs`

## 结果

已补齐归档列表按创建时间降序与 --grep/--limit 筛选、session-context 排障日志与无报告隐藏及已结束任务取消选中提示、task show 的 Worktree/blocking 项/执行历史摘要、standards list 的 UTF-8 正文大小，以及 Pi 桥接的 show/cancel/list 筛选与 cancel(runId) 动作，并同步 DESIGN.md 与测试。已在任务 Worktree 中验证 npm run typecheck、npm run build、定向测试（176/183 通过，7 项跨卷跳过）及全量 npm test（584/591 通过，0 失败，7 项跨卷跳过）。
