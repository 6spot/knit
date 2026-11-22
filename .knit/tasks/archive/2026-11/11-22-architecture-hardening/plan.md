# 架构加固子任务清单

主任务 `k-d123fec5fa11`。在推进 Antigravity 边界修复主任务（`k-cdf8de80d14c`）及后续扩展更多执行器／宿主前，先把最影响长期维护成本的四处架构边界整理清楚。

| 顺序 | 子任务 | 编号 | 验证 | 前置依赖 | 做完之后有什么不同 |
| --- | --- | --- | --- | --- | --- |
| 1 | [收敛 Agent 规格描述表，消除业务层对具体 Agent 名的分支硬编码](../11-22-agent-spec-registry/task.md) | `k-84165a4f76ee` | `independent` | 无 | `workflow` 校验、`run-prepare` 派发校验和 `workflow show` 统一消费 `AgentSpec` 描述表，新增 Agent 不再在 4 层改 `if/else`；`schemaProblems` 归位 `contracts/schema.ts` |
| 2 | [下沉任务、交付与上下文用例至应用层并返回结构化结果](../11-22-application-use-cases/task.md) | `k-e03319df1da4` | `independent` | 无 | `task ready/close/cancel`、`deliver` 事务回滚和 `context` 拼装下沉到 `application/` 并返回结构化结果，`worktree` 清理/合并不再直接返回展示文案，CLI 只做参数解析与渲染 |
| 3 | [反转应用层对适配器的依赖并抽出窗格宿主端口](../11-22-invert-adapter-dependencies/task.md) | `k-0821df285a6f` | `independent` | `k-84165a4f76ee` | `application` 不再静态依赖 `adapters/`，通过 `contracts/pane.ts`（`PaneHost`）与入口注入解耦 Rex 和执行器，收口通用窗格生命周期外壳 |
| 4 | [优化按 ID 查找任务性能、运行时状态文件改为原子写入并清理遗留代码](../11-22-task-lookup-and-atomic-runtime/task.md) | `k-053fe369b3ec` | `self` | `k-84165a4f76ee`、`k-e03319df1da4`、`k-0821df285a6f` | `findTask` 优先查活跃任务不再每次全量解析归档，`statusLines` 不重复查库，`worker.json`/`before.json`/`after.json` 改用 `atomicWrite`，移除未使用的 `NodeProcessPort` |

## 与现有主任务 `k-cdf8de80d14c` 的衔接

- 第 1 项与第 2 项改动文件互不重叠，可并行执行；第 3 项依赖第 1 项；第 4 项依赖前 3 项。
- 现有 Antigravity 修复主任务（`k-cdf8de80d14c`）的第一个子任务 `k-77935d729cf5` 依赖 `k-053fe369b3ec`：架构边界收口后再改 `src/adapters/antigravity/*`、`task-store.ts` 与 `context`，避免先往旧边界里加逻辑再二次搬迁和合并冲突。
- 执行者不得修改受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查）；模板改动写入 `assets/templates/`。
- 每个子任务完成后在 macOS 普通终端与 Rex 终端各跑一次 `npm test`，并运行 `npm run typecheck`。
