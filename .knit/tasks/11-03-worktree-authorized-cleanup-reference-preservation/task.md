---
id: k-7e09de42a7a3
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:08.951Z
title: Worktree：授权清理与恢复引用保全
---

# 任务 15 冻结输入：Worktree 授权清理与恢复引用保全

## 背景

任务 13（执行路由／跨目录查询／续做）与任务 14（项目移动与关联修复）已交付。本任务实现 Worktree 生命周期末端：在显式授权下清理已结束任务的 worktree，并在删除前保全任务资料、Session 与 run 引用，避免恢复链指向已删除目录。

设计来源：WORKTREE.md 第 6.4 节；DESIGN.md 第 10、16.3 节；OPERATIONS.md 归档与引用约定。清理是独立操作，不与任务完成、Git 交付、`knit gc` 混做。

## 命令

新增 `knit worktree cleanup`，挂在现有 `worktree` 命令组；只在主检出运行（关联 worktree 内调用报 `main_checkout_required`）。

```
knit worktree cleanup --task <taskId>
  [--branch]                 # 同时删除任务 worktree 分支（默认保留分支）
  [--discard-branch]         # 分支未合入时仍按授权删除（仅在 --branch 下有意义）
  [--discard-changes]        # 允许删除含未提交／未跟踪／忽略资料的 worktree
  [--apply]                  # 缺省只读预览；执行需同时提供 --authorization-ref
  --authorization-ref <ref>  # apply 必填；按 delivery.resolveAuthorization 同口径记录，不冒充语义核验
  [--dir <dir>]              # 主检出（默认当前目录）
```

- 预览（无 `--apply`）绝不创建目录、不写 binding／Session、不运行删除命令；`--authorization-ref` 在预览中可省略。
- `--apply` 缺少非空 `--authorization-ref` 直接拒绝（`authorization_required`），不触碰现场。
- 输出 JSON 与文本；状态取值见下。

## 候选与预检

候选为任务 `binding.worktree`（任务无 worktree 时 `noop`）。只处理该任务，不批量清理其它任务。

预检全部只读，任一阻断项在 apply 时不删除：

1. **任务已结束**：任务 `status` 必须为 `closed`（outcome 为 completed／cancelled／superseded 均允许，报告实际值）。未结束 → `blocked_task_open`。
2. **现场一致**：`worktree.path` 存在；`git worktree list --porcelain` 中该路径登记且分支等于 `worktree.branch`；路径属于当前主检出。否则 → `invalid`（保留条目与诊断，不删除、不清空 binding）。
3. **活动／未知执行**：该任务的 run 存在 `claimed/preparing/running`、completed 但结果尚未被接收、阶段进程仍存活或身份未知，或任务锁／项目锁被占用或 owner 不可核实 → `blocked_active`／`blocked_unknown`。语义与 task 14 的 `runActivity`／锁核实一致；未知不冒充死亡。
4. **工作区内容**：worktree 中 tracked／untracked／ignored 内容非空时默认 `blocked_dirty` 并列出摘要（数量与最多若干路径）；提供 `--discard-changes` 才继续。`git worktree list` 标记 `locked` 的拒绝，`blocked_locked` 不可由任何开关越过。
5. **分支**（仅 `--branch`）：以 `delivery.defaultBranch`（config）→ 本地 `origin/HEAD` → 主检出当前分支的顺序确定合入目标；用 `merge-base --is-ancestor <branch> <target>` 证明已合入。目标未知或未合入时默认 `blocked_unmerged`；`--discard-branch` 时继续并记录「明确丢弃」。`--discard-branch` 未配合 `--branch` 时报参数错误。
6. **保留可行性**：待保全资料（任务资料目录、Session 文件）可读；不可读时 `blocked_unknown` 或 `failed`，不先删目录。

## 执行（apply）

顺序固定，先保全后删除：

1. 整体预检通过后，新建或沿用未完成回执的 `opId`；操作目录 `.knit/.runtime/worktree-cleanup/<opId>/`，先写 `journal.jsonl`（planned）与 `receipt.json`（finishedAt=null）。
2. 获取项目锁与任务锁（action=`worktree.cleanup`）；锁内重读 binding、重跑预检。锁失败或现场变化 → 不删除，按 `blocked_*`／`failed` 记录。
3. **保全任务资料**：若 worktree 内存在本任务资料目录（按 binding 与 taskId 定位），复制到 `<opDir>/preserved/task-material/`，逐文件记录相对路径／大小／SHA-256，复制后重新读取核对摘要；失败则停止，worktree 保留。
4. **保全 Session 文件**：对 `cwd` 位于该 worktree 的 Session（不限于本任务；同一目录下的会话都受影响）：若 `sessionFile` 也位于 worktree 内，复制到 `.knit/.runtime/pi-sessions/`（避免覆盖：冲突时加 `<knitSessionId>` 前缀），核对后可读，再更新记录；若 `sessionFile` 位于主检出则只更新 `cwd`。所有受影响 Session 的 `cwd` 更新为主检出根。
5. **删除 worktree**：`git worktree remove <path>`；存在 `--discard-changes` 时使用 `--force`。失败保留目录并记录 stderr。
6. **删除分支**（仅 `--branch`）：预检已证明合入或已授权丢弃，使用 `git branch -D <short>`；失败记 `partial`，不重删目录。
7. **清理 binding**：成功后清除 `binding.worktree`（保留 `repoRoot`／`branch` 等主字段），不删除任务资料；若 binding 已无 worktree 则不重复写。
8. 写回 Session 变更；更新 `receipt.json`（finishedAt、步骤结果、preserved 清单摘要、session 变更、分支结果、authorizationRef 原文与解析类型、实际路径）与 journal `finish`；写 operation 记录 `kind=worktree.cleanup`、state=completed／needs_attention／failed。

## 状态与重试

- 预览状态：`removable`、`noop`、`blocked_task_open`、`blocked_active`、`blocked_unknown`、`blocked_dirty`、`blocked_unmerged`、`blocked_locked`、`invalid`、`failed`。
- apply 结果：`removed`（目录已删、分支按请求处理）、`partial`（目录已删但分支／binding／Session 未全部完成）、上述阻断／无效状态、`noop`（无 worktree 或上次回执已收束）。
- 中断重试：以未完成回执（finishedAt=null）为入口，跳过已完成的删除与复制，只补未完成步骤；已删除的目录不重复删除，已删除的分支视为完成。重复 apply 已完成对象 → `noop`，不产生新的 Git 副作用。回执丢失时以现场事实判定，不凭日志宣称成功。
- 不删除任务目录、归档、run 产物、Session 文件（除迁移到主检出）；不运行 `knit gc`；不改任务 phase／status／outcome，不改写历史 run 结果或 Git 历史。

## 数据与记录

- binding 不新增字段；清理后 `worktree` 为空，操作历史以 receipt＋operation 为准。
- receipt 是恢复与审计入口：`schemaVersion`、`opId`、`taskId`、`mainRoot`、`apply`、`authorizationRef`、`taskStatus/outcome`、`worktree`（原路径／分支／布局／relativePath）、`steps`（planned／completed／failed／skipped）、`preserved`（文件清单与摘要）、`sessions`（Knit ID、旧 cwd／sessionFile、新值）、`branchDeletion`（目标、证明方式、结果）、`finishedAt`。
- journal 逐行记录 plan／preserve／remove／branch／binding／finish 与失败原因，不作为权威回执。

## 完成条件（验收）

隔离夹具必须覆盖：

1. 只读预览：可清理报告完整，未创建运行目录、未改 binding／Session、未删除目录。
2. 正常 apply：worktree 删除、任务资料（含未跟踪草稿）保全并可读、Session cwd／sessionFile 更新到主检出、binding 清空、分支保留、历史 run 文件不变、receipt／journal／operation 可核对。
3. 未结束任务、活动／未知执行、任务锁占用、worktree locked：分别阻断且现场不变。
4. dirty worktree 默认阻断；`--discard-changes` 时先保全任务资料再删除，ignored／untracked 内容清除。
5. `--branch`：已合入删除；未合入阻断；`--discard-branch` 明确丢弃后删除。
6. Session 文件位于 worktree 时复制并改指、原文可读；缺失文件如实记录且不冒充可恢复。
7. 中断／部分成功重试：目录已删或 binding 未清时按回执继续；重复 apply 幂等 noop。
8. 无 worktree → noop；路径缺失／未登记／分支不符 → invalid 且保留 binding。
9. 在关联 worktree 内调用拒绝；apply 无授权引用拒绝。
10. `npm test` 全量（含 typecheck、build）通过，回归任务 13／14 已有测试。

## 边界

- 不实现：worktree 创建／连接／handoff／prepare／repair 的行为变更、跨目录合入交付（任务 16）、多任务并行调度（任务 17）、全局存储 GC、自动清理、真实多机／真实模型验收。
- 用户既有决定：真实模型与真实多机验收延期；隔离测试不冒充真实验收。业务完成、提交、归档、push 分别处理。

<!-- knit:progress:start -->
## 当前位置

交付阶段；实施 run 已接收，主 Agent self 自检通过，待完成与交付。

## 关键经过

- 冻结输入：`knit worktree cleanup --task <id>`，默认只读预览；apply 需非空 `--authorization-ref`；可选 `--branch`／`--discard-branch`／`--discard-changes`；只在主检出运行。
- 实施 run `run-ead2b0fa483b` 完成并被接收（phase → deliver）。新增 `src/application/worktree-cleanup.ts` 与 CLI `worktree cleanup`：预检任务已 closed、worktree 登记与分支一致、活动／未知 run 与锁、dirty（tracked／untracked／ignored）、locked、分支合入证明与保全可行性；apply 先保全任务资料与 Session 文件并核对 SHA-256，再删除 worktree（`--discard-changes` 时 `--force`）、按证明或明确丢弃删除分支、清除 `binding.worktree`、改指受影响 Session 的 `cwd`／`sessionFile`，写 journal＋receipt＋operation，支持未完成回执续做与重复 apply 幂等。
- 自检（主 Agent，self）：逐段核对预检、保全、锁内重读、删除顺序、回执与续做逻辑；`npm test` 全量 390 项通过（含 typecheck、build），新增 9 个夹具场景全绿。
- 已知边界：真实模型／真实多机与原生客户端恢复未验收；`--discard-changes` 仅保全本任务资料，其余未跟踪内容按授权丢弃；清理后 binding 不再保留 worktree 历史（回执＋operation 为入口）；`taskDirFromBinding` 按受信本机 binding 路径定位，未额外做路径越界检查。

## 结果与验证

- `npm test`（含 typecheck、build）390 项通过；新增场景：只读预览无写入、正常 apply 保全与 Session 改指、任务未结束／活动／未知／锁／locked 阻断、dirty 与 discard、分支合入／阻断／丢弃、Session 文件复制与冲突、命名、中断重试与幂等、无 worktree／路径缺失／分支不符、关联 worktree 内拒绝与缺授权拒绝。
- 修改文件：`src/application/worktree-cleanup.ts`（新）、`src/cli/worktree.ts`、`test/worktree-cleanup.test.mjs`（新）。

## 运行引用

- 实施 run：run-ead2b0fa483b（snapshot ready；结果已接收）。
- 会话：s-95bb6b633b28 / 21d38a51-de57-4bbc-8f16-738f9658a3e2。
- 本任务原无绑定行，派发前以 `knit task adopt k-7e09de42a7a3` 补齐 refs/heads/main 绑定；未改变任务身份。

### 交付记录

<!-- knit:delivery:op-71ca1d9b38e7 -->
- 操作: op-71ca1d9b38e7
- 时间: 2026-11-04T09:25:33.894Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-04-message-commit-push-remaining
- 工作提交: 53aead46dee26a5b61e0ea769c203f0fc0957f79
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-authorized-cleanup-reference-preservation

<!-- knit:progress:end -->
