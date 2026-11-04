---
id: k-200ec35a4ae0
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:10.955Z
title: 跨目录交付：授权合入与归档接续
---

# 任务 16 冻结输入：跨目录交付——授权合入与归档接续

## 背景

任务 13–15 已交付执行路由、项目移动修复与授权清理。本任务补齐 Worktree 分支成果回到主检出的授权合入，并把任务资料与绑定转到目标目录，使既有 `knit deliver`（提交＋封存＋归档）可以接续完成。设计来源：DESIGN.md 第 10.1／10.3／16.3 节、WORKTREE.md 第 6.4／6.8 节、OPERATIONS.md 交付约定。

合入是独立、显式授权的操作；不把默认分支检测当成权限，不自动 push、发布、rebase、reset 或改写历史。合入成功后仍由 `knit deliver --branch <target>` 完成业务产物／任务资料提交与归档。

## 命令

新增 `knit worktree merge`，只在主检出运行（关联 worktree 内调用报 `main_checkout_required`）：

```
knit worktree merge --task <taskId> --into <refs/heads/...>
  --authorization-ref <ref>   # apply 必填；按 delivery.resolveAuthorization 同口径记录，不冒充语义核验
  [--apply]                   # 缺省只读预览
  [--dir <dir>]               # 主检出（默认当前目录）
```

- `--into` 始终必填，必须是完整本地 `refs/heads/...`；不按 main/master 或默认分支猜测，不自动切换分支。
- 预览绝不写文件、不运行 `git merge`、不更新 binding／任务正文。
- apply 缺少非空 `--authorization-ref` 直接拒绝（`authorization_required`），不触碰现场。

## 预检（全部只读）

候选为任务的 `binding.worktree`；无 worktree／已 inactive 且无未完成回执时 `noop`。

1. **任务**：`status=closed` 且 `outcome=completed`；其它结束结果或未结束 → `blocked_task_open`。任务已归档 → `invalid`（无需合入）。
2. **现场**：worktree 路径存在、在 `git worktree list --porcelain` 中登记、分支等于 `worktree.branch`、归属当前主检出；`binding.worktree.active === true`（已转交则 noop）。否则 `invalid`。
3. **源工作区**：任务资料目录之外不得有 tracked／untracked 改动（ignored 允许）；任务资料目录内的未提交修改允许并随资料转交。源 dirty → `blocked_dirty` 并列出摘要。
4. **目标**：`--into` 存在且为主检出当前分支（`symbolic-ref HEAD`）；不得被其它 worktree 检出；目标 index 无暂存内容、tracked 工作区无修改 → 否则 `blocked_target`／`blocked_dirty`。未跟踪文件不预先删除；若会阻挡合入由 Git 报错并按冲突处理。
5. **活动／未知执行**：该任务 run 非终态、completed 未接收、阶段进程存活／未知、任务锁或项目锁被占用 → `blocked_active`／`blocked_unknown`。语义与任务 14／15 的核实一致。
6. **资料可转交**：主检出已存在本任务资料目录且与源内容不同 → `conflict`（保留两边，不合入）；相同或不存在 → 可继续。源资料目录不可读 → `blocked_unknown`。
7. **合入可行性**：源分支存在于本地；源与目标不同；`merge-base` 可读。源已是目标祖先时合入步骤为 `noop`，只补资料／绑定转交。

## 执行（apply）

先整体预检，再持项目锁与任务锁；锁内重读 binding、重跑预检，现场变化不合并。操作目录 `.knit/.runtime/worktree-merge/<opId>/`，先写 journal（planned）与未完成 receipt。

1. **合入**：`git merge --no-ff -m "knit: merge <taskId> (<opId>)" <sourceBranch>`（源已是祖先时跳过）。
   - 记录 `beforeHead`、`afterHead`、合入提交 OID。
   - 失败时若存在 `MERGE_HEAD` 执行 `git merge --abort`；工作区恢复原 HEAD，源 worktree／分支保留，状态 `conflict` 或 `failed`，不更新 binding、不转交资料。
   - 若命令非零但 HEAD 已产生含本 opId 的合入提交，按恢复处理（记录真实提交并继续），不重复合入。
   - 成功后核对 `git merge-base --is-ancestor <source> <target>` 与目标 HEAD。
2. **转交任务资料**：定位源 worktree 内本任务资料目录；主检出对应目录不存在则复制（文件／目录，逐文件 SHA-256 核对）；已存在且内容相同则保留；内容不同则 `partial` 并保留两边，不覆盖。
3. **任务正文分支**：解析并重写资料中的 `task.md` 的 `branch` 为 `--into`（不改 status／phase／outcome／正文），写后回读核对。
4. **binding 转交**：`binding.branch = --into`；`worktree.active = false`；写入 `mergedAt`、`lastMergeOp`（新增可选字段，旧记录缺省）。保留 worktree 路径／分支与其它字段（后续清理可读）；binding 保存失败 → `partial`，可按回执重试。
5. **回执／记录**：`receipt.json` 记录 taskId、mainRoot、source（path／branch／baseline）、target、authorizationRef 与解析类型、beforeHead／afterHead／mergeCommit／mergeKind（merge／noop／recovered）、任务资料清单摘要、binding 变更、步骤状态、finishedAt；journal 逐行记录 plan／merge／transfer／document／binding／finish；operation `kind=worktree.merge`、state=completed／needs_attention／failed。

## 状态与重试

- 预览：`mergeable`、`noop`、`blocked_task_open`、`blocked_active`、`blocked_unknown`、`blocked_dirty`、`blocked_target`、`blocked_locked`、`invalid`、`conflict`、`failed`。
- apply：`merged`（合入与转交完成）、`partial`（合入成功但资料／正文／binding 未完成）、上述阻断状态、`noop`、`conflict`。
- 中断重试：未完成回执为入口；已核实的合入提交（含 opId）不重复合入，只补资料／正文／binding。重复 apply 已完成对象 → `noop`，不产生新提交。回执丢失时以 HEAD 与提交 message 核实，不凭日志宣称成功。
- 合入失败不回滚源 worktree／分支，不删除资料；已成功的合入不回滚，后续按 `knit deliver` 继续。新增操作使用新 opId；同一 task 同时只允许一个未完成 merge 回执。

## 完成条件（验收）

隔离 Git 夹具必须覆盖：

1. 只读预览：mergeable 报告完整，无提交、无 binding／文件写入、无运行目录。
2. 正常 apply：生成含 opId 的合入提交；任务资料复制到主检出并核对摘要；task.md branch 更新；binding branch／active／mergedAt／lastMergeOp 更新；源 worktree 保留；历史 run 不变；receipt／journal／operation 可核对。
3. 源任务资料外 dirty、目标 index／tracked 脏：分别阻断且 HEAD 不变。
4. 真实冲突与未跟踪草稿阻挡：`git merge` 失败后 abort，HEAD／index 恢复原状，源保留，状态可诊断。
5. 目标未检出、被其它 worktree 占用、非完整 ref、任务未结束／已完成但已归档：阻断且现场不变。
6. 活动／未知 run、任务锁／项目锁占用：阻断；释放后可 apply。
7. 重试与幂等：合入已成功但资料／binding 未完成时按回执续做，不产生第二个合入提交；重复 apply noop。
8. 合入后 `knit deliver --branch <target>` 能定位任务资料、通过完成校验并归档；合入提交与交付元数据提交分开，逐任务历史保留。
9. 关联 worktree 内调用拒绝；apply 缺授权拒绝。
10. `npm test` 全量（含 typecheck、build）通过，回归任务 13–15 测试。

## 边界

- 不实现：自动切换／检出目标分支、自动解决冲突、push／PR／发布、历史改写、批量多任务合入、worktree 清理（任务 15 已有独立命令）。
- 不把 `origin/HEAD` 或配置默认分支当作合入权限；`--into` 与授权引用缺一不可。
- 真实多机／真实模型验收按用户既有决定延期；隔离测试不冒充真实验收。业务完成、提交、归档、push 分别处理。

<!-- knit:progress:start -->
## 当前位置

交付阶段；实施 run 已接收，主 Agent self 自检通过，待完成与交付。

## 关键经过

- 冻结输入：新增 `knit worktree merge --task <id> --into <refs/heads/...>`，缺省只读；apply 需非空 `--authorization-ref`；只在主检出运行，不自动切换分支、不自动解冲突、不 push。
- 实施 run `run-81f9025f33dc` 完成并被接收（phase → deliver）。新增 `src/application/worktree-merge.ts` 与 CLI `worktree merge`：预检任务 closed/completed、worktree 登记与分支、源 dirty、目标当前分支／index／tracked 工作区、活动／未知 run 与锁、资料冲突与 merge-base；apply 持项目锁＋任务锁重跑预检，`git merge --no-ff`（源已是祖先时 noop），失败 abort 并恢复 HEAD，成功核对父节点／祖先／message；随后转交任务资料（逐文件 SHA-256）、改写 task.md branch、更新 binding branch／active／mergedAt／lastMergeOp，写 journal／receipt／operation，支持中断续做与幂等。
- 自检（主 Agent，self）：核对预检与合入恢复路径、失败 abort 现场、资料转交与 binding 顺序、回执续做；`npm test` 全量 401 项通过（含 typecheck、build），新增 11 个夹具场景全绿（含合入后 deliver 归档）。
- 已知边界：真实多机／真实模型验收未做；源分支若已提交任务资料（tracked `task.md`），合入后 branch 改写造成的 tracked 修改在中断重试时可能按目标 dirty 阻断，需先提交或恢复该文件；`--discard-*` 不属于本命令；合入后仍由 `knit deliver` 完成提交／归档。

## 结果与验证

- `npm test`（含 typecheck、build）401 项通过；新增场景：只读预览、正常合入与转交、源／目标 dirty、真实冲突与未跟踪阻挡、目标不可用／占用／任务未结束／已归档／locked、活动与未接收 run、锁释放重试、回执续做与幂等（含 branch 改写识别）、合入后 deliver 归档、CLI 拒绝路径。
- 修改文件：`src/application/worktree-merge.ts`（新）、`src/cli/worktree.ts`、`src/contracts/metadata.ts`、`test/worktree-merge.test.mjs`（新）。

## 运行引用

- 实施 run：run-81f9025f33dc（snapshot ready；结果已接收）。
- 会话：s-5c4b48ab117e / c50e372f-2dea-4eb7-b45c-359d90c73ec0。
- 本任务原无绑定行，派发前以 `knit task adopt k-200ec35a4ae0` 补齐 refs/heads/main 绑定；未改变任务身份。

### 交付记录

<!-- knit:delivery:op-bf15a10bf0af -->
- 操作: op-bf15a10bf0af
- 时间: 2026-11-04T09:59:14.633Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-04-message-commit-push-remaining
- 工作提交: f82d782481d204b2b9983e2477a7e15a2546bf13
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-cross-directory-authorized-merge-delivery

### 任务资料提交记录

<!-- knit:metadata-commit:op-bf15a10bf0af -->
- 任务资料提交: be43008d6c31d9840d9ae55c013f840dbaf2f754
- 归档目标: .knit/tasks/archive/2026-11/11-03-cross-directory-authorized-merge-delivery

<!-- knit:progress:end -->
