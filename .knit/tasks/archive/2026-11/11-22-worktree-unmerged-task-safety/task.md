---
id: k-187f77a762fa
title: 防止新建任务与未合并的 Worktree 分支重名并支持读取未合并的归档任务
status: delivered
stage: null
verification: independent
parent: k-cdf8de80d14c
dependsOn:
  - k-050013968b09
priority: P1
createdAt: 2026-11-22T05:40:36.878Z
---

## 目标与范围

解决派发过的任务在任务分支上交付后、尚未合并回主检出期间（例如默认 `worktree.autoMerge: false`，或 `autoMerge: true` 因合并冲突中止），主检出看不到该任务导致的目录名／分支名碰撞和上下文读取失败问题：

1. **`knit task new` 分配目录名时避开已有的任务分支与 Worktree 目录**：
   - 现状：`src/application/worktree.ts` 的 `taskWorktree(root, taskDir)` 仅按 `basename(taskDir)`（如 `11-22-task`）计算 Worktree 位置和分支名 `knit/<目录名>`。当任务 A 在其 Worktree 上交付但尚未合并回主检出时，任务 A 的目录已从主检出移入 `<worktree>/.knit/tasks/archive/<YYYY-MM>/<目录名>`，主检出中不再有该目录。此时在主检出运行 `knit task new`（若使用相同 `--slug` 或缺省的 `task`），`src/application/task-store.ts` 的 `createTask()` 只用主检出的 `taskDirectories(root)` 计算 `taken` 集合，不知道 `knit/<目录名>` 分支和 Worktree 仍存在，会**重复分配相同的目录名**。
   - 后果：新任务会直接撞上任务 A 尚未合并的 Worktree 和分支；一旦新任务被派发会直接复用任务 A 的 Worktree，若新任务被取消（`knit task cancel`），`cleanCancelledWorktree` 会强制删除该 Worktree 和 `knit/<目录名>` 分支，**永久销毁任务 A 已交付但尚未合并的提交与归档**。
   - 做法：在 `createTask()` 计算已被占用的目录名集合 `taken` 时，除主检出 `taskDirectories(root)` 外，一并纳入当前项目已存在的任务 Worktree 目录名（或其中包含的任务目录）以及（在 Git 仓库中时）`refs/heads/knit/*` 分支对应的目录名，确保新建任务递增序号（如 `-2`），绝不与尚未清理的任务 Worktree 或 `knit/*` 分支重名。
2. **支持按 ID 查找并读取已交付在任务 Worktree 但尚未合并回主检出的任务**：
   - 现状：在 `worktree.autoMerge: false`（或合并冲突未合并）下，`knit deliver <id>` 成功后，任务目录位于任务 Worktree 的 `.knit/tasks/archive/<YYYY-MM>/<目录名>` 中。在主检出执行 `git merge` 之前，Pi 主会话仍选中着 `<id>`，下一轮 `before_agent_start` 调用 `knit context <id>`（以及运行 `knit task show <id>`、`knit run status <id>` 或 `createTask` 校验 `--parent`／`--depends-on`）调用 `findTask(root, id)` 时，因只扫描主检出的 `.knit/tasks/`，会直接报错「`没有任务 <id>；用 knit task list 查看现有任务`」。
   - 做法：在前置任务 `k-053fe369b3ec` 改造后的分级查找链路上扩展第三级回退——当主检出的活跃目录与主检出归档目录都未找到任务时，补充扫描项目对应的现有任务 Worktree 目录（`<worktreeRoot>/*/.knit/tasks/archive/*/*`），使按 ID 查找能读出已在该项目的任务 Worktree 中归档但尚未合并回主检出的 `delivered` 任务：
     - **关键边界**：必须在 `StoredTask` 上区分其所在检出根（如 `storeRoot`，或标记为未合并外部归档），避免调用方拿 `join(root, stored.dir)` 去主检出读文件报 `ENOENT`，或对外部归档执行误写；
     - `knit task show <id>` 查提交号时若主检出 `HEAD` 尚无该提交，从对应的任务 Worktree／任务分支查出 `Knit-Task: <id>` 提交；
     - `knit task list`（不含 `--archive`）的进行中列表不受影响，同一任务 ID 在合并后若主检出已有则以主检出为准、不重复列出；
     - 保持 `run-prepare.ts` 的 `dependencyProblems` 既有语义：已交付但任务分支尚未合并进主检出 `HEAD` 的依赖任务，在派发新任务时仍必须拒绝并给出合并命令。
   - 同步更新 `docs/design/DESIGN.md` 第 8.2 节中关于交付后、合并前查看任务的说明。

边界：受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，不得修改。

## 完成条件

### Requirement: 新建任务目录名不与未合并的任务分支或 Worktree 冲突

#### Scenario: 任务在任务分支交付但尚未合并时创建同名 slug 的新任务

- GIVEN 任务 A（目录名 `MM-DD-demo`）已在任务 Worktree 和分支 `knit/MM-DD-demo` 上交付，且 `worktree.autoMerge` 为 `false`（尚未合并回主检出，主检出中已无 `MM-DD-demo` 目录）
- WHEN 在主检出运行 `knit task new --title "新任务" --slug demo`
- THEN 新任务分配的目录名为 `MM-DD-demo-2`（避开已有的 `knit/MM-DD-demo` 分支与 Worktree）
- AND 取消新任务（`knit task cancel`）不会删除任务 A 的 Worktree 和 `knit/MM-DD-demo` 分支

### Requirement: 已在任务 Worktree 交付但尚未合并的任务仍可按 ID 查看与注入上下文

#### Scenario: 交付后合并前运行 knit context、knit task show 及作为新任务的 parent 或 dependsOn

- GIVEN 任务 A 已在任务 Worktree 归档并提交到 `knit/<目录名>` 分支，尚未合并进主检出当前分支
- WHEN 在主检出运行 `knit context <任务 A 的 ID>`、`knit task show <任务 A 的 ID>`，或运行 `knit task new --parent <任务 A 的 ID> --depends-on <任务 A 的 ID>`
- THEN `knit context` 与 `knit task show` 均能正常读出任务 A 的 `delivered` 状态、归档目录与任务分支上的提交号，不报「没有任务」；`knit task new` 能识别任务 A 存在，且在新任务派发前仍由依赖检查要求任务 A 先合并进主检出

## 待澄清

## 相关资料

- `src/application/task-store.ts` — `createTask`、`scanTasks`、`findTask` 与 `taskDirectories`
- `src/application/worktree.ts` — `taskWorktree` 计算项目的 Worktree 根目录与分支名
- `src/cli/task.ts` — `knit task show`、`knit task list` 与 `knit task cancel`
- `src/cli/context.ts` — `knit context [id]` 主会话每轮上下文读取
- `src/application/run-prepare.ts` — `dependencyProblems` 对已交付但未合并依赖任务的检查
- `test/deliver-worktree.test.mjs` — 任务分支交付与自动合并测试
- `docs/design/DESIGN.md#8-完成与交付` — 任务分支交付、归档与合并规则

## 结果

已完成两项改进：1）createTask 分配目录名时一并检查已有任务 Worktree 与本地 refs/heads/knit/*（含大小写别名与压缩引用），避免与未合并交付任务重名或取消时误删；2）StoredTask 记录所在检出根，按 ID 查找支持在主检出未命中时读取同仓库未合并任务 Worktree 中的 delivered 归档，task show 与 context 核对 Knit-Task 尾部字段查出任务分支提交，同时保持派发前未合并依赖拒绝语义，并更新 DESIGN.md 第 8.2 节。完成条件全部满足。独立审查（r-3e58523e768f）结论 pass（审查补修 3 处边界）：npm run typecheck 通过，macOS Rex 与普通终端 npm test 各 440/440 通过（含 7 项跨文件系统用例），并通过生产 Pi 扩展核验 before_agent_start 上下文注入。未验证：真实在线模型会话。
