---
id: k-566ade3a274d
title: 加固交付 Git 门禁、空仓库首提交、事务回滚与任务锁
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-fc88509c221b
priority: P0
createdAt: 2026-11-27T13:37:25.955Z
---

## 目标与范围

消除交付事务、Git 提交边界、Worktree 分支复用以及任务写入并发中的高危缺陷，确保 `knit deliver` 绝不在 Git 异常时静默漏提代码、支持空仓库首次提交、回滚真实可靠，并让任务生命周期和交付写入与后台结算共享任务锁防竞态。

### 具体改动与思路

1. **交付 Git 门禁与空仓库首次提交（`src/application/delivery.ts`）**：
   - `workspaceChanges` 检查 `git status` 退出码；非 0 时向上显式报错，绝不返回空文件列表导致 `commitDelivery` 静默按 `{ kind: "nothing" }` 归档交付。同步核对 `commitDelivery` 内 `git show` 与 `git log` 的退出码。
   - `commitDelivery` 与 `deliverTask` 暂存回滚先判断仓库是否存在 `HEAD`（`git rev-parse --verify --quiet HEAD`）：有 `HEAD` 时沿用 `git reset -q -- ...`；无 `HEAD`（刚 `git init` 尚未提交的仓库）时改用 `git rm --cached --ignore-unmatch -q -- ...`（或等效安全暂存/回滚），使主会话直接完成的任务在空仓库也能正常交付。
   - 当待提交文件数较多时，`git reset`、`git add`、`git commit --only` 通过 `--pathspec-from-file=- --pathspec-file-nul` 经 stdin 传递路径，规避大重构触发 `E2BIG`。
   - `workspaceChanges` 对子模块仅在其 gitlink 提交实际变化（或新增/删除）时纳入可提交清单，避免仅子模块工作区脏引起 `nothing to commit` 回滚或误报 `少了`。
2. **交付事务可靠性与预览一致性（`src/application/delivery.ts`）**：
   - 将 Worktree 交付时的 `.knit-delivery-*` 临时备份目录建在 `dirname(workspace)`（即项目 Worktree 根目录，同文件系统且位于 Git 工作区之外），不再暴露在 Worktree 根目录内干扰 hook 或工作区检查，并确保异常路径可靠清理。
   - `rollback()` 逐项 `try/catch` 执行目录归位、备份恢复、空目录清理与 `saveTask`，显式检查 `saveTask` 返回的 `conflicts`；若任一回滚步骤失败，在返回结果中如实汇总回滚残余问题而非宣称“状态已恢复为 done”。
   - 统一 `check-ignore` 退出码判断，并在判断任务目录是否被 Git 忽略时一并核对归档目标位置（若仅忽略 `.knit/tasks/archive/`，归档须留在主检出，避免 `autoMerge` 删除 Worktree 导致归档丢失）。
   - 修复 `previewDelivery` 中 `recorded` 含目录/子模块尾部 `/` 时一边列出待提交文件一边误报 `unchanged` 的自相矛盾；将 `--message-file` 存在性校验提前到 `previewDelivery` 之前，并在预览传空 `--message ""` 时给出提示。
3. **任务写入并发锁与目录原子抢占（`src/application/task-lifecycle.ts`、`src/application/delivery.ts`、`src/application/task-store.ts`）**：
   - `readyTask`、`closeTask`、`cancelTask`、`deliverTask` 在修改任务文件前统一复用 `withTaskRunLock`（非 Git 项目同样可使用主检出 `.knit/.runtime/<id>.lock`），消除与后台 `finishRun` 并发修改的 TOCTOU 窗口。
   - `createTask` 改用非递归 `mkdirSync(join(root, dir))` 原子抢占目录名，遇 `EEXIST` 时自动尝试 `-2`、`-3` 后缀重试，消除宿主并发建同名草稿撞 `version_conflict` 抛未捕获异常。
4. **Worktree 复用分支核对与残缺取消清理（`src/application/worktree.ts`）**：
   - `ensureWorktree` 复用已有目录前核对 `git symbolic-ref --quiet HEAD` 确为 `refs/heads/${worktree.branch}`，若分支已切偏或处于 detached HEAD 则拒绝派发并给出恢复命令。
   - `cleanCancelledWorktree` 以 `existsSync(join(worktree.path, ".git"))` 判断是否为有效 Worktree，目录残缺（无 `.git`）时仍能执行 `git worktree prune` 并清理任务分支。

### 边界与约束

- 不修改 `runtime-cleanup.ts`（锁回收竞态与归档剪枝归 `k-3e85bbaa5d20`），不修改 `cli/deliver.ts` 的 `--authorization` 帮助文案（归 `k-48ccd026c70d`），仅在交付结果结构体新增必要回滚警告字段时在 `cli/deliver.ts` 做对应展示。
- 测试追加到 `test/deliver.test.mjs`、`test/deliver-worktree.test.mjs`、`test/task-lifecycle.test.mjs`、`test/task-cancel-worktree.test.mjs`、`test/run-worktree.test.mjs`。
- 涉及提交、交付事务与任务锁高风险核心链路，须运行 `npm run typecheck`、`npm run build` 及全量 `npm test`。

## 完成条件

### Requirement: 交付 Git 异常拦截与空仓库首次提交
#### Scenario: git status 失败阻断交付并回滚
- WHEN 交付提交阶段 `git status` 返回非零退出码
- THEN 交付拒绝并触发回滚，任务目录恢复原位置且状态恢复为 `done`，不会静默按无改动完成交付

#### Scenario: 空 Git 仓库无 HEAD 时可完成首次交付提交
- WHEN 项目刚运行 `git init` 且尚无任何提交，主会话直接完成任务并运行 `knit deliver`
- THEN 交付成功归档并生成仓库首个提交（末尾含 `Knit-Task: <id>`），且不因 `git reset` 失败回滚

#### Scenario: 脏工作区子模块不破坏交付提交
- WHEN 仓库包含子模块且仅子模块内部有未提交脏改动（父仓库 gitlink 未变）
- THEN 交付不把该子模块误纳入待提交文件，也不会因此回滚或误报 `少了`

### Requirement: 交付临时目录隔离、回滚完整性与忽略规则
#### Scenario: 交付临时备份目录不出现在 Worktree 根目录内
- WHEN 派发过的任务在 Worktree 中执行交付（任务分支原有旧任务目录）
- THEN 临时备份建在 Worktree 根目录之外，pre-commit hook 期间工作区不出现 `.knit-delivery-*` 未跟踪目录

#### Scenario: 回滚阶段发生冲突或失败时如实汇报
- WHEN 提交失败触发回滚且 `saveTask` 遇冲突或目录移回失败
- THEN 返回的错误如实报告回滚未完成的具体细节，不误报状态已恢复为 `done`

#### Scenario: 仅忽略归档目录时不把归档留在待删 Worktree 中
- WHEN `.gitignore` 忽略 `.knit/tasks/archive/` 而未忽略 `.knit/tasks/`
- THEN 派发任务的归档留在主检出而非 Worktree 中，自动合并删 Worktree 后归档不丢失

### Requirement: 并发建草稿、任务锁与 Worktree 分支核对
#### Scenario: 并发创建同名 slug 草稿自动递增后缀不崩溃
- WHEN 并发调用 `createTask` 创建同一 `--slug` 的两个草稿
- THEN 两者均创建成功并分别获得不冲突的目录名（如 `-2`），不抛出 `version_conflict`

#### Scenario: Worktree 切偏分支时拒绝复用派发
- WHEN 任务的 Worktree 被手工切换到其他分支或进入 detached HEAD
- THEN `ensureWorktree` 拒绝复用并提示恢复到 `knit/<任务目录名>` 分支

### Requirement: 构建与全量回归通过
#### Scenario: 类型检查、构建与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 8 节交付、回滚与合并清理规则
- `AGENTS.md` — 交付与高风险独立审查规范
- `.knit/standards/development.md` — 编码风格与测试分层规范
- `src/application/delivery.ts` — 交付预览、提交与事务回滚
- `src/application/task-store.ts` — 任务目录名分配与 `saveTask`
- `src/application/task-lifecycle.ts` — 生命周期写入入口
- `src/application/worktree.ts` — Worktree 创建、复用与取消清理

## 结果

九个验收场景通过。Git 状态查询失败能阻断交付，空仓库可做首个提交，失败后恢复原任务和暂存区并报告未恢复项；支持脏子模块、跨卷归档、同名草稿竞争、切偏分支拒绝派发和交付；任务生命周期写入与结算共享锁。独立审查 r-dbf5215b3bc3 结论 pass，直接修正切偏工作树仍可交付、已暂存新增但工作文件已删除的路径导致交付回滚、同时忽略活跃与归档目录时撤回提示错误三处。最终工作树经宿主验证 npm run typecheck、build、pack:check、含第二个可写卷的 npm test 628/628（0 失败、0 跳过）、git diff --check 均通过。
