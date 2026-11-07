---
id: k-9cd9a63bd5c5
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T15:16:51.209Z
title: Worktree 模式下的多任务调度
---

# Worktree 模式下的多任务调度

## 目标与边界

用户要求：在 Worktree 模式开启的前提下增加多任务调度（队列与并发上限）。Worktree 未开启时不提供该能力。

已有基础（已核对）：

- **并行执行已实现**：执行锁按执行目录取键，不同 worktree 可同时跑阶段并各自接收；同一执行目录、同一任务互斥；主检出一次一个（`OPERATIONS.md:31`、`:37`；`test/worktree-parallel.test.mjs`，任务 `k-2cbd2f312298`）。
- **队列事实已有但只读**：`priority`／`dependsOn`／`order` 由 `src/application/task-schedule.ts`、`src/domain/schedule.ts` 投影，`task next` 按稳定顺序列出可启动任务，不派发。
- **派发是手动的**：`run prepare`／`run start`／`run implement` 由主会话或用户逐次调用；没有并发上限、排队、依赖图调度或自动补位（`OPERATIONS.md:31` 明确「不设并发上限、排队、依赖图或跨机调度」）。
- **worktree 自动创建尚未实现**：见 `k-da9973a69c20`（默认 OFF、`run prepare` 首阶段前确保）。本任务的调度应以该任务提供的「每个任务独立执行目录」为前置。

目标（待确认范围）：在 worktree 模式下，按既有 priority／order／dependsOn 选出可启动任务，遵守并发上限派发 worker，槽位释放后补位，失败与取消互不影响，并给出可观察的队列状态。

边界：

- 不建跨机调度、不做多人协作、不做任务依赖图的可视化平台。
- 不绕过 `task ready`、授权、完成资格与既有锁；调度本身不改变业务状态判定。
- 交付与合入仍按既有主检出锁串行；调度默认不接管交付、合入与清理（是否自动推进到收尾见待澄清）。
- 不引入新的后台常驻服务，除非用户明确要求并接受其生命周期与恢复语义（现状：Knit 没有调度守护进程）。

## 已核对的缺口（「哪里有问题」）

1. **运行形态未定**：Knit 没有常驻服务；一次性命令派满即返回，还是常驻监听补位，决定实现与恢复方式。`DESIGN` §10.1 对交付明确「不额外建设后台操作调度器」，调度若常驻需要单独定义生命周期、取消与崩溃恢复。
2. **并发上限的原子性**：上限计数必须跨进程原子，否则同时调用两次 `schedule` 会超发；现有项目锁按执行目录取键，主检出锁被 `prepare`／交付占用，需要一个不阻塞派发的计数与占位方式。
3. **队列来源与阶段语义**：`task next` 只展示「可启动」；调度是只派第一个配置阶段，还是会连续推进 implement→check（需先接收结果）？检查阶段不能绕过接收与 `onVerdict`。
4. **worktree 门槛**：调度要求 `worktree.default: on`，还是只要任务已有 worktree 绑定即可？若 ON 时自动创建失败（脏守卫、分支占用），调度应跳过该任务还是整体停止。
5. **失败与重试**：run 失败、`needs_attention`、取消后槽位是否立即释放；是否自动重试（几次、间隔）；同一任务重复失败是否移出队列。
6. **授权范围**：一次 `schedule` 调用覆盖多少次自动派发？无人值守期间的模型调用与写入是否需要单独的明确授权；用户中断后队列如何停止。
7. **冲突与交付**：并行任务可能改同一批文件，worktree 只隔离工作区，不阻止后续合入冲突；调度是否需要输出冲突风险或限制同文件并发。
8. **可观测性**：需要队列视图（等待／运行／失败／上限）与事件；现有 `run list`／`status` 是否够用，桥接是否需要新工具或轮询。
9. **文档漂移**：`OPERATIONS.md:31` 的「不设并发上限、排队」与 `DESIGN.md:812` 的「多任务并行调度属于后续」都要改；已登记在 `k-a6a220185827`，本任务落地后需同步精确表述。

## 外部参考（2026-11-06 核对）

- **GSD（`open-gsd/gsd-core`，`gsd-core/workflows/execute-phase.md`）**：把计划按依赖分组成「波次（wave）」，波内可并行、波间串行；`parallelization=false` 时波内也串行。派发前先做**同波文件重叠检查**（`files_modified` 两两比较），重叠则降级为串行或警告（L548-580）。编排者保持轻量，只发现计划、分析依赖、分组、派发、收结果；每个执行者拿到独立上下文与 worktree。没有数字并发上限，波次就是批次单位。
- **Trellis 0.6.17（本地核对）**：`task.json` 里有 `relatedFiles` 字段，但 `task.py` 只在创建时初始化为空数组（`scripts/common/task_store.py:550`），全部脚本无写入、无读取；`types.py` 只是类型声明。即它是**未启用的占位字段**。Trellis 也没有「交付物」文档：`prd.md` 需求、`design.md` 设计、`implement.md` 执行清单、`research/` 调查；`implement.md` 是勾选清单，不声明文件路径。结论：Trellis 提供不了「交付物」的可参考实现，只能参考「把影响路径放任务元数据而不是计划」这个方向。
- **Claude Code agent teams**（官方文档）：共享任务列表＋认领＋依赖自动解锁，由 lead 协调；适合可独立开展的工作，文档明确「顺序任务、同文件修改、依赖多的任务用单会话或 subagent 更有效」；没有并发上限，团队规模由用户决定。另一页 worktrees 则明确「手动并行会话」：不提供自动协调。
- **Claude Squad／uzi** 等终端管理器：每个任务一个 worktree／tmux 会话，用户手动派发与查看，不做队列与并发控制。
- **共同点**：队列都基于依赖就绪集；并行以独立工作区为前提；在派发前处理同文件冲突比事后合入便宜；很少做「常驻调度守护进程」，多数由主会话／编排流程在一个命令里推进。

对 Knit 的启示：用现有 `dependsOn` 形成就绪集，按 `priority`／`order` 排序，取前 N 派发；派发前检测任务声明的改动路径重叠，重叠任务串行；一次 `schedule` 推进一批，不建守护进程。难点是 Knit 目前没有结构化的「影响路径」字段，需决定是否新增声明或先不做冲突检测。

## 已确认方向（2026-11-06）

- **影响路径声明与派发前重叠检查纳入本任务**：任务声明自己会改的路径；调度器对就绪任务两两比对，重叠的串行，不重叠的并行；声明同时作为提交范围的参考（不取代实际 diff 核对）。
- **影响路径属于交付物，不塞进 task.md**（2026-11-06 用户纠正）；但也不再新建 `deliverable.md`：放 `plan.md` 的固定区段，作为动手前的预期声明（用户 2026-11-06 决定）。task.md 只留需求与验收。
- **声明只写预期**：实际交付以运行时 scope 与 Git diff 为准；交付时比对声明与实际，超出声明则报告，不静默接受。
- **无 `plan.md` 的任务不参与并行**（单独跑）；不为简单任务强制新建计划。
- **目标是通过并行缩短总时长**：串行只用于真正有依赖或路径重叠的任务。
- **自动化优先**：用户希望调度能自动推进，不只派第一批。

建议的自动化边界（待确认）：派发 → 等待完成 → 自动接收结果 → 按 `onVerdict` 推进 implement／check → 直到任务到达 deliver 前停下并报告；交付、合入、清理仍需单独授权，不由调度自动执行。这样既自动，又不把“完成判定 + 提交授权”混进调度。

## 已确认方案（2026-11-06）

- **自动化边界**：派发 → 等待 → 自动接收 → 按 `onVerdict` 推进 implement／check；到达 deliver 后，配置了 `delivery.mode: merge` 或 `worktree.cleanup: after-merge` 就自动 close + deliver + 合入／清理（配置作为合入／清理的授权来源，记录摘要）；未配置时停在 deliver 前要单独授权；用户显式授权提交／合入／清理时按授权执行。
- **运行形态**：`knit run schedule --until-idle` 前台循环（默认），`--once` 只派一批；不做常驻守护进程；调度锁保证单实例。
- **worktree 门槛**：`worktree.default: on` 时才调度；未开启不报错，输出说明并退出 0，不派发、不接收，按常规逐个执行。仅任务绑定不开启调度。
- **影响路径**：`plan.md` 固定区段 `## 影响路径`，只声明预期；无计划的任务独占运行；实际交付以 scope + Git diff 为准。
- **并发**：`scheduler.maxConcurrent` 缺省 1；计数含手动 run；`maxAttempts` 缺省 1，只限单次 schedule 循环。

完整规则、失败语义、收尾顺序与测试见同目录 [design.md](design.md)。

## 待澄清

- 无阻塞项。已知口径冲突：本条把「配置了自动合入／清理」视为对应步骤的授权来源，与 `k-da9973a69c20` 第 5 节「配置不是授权」不同；实施时按本任务口径为准并同步修正那份设计。

## 完成条件

- `run schedule` 在 `worktree.default: on` 时按 design.md 的门槛、就绪集、排序、重叠检查、上限与锁生效；未开启时不派发、不接收，输出说明并退出 0。`--once` 与 `--until-idle` 行为正确。
- 自动接收与阶段推进不绕过现有接受／`onVerdict`／完成资格；失败不重派、不阻塞其它任务。
- 收尾：配置自动合入／清理时自动 close+deliver+merge/cleanup 并记录 config 摘要；用户显式授权提交／合入／清理时按授权执行；两者都没有时停在 deliver 前并报告。
- `plan.md` 影响路径解析与重叠判定按 design.md；无计划任务独占。
- 输出（文本与 `--json`）覆盖就绪、跳过原因、派发、接收、推进、失败与汇总；SIGINT 只停派发。
- 测试覆盖 design.md 第 11 节；真实 worktree + 真实模型端到端验收另记。
- 文档维护作为收尾（不另开任务）：DESIGN §3.11／§4.1／§6／§10／§13／§15.2，OPERATIONS 锁与调度语义，README／AGENTS 与受管块，docs／README 与 WORKTREE.md 的「后续」口径，命令帮助与桥接 schema，GLOSSARY 新术语；与 `k-a6a220185827` 分工避免重复，完成后全文检索旧口径清零。

## 文档维护（收尾）

调度实现完成后统一维护，作为本任务完成条件，不另开任务：

- DESIGN：§3.11 调度事实、§4.1 命令表、§6 Worktree、§10 交付边界、§13 配置、§15.2 移除「后续」。
- OPERATIONS：并发／排队旧口径改为「并行执行 + 显式调度器」，写清调度锁、计数、失败与 SIGINT。
- README／AGENTS（受管块重新生成）、docs/README 与 WORKTREE.md 的「后续」口径、命令帮助与桥接 schema、GLOSSARY 新术语。
- 与 `k-a6a220185827` 分工：它回写既有 Worktree 漂移，本任务只补调度新增内容；完成后全文检索，确认「不设并发上限」「多任务并行调度属于后续」等旧口径清零。

清单与优先级见 [design.md](design.md) 第 10 节。

## 输入引用

- 本次会话用户要求（2026-11-06）：补调度，但只在 Worktree 模式下提供。
- 并行与锁：`OPERATIONS.md` 第 2 节；`test/worktree-parallel.test.mjs`；任务 `k-2cbd2f312298`。
- 队列事实：`src/application/task-schedule.ts`、`src/domain/schedule.ts`、`DESIGN.md` §3.11。
- Worktree 开关：`k-da9973a69c20`（`design.md`）。
- 文档回写：`k-a6a220185827`。

<!-- knit:progress:start -->
## 当前位置

方案定稿（design.md）：门槛、就绪集、重叠检查、循环与收尾边界已确认；未实施。

## 关键经过

- 2026-11-06：核对并行执行、队列事实与派发现状，确认「并行有、调度无」；登记任务与缺口清单。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-07fe5862d55c -->
- 操作: op-07fe5862d55c
- 时间: 2026-11-07T03:59:05.089Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: 84d2fa10f4075a98186d1b7d4b6b94e016628fda
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-worktree-run-scheduler

### 任务资料提交记录

<!-- knit:metadata-commit:op-07fe5862d55c -->
- 任务资料提交: e4b6a4b9321f7a863225217c8e3a94b96ef2c67d
- 归档目标: .knit/tasks/archive/2026-11/11-06-worktree-run-scheduler

<!-- knit:progress:end -->
