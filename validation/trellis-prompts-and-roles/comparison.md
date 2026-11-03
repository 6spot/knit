# Trellis 与 Knit 的对照（054）

本文件只比较固定提交 `f089cb3286071199e84118dee86b6d76aab032f1` 与当前 Knit 源码。Trellis 行是源码／注入路径核对；Knit 行是当前实现事实。建议方案另见 [proposal.md](proposal.md)。

## 1. 对照表

| # | Trellis 来源与实际行为 | Knit 当前对应点 | 差异与问题 | 采用／不采用的理由 | 影响位置 |
| --- | --- | --- | --- | --- | --- |
| 1 | `workflow.md` L155-159、L179-183：先分简单／复杂请求；简单请求也要问是否建任务，用户拒绝就本次跳过；复杂请求进入规划。 | `workflow.md` L5-13 有五类路径；桥接无任务注入 L314-317 只列普通问答、小修改、正式需求、继续／补充。 | 没有“较长只读调查／外部项目评估”的显式路径；模型容易把“要读很多文件”误判为正式需求，随后建任务。 | **采用“显式无任务路径”**；不采用“每个简单请求都问建不建任务”，Knit 普通问答应直接回答。 | workflow、桥接注入、AGENTS 受管块、DESIGN §4.2 |
| 2 | `workflow.md` L159、L325-339：任务创建同意不等于实施同意；创建后仍是规划，`start` 才是实施门。 | Knit `workflow.md` L11 已要求先提议再 `task new`；DESIGN §4.2 明确授权不覆盖提交／发布。 | Knit 已有此规则，真实案例不是缺少“同意≠实施”。 | **保留**；不需要新状态或新确认步骤。 | 无 |
| 3 | `pi/agents/trellis-research.md` L1-25：工具含 write，但必须先 `task.py current`，只写当前任务 `research/`，回复路径和摘要；Claude 变体（`claude/agents/trellis-research.md` L30-32）在无任务时要求询问用户写到哪里。 | Knit 没有 research 阶段或内置 research 角色；`advisory` 需要 taskId（桥接 L633-642），且没有 `.knit/agents/advisory.md`。 | Trellis 的 research 角色是**任务内规划助手**，不是“免任务回答”的闭环；它也不负责完成／检查规则。 | **采用“有正式任务时把调查材料落文件”**；**不新增 research 阶段／角色**，因为角色名不解决任务入口，反而增加 phase／tool policy。 | 可选 workflow、research 材料约定；无核心改动 |
| 4 | `workflow.md` L369-390：研究输出按主题写入 `{TASK_DIR}/research/`，路径和摘要是给主 Agent 的交接；聊天不是持久载体。 | Knit 任务资料 `research/` 由 ContextPlanner L274-298 摘要注入；主 Agent 用 `knit_material` 写；worker 系统提示 L140 禁止修改 `.knit/`。 | Knit 已有研究材料通道，但 worker 不能把正式报告写进 `.knit/`；正式报告必须是项目内文件（如 `docs/…`、`validation/…`）。 | **采用“研究材料与正式报告分开”**：材料进任务目录，报告进项目路径；不把 `research/` 当交付物。 | workflow、implement 提示、材料文档 |
| 5 | `pi/agents/trellis-check.md` L21-37、`workflow.md` L545-553：check 读 diff 和任务产物，发现问题**直接修复**，再跑 lint／typecheck。 | Knit `check.md` L3 明确“不修改实施内容”；阶段工具策略只读；接收时若 scope 被改动则拒绝。 | Trellis 的 check 是“自修＋验证”，与 Knit 的独立检查职责相反。 | **不采用**；保留 Knit 的独立性。可以借鉴其“先看 diff、再对任务产物、最后跑验证”的检查顺序。 | 可选 check 文案；核心不变 |
| 6 | `workflow.md` L147-152、L273-279、L600-640；`finish-work.md` L1-20：Phase 2 检查、Phase 3 commit 都是 required steps，研究任务也不能跳过。 | `onImplementationAccepted` L151-160 固定 implement→check；delivery 需要有效检查；正式任务没有“研究报告跳过 check”的阶段。 | 正式研究任务同样会被推到 check；若不想 check／commit，就不应把它做成正式任务。 | **正式任务保留 check＋受权交付**；是否为“正式只读调研”开例外是产品决定，见 [B006](../../BLOCKERS.md)。 | 若选例外：domain/task、run-acceptance、delivery、STATES |
| 7 | `workflow.md` L234-240；implement／check 角色 L11-17：派发只由主会话发起；子 Agent 不能再派发 implement／check；派发提示以 `Active task` 开头。 | `stage.ts` L137-142 已写明“独立阶段执行器、不是主 Agent、不要委派其他 Agent”；角色文件没有再重复。 | Knit 已有等价递归守卫，只是没有 `Active task` 前缀。 | **保留现有守卫**；不为了复制 Trellis 格式新增派发协议。 | 无；仅在角色文案需要时补一句 |
| 8 | `workflow.md` L392-414：用 `implement.jsonl`／`check.jsonl` 手工整理 spec 与 research 路径；代码文件不预登记。 | ContextPlanner L274-298 自动注入 `plan/design` 全文和 `research/` 摘要；任务资料由 `task material list` 展示。 | Trellis 需要主 Agent 先做 manifest；Knit 已自动装配，且研究材料按需读取。 | **不采用 jsonl manifest**；保留 Knit 的自动规划资料。若正式研究报告需要检查全文，应把报告作为项目文件加入 scope，而不是塞进 research 摘要。 | 无 |
| 9 | Pi 扩展 `index.ts.txt` L1124-1151、L2066-2085：从 workflow 的状态块解析 `no_task`／`planning`／`in_progress`，每轮 `before_agent_start` 注入。 | 桥接 L291-320 每轮 `buildTurnContext`；`before_agent_start` L322-340 注入 `systemPromptOptions.sections.knit`。 | 机制已经等价；Knit 的无任务文案缺少只读调查。 | **采用“每轮注入”**（已实现）；本次只改注入内容，不新增入口。 | 桥接模板、bridge-query 测试 |
| 10 | Pi 扩展 L2028-2033：`session_start` 提示可用 `/trellis-start`／`/trellis-continue`；同扩展 L1824-1837、L2066-2118 在 `before_agent_start` 注入缓存的 session overview／workflow 启动上下文。 | 桥接 L342-352：`session_start` 自动登记／恢复选择并启动观察；L322-340 每轮注入任务上下文；`knit start` 只是可选启动方式。 | 两者都能自动给首轮上下文；Trellis 另提示 start／continue，Knit 把恢复选择放在 `session_start` 自动完成。 | **不采用手动 start 前置条件**；保留 Knit 自动 attach，并把“无需先 knit start”写入验收。 | 无核心改动；跨会话验收 S9 |
| 11 | `common/skills/brainstorm.md` L11-19、L39-70；`workflow.md` L346-347：先查代码／资料，再只问用户必须决定的事；一次问一个最高价值问题。 | `workflow.md` L17 已要求“从任务资料和工程代码取事实，已有资料能回答的不重复询问；只就需用户取舍的事项提问”。 | Knit 有“先取证”，没有明确“一次一个问题”。 | **部分采用**：讨论阶段可补“一次只问一个最高价值问题”；不新增状态。 | workflow 讨论章节 |
| 12 | `workflow.md` L600-640；`finish-work.md` L1-20：AI 起草分批提交、用户一次性确认，之后归档并记录 journal。 | `knit deliver`／`archive` 要求完整分支；Agent 交付还需 `authorizationRef`（直接 CLI 调用另记显式调用）；提交不由 worker 执行；不自动提交。 | Trellis 的收尾更自动化；Knit 的授权边界更严格。 | **不采用自动提交**；保留 Knit 的显式授权。研究结论若只是回答，不需要 Git 交付。 | 无 |

## 2. 实际调用链

先注意状态模型不同：Trellis 的任务 status 主要是 `planning`／`in_progress`／`completed`，research 是 planning 内的可选步骤；Knit 的 phase 是 `discuss`／`implement`／`check`／`deliver`。因此 Trellis 的 research 不能直接映射成 Knit 的新 phase，也不能用其 research 角色推断 Knit 的完成规则。

### Trellis

1. Session start 注入项目上下文；每轮 `before_agent_start` 从 `workflow.md` 解析并注入 `workflow-state`（`index.ts.txt` L1124-1151、L2066-2085）。
2. `workflow.md` 的请求分流先要求任务创建同意；复杂任务进入 Phase 1，研究是 Phase 1.2 的一个可选步骤（L367-390）。
3. `trellis-research` 是子 Agent 类型：Pi 角色先解析活动任务，只写 `research/`；它不是主会话的“直接回答”路径（`trellis-research.md` L15-25）。
4. Phase 2 的 `trellis-check` 会直接修复发现；Phase 3 的 spec 更新和 commit 是 required（`workflow.md` L147-152、L543-553、L600-640）。
5. 因此，Trellis 的独立 research 角色不能证明“研究任务可免检查／免提交”；它的实现反而把 research 放在正式任务和后续 required steps 之内。

### Knit

1. 正常打开 Pi：`session_start` 自动登记主会话、恢复任务选择并启动 run 观察（`knit.ts` L342-352）；无需 `knit start`。
2. 每轮 `before_agent_start` 注入当前任务／阶段／资料，或注入无任务入口（L291-340）。
3. 主 Agent 按 `workflow.md` 自行判断是否 `task new`；核心没有关键词分类器，任务创建是模型行为，拒绝＝不调用＝无副作用（任务 048）。
4. `task ready` 后，实施 worker 的 accepted 结果由 `onImplementationAccepted` 无条件推进 `implement → check`（`domain/task.ts` L151-160）。
5. check 的 pass → deliver；changes_requested → implement；deliver 才做受权提交／归档（`domain/task.ts` L162-178、`run-acceptance.ts` L322-367）。
6. `run check --scope` 是另一条非正式只读检查路径，不建 Task／binding，也不推进 phase（`informal-check.ts` L123-142）。

## 3. 真实案例的因果链

`knit-demo` 的 `k-748f2087202d`（`11-03-eval-pi-rexagents`）只要求静态调研，但轨迹是：

```
用户请求：阅读外部项目并给结论
  → 主 Agent 没有“只读调查”入口，按“新正式需求”建任务
  → discuss/ready
  → 因为正式任务只有 implement 是写入阶段，派发 implement
  → implement 报告被接收（changedPaths 为空集也可通过，run-acceptance L267-270）
  → onImplementationAccepted 固定 implement → check；按现有流程，下一步就是独立检查
```

结论：

- **不是模型误读某一句提示词**，而是三处叠加：入口缺少只读路径、实施角色以代码改动为表述基础并固定交检查、核心转移不区分类别。
- **不能靠“调用子 Agent 不等于实施”解决**：真正决定阶段的是 `task new` 和 `run implement`，不是子 Agent 的名字。
- **Trellis 的 research 角色不是反例**：它仍然依附任务，且在 Pi 上先解析活动任务；它没有把 research 变成免任务、免检查的完成路径。
- **现有 `advisory` 也不是轻量闭环**：必须带 taskId；报告只作为 run 结果，不写任务输入／业务资料，也不推进阶段；没有任务时不可用。
- **现有 `run check --scope` 可做“非正式独立复核”**，但它是检查语义，不是研究入口；不建绑定、不赋交付资格。

## 4. 当前实现的边界事实

| 事实 | 依据 | 对方案的含义 |
| --- | --- | --- |
| 阶段枚举没有 research | `src/contracts/run.ts`、`src/contracts/session.ts` | 要么不建任务，要么走现有 implement/check；新增 research phase 是产品变更。 |
| implement 接收不要求 changedPaths 非空，也不要求是代码 | `run-acceptance.ts` L261-270 | 空操作的 implement 也会推进 check；真实案例不需要“伪造代码”即可进入 check。 |
| worker 禁止修改 `.knit/` | `stage.ts` L140 | 正式报告不能由 worker 写进任务目录；报告必须是项目路径。 |
| check 只读且不能修改成果 | `check.md` L3；`run-acceptance.ts` L345-347 | 研究结论由实施产出、检查核对；检查者不能代为改写。 |
| 正式完成按规则须有有效检查 | `STATES.md` L47；`domain/task.ts` L209-216 注释 | `task close --outcome completed` 不能当成正式调研的合法跳过路径；当前实现守卫见 [B007](../../BLOCKERS.md)。 |
| deliver／archive 要求完整分支；Agent 交付另需授权来源 | `src/cli/deliver.ts` L76-97；`delivery-service` | 没有“免 Git 正式完成”的现有模式；不建正式任务是最小替代。 |
| 模板升级保留项目 workflow | `templates.ts` L20-29；`init.test.mjs` L86-105 | 只改源模板不会自动改旧项目的自定义 workflow；需要迁移说明或用户手工采纳。 |
| 桥接是 managed | `templates.ts` L20-29；init 基线逻辑 | 未改动的桥接可按基线升级；用户改过的桥接会保留并报告差异，不能静默覆盖。 |

## 5. 研究结论摘要

- **值得借鉴**：无任务状态的显式分流、任务创建同意与实施同意分离、研究材料持久化、先取证再问、每轮状态注入、子 Agent 递归守卫。
- **不适合直接照搬**：Trellis 的 research 子 Agent（仍依附任务）、check 自修（破坏独立性）、required commit（越过 Knit 授权边界）、手动 `/trellis-start`（Knit 已自动入口）。
- **不建议**：为真实案例新增 research 阶段或把 advisory 包装成研究闭环；这会扩大状态机而不解决“何时该建任务”的入口问题。
- **建议主线**：把只读调查放回主会话，把正式研究报告留给正式任务；正式任务仍走 implement → check → deliver，除非用户明确决定 B006 的例外规则。
