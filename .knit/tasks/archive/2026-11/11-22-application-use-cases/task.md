---
id: k-e03319df1da4
title: 下沉任务、交付与上下文用例至应用层并返回结构化结果
status: delivered
stage: null
verification: independent
parent: k-d123fec5fa11
dependsOn: []
priority: P1
createdAt: 2026-11-22T06:32:51.477Z
---

## 目标与范围

将目前直接写在 `src/cli/` 命令处理器里的业务用例编排、状态迁移规则和交付事务回滚下沉到 `src/application/`，并建立结构化结果对象与 CLI 展示渲染之间的清晰边界：

1. **下沉任务生命周期用例（`src/cli/task.ts` → `src/application/`）**：
   - 现状：`task ready`（`readyProblems` 校验、状态迁移与 `confirmedDigest` 写回）、`task close`（状态拒绝、独立审查校验、路径检查、运行中拒绝、`--reason` 拼装与 `changedPaths` 合并）、`task cancel`（状态与运行中校验、取消写回、归档及 Worktree 强制清理）的全部业务逻辑都在 `src/cli/task.ts` 的 Commander action 中。
   - 做法：在 `src/application/`（如 `task-lifecycle.ts` 或 `task-store.ts` 旁的新模块）提供纯用例函数 `readyTask`、`closeTask`、`cancelTask`，返回带明确状态/结果字段的判别联合类型；`src/cli/task.ts` 只做参数收集、调用用例和按结果渲染 stdout/stderr 与退出码。
2. **下沉交付事务与回滚流程（`src/cli/deliver.ts` → `src/application/delivery.ts`）**：
   - 现状：整个交付流程（状态检查、配置检查、任务目录备份与移动、写 `delivered` 与授权、调用 `commitDelivery`、失败时 `git reset` 与目录/状态回滚、调用 `mergeAndCleanWorktree`、合并失败删除主检出恢复出的旧任务目录）全部写在 `src/cli/deliver.ts` 中。
   - 做法：将完整事务编排封装为 `deliverTask()` 放进 `src/application/delivery.ts`，返回结构化结果（包含交付成功、归档路径、提交摘要与差异、自动合并与清理结果，或拒绝/回滚原因）。
   - 同步改造 `src/application/worktree.ts` 中的 `cleanCancelledWorktree` 与 `mergeAndCleanWorktree`，返回结构化数据（例如已删/保留的 Worktree 与分支、丢弃文件数、合并成败与原始 Git 错误）而非预先拼好的中文输出行 `lines: string[]`，由 `src/cli/` 统一渲染。
3. **下沉主会话上下文拼装并消除 `<standard>` 块重复渲染（`src/cli/context.ts` → `src/application/`）**：
   - 现状：`src/cli/context.ts` 直接负责按 `discuss` 与 `sessionStage` 筛选、去重规范并拼装 `<standard path="..." title="...">` 块，与 `src/application/handoff.ts` 里的块渲染逻辑重复。
   - 做法：在 `src/application/` 提供 `buildSessionContext()`（复用与 `handoff.ts` 一致的规范块渲染辅助），返回结构化上下文（讨论规范、选中任务状态/路径/补充规范等），`src/cli/context.ts` 仅负责渲染输出，并严格保持「任务状态与规范不变时输出逐字不变」的不变量。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。
- 本任务是纯架构分层重构：所有现有 CLI 命令（`knit task`、`knit deliver`、`knit context`）的标准输出文案、错误提示和退出码行为必须保持向后兼容，不新增 CLI 子命令或 `--json` 参数，不修改 `src/adapters/*`。

## 完成条件

### Requirement: 任务生命周期与交付事务可在应用层独立调用且回滚行为等价

#### Scenario: 应用层用例直接完成 ready、close、cancel 与 deliver 并支持交付失败回滚

- GIVEN 临时 Git 仓库夹具中的任务（覆盖主检出直接完成与派发至 Worktree 的任务）
- WHEN 直接调用 `application/` 导出的 `readyTask`、`closeTask`、`cancelTask` 与 `deliverTask`（包含 Git hook 拒绝提交触发回滚及 `autoMerge` 合并冲突的场景）
- THEN 各用例返回结构化结果对象（不直接读写 `process.stdout`/`process.stderr`/`process.exitCode`），交付被 Git 拒绝时正确恢复任务目录、`task.md` 状态为 `done` 且撤回授权，合并冲突时保留任务分支与 Worktree 并在结构化结果中携带 Git 原始错误

### Requirement: worktree 清理/合并与会话上下文返回结构化结果且 CLI 输出兼容

#### Scenario: worktree 与 context 返回结构化数据且现有 CLI 回归测试全绿

- GIVEN 现有 `test/*.test.mjs` 全部 CLI 端到端与回归测试套件
- WHEN 运行 `buildSessionContext`、改造后的 `cleanCancelledWorktree`／`mergeAndCleanWorktree`，以及全量 `npm run typecheck` 和 `npm test`
- THEN `src/cli/deliver.ts` 不再包含目录备份／移动／`git reset` 回滚逻辑，`src/application/worktree.ts` 不再直接拼装中文终端文案，且现有全部 CLI 测试（含 `context` 逐字稳定性和 `deliver` 预览/归档/自动合并测试）在 macOS 普通终端与 Rex 终端全部通过

## 待澄清

## 相关资料

- `src/cli/task.ts` — 当前包含 `ready`/`close`/`cancel` 业务逻辑的 CLI 文件
- `src/cli/deliver.ts` — 当前包含交付事务与回滚逻辑的 CLI 文件
- `src/cli/context.ts` — 当前包含上下文规范去重与 XML 渲染的 CLI 文件
- `src/application/delivery.ts` — 现有交付预览与提交模块
- `src/application/worktree.ts` — 当前返回中文 `lines` 的 `cleanCancelledWorktree` 与 `mergeAndCleanWorktree`
- `src/application/handoff.ts` — 执行者交接块渲染参考
- `docs/design/DESIGN.md#8-完成与交付` — 完成、交付、回滚与自动合并规则

## 结果

已将 readyTask/closeTask/cancelTask（src/application/task-lifecycle.ts）、deliverTask（src/application/delivery.ts）及 buildSessionContext（src/application/session-context.ts）下沉到应用层并返回结构化结果；cleanCancelledWorktree 与 mergeAndCleanWorktree 改为返回结构化数据，CLI 统一负责渲染（新增 src/cli/worktree.ts）。完成条件全部满足。独立审查（r-84f0a03a4be8）结论 pass（0 文件审查修改）：npm run typecheck 退出 0，30 组重构前后 CLI 对比完全一致，macOS 普通终端与 Rex 终端 npm test 各 405/405 通过。额外记录：审查发现基线已存在部分暂存任务文件在 hook 拒绝后被重置为 HEAD 的既有行为，属等价重构范围外。
