---
id: k-4367ce59738d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-05T22:43:26.411Z
title: 提示词与诊断修复：coverage 每项一路径、ready 无参拒绝、取消归档结束位置
---

# 提示词与诊断修复：coverage 每项一路径、ready 无参拒绝、取消归档结束位置

## 目标与边界

修三处一致性与诊断问题，行为语义保持既有约定：

1. **coverage 提示**：`src/application/run-acceptance.ts:386-399` 的 `check_scope_incomplete` 采用前缀匹配——`coverage` 每项必须等于某个 scope 路径，或以该路径开头且后面不是 `[A-Za-z0-9._/-]`。把多个路径用逗号合并成一项不会被算作覆盖。核心生成的阶段要求与检查提示词要明确“每项一个路径”。
2. **`knit task ready` 无参**：`src/cli/task.ts:444` 允许省略 taskId，`undefined` 一路传到 `locate()`，报「任务不存在: undefined」。应明确拒绝并支持按主会话当前选择解析。
3. **取消→归档结束位置**：`task close --outcome cancelled` 按设计保留停止位置，但 `src/application/task-history.ts` 的 `archivedHistoryProblems()` 要求 `stage=deliver`，导致归档后列表显示「档案异常」。应只对 `completed` 要求 deliver，`cancelled/superseded` 接受停止位置。

边界：不改状态机、不改接受判定强度；只补提示、诊断与归档有效性判断。

## 完成条件

- `stageRequirementOf()` 的结论阶段要求包含“coverage 每项一个路径（可写成「路径：核对内容」），不要合并多项；scope 中每个路径都要单独出现，否则接收会以 check_scope_incomplete 拒绝”。
- `reportTemplateOf()` 中 `coverage` 示例为 `["src/app.ts：核对内容"]`。
- `assets/templates/.knit/agents/check.md` 的 coverage 说明补同一句规则（本仓库 `.knit/agents/check.md` 由主会话在 run 之外同步，实施 run 不得改 `.knit/`）。
- `knit task ready`（无 taskId、无 `--session`）退出码 1，reason `task_id_required`，输出不含 `undefined`；`--session <knitSessionId>` 时有已落盘选择则用它，选择未落盘报 `selection_pending`，无选择报 `selection_missing`。
- `TaskService.ready()` 对空 taskId 抛 `invalid_request`；`locate()` 有空值保护。
- `archivedHistoryProblems()`：`completed` 仍要求 `stage=deliver`；`cancelled`／`superseded` 只要求 stage 非空，归档列表不再报「档案异常」。
- `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts` 一致：`knit_task` 的 `ready`／`record`／`close` 未传 taskId 时使用本轮 `session resolve` 的当前任务；无选择时返回同一句明确提示。

## 输入引用

- 设计：`docs/design/DESIGN.md` §3.9（状态转移与展示）、§4.3（命令面）；`docs/design/STATES.md` §3（结束与归档字段）；`docs/design/OPERATIONS.md` 的 `task ready` 与检查接收条目。
- 代码：`src/application/stage.ts`、`src/application/task-history.ts`、`src/cli/task.ts`、`src/application/task-service.ts`、`src/application/run-acceptance.ts`、`src/application/session-service.ts`、`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`。
- 测试：`test/stage-contract.test.mjs`、`test/m1-cli.test.mjs`、`test/task.test.mjs`、`test/session.test.mjs`、`test/bridge-query.test.mjs`、`test/init.test.mjs`。
- 验证入口：`npm run typecheck`、`npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-5f9c9ae9aff1，24 分钟）

- `src/application/stage.ts`：`stageRequirementOf()` 对声明了 `coverage` 的结论阶段追加明确规则——每项一个路径（可写「路径：核对内容」）、不合并多项、scope 中每个路径都要单独出现；`reportTemplateOf()` 的 `coverage` 示例改为 `["src/app.ts：核对内容"]`。
- `assets/templates/.knit/agents/check.md`：`coverage` 说明补同一句规则。
- `src/cli/task.ts`：`ready` 无 taskId 且无 `--session` → `task_id_required`；新增 `--session`，用 `SessionService.resolveSelection` 取已落盘选择，未落盘 `selection_pending`、无选择 `selection_missing`。
- `src/application/task-service.ts`：`ready()` 入口与 `locateTaskDocument()`／`locate()` 增加空 ID 保护（`invalid_request`），不再把 `undefined` 传进索引查询。
- `src/application/task-history.ts`：`completed` 仍要求 `stage=deliver`；`cancelled`／`superseded` 只要求 stage 非空（保留停止位置），归档列表不再报「档案异常」。
- `.pi/extensions/knit.ts` + `assets/templates/pi/extensions/knit.ts`（两份一致）：`knit_task` 的 `ready`／`record`／`close` 省略 taskId 时使用本轮 `session resolve` 的当前任务；无选择时返回明确提示。
- 测试：新增／更新 `test/stage-contract.test.mjs`、`test/session.test.mjs`、`test/task.test.mjs`、`test/task-history.test.mjs`、`test/bridge-query.test.mjs`。

### 验证（主会话复核 2026-11-05）

- `npm test`：512/512 通过（一次运行出现 1 例既有间歇失败，复跑全绿；仍是 `test/stage.test.mjs` 的 stderr 竞态，与本任务无关）。
- 实跑 CLI：`knit task ready`（无参）→ 退出码 1，输出 `缺少 taskId：knit task ready <taskId>；或先 knit task use <taskId> --session <id> 再用 --session 解析（task_id_required）`；JSON 输出 `data.reason=task_id_required`、`reasonCode=invalid_request`。修复前是 `任务不存在: undefined`。
- `node --test test/session.test.mjs`：11/11 通过（覆盖 `--session` 已落盘／pending／missing 三种情形）。
- 本仓库 `.knit/agents/check.md` 已由主会话与模板同步；`knit init --check` 三项 agents 均为「沿用」。
- 两份桥接 `diff` 一致。

### 主会话补充修改（交付时说明）

- `src/cli/task.ts` 的三处拒绝信息改为带原因码的人读文本（`knit: 缺少 taskId：…（task_id_required）`），JSON 保持 `data.reason` 为语义码、`reasonCode=invalid_request`，与既有 CLI 错误口径一致；测试 11/11 通过。

### 已知边界

- `--session` 只解析主会话已落盘的选择；普通 shell 无会话身份时仍要求显式 taskId（这是设计内的明确失败）。
- 归档放宽只针对 `cancelled`／`superseded`；`completed` 仍必须 `stage=deliver`。

### 更正（交付前）

- 撤回上一条“主会话补充修改”：run 接收后再改 scope 内文件会让完成评估报 `scope_changed`。`src/cli/task.ts` 的“带操作提示的消息”改动已还原为 run 原样（`knit: task_id_required`，退出码 1），该项移交任务 B（`k-c8e440a3d4dd`）一并处理。
- 复核：还原后 `node --test test/session.test.mjs` 11/11 通过；`npm run build` 通过；实跑 `knit task ready` 退出码 1。

### 交付记录

<!-- knit:delivery:op-6c180fd08fb6 -->
- 操作: op-6c180fd08fb6
- 时间: 2026-11-05T23:21:19.157Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：任务 A（提示词与诊断修复）按讨论方案实施并本地提交，不含 push／发布
- 工作提交: e0290a6de8d1269778415dda0d5636b45ba46097
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-coverage-prompt-and-ready-guard

### 任务资料提交记录

<!-- knit:metadata-commit:op-6c180fd08fb6 -->
- 任务资料提交: 03460ef4e4cd4e4bb1c61c7e5cf048f7ee22808a
- 归档目标: .knit/tasks/archive/2026-11/11-05-coverage-prompt-and-ready-guard

<!-- knit:progress:end -->
