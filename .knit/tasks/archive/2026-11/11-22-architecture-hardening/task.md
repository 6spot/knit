---
id: k-d123fec5fa11
title: 加固多 Agent 接入与用例分层架构（主任务）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-22T06:32:33.917Z
---

## 目标与范围

这是主任务，用于在全面接入 Antigravity（`agy`）及后续扩展更多执行器与功能之前，先把 Knit 的核心分层边界与扩展点理顺，降低未来迁移和重构成本。主任务不直接产出代码，具体实现与验证由子任务分别交付；子任务拆解与与现有 Antigravity 修复任务（`k-cdf8de80d14c`）的依赖衔接见 `.knit/tasks/11-22-architecture-hardening/plan.md`。

本次纳入范围的 4 项架构加固：

1. **收敛 Agent 规格描述表（`k-84165a4f76ee`）**：把各执行器（`pi`、`antigravity`）的模型格式、思考等级范围、顶层流程缺省继承规则与展示文案收敛为统一的规格描述表，消除 `contracts`、`domain`、`application`、`cli` 四层对具体 Agent 名的分支硬编码与重复校验；顺手将通用 `schemaProblems` 从 `contracts/task.ts` 归位至 `contracts/schema.ts`。
2. **下沉核心用例至应用层并返回结构化结果（`k-e03319df1da4`）**：将 `cli/task.ts`（`ready`、`close`、`cancel`）、`cli/deliver.ts`（交付事务与回滚）、`cli/context.ts`（主会话上下文拼装）里的业务编排与事务逻辑下沉到 `src/application/`，让应用层用例及 `worktree` 清理/合并函数返回结构化结果对象，`cli/` 只负责参数绑定与中文文案渲染，保持现有 CLI 输出与退出码兼容。
3. **反转应用层对适配器的依赖并抽出窗格宿主端口（`k-0821df285a6f`）**：打断 `application` 与 `adapters` 之间的层级双向依赖，在 `contracts/` 定义薄的 `PaneHost` 端口接口（由 Rex 适配实现），通过入口注入执行器注册表与窗格宿主，并收口窗格执行生命周期外壳，避免每个新执行器重复拼装 `registerPane`／信号退出／`writePaneOutcome`。
4. **消除热路径全量扫描、运行时状态文件改为原子写入并清理遗留死代码（`k-053fe369b3ec`）**：让 `findTask` 优先按活跃目录查找、找不到再查归档，消除 `statusLines` 的重复查库；将 `worker.json`、`before.json`、`after.json` 统一改为 `atomicWrite`；移除生产代码已零引用的历史 `NodeProcessPort`。

明确不在本主任务范围内（延后，不做过度设计）：

- 不提前设计第二套主会话宿主桥接分发机制或 MCP Server（待实际需要接入第二个主会话宿主时再立项）。
- 不重做 `antigravity` 适配器的 macOS `sandbox-exec` 跨平台隔离方案（待外部 `agy` CLI 自身提供跨平台隔离能力或立项跨平台支持时再处理）。
- `cleanAgyRuntime` 抛错阻断 `finishRun` 入账的问题已由现有子任务 `k-c84dae7772e7` 覆盖，本主任务不重复处理。

## 完成条件

### Requirement: 架构加固子任务全部交付且全量验证通过

#### Scenario: 4 个架构子任务按依赖顺序完成交付

- GIVEN `.knit/tasks/11-22-architecture-hardening/plan.md` 列出的 4 个子任务
- WHEN 各子任务按依赖顺序完成实现、审查与交付，且主任务汇总交付提交与验证结果
- THEN 4 个子任务全部处于 `delivered`（或经用户决定 `cancelled`），主任务自身无代码改动
- AND 在 macOS 普通终端与 Rex 终端运行 `npm test` 全部通过，`npm run typecheck` 与 `npm run pack:check` 均通过

## 待澄清

## 相关资料

- `.knit/tasks/11-22-architecture-hardening/plan.md` — 架构加固子任务清单与依赖排期
- `.knit/tasks/11-22-agy-and-worktree-fixes/plan.md` — 现有 Antigravity 修复与 Worktree 安全任务清单（承接本主任务）
- `docs/design/DESIGN.md` — 现行设计文档
- `src/contracts/agent.ts` — 执行器适配器契约
- `src/contracts/workflow.ts` — 工作流与 Agent 参数契约
- `src/adapters/agents.ts` — 内置执行器注册表

## 结果

4 个架构加固子任务全部交付并合并至 main：k-84165a4f76ee（4e18620）、k-e03319df1da4（178eba3，合并 205e4a4）、k-0821df285a6f（976eac2）、k-053fe369b3ec（c7d30fd）。主任务无代码改动。验证：最终代码基线 c7d30fd 已在 macOS 普通终端与 Rex 终端各通过 npm test 409/409，主检出 npm run typecheck 与 npm run pack:check 均通过。
