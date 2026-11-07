# Worktree 模式下的多任务调度：设计

状态：2026-11-06 讨论定稿（自动化边界、运行形态、worktree 门槛已确认），未实施。

## 1. 命令与门槛

`knit run schedule [--once | --until-idle] [--max <n>] [--authorization-ref <ref>] [--dir <dir>]`

- 默认 `--until-idle`：循环派发、接收、推进，直到没有活动 run 且没有可派发任务。
- `--once`：只做一轮「计算 + 派发」，不等待、不接收，然后返回。
- `--max` 覆盖 `scheduler.maxConcurrent`（1..N），只影响本轮上限。
- **门槛**：项目 `.knit/config.json` 的 `worktree.default` 为 `"on"` 时才调度。未开启时不报错：`run schedule` 输出「worktree 模式未开启，未触发调度；按常规逐个执行」并退出 0，不派发、不接收。仅有任务级 worktree 绑定不足以开启调度。
- 不建常驻守护进程。调度锁保证同一项目同时只有一个调度循环：`LockManager` project scope，`rawKey = "schedule:" + normalizedRoot`，与普通项目锁（根路径）不同键，不阻塞 prepare／交付。

## 2. 配置

```json
"scheduler": {
  "maxConcurrent": 1,
  "maxAttempts": 1
}
```

- 缺省值：1／1；`doctor` 校验正整数。
- `maxConcurrent` 是调度器同时派发的上限；计数为 run store 中 `claimed`／`preparing`／`running` 的 run 数（含手动派发的 run）。手动 `run implement` 仍可自行超限，调度器不阻止，但会计入。
- `maxAttempts` 是同一任务在**一次 schedule 循环内**的最大派发次数；失败／接收失败后不再重派，记入报告。下一次调用重新计数。
- `scheduler.*` 只决定动作与上限。`worktree.default` 是调度门槛；`delivery.mode`／`worktree.cleanup` 的选择在用户明确配置时作为**对应收尾步骤的授权来源**（记录 `config:<相对路径>@<sha256>`），不授权提交本身；未配置时收尾需单独授权（见第 7 节）。

## 3. 就绪集与顺序

从任务事实派生，不新建队列文件：

- 条件：`status=open`、`outcome=null`、未归档、`stage` 是当前生效流程中的配置阶段、没有活动 run、没有待应用草案、`dependencyBlockersOf` 为空。
- 顺序沿用 `task next` 的稳定顺序：优先级 → `order` → 创建时间。
- `stage=start` 的任务不自动 ready（讨论与确认仍由主会话负责），不进入调度。
- `stage=deliver` 的任务进入收尾判定（第 7 节），不再派发阶段。

## 4. 影响路径与重叠

`plan.md` 固定区段：

```markdown
## 影响路径

- src/application/task-schedule.ts
- src/cli/run.ts
- test/worktree-parallel.test.mjs
```

- 解析规则：`## 影响路径` 到下一个 `## ` 之间，每行一个条目，去掉列表符号与行尾空白；仓库相对路径，允许目录前缀（`src/application/`），不做复杂 glob。
- 归一化：去掉 `./`、末尾 `/`；比较时按路径段前缀判断重叠（`src/a` 与 `src/a/b.ts` 重叠；`src/ab` 与 `src/a` 不重叠）。
- **无 `plan.md`、无该区段或区段为空**：任务视为「未知影响」，只能独占运行——当前没有任何活动 run 时才派发，且它运行期间不再派发其它任务。
- 候选任务与以下任务比对，重叠加则跳过（原因 `path_overlap:<taskId>`）：
  - 当前有活动 run 的任务；
  - 本轮已派发的任务；
  - 已有 worktree 绑定但尚未交付完成的任务（避免不同 worktree 改同一批文件后在合入时冲突）。
- 重叠判断只看声明，不读取主检出当前差异；声明不准确时由派发前人工澄清或交付核对兜底。

## 5. 派发

- 每轮按顺序取候选，直到达到 `maxConcurrent`。
- 对每个候选：调用现有 `run prepare`（首阶段会按 `k-da9973a69c20` 自动准备 worktree）→ `run start`。prepare 失败（脏守卫、无 HEAD、分支占用等）记录原因并跳过该任务，不重试、不阻塞其它任务。
- 计数与派发在同一调度锁内完成，避免两个 schedule 同时超发。
- 派发成功记录 runId／任务／阶段；`--once` 到此返回。

## 6. 循环、接收与推进（`--until-idle`）

- 每 2 秒轮询活动 run 的 state（`run status` 同源），不做模型调用。
- run 进入终态后：
  - `completed`：调用 `run accept`（现有接受流程，核对输入／scope／分支）。接受成功则按 `onVerdict` 推进 stage；接受失败记 `needs_attention`，该任务本轮不再派发。
  - `failed`／`cancelled`：记录终态与原因，释放槽位，任务本轮不再派发（受 `maxAttempts` 约束）。
- 每次状态变化后重算就绪集并补位。
- 停止条件：没有活动 run、没有可派发任务，且没有可自动收尾的任务 → 输出汇总并退出 0；调度锁冲突、配置非法 → 退出非零。
- `SIGINT`：停止派发与接收，保留活动 run，输出当前状态后退出；不自动取消 run。

## 7. 自动收尾边界

- 任务到达 `stage=deliver` 后按授权来源决定动作：
  - **配置了** `delivery.mode: "merge"` 或 `worktree.cleanup: "after-merge"`：视为用户对合入／清理的授权（记录 `config:<路径>@<sha256>`），自动执行 `task close --outcome completed`（核心核对证据）→ `deliver` → 按配置合入与清理。提交仍需可记录的授权来源；缺少时停在提交前说明缺口，配置只覆盖合入／清理，不覆盖提交。
  - **用户显式授权**提交、合入、清理（`--authorization-ref` 覆盖对应动作）：按授权执行，不要求先改配置；配置只决定默认是否自动合入／清理，不阻止显式授权。
  - **两者都没有**：停在 deliver 前，报告「待交付／待授权」，不自动提交、不合入、不清理。
- 授权来源记录在交付操作中：`config:<相对路径>@<sha256>` 或调用方声明；两者同时存在时优先记录调用方来源，并保留配置摘要。
- 与 `k-da9973a69c20` design 第 5 节「配置不是授权」的口径冲突：以本条为准——配置可作为合入／清理的授权来源并记录摘要，但不授权提交；显式授权可以覆盖全部动作。实施时同步修正那份设计。
- 自动收尾失败（完成证据不足、交付 needs_attention、合入冲突、清理被脏工作区阻断）：保留现场，记录原因，该任务本轮不再重试，继续其它任务。
- 关闭与交付仍由核心按现有完成资格、scope、分支与锁规则核对；调度不绕过。

## 8. 失败与并发语义

- 一个任务失败不影响其它任务；所有跳过与失败都带任务 ID 与原因。
- 同一任务不会出现两个并行 run（`run prepare` 已有复用／互斥规则）。
- 同一执行目录仍由现有执行锁串行；调度只保证不同 worktree 的并行。
- 不自动重试跨调用；下一次 `schedule` 重新评估。
- 不抢占、不取消正在运行的 run；用户可用 `run cancel` 单独处理。

## 9. 输出

- 启动时输出：门槛与上限、就绪／跳过清单（依赖未满足、路径重叠、未知影响、活动 run、草案）。
- 运行中输出：派发、完成、接收、推进、跳过、失败。
- 结束汇总：成功推进的任务、仍在运行、待交付、失败原因。
- `--json` 走现有协议输出，事件字段包含 `taskId`／`runId`／`stage`／`action`／`reason`。

## 10. 文档维护（本任务收尾的一部分）

调度落地后必须同步以下文档，作为本任务的完成条件，不另开任务：

- `DESIGN.md`：§3.11 补调度事实与就绪集；§4.1 命令表补 `run schedule`；§6 Worktree 补调度与 worktree 门槛；§10 交付边界补自动收尾与授权来源；§13 配置补 `scheduler.maxConcurrent`／`maxAttempts` 与 `worktree.default`／`delivery.mode`／`worktree.cleanup` 的生效关系；§15.2 删除「多任务并行调度属于后续」。
- `OPERATIONS.md:31`：「不设并发上限、排队、依赖图或跨机调度」改为「并行执行 + 显式调度器」，写清调度锁、计数、失败与 SIGINT 语义。
- `README.md`／`AGENTS.md`：命令与 Worktree 口径若与现状不一致，一并修正；AGENTS 受管块由 `agentsManagedBlock` 重新生成，保持基线一致。
- `docs/README.md` 与 `docs/research/WORKTREE.md`：Worktree 不再是「后续设计」；调度规则以 DESIGN／OPERATIONS 为准，不复制正文。
- 命令帮助文本与 `bridge-tools` 描述：`knit run schedule --help` 与本设计一致；若暴露桥接工具，参数 schema 同步。
- 术语表：调度、就绪集、影响路径、调度锁进入 `GLOSSARY.md`。
- 与 `k-a6a220185827` 的分工：它负责既有 Worktree 漂移回写；本任务只补调度新增内容，避免同节重复修改。两者都完成后做一次全文检索，确认没有「不设并发上限」「多任务并行调度属于后续」等旧口径残留。

## 11. 测试

夹具仓库 + fake Pi，不调用真实模型：

- 就绪集与排序：依赖阻塞、start 阶段排除、活动 run 排除、草案排除。
- 重叠：相等、目录前缀、不重叠、缺 plan／空区段（独占）。
- 上限与原子性：两个 schedule 并发只有一个取得调度锁；计数包含手动 run。
- 派发：worktree 门槛拒绝；prepare 失败跳过并继续；`--once` 不接收。
- 循环：自动接收、推进 implement→check、check pass 进入 deliver；接受失败／run 失败不重派。
- 收尾：无配置停在 deliver；配置+授权自动 close+deliver+merge/cleanup；配置缺授权停住；交付失败保留现场。
- 取消：SIGINT 后不再派发，活动 run 保留。
- 回归：主检出任务仍串行；`task implement` 路径不受影响。
- 真实 worktree + 真实模型端到端验收另记。

## 12. 不纳入

- 常驻守护进程、跨机调度、多人协作、并发上限的全局强制（手动派发仍可超限）。
- 任务自动 ready、自动澄清、自动拆分。
- 按文件内容预测冲突（只看声明路径）。
- 跨调用的自动重试与退避。
- 自动推送、发布或 PR。
