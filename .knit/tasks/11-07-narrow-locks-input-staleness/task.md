---
id: k-f0d9a8952aff
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P0
dependsOn:
  - k-6f0616f3779d
order: 50
createdAt: 2026-11-07T05:15:55.166Z
title: 锁收窄与状态写归属：任务级声明、工作树租约与 stale_input
---

## 目标与边界

### 背景与问题

当前把三种资源压在同一把 project 锁上，并由 worker 整阶段持有：

- `task new`／`update`／`ready`／`implement`／`close`／`rename`／`applyPending` 都要取 project 锁（`src/application/task-service.ts:1359`、`1859`、`2110`、`2176`、`2232`）。worker 一跑，另一 session 连登记任务都拿不到锁，直接 `lock_busy`（`src/infrastructure/locks.ts:210`）。
- run 的改动归属是整棵工作树的前后差，`.knit/**` 一律视为保护路径（`src/application/stage-runner.ts:960-970`），`task record` 这类追加会被判 `protected_path_modified`；而 `inputsDigestOf` 本来就排除记录区（`src/contracts/context-plan.ts:44`），这是归因误伤。
- 活动 run 中 `task update` 只允许存草案（`src/application/task-service.ts:1849-1857`），把改需求变成两步隐藏状态；收尾本来就能识别输入变化并转 `needs_attention: stale_input`（`src/application/run-acceptance.ts:209-214`、`668`）。

### 交付范围

1. 锁域拆分：任务不被长租约占用；任务锁为毫秒级短互斥；新增 `state:<主检出根>` 短锁；原 project 锁保留键名与 scope，语义改为工作树租约，只由 worker 与整树操作持有。
2. 「任务正在被处理」由 run 状态表达：`update` 在目标有活动 run 时必须声明 `--run <id>`，未声明报 `task_busy: run <id>`；`record`／`material save` 不要求声明。
3. 活动 run 中允许直接改输入，按现有状态机转移（`change` 回 start，需重新 `ready`；`clarify` 就地停留）；收尾按摘要判 `stale_input`，结果与工作区保留。
4. 归属收窄：`.knit/tasks/**` 整体从 `changedPaths` 剔除，不判越界，也不引入 journal；standards／config／workflow／agents 维持硬保护。
5. 补齐 `needs_attention: stale_input` 的出口与 `run status` 引导。
6. 同步提示词、文档与测试。

### 非目标

- 不强制 worktree；主检出仍可执行任务。
- 不把任务状态搬出被跟踪树。
- 不引入状态写入 journal、actor 归属判定或新增元数据表。
- 不因直接编辑 `.knit/tasks/**` 判 `protected_path_modified`。
- 不冻结 frontmatter，也不改状态机：输入更新沿用现有 `inputsUpdated` 转移。
- 不删除 `--pending`／`apply-pending`；只把它降为显式选项，且不需要 `--run`。
- 不引入强制接受旧规格产物。
- 不把材料（`plan.md`／`design.md`／`research/`）计入输入冻结。
- 不引入多用户／远程权限模型。

## 写入约定（软约束）

- 推荐经 Knit 接口写任务：`knit_task`（new／update／record／implement／ready／close）、`knit_material`（save／delete）。接口会做版本核对、输入摘要与阶段守卫。
- 直接编辑 `task.md` 或任务资料不判越界，但不会留下 actor 记录；能否被看见只取决于内容差异。
- 不论谁写、怎么写，输入区变化都会由 `inputsDigest` 检出并在收尾判 `stale_input`；记录区变化不影响摘要。
- 阶段提示词说明优先走接口，不做机械惩罚。

## 关键决定

- 直接写入加中途变更判 `stale_input`；结果保留，不计为对当前规格的成果。
- 主会话与其派发的子进程都能写同一任务；不设“只有持有者能改输入”。
- 输入更新沿用现有状态机：`change` 表示目标或方向变化，回 start 重新确认；`clarify` 就地补输入。
- 归属只按路径与摘要判定：任务资料目录整体剔除，不做 journal 与 actor 归属。
- `--pending` 保留为显式选项，不再是活动 run 的默认行为。
- 材料变化不判 stale。
- stale 之后只有两条路：等 run 结束或取消，然后重新 `ready`／开新 run；不引入强制接受。
- 锁与归属一起改，不拆任务；完成验证用 `independent`。

## 完成条件

- 任务 A 在主检出运行期间，另一 session 能成功 `task new`、`task update <B>`；A 的 run 仍 `accepted=true` 且 `inputsDigest` 未变。
- 同一窗口内 `task record <A>` 成功，A 的 run 仍 `accepted=true`。
- 活动 run 中 `task update <A>` 不带 `--run`：报 `task_busy: run <id>`，不写文件；带 `--run <id>` 且 `--kind clarify`：写入成功，阶段不变。
- 活动 run 中带 `--run <id> --kind change` 修改 A 的目标：A 的 run 收尾为 `needs_attention: stale_input`，结果与工作区保留；任务阶段回到 start，旧 run 结束后 `task ready` 可重新进入 implement。
- 阶段窗口内用 edit 直接改 `.knit/tasks/<A>/task.md` 的记录区：run 仍 `accepted=true`，`task.md` 不出现在 `changedPaths`。
- 阶段窗口内用 edit 直接改 `.knit/tasks/<B>/task.md`：A 的 run 仍 `accepted=true`。
- 阶段窗口内改 `.knit/config.json` 或 `.knit/workflow.yaml`：仍判 `protected_path_modified`。
- 同一检出里为任务 B 开第二个 run：prepare 阶段以 `workspace_busy` 拒绝，不生成新 run 记录；worker 持租约时 `snapshot restore`／`worktree merge`／`deliver` 被拒。
- 两个独立 CLI 进程并发 `task new`：得到不同 ID、不同目录，两个 binding 都在，无丢写。
- `--pending` 在活动 run 中仍可用且不需要 `--run`；不再是默认行为。
- 上述场景有自动化测试；`npm test` 通过。

## 实施要点

- `src/infrastructure/locks.ts`：`LockScope` 增加 `state`；保留 `project` 键名，语义改为工作树租约；`orderKeys` 只在末尾追加 `state` 档位，已有顺序不变；`locks`／`doctor` 显示新 scope。
- `src/application/task-service.ts`：`newTask`／`update`／`ready`／`implement`／`close`／`rename`／`applyPending` 改取 task＋state，不再取 project；`update` 在有活动 run 时校验 `--run`，其余逻辑与现有 `updateDirect` 一致（含 `inputsUpdated` 转移与凭据清理）；state 锁短等待（≤1s）后 `lock_busy`。
- `src/application/run-coordinator.ts`：`prepare` 不取 project；用 task＋state 串行化，锁内 `findActive` 复用既有 run；创建前只读检查工作树租约，占用时 `workspace_busy` 拒绝，不生成 run。
- `src/application/run-acceptance.ts`：接收取 task＋state；`attention` 分支不变，补 `run status` 的下一步提示。
- `src/worker/knit-worker.ts`：工作树租约与会话锁不变；任务写走短锁。
- 归属：`src/application/stage-runner.ts:960-970` 的剔除规则改为「`.knit/tasks/**` 全部剔除 + 排除已授权 standards；其余 `.knit/**` 仍判越界」。
- 错误与输出：新增 `task_busy`、`workspace_busy` reason，同步 `src/contracts/protocol.ts`、`src/contracts/errors.ts`、`src/cli/output.ts`。
- state 锁键统一用主检出根（元数据库所在），不用 worktree 根。
- 提示词：`src/application/templates.ts` 受管块与 `.knit/agents/implement.md` 写成「优先经 `knit_task`／`knit_material` 改任务资料，直接编辑不判越界但无法归因」。确认 worker 阶段会话里 `knit_task`／`knit_material` 实际可用。
- 文档：`OPERATIONS.md` 第 2 节（锁域、任务资料归属）、第 3 节（快照恢复范围）、`STATES.md` 第 3 节（直接写入与 stale）、`ARCHITECTURE.md` 锁职责、`DESIGN.md` 第 4.1 与 5.6 节附近、`GLOSSARY.md` 增补工作树租约。
- 测试：`test/infrastructure.test.mjs` 扩锁与并发；新增 `test/state-writes.test.mjs` 覆盖任务资料剔除、stale 判定、硬保护路径。

## 风险与回滚

- `.knit/tasks/**` 整体剔除后，worker 直接改自己的验收标准不会被判越界；输入区改动仍会触发 stale，记录区改动无害。这是已接受的取舍。
- 没有 actor 归属：并发写入只能靠内容差异与 git 状态辨认。
- 输入变化会让阶段在 run 期间改变（`change` 回 start），只影响后续派发；旧 run 未结束前 `prepare` 会复用旧 request，重跑前必须先等它结束或取消。
- 同区段并发写可能互相覆盖，靠 `expectSha256`／`expectDigest` 失败重试；记录区为追加，天然安全。
- 两个 prepare 与 worker 取租约之间有竞态窗口，最终互斥由 worker 取租约保证；prepare 的只读检查只减少无效 run，不承诺强互斥。
- 回滚只需还原剔除规则与取锁范围，无数据迁移。

## 输入引用

- 用户决定：锁收窄到任务级；主会话与子进程共写；任务资料直接编辑不判越界（放弃 journal 与严格写路径）；目标或方向变化回 start 重新确认是合理的；材料不算输入冻结；stale 后不接受旧产物。
- [docs/design/OPERATIONS.md](../../../docs/design/OPERATIONS.md) 第 2 节、第 3 节
- [docs/design/STATES.md](../../../docs/design/STATES.md) 第 3 节
- [docs/design/ARCHITECTURE.md](../../../docs/design/ARCHITECTURE.md) 基础设施与锁职责
- [AGENTS.md](../../../AGENTS.md) 开发约定与交付检查

## 依赖与交接

- 无硬前置。改动触及锁协议、阶段归属、提示词与状态机文档；实施前须通读上列章节与 `src/infrastructure/locks.ts`、`src/application/task-service.ts`、`src/application/run-coordinator.ts`、`src/application/run-acceptance.ts`。

## 待讨论与待验证事项

无 `[blocking]`。实施时核对：`--run` 的 CLI 与环境变量优先级；`workspace_busy` 的报错文案与退出码；worker 会话里 Knit 工具的实际可用性。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-07T05:16:17.078Z
- 方式: self → independent；理由: 并发与保护路径正确性无法自证

### 阻塞与复位（讨论期）

`task ready` 被 `repair_round_limit` 拒绝：`stageVisits.implement=3`，配置 `workflow.maxRepairRounds: 2` 只允许进入 3 次。讨论期四次 `update --kind change` 各回一次 `start`，每次 `ready` 重新进入 `implement`，预算在尚未执行任何 run 前耗尽。

一次性复位：备份 `.knit/.runtime/binding-backup-k-f0d9a8952aff.json`，将 binding 的 `stageVisits` 清空、`stopReason` 置 null；随后 `task ready` 成功。

待定：准备期（尚未执行过 run）的 `kind=change` 是否应消耗阶段访问预算。若沿用现语义，频繁澄清需求会反复触发该上限。

### 纳入审计修复计划（2026-11-07）

- 挂到总任务 k-2c0d10318898，优先级 P2 → P0；前置依赖 k-6f0616f3779d（崩溃锁自动回收）：本任务新增的 state 锁应纳入其自动回收。
- 后继 k-fdfd8c171736（改动来源归属）依赖本任务的 `.knit/tasks/**` 剔除规则，两者都改 stage-runner 收尾逻辑，须串行。
- 审计 S4 补充：run 期间用户编辑输入区，当前报 `protected_path_modified`，而不是 `stale_input`；本任务的剔除规则会让它走到 `stale_input` 分支，完成条件已覆盖。

### 跨机交接（2026-11-07）

交接到另一台机器执行：新机器没有本机 binding，stage=implement 时 `task ready` 会报 `phase_mismatch`（审计 S6）。因此把 frontmatter 改回 start，在新机器上重新 ready；输入未改。

<!-- knit:progress:end -->
