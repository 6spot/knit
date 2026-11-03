# 051 独立验收：首版自然语言任务与规划全链路（2026-11-03）

## 结论速览

- **确定性链路**：8 场景 85 断言，80 通过 / 5 不通过；5 项不通过全部集中于实施交接的 worker 实际装配，已登记 **[B005](../../BLOCKERS.md)**（规划资料分节 path 错误 + stage 提示不渲染 planning 分节）。
- **真实宿主最小验证**：21/21 通过（pi 1.5.0 + 真实桥接 + 真实模型 magpie/group/openai，真实模型轮共 3 次）。
- **验收状态**：051 保持 **in_progress**。除 B005 涉及的"实施／检查角色实际读取规划资料"一项外，其余验收项全部通过；B005 修复后需复验确定性探针场景7（并建议补一次真实 worker 提示抽查）。
- 本报告不替代 043 的 16 项审计修复复验结论，也不替代 052 的 Pi 1.5.0 兼容结论；三者分别成立。

## 环境与基线

- Linux aarch64 / Node v24.21.0 / git 2.x；宿主 pi 1.5.0（`/home/opc/.pi/agent/bin/pi --version` → 1.5.0）。
- 仓库基线：提交 `666e1f378b5838a665ad267396862998d34f4d9c`（043 审计修复），工作区含 044–050 实现与 052/053 的未提交改动（38 个修改路径）；验收针对当前工作区状态。
- 核心命令验证（当前工作区重跑）：`npm run typecheck` 通过；`npm run build` 通过；`node --test test/*.test.mjs` **242/242 通过**；`npm run pack:check` 通过（8 项 PASS）。
- 模型：provider=magpie / model=group/openai（本机已配置）；全部证据不含凭据。

## 方法

1. **确定性接口验证**（无真实模型）：[deterministic-probe.mjs](deterministic-probe.mjs)，输出 [deterministic-probe-output.txt](deterministic-probe-output.txt)。复用 `test/bridge-query.test.mjs` 的 loadBridge／makeHostStub 模式（真实桥接模板经 tsc 编译后挂公开 API 替身）与 `dist/cli/knit.js`，在 8 个隔离临时 git 项目各跑 `knit init` 后覆盖完整链路；场景7 另以 dist 的 context-planner + stage 模块核对 worker 实际装配。
2. **真实宿主验证**：[real-host-probe.mjs](real-host-probe.mjs)，输出 [real-host-probe-output.txt](real-host-probe-output.txt)、事件流 [real-host-events.jsonl](real-host-events.jsonl)、摘要 [real-host-summary.json](real-host-summary.json)。复用 `validation/pi-1.5.0-compat/tools-probe.mjs` 的 RPC 探针模式：真实 pi 1.5.0 加载 `knit init` 生成桥接，3 轮真实模型（预算 3 次，未超）：
   - 轮1：模型经 `knit_task`（action=new → action=use）创建并选择任务；轮2：模型经 `knit_material`（save → read）写入并读回 plan.md；轮3：禁用工具，模型仅凭每轮注入的 knit 分节回答当前任务 ID 与资料列表。每轮后均以 CLI 核对真实落盘（任务、选择、resolve、plan.md 内容），不只看模型回复。
3. **复用既有证据**：包产物新初始化／旧模板升级沿用 [050 的 validation/workflow-integration/](../workflow-integration/README.md)（FRESH_INIT／WORKFLOW_NEW／BRIDGE_NEW／MATERIAL_SAVE／UPGRADE_KEEPS_CUSTOM／OLD_TASK_OK 全过，本轮 pack:check 复跑通过佐证包内容一致）；Pi 1.5.0 接口结论沿用 [052](../pi-1.5.0-compat/README.md)。

## 逐项验收映射（044 契约 → 051）

| # | 验收项（044 契约/051 必需复验） | 结果 | 证据 |
| --- | --- | --- | --- |
| 1 | 无任务轮入口规则；普通查询不建任务、不写选择、不落资料 | 通过 | S1 10/10：注入含"当前无选定任务/不建任务/task new 授权语义/task list"；knit_status 只读调用后任务数、选择条目、资料均不变 |
| 2 | 新正式任务：授权后 task new；稳定身份；拒绝无副作用；重复创建带提醒且不替换已有选择；非法路径拒绝 | 通过 | S2 12/12：`k-` 稳定 ID、选择持久化（entryRef）、拒绝（无调用）前后任务数/选择条目/任务目录均不变、`../escape.md` 被拒且无文件产生、重复创建返回"已选择任务 <id>"提醒且索引选择不变 |
| 3 | 多轮澄清：需求累积写入 task.md 输入区（clarify 保持 discuss）；待决项与未完成步骤入 plan.md 并持久；新桥接实例按任务目录读回 | 通过 | S3 7/7：两轮 clarify 累积落盘、plan.md 含"## 待决项/## 未完成"，新桥接实例读回一致 |
| 4 | 进度勾选（material save）不改 task.md/inputsDigest、不产生草案、不改变阶段（检查资格保持）；修改目标走 change 回 discuss 且摘要变化；clarify 保持当前阶段 | 通过 | S4 9/9：勾选后 task.md 字节不变、pendingDraft=null、phase=implement、inputsDigest 不变；change 后 digestChanged=true、phase=discuss、重新 ready 摘要不同；clarify 保持 implement / discuss 各得验证 |
| 5 | 实施前结构核对：简单任务无 plan.md 直接 ready；空 plan.md 阻止（ready_plan_incomplete）；有内容后通过 | 通过 | S5 3/3：CLI 错误信息"plan.md 为空；复杂任务的实施计划未完成" |
| 6 | 跨会话接续：同原生会话重启同 knitSessionId 且 resolve 恢复选择；新会话新 ID 默认无选择不复活旧任务；接续后注入同一任务不串任务；资料随任务目录读取（改名后按稳定 ID 定位） | 通过 | S6 13/13：resolve 返回 `source=native/effective=true`；新会话 resolve `taskId=null/effective=false`；task use 后恢复；rename 后 material read 仍命中 |
| 7 | 实施交接：ready 后实施／检查上下文含规划资料分节 | **部分不通过（B005）** | S7 12/16：ContextPlan 分节本身齐备（plan/design 全文 digest 与磁盘一致、research 仅入口摘要）；但分节 `path` 为 `.knit/tasks/tasks/<dir>/…`（错），`loadSectionContents` 据此载入 0 个规划分节，实施提示不含 plan/design 正文（`buildUserPrompt`/`buildSystemPrompt` 均不渲染 `planning-material`）→ 见 [B005](../../BLOCKERS.md) |
| 8 | 每轮注入刷新：随任务选择/阶段/资料更新刷新，不堆叠、不串任务；custom 轮不注入 | 通过 | S8 12/12：discuss→implement 阶段刷新、新增 design.md 后列表刷新、重复轮内容稳定、切换任务后旧任务 ID 与资料不再出现、custom 轮分节为空 |
| 9 | 真实宿主：真实模型经 knit_task 创建+选择并落盘 | 通过 | R1：knit_task new（title/slug 与请求一致）+ use；任务落盘、选择 persisted、`session resolve` effective=true |
| 10 | 真实宿主：真实模型经 knit_material 写 plan.md 并正确读回 | 通过 | R2：save+read 调用；plan.md 落盘含"## 未完成"与两个未勾选步骤；模型回复"# 实施计划"（读回数据正确） |
| 11 | 真实宿主：每轮注入（before_agent_start + systemPromptOptions.sections）到达真实模型 | 通过 | R3：第 3 轮禁用工具，模型凭注入回答任务 ID `k-…` 与"规划资料列表：plan.md"，0 次工具调用 |
| 12 | 包产物新初始化与旧模板升级可走完整入口；旧单文件任务/自定义规则保留 | 通过（复用 050 证据 + 本轮 pack:check 复跑） | [validation/workflow-integration/](../workflow-integration/README.md)；旧单文件任务未强制拆分 |
| 13 | 主 Agent 自然语言行为完整质量（自主分类措辞、多轮澄清对话质量、修改提议承接） | 未验证 | 真实模型预算 3 轮已用于工具链路与注入到达验证；多轮自然语言对话行为未覆盖（确定性侧已验证承接接口与授权语义，见 #1–#4） |
| 14 | 真实 worker run（prepare/start 实际实施轮）在真实提示下读取规划资料 | 未验证（受 B005 影响） | B005 使 worker 提示现缺规划分节；修复后需补真实 run 提示抽查；本轮以 dist 装配函数静态断言代替（场景7） |

S1–S8 对应 [deterministic-probe-output.txt](deterministic-probe-output.txt)；R1–R3 对应 [real-host-probe-output.txt](real-host-probe-output.txt)。

## 确定性验证 / 真实宿主验证 / 未验证项（明确区分）

- **确定性接口验证**：上表 #1–#8、#12。替身只替换宿主公开 API（命令/工具注册、事件分发、原生会话文件），核心语义全部经真实 CLI 进程与真实磁盘落盘核对。
- **真实宿主验证**：#9–#11。真实 pi 1.5.0、真实桥接模板（init 产物）、真实模型 3 轮；核对以落盘事实为准（任务记录、选择索引、plan.md 内容、resolve 结果），模型回复仅作辅助。
- **未验证项（如实保留，不以替身冒充）**：
  - #13 主 Agent 自然语言行为的完整对话质量（需更多真实模型轮，本轮预算 3 次已用尽）。
  - #14 真实实施 run 中 worker 实际收到规划资料（当前因 B005 必然缺失，需修复后验证）。
  - macOS 平台、NPM 发布、外部部署与真实项目操作：按边界未执行。
  - 043 的 16 项审计修复复验、052 的 Pi 1.5.0 兼容结论：各自独立成立，本验收未重跑其全部证据（typecheck/build/242 项测试/pack:check 在当前工作区复跑通过）。

## 遗留

- **B005**（[BLOCKERS.md](../../BLOCKERS.md)）：`src/application/context-planner.ts:282` 任务目录名切片含多余 `tasks` 段 → planning 分节 `path` 错误；`src/application/stage.ts:59-77` 按错误 path 读取失败静默跳过，且 `buildSystemPrompt`（120 行）/`buildUserPrompt`（140 行）不渲染 `planning-material` 分节。digest/冻结摘要语义未受污染（planning 分节 countsTowardInputs=false）。
- B005 修复后的复验入口：`node validation/main-workflow-gate/deterministic-probe.mjs`（场景7 五项转 PASS，脚本其余 80 项应保持通过）；建议另补一次真实 worker run 提示抽查后，将 051 标记 completed。
