---
id: k-d10f8d4c2833
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:08.552Z
title: Worktree：项目移动与关联修复
---

# Worktree：项目移动与关联修复

## 目标与边界

支持项目／Worktree 整体移动后的关联修复：在新位置核实身份与目录关系，修复可证明的 Git 关联和本机定位，保留原 taskId、历史运行、来源及未知项。

以任务 13（k-1910551e4f50，已交付）的 `mainRoot`／`executionDir` 路由为前提：`.knit/` 元数据、run 产物、pi-sessions 只在主检出；worktree 是执行目录。修复只改本机定位，不改任务业务状态、分支归属和已接收成果。

范围外：不自动移动项目或 Worktree，不实现跨目录合入交付（任务 16）、授权清理（任务 15）、并行调度（任务 17），不启用 `extensions.relativeWorktrees`／`--relative-paths`，不接管、取消或重跑任何执行。

## 需求冻结（依据 WORKTREE §6.5、DESIGN §16.3、OPERATIONS 恢复约定）

### 1. 命令与模式

新增 `knit worktree repair`，只在主检出（mainRoot）运行，沿用 `--dir`、全局 `--json`：

- `knit worktree repair [--task <taskId>] [--apply]`；
- 缺省只读：列出候选任务的旧／新定位、可修复性、Git 关联现状与计划动作，不写任何文件、不执行修复；
- `--apply`：预检通过后执行 Git 关联修复与本机定位更新，写操作 journal／receipt；
- `--task` 限定单任务；不指定时覆盖本项目全部可识别候选；
- 无移动或无候选时输出 no-op 并正常退出；项目级错误（非 Git 根、元数据不可读、主检出身份不符）报错退出，不写半份结果；
- `--apply` 中任一候选阻塞或失败时，不得把该候选标成已修复；其它候选按逐任务结果如实报告（整体预检与逐任务执行分开，见第 5 条）。

### 2. 候选与可证明关系

候选来源为 binding（SQLite），包括没有 worktree 的任务：

- `binding.repoRoot !== 当前 mainRoot` → 项目移动候选；
- project 布局 worktree 的 `binding.worktree.path !== join(新 mainRoot, relativePath)` → worktree 移动候选；
- 目录存在、Git 关联失效（`git worktree list` 缺失该路径或 gitdir 仍指旧位置）→ 关联修复候选；
- 已一致且可核验 → `ok`（no-op）。

只按可证明关系修复：

- project 布局：新路径 = `新 mainRoot + binding.worktree.relativePath`，`relativePath` 必须仍在任务资料父目录内且新路径存在；
- global 布局：`binding.worktree.path` 不变（仍在全局位置），只修复指向新主检出的 Git 关联并更新 `repoRoot`；
- 新路径上的 `.git`／worktree 归属、分支、任务 frontmatter `id` 必须与 binding 一致；`relativePath` 的目标目录内 `task.md` 的 id 必须等于 taskId；
- 旧路径仍存在且被其它仓库／任务／分支占用 → `conflict`，不覆盖、不删除；
- 无法证明新位置（新路径缺失、多个候选、frontmatter／分支不符）→ `invalid`，保留原 binding 与可读诊断；
- `binding.repoRoot === 当前 mainRoot` 但 worktree 路径失效且不能证明新位置 → 仅报告，不猜路径。

### 3. Git 关联修复

- 先完成只读预检（路径、frontmatter、分支、基线、`git worktree list`），再执行 `git worktree repair <新路径…>`（从新 mainRoot 运行；global 布局传其现有路径）；
- 修复后重新核验：worktree 在 `git worktree list` 中、分支为 `binding.worktree.branch`、基线是分支祖先（沿用 `verifyRegisteredWorktree` 语义）；核验不通过按失败处理，不回写 binding；
- 若实际 Git 版本在整体移动后无需 repair 即已可用，仍须完成核验与本机定位更新，并如实记录“无需 repair”；
- 不执行 `git worktree prune`、不删除目录、不改分支、不提交、不推送。

### 4. 本机定位更新

预检与 Git 核验通过后，原子更新：

- 本项目所有 binding（含无 worktree 的任务）`repoRoot` → 新 mainRoot；
- project 布局 worktree：`worktree.path` → 新路径；`relativePath`、`branch`、`baseline`、`active`、`handoffAt`、`lastHandoffOp`、`preparedAt`、`lastPrepareOp`、任务 frontmatter（branch/相对路径/id）保持不变；
- 新增可选字段 `worktree.repairedAt`、`worktree.lastRepairOp`（schema 可选，旧记录兼容）；no-op 不写这些字段；
- 仅更新受修复任务的 Session：`cwd` 等于旧 mainRoot 或位于旧 project worktree 路径下时映射到新位置（保留相对子路径）；`sessionFile` 位于旧 mainRoot 的 `.knit/.runtime/pi-sessions/` 下时映射，且仅当新位置文件存在才更新；保留 `knitSessionId`、原生 ref、kind、status、source、checkpoint、selection；
- 历史 run 的 request／result／receipt／scope 不改写（它们是当时事实）；新 run 由修复后的 binding 路由到新 `executionDir`；不重新接收旧 run。

### 5. 活动执行与并发

- apply 前预检候选任务是否存在活动／未知执行：以 RunStore 中非终态 run 与 task／stage 锁存活双重核对；身份未知按阻塞处理；
- 任一候选任务存在活动执行或结果待接收 → 该任务 `blocked_active`／`blocked_unknown`，不修复、不改 binding；其它候选可继续，但必须在输出中明确未处理项；
- 整个 apply 持有项目锁，逐任务持有任务锁（按 `orderKeys` 排序），锁内重读 binding 再写，防止与 create／connect／handoff／prepare 竞态；
- 修复不得改变任务 phase／status／outcome，不触发 run 接收、阶段推进或交付。

### 6. 证据、部分成功与重试

- 操作目录 `.knit/.runtime/worktree-repair/<opId>/`：`journal.jsonl`（逐步骤：precheck、git-repair、verify、binding、sessions、结果与 stderr 摘要）、`receipt.json`（任务、旧／新根、状态、完成步骤、finishedAt）；
- 新增 `repairedAt` 前的中间状态以 receipt 为准；中断后重跑：已核验且 binding 已更新的任务识别为 no-op（不重复 git 副作用），未完成步骤继续；
- 部分失败不回滚已成功的 Git 修复（不制造二次破坏），保留 receipt 供核对并允许幂等重试；
- 失败／冲突／阻塞均保留原 binding 可读诊断，不删除条目、不把未知项当成功。

### 7. 输出与诊断

逐任务输出：`ok`、`repairable`、`repaired`、`invalid`、`conflict`、`blocked_active`、`blocked_unknown`、`failed`，附旧根、新根、worktree 路径、原因与计划／已执行动作；`--json` 返回结构化结果。`worktree status`／`list` 继续显示失效原因，不因修复候选存在而误报可用。

## 完成条件（隔离夹具，self 验证）

新增 `test/worktree-repair.test.mjs`，至少覆盖：

1. 整体移动主项目（project 布局 worktree 随项目移动）：`git worktree list` 失效 → `repair --apply` 修复关联，binding `repoRoot`／`worktree.path` 更新，`worktree status`／执行路由恢复，历史 run request 不变；
2. global 布局：主项目移动后修复关联，`worktree.path` 保持不变，`repoRoot` 更新；
3. 旧路径复用或新路径被占且分支／frontmatter 不符 → `conflict`，binding 原样保留；
4. 新路径缺失或关系不可证明 → `invalid`，保留条目与诊断，不启动任务；
5. 活动／未知执行 → 阻塞该任务，不修复、不改 binding；其它任务结果如实报告；
6. 部分修复／中断后重试：已修复项 no-op，未完成项继续，receipt／journal 可核对；
7. 只读模式（缺省）不改文件、不执行 `git worktree repair`；非 Git 根／身份不符明确报错；
8. 无移动时 no-op，不产生 Git 副作用；
9. 受修复任务的 Session `cwd`／`sessionFile` 正确映射，字段保留；不在旧根下的会话不动；
10. 任务 13 回归：修复后 worktree 内派发按新路径执行，主检出拒绝 worktree 执行、`worktree list/status` 正常。

同时运行 `npm test`（含 typecheck、build）全量通过。真实模型、真实多机移动与原生客户端恢复不在此验证范围，按用户延期决定保留。

## 输入引用

- [仓库规范](../../../AGENTS.md)、[文档索引](../../../docs/README.md)、[工作流](../../workflow.md)。
- [docs/research/WORKTREE.md](../../../docs/research/WORKTREE.md) §6.5 随项目移动、§6.6 持久关联。
- [docs/design/DESIGN.md](../../../docs/design/DESIGN.md) §9.4、§16.3；[STATES.md](../../../docs/design/STATES.md)；[OPERATIONS.md](../../../docs/design/OPERATIONS.md) 恢复约定。
- 上游：[Worktree：执行路由、跨目录查询与会话续做](../archive/2026-11/11-03-worktree-execution-query-session-resume/task.md)（k-1910551e4f50，已交付）。

## 依赖与交接

- 依赖任务 13 的 `resolveProjectStart`／`executionRouteOf`／`verifyWorktreeRegistration`、`cliMainRoot` 与 executionDir 路由。
- 交付后为任务 15（清理）、16（跨目录交付）、17（并行调度）提供稳定定位；本任务不实现它们。

<!-- knit:progress:start -->
## 当前位置

交付阶段；实施 run 已接收，主 Agent self 自检通过，待完成与交付。

## 关键经过

- 实施 run `run-05768e92d334`（magpie/auto/glm-5.3-flash）完成并被接收（implementation_accepted），phase 进入 deliver。
- 新增 `src/application/worktree-repair.ts`（1244 行）与 `knit worktree repair [--task] [--apply]`：只读预检与 apply 分离；候选来自 binding（含无 worktree 任务）；project 布局按 `mainRoot + relativePath` 证明新路径，global 布局路径不变；先核 frontmatter id／Git 登记／分支／基线，再执行 `git worktree repair` 并复核；原子更新 binding `repoRoot`／`worktree.path` 与 `repairedAt`／`lastRepairOp`；受修复任务的 Session `cwd`／`sessionFile` 映射；活动／未知执行按 RunStore 终态与 task 锁双重核对后阻塞；操作写 `.knit/.runtime/worktree-repair/<opId>/` 的 journal／receipt，支持中断续做与部分成功报告；历史 run 资料不改写。
- 自检（主 Agent，self）：逐段核对 repair 预检、Git 修复、锁顺序、事务与回执逻辑；`npm test` 全量 381 项通过（含 typecheck、build），新增 11 个夹具场景全绿。
- 已知边界（未验证／待后续）：真实模型、真实多机移动与原生客户端恢复未验收；自定义 `--path` 位于 `.knit/worktrees/` 之外但仍在项目内时按 invalid 报告（当前按默认项目布局验证）；`taskId` 为 null 的主会话 `cwd`／`sessionFile` 不随任务修复改写，仍按原客户端回退规则续做。

## 结果与验证

- `npm test`（含 typecheck、build）381 项通过；新增场景：整体移动 project 布局、global 布局、frontmatter／分支冲突、新路径缺失、活动／未知执行阻塞、部分修复重试、只读与项目级错误、无移动 no-op、Session 映射与 sessionFile 缺失保留、任务 13 路由回归、无 worktree 任务 repoRoot 归一。
- 修改文件：`src/application/worktree-repair.ts`（新）、`src/application/worktree-manager.ts`、`src/cli/worktree.ts`、`src/contracts/metadata.ts`、`test/worktree-repair.test.mjs`（新）。

## 运行引用

- 实施 run：run-05768e92d334（snapshot ready；结果已接收）。
- 会话：s-e4d6fe43a351 / 9f780f75-ee6d-4c91-8964-a8e6d49838af。
- 本任务原无绑定行，派发前以 `knit task adopt k-d10f8d4c2833` 补齐 refs/heads/main 绑定；未改变任务身份。

### 交付记录

<!-- knit:delivery:op-dd5652bad678 -->
- 操作: op-dd5652bad678
- 时间: 2026-11-04T08:52:38.738Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-04-message-commit-push-remaining
- 工作提交: ee914ad148ff278c2f63cce251d9b4300a770f19
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-move-binding-repair

<!-- knit:progress:end -->
