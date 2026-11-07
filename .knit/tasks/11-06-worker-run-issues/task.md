---
id: k-ae990e2f36dc
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T14:26:07.489Z
title: Worker run 运行问题
---

# Worker run 运行问题

## 目标与边界

用户要解决的是「什么时候该派子进程（Worker run）、什么时候主会话直接做」没有明确定义（2026-11-06 讨论）。

用户确认的模型（以此为准）：

- **是否建任务完全由用户决定**，Agent 不替用户决定建或不建；建了任务就有归档与追溯，不建任务照样能把活干完，只是没有任务档案可追。
- **是否派子进程只取决于工作的复杂度**：简单、已知位置的工作由主会话直接做，省掉子进程启动、重读上下文与等待；复杂、涉及面广的工作派子进程，用干净上下文执行，只把结果汇报回主会话，主会话保持调度角色，不被过程细节污染。
- 任务存在与否与是否派 worker 是两个独立维度，不能互相推导。

用户要求：给出一套准确、可操作的分层标准，并参考其他开源／主流项目的做法。

已核对的事实：

- Run 状态枚举 `claimed`／`preparing`／`running`／`completed`／`cancelled`／`failed`（`src/contracts/run.ts:52-60`）；每个 run 在 `.knit/.runtime/runs/<run-id>/` 落 `state.json`、`request.json`、`inputs.json`、`instructions.json`、`claim`、`events.jsonl`、`result.json`。
- 派发不是自动的：`knit run implement`／`knit_run` 由主会话调用；`task ready` 只核对阶段与结构，不决定由谁实施。
- Knit 的 `run` 只服务正式任务；无任务时按 DESIGN §4.2 使用宿主通用子 Agent，宿主不提供时主会话直接做并说明限制。
- 正式任务可走「主会话直接实施 + `task implement` 记录」（DESIGN §3.8；归档任务 `k-795f3804775e` 实现该通道），因此任务存在不等于必须派 worker。
- `run check --scope` 提供不建任务的非正式只读检查，不赋交付资格。

## 外部参考（本轮核对，2026-11-06）

| 来源 | 与「是否派子代理」相关的结论 |
| --- | --- |
| Claude Code 文档（Create custom subagents） | 「Use one when a side task would flood your main conversation with search results, logs, or file contents you won't reference again: the subagent does that work in its own context and returns only the summary.」收益是保留上下文、限制工具、按任务路由更便宜的模型；每次子代理都单独计费。 |
| Cline 文档（Subagents） | 适合「需要来自代码库多个区域的大范围上下文」：陌生项目摸底、跨切面调查、改动前调研、大仓库；并明确「For small, focused tasks where you already know which files to look at, subagents add unnecessary overhead. Just ask Cline directly.」 |
| Roo Code 文档（Boomerang Tasks） | 用于大型多步项目拆分；子任务各自独立上下文，父任务只看摘要，保持高层调度；动机是复杂性与上下文隔离。 |
| Anthropic 工程博客（How we built our multi-agent research system） | 多代理适合「heavy parallelization, information that exceeds single context windows, interfacing with numerous complex tools」；不适合需要共享上下文或存在大量依赖的任务，「most coding tasks involve fewer truly parallelizable tasks than research」；成本上「agents typically use about 4× more tokens than chat interactions」。 |
| Trellis 0.6.17（本地） | 阶段实施与检查固定由子代理执行（非 inline 平台），不是按复杂度动态选择；与 Knit 需要的「按复杂度决定」不同，不能直接照搬。详见下节的任务绑定核对。 |

### Trellis 的任务与子代理绑定（本轮核对）

- **implement／check 子代理必须有任务目录**：`shared-hooks/inject-subagent-context.py` 定义 `AGENTS_REQUIRE_TASK = (AGENT_IMPLEMENT, AGENT_CHECK)`；找不到任务目录时 hook 直接 `sys.exit(0)`，不注入任何任务上下文（L69-71、L1124-1146）。这是软拦截：不报错，但子代理拿不到 prd／design／implement 与上下文。
- **research 子代理是例外**：`AGENTS_REQUIRE_TASK` 不含它，hook 注释写明「research doesn't require it」（L69-71、L1175-1176）；角色文件则要求在无活动任务时**询问用户写入位置，不自行猜测**（`claude/agents/trellis-research.md` Step 1）。
- **流程上先建任务**：workflow Phase 1.0「Create task [required · once]」在规划、研究与实施之前；Phase 2 只在任务 `in_progress` 后执行，因此正常路径下子代理总是任务绑定。
- **无任务时整条 Trellis 流程跳过**：Request Triage 写明简单对话／小任务由用户决定是否建任务，用户拒绝则本次不用 Trellis——也就是主会话直接干，不存在「无任务子代理」。
- **没有复杂度阈值**：Trellis 对有子代理能力的平台总是派 implement／check；对 `codex-inline`、Kilo、Antigravity、Devin、DeepSeek Harness 等无子代理平台则改为主会话 inline 执行。即它的分流依据是**平台能力**，不是复杂度。
- 对比 Knit：两者都是「正式阶段绑定任务」；Trellis 的拦截是 hook 静默跳过，Knit 是 CLI 硬报 `task_required`。差别在「何时派」：Trellis 默认全派，Knit 需要一套复杂度标准（正是本任务要定的）。

归纳：主流做法把「派子代理」绑定在**上下文负担**与**可独立完成**上，而不是绑定在「有没有任务」上；对「已知位置的小改动」明确判为开销。

## 建议标准（Agent 建议，待确认）

判定发生在动手前，按顺序走三步：

**第一步：是否可委派**（不满足则留在主会话，先澄清或边做边确认）
- 需求已稳定，能写清目标、范围与验收；执行期间不需要频繁反问主会话。
- 可独立完成：主会话能用任务资料／消息交代清楚，worker 不必共享主会话的隐性上下文。
- 若需求还在变、需要连续互动、依赖主会话未落盘的判断，则不派；先澄清，或主会话带着做（对应 Anthropic 指出的「共享上下文／依赖多」不适合委派）。

**第二步：满足任一条件即派 worker**（其余留在主会话）
- **W1 独立检查**：任务要求 `independent`，或结果正确性无法由作者自证（协议、数据迁移、权限、并发、安全、保护路径）。
- **W2 改动面**：改动点名后就能看到的范围 ≥ 3 个文件，或跨 ≥ 2 个模块／包（含必须同步的配置、测试、文档）。
- **W3 摸底成本**：动手前需要读 ≥ 8 个文件或 ≥ 1500 行，或依赖大量搜索／长日志——这些内容主会话不会复用。
- **W4 用户指定**：用户明确要求走 worker 流程。

恢复与跨会话能力不属于派发判据（2026-11-06 删除原 W4）：它是正式任务的共同属性，主会话与 worker 都能续；动手前也无法预知会不会被打断。需要跨会话时靠建任务保留 Session 引用与记录区，与派不派 worker 无关。

**第三步：全部满足则主会话直接做**
- 单文件或纯文案／注释／小函数／单个配置项；
- 动手前已知道改哪里，不需要广域探索；
- 自证足够（`self`／`none`），不需要独立检查；
- 一次做完。

**硬约束：不建任务就没有 Knit worker。** `run prepare/start/implement/check`（正式阶段）都要求 `--task <taskId>`（`src/cli/run.ts:59`、`:297`）；唯一例外是 `run check --scope`，它是非正式只读检查，不建 Task 绑定、不推进阶段、不赋交付资格。因此无任务时的「复杂」只能走宿主通用子 Agent 或主会话；要 Knit 的 implement→check 与恢复能力，必须先有任务，而建不建任务由用户决定。

**矩阵（任务 × 派发）**

| 工作 | 无任务 | 有任务 |
| --- | --- | --- |
| 简单 | 主会话直接做 | 主会话直接做，收尾用 `task implement` 记录 |
| 复杂、可委派 | 宿主通用子 Agent；需要独立核对时用 `run check --scope` | Knit worker（implement→check） |
| 复杂、强耦合或需求未稳 | 主会话先澄清再动手 | 主会话先澄清；确认可委派后仍建议派 worker |

**为什么这样分**：主会话直接做省掉子进程启动与重读输入；派 worker 的收益是干净上下文、只回摘要、可独立检查。阈值是默认值，用于减少临场摇摆，可随项目调整。

**不新增记录**：交付报告不单独标明「主会话实施／worker 执行」（用户 2026-11-06 确认）；两边已有的记录（`task implement` 文件、run 目录）足够事后核对，不另加展示或字段。

## 报错的含义（讨论结论，2026-11-06）

- 报错不是「没任务就不许干活」。主会话随时可以直接做，不需要命令、不会报错；`task_required` 只在对一个**只能绑定任务的派发命令**（`run prepare/start/implement/check`）漏传 `--task` 时出现。
- 桥接层同样拦在 `knit_run`：无 `taskId` 时返回「<action> 需要合法 taskId」（`.pi/extensions/knit.ts` 的 `knit_run`），而不是偷偷做主会话实现。
- 不照 Trellis 静默的原因：Trellis 的 hook 找不到任务就 `sys.exit(0)`，子代理照常启动但拿不到 `prd.md`／`design.md`／`implement.md`，只能靠猜——失败是无声的。Knit 的既有原则是「不静默降级」（AGENTS：缺少能力先报告；`external` 声明后工具不存在要报错）。把「派发失败」静默成「看起来在跑」比报错更糟。
- 不建议让 `knit run` 自己静默实现：run 是独立进程 + 冻结输入 + claim／快照／报告，命令本身无法变成主会话；偷偷在主会话做会让命令语义、记录与核心核对全部对不上。
- **报错保持不变**：用户 2026-11-06 确认不改文案也不做无任务降级；「找不到就报错」本身是合理行为，不让系统瞎猜。

## 待澄清

- [assumed] 无任务但复杂时使用宿主通用子 Agent 属合规路径（不建 Knit 任务、不出 Knit run）；用户未否认（Agent 建议，待确认）。
- [assumed] `run check --scope` 可作为无任务场景的独立只读核对，不赋交付资格（现行设计已有，非新增）（Agent 建议，待确认）。

## 完成条件

- 派发标准落入受管块模板、两个桥接文件、DESIGN §4.2 与 ROLE-CONTRACT，口径一致且不含时长／步骤数／阶段数／恢复需要阀值。
- 提示词明确：建任务仍由用户决定；无任务时不派 Knit run（用宿主子 Agent）；`independent` 不得用主会话自检或 `run check --scope` 代替；不得用 `task implement` 绕开 W1。
- 交付报告不新增执行方式字段（已确认），`task implement` 与 run 记录仍可事后核对。
- 测试：模板与注入一致性、受管块基线一致；真实会话行为另记待验收。

具体措辞、落地位置与反模式见同目录 [design.md](design.md)。

## 输入引用

- 本次会话用户说明（2026-11-06）：任务是否创建由用户决定；是否派子进程由复杂度决定；主会话承担调度。
- [design.md](design.md)：定稿标准、落地位置、反模式与验证。
- `src/contracts/run.ts`、`.knit/.runtime/runs/`、DESIGN §3.8／§4.2、ROLE-CONTRACT 第 2 节。
- 外部来源：Claude Code「Create custom subagents」、Cline「Subagents」、Roo Code「Boomerang Tasks」、Anthropic「How we built our multi-agent research system」。
- 前作：归档任务 `k-795f3804775e`（主会话实施凭据）、归档任务 `k-efc748322ccf`（澄清门）。

<!-- knit:progress:start -->
## 当前位置

任务已出方案（design.md），未实施、未授权提交。

## 关键经过

- 2026-11-06：登记主题，核对 Run 状态与本地 run 记录。
- 2026-11-06：核对现行路由：派发由主会话调用，`task implement` 提供正式任务由主会话实施的通道，任务与 worker 无绑定。
- 2026-11-06：核对 Claude Code／Cline／Roo Code／Anthropic 与 Trellis 的做法，形成「可委派 → 复杂度阈值 → 否则主会话」的三步标准。
- 2026-11-06：核对 `knit workflow show`（本项目 implement／check 两个阶段），确认「阶段数」不可作阀值；随后删除 W4（恢复与跨会话）——它是正式任务的共同属性，不是派发判据。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-a1e2f4cd5aa7 -->
- 操作: op-a1e2f4cd5aa7
- 时间: 2026-11-07T01:45:54.936Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: ea64d7391d26f03724b723828db9c60311703090
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-worker-run-issues

<!-- knit:progress:end -->
