# 实施与验收清单（054 建议）

本文件把 [proposal.md](proposal.md) 的方案拆成可执行步骤和验收场景。**当前尚未实施**；本任务只交研究、文案和清单。若用户选择 B006 的 A 方案，以下第 1–5 步是提示词／上下文改动；若选择 B/C，另立核心任务，不能把状态机改动混进本清单。

## 1. 实施前决定

- [ ] 用户确认 B006：推荐 A（不新增 research 阶段；只读调查不建任务；正式报告仍 check＋受权交付）。
- [ ] 用户确认 B007 的处理：另立任务补 `task close --outcome completed` 的检查资格守卫；不把 close 当正式调研捷径。
- [ ] 若选择 B/C：先写状态／交付变更任务，再实施；本清单只作为提示词部分的参考。

## 2. 实施步骤

### 步骤 1：主会话分流模板

改动：

- `assets/templates/.knit/workflow.md`
  - 把“普通讨论与问答”扩展为“普通讨论、问答与只读调查”。
  - 增加“非正式独立复核”路径（`knit run check --scope`）。
  - 增加“正式研究报告／需要跟踪的调研”路径，明确只有用户要求正式跟踪／成果／复核时才建任务。
  - 增加“已有任务的辅助调查”，明确不推进阶段、不另建任务。
  - 在正式任务说明后补“没有默认的免检查／免 Git 模式”。

验收：

- 模板文本包含只读调查、非正式复核、正式研究报告三个关键词。
- 不出现“只读调查必须建任务”或“所有实施都必须检查”这类与分流冲突的绝对句。
- “普通问答直接回答”“不按关键词建任务”“授权不覆盖提交／发布”仍保留。

### 步骤 2：角色文案

改动：

- `assets/templates/.knit/agents/implement.md`
  - 产出从“代码改动”扩展为“代码、测试、配置、文档或研究报告”。
  - 增加“不要为了产生改动而改无关代码”“没有可核对产出时报告缺少成果”。
  - 明确只读调查不在 implement 执行。
- `assets/templates/.knit/agents/check.md`
  - 检查对象扩展为代码、文档、研究报告。
  - 报告类产出核对来源、覆盖、结论；无正式产出时 blocked，不形式通过。
- 可选：新增 `assets/templates/.knit/agents/advisory.md`，只读、不推进、建议不是完成证据。

验收：

- implement 不再把“代码”作为唯一产出。
- check 仍保持“不修改实施内容”。
- 可选 advisory 文件存在时，ContextPlanner 能把它作为 role 分节；不存在时仍不阻塞 advisory run（现有 `roleRequired` 只对 implement／check 为真）。
- 若新增 advisory，`TEMPLATE_SPECS` 必须有对应 project 条目，升级时为缺失项目补建。

### 步骤 3：AGENTS 受管块

改动：

- `src/application/templates.ts` 的 `agentsManagedBlock`：把“普通讨论、小修改、新正式需求”改为包含“只读调查”和“正式研究报告”的表述。
- 若新增 advisory，更新“阶段角色指令”的列表说明。

验收：

- `test/init.test.mjs` 的受管块唯一性、开始／结束标记、`.knit/workflow.md` 提及仍通过。
- 新增长句不破坏受管块按基线比较；人工修改仍报告差异，不静默覆盖。
- 旧项目升级测试仍保留自定义 AGENTS 内容。

### 步骤 4：每轮注入

改动：

- `assets/templates/pi/extensions/knit.ts`
  - 无任务分支：只读调查直接回答；临时只读委派不建任务；非正式复核用 `knit run check --scope`；只有正式跟踪／成果／复核才提议任务。
  - 有任务分支：补“只读辅助调查不推进阶段；仅用于只读调查的任务先确认转为正式成果或结束，不要自动派发 check”。
- 工具描述：`knit_task` 与 `knit_run` 加“只读调查不建任务／不派发”的提示。

验收：

- `test/bridge-query.test.mjs` 的无任务断言仍含“当前无选定任务”，并新增只读调查、非正式复核、正式跟踪的断言。
- 有任务注入断言包含“只读辅助调查不推进阶段”。
- 不改变 `before_agent_start` 的触发条件：仍只对用户轮次注入；`session_start` 仍自动 attach；不新增手动 `knit start`。
- 注入文本是行为引导，不是安全边界；写动作仍由核心核对（保留现有注释语义）。

### 步骤 5：规范与文档同步

改动：

- `DESIGN.md` §4.2 请求分类表：加“只读调查／外部评估”“非正式独立复核”“正式研究报告”；明确正式任务仍 implement→check→deliver。
- `DESIGN.md` §5.1：说明研究材料与正式报告的边界；正式报告不能在 `.knit/` 内由 worker 写。
- `OPERATIONS.md` 主会话段落：同步分流和“只读调查不建任务”。
- 如有必要，`GLOSSARY.md` 区分“只读调查”“正式研究报告”“非正式检查”；不要引入 research phase 术语。

验收：

- 搜索旧表述“实施按代码改动”“所有实施交检查”等，确认只保留在正式任务语境。
- 交叉引用 B006／B007 不把待决定项写成已生效规则。
- 术语一致：Knit 仍用 discuss／implement／check／deliver，不新增 research phase。

### 步骤 6：核心（仅当 B/C 被选择）

若用户选择 B1／B2／C：

- 先写状态与完成规则任务，明确：
  - 是否新增任务类型／outcome／field；
  - 谁有权标记“研究报告完成”；
  - 检查是否必需；
  - 无 Git 完成的 archive／seal 语义；
  - 旧任务兼容与回滚。
- 修改 `src/domain/task.ts`、`src/application/run-acceptance.ts`、`src/application/delivery-service.ts`、`src/contracts/*`、`STATES.md` 和相关测试。
- 不能用 `task close --outcome completed` 的现有缺口代替新规则；先修 B007 或在新规则中显式覆盖。

验收：

- 所有状态转移仍满足 `STATES.md` 不变量。
- 正式代码任务仍必须有效独立检查；研究例外只能由显式规则触发。
- `task close` 的完成守卫可审计，不接受“没有检查但 completed”的隐式路径。

### 步骤 7：验证命令

在实现改动后运行：

```bash
npm run typecheck
npm run build
node --test test/*.test.mjs
npm run pack:check
```

隔离夹具补充：

- 新项目 `knit init`：workflow／AGENTS／桥接内容正确。
- 旧项目自定义 workflow：升级后保留原文；不静默覆盖。
- 旧桥接未改：按基线升级；改过：保留并报告差异。
- 只读调查场景：无 task／run 副作用。
- 正式任务场景：仍有独立 check；检查失败不能被 deliver 绕过。

不要求：

- 真实模型轮（提示词行为可用确定性注入断言 + 后续真实宿主抽查；本轮不新增实现镜像测试）。
- macOS、NPM 发布、外部部署；这些仍按既有边界。

## 3. 验收场景

| ID | 用户请求 | 预期工具／阶段轨迹 | 明确不应发生 | 证据 |
| --- | --- | --- | --- | --- |
| S1 普通问答 | “解释这个函数做什么” | 读取相关文件／回答；无 `knit_task new`、无 `knit_run` | 不建任务、不写选择、不派 check | 任务数／选择条目不变；无 run 目录 |
| S2 只读外部评估 | “读这个外部项目，告诉我它的架构和风险，不要改任何东西” | `read`／`grep`／`find`／`ls`，必要时宿主只读子 Agent；直接回答并给来源 | 不建 Task、不 `run implement`、不因用了子 Agent 自动进入 check | 无任务、无 run、无项目写入；回答含来源 |
| S3 只读代码审阅 | “看这段 diff 有没有问题，不用建任务” | 主会话读取＋自检；或 `knit_run check --scope <路径...>`（非正式） | 不建 Task／binding；不推进 phase；不提交 | 非正式 check 结果只读；任务数不变 |
| S4 非正式小修改 | “把这个文案改一下，顺便跑下相关测试” | 编辑＋测试＋汇报；无任务 | 不建任务、不提交、不自动派检查 | 工作区改动；无 `.knit` 任务 |
| S5 正式代码开发 | “实现这个功能，建任务跟踪” | 授权后 `knit_task new`→`ready`→`knit_run implement`；接收后 phase=check；`knit_run check` pass 后 phase=deliver；授权后 `knit_deliver` | 不能跳过独立检查；不能由实施者自己宣布检查通过 | 任务 phase 轨迹、check 记录、`lastCheckRunId`、交付授权 |
| S6 正式研究报告 | “做一份可复核的调研报告并纳入任务” | 授权建任务；讨论写入报告目标／路径；implement 写项目内报告；check 核对来源／覆盖／结论；授权后 deliver 提交 | 不把报告写进 `.knit/`；不把任务 `research/` 当正式报告；不在未授权时提交 | 报告路径在项目内；check verdict；交付提交或停在 deliver |
| S7 已有任务辅助调查 | 已有正式任务中问“顺便查一下这个库的行为” | 主会话读取或只读委派；需要时 `knit_material save` 到 `research/`；phase 不变 | 不新建任务；不自动 `run implement`／`check`；不因材料保存改变 phase／inputsDigest | phase 前后一致；material list 增加；无新任务 |
| S8 正式任务独立复核 | “这个任务请独立检查” | `knit_run check --task <id>`（check／deliver 或未归档 completed 可触发） | 不在 discuss／implement 直接跳检查；检查者不改文件 | phase=check；check 报告；scope 未变 |
| S9 跨会话继续 | 重新打开 Pi 后继续当前任务 | `session_start` 自动 attach；`resolve` 恢复选择；注入当前任务；无需 `knit start` | 不清空选择、不新建重复任务、不重置 phase／修复次数／scope | resolve effective；注入含任务；任务 ID 相同 |
| S10 拒绝／未授权 | “先别建任务，只讨论” | 只回答／讨论；不调用创建 | 不 `task new`、不写选择、不派 run | 任务数／选择不变 |
| S11 只读调查回归 | 只读调查完成后检查 | 直接回答；阶段轨迹为空；任务表无新增 | 不出现 implement→check；不出现“仅为确认”而建的 check | 任务列表、run 列表、工作区均无变化 |

### 3.1 关键断言

- S1／S2／S3／S4／S11：`task new` 调用次数为 0；`run implement` 为 0；正式 check 为 0。
- S3：如使用非正式 check，`task list` 不变，`binding` 不创建，phase 不存在（无任务）。
- S5：`onImplementationAccepted` 后 phase 必须为 `check`；check 报告 `pass` 后必须为 `deliver`；未授权 `deliver` 不得提交。
- S6：报告文件路径不在 `.knit/` 下；check 覆盖报告路径；未授权时不得产生 Git 提交。
- S7：`material save` 不改变 task.md 输入区摘要、不产生 pending draft、不改变 phase（沿用 045／051 S4 的语义）。
- S9：新会话 `session resolve` 仍返回同一任务；注入内容不串旧任务；不要求 `knit start`。
- S10：拒绝后任务数、选择、目录均无变化。

## 4. 回归与升级验证

| 项目 | 验证 | 预期 |
| --- | --- | --- |
| 新初始化 | 隔离项目 `knit init` | workflow 含只读调查／正式报告；AGENTS 块含新表述；桥接含新注入；无冲突 |
| 旧自定义 workflow | 写入自定义内容后升级 | 原文保留；不静默覆盖；报告可发现差异 |
| 旧桥接未改 | 基线匹配时升级 | 更新为 managed 新模板；无重复条目 |
| 旧桥接已改 | 人工修改后升级 | 保留用户版本；不静默覆盖；给出差异／冲突结果 |
| 旧任务 | 单文件任务继续 | 仍可 list／use／ready；不被强制拆分 |
| 正式代码任务 | 现有 044–051 回归 | implement→check→deliver 语义不变；检查独立性不降级 |
| 正式报告任务 | 新增隔离夹具 | 报告走 implement→check；无 `.knit/` 写入；未授权不提交 |
| 只读调查 | 注入断言 + 宿主行为抽查 | 无任务、无 run；即使使用只读子 Agent 也不自动建任务 |

### 4.1 升级路径注意

- `workflow.md` 是 **project** 所有权：init 已存在即 keep；改源模板不会自动改旧项目。需要发布说明／迁移片段。
- 角色文件同样是 project：已有自定义 implement／check 不会被覆盖；可提供建议文本，但不能静默替换。
- 新 advisory 文件是缺失补建；已有同名文件保留。
- AGENTS 受管块只在基线匹配时更新；人工修改报告差异。
- 桥接是 **managed**：未改动的旧桥接按基线升级；用户改过的保留。
- 不能只在当前开发仓库改 `.knit/` 生成文件；源模板和安装包产物必须同步。

## 5. 完成声明边界

完成 054 只能声明：

- 固定 Trellis 基线的对照研究完成；
- 请求分流、角色职责、文案草案、实施与验收清单完成；
- 未修改产品提示词、模板、桥接或状态机；
- 未运行真实模型，未做 macOS／发布／真实项目验证。

不能声明：

- “Knit 已经能在真实会话中自动这样分流”——需要实施步骤 1–4 并验证；
- “正式研究报告已经可以免检查／免 Git”——B006 尚未决定；
- “Trellis 行为已在本机运行验证”——只做了源码与注入路径核对。
