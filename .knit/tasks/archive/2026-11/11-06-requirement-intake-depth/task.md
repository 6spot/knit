---
id: k-9197494d2657
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-06T14:15:40.000Z
title: 需求澄清深度不足：过早脑补与一次性确认
---

# 需求澄清深度不足：过早脑补与一次性确认

## 目标与边界

用户反馈（2026-11-06）：Agent 对需求问得不够细。用户说明一个具体情形后，Agent 自行补齐大量理解，最后只让用户做一次「是否正确」的确认。期望按成熟的需求挖掘方式：先想清楚用户描述里有哪些不足、冲突或不合理之处，对照项目里已有的规则、决定与事实，主动提示问题并给出更好的建议，多问几轮，把需求说明确后再进入实施，以减少返工。

现状（核对证据）：

- 现行规则只写方向，不写过程。AGENTS 受管块与桥接注入只有「关键缺口先讨论，呈现缺口与选项；需求明确直接登记」等一句（`src/application/templates.ts:73-74`、`.pi/extensions/knit.ts` 的 `SESSION_BEHAVIOR_GUIDANCE` 与无任务分支），没有缺口维度、取证要求、提问节奏和停止条件。
- 判断权在模型自评：「需求明确直接登记」（受管块）、「已有资料能回答的不重复询问，只就需用户取舍的事项提问」（[DESIGN](../../../docs/design/DESIGN.md) 4.2）方向都是压低提问，模型很容易得出「我懂了」。
- 没有机械核对：`task ready` 只检查 `plan.md` 是否为空与前置依赖，待决项是否清空仍属主 Agent 语义判断（`src/application/task-service.ts` 的 `assertReadyStructural`，注释明确「目标占位是否已确认属主 Agent 语义判断」）。
- 没有留痕：讨论中的假设与未决问题不落盘、不计数、不进注入，下一轮无法核对「用户答了什么、Agent 假设了什么」，最后只能靠一次总确认兜底。
- 已有前作：任务 `k-efc748322ccf`（2026-11-03）已实现澄清门（关键缺口先讨论／明确直接登记／想法标注／假设标注／复杂拆分／创建≠授权），但仍只是提示词条目。本轮针对「实际行为没跟上」的补强，不重复该任务结论。

目标：形成可执行的澄清协议——按固定维度做缺口扫描、先取证再提问（含项目既有决定与任务历史）、与既有决定冲突时主动指出并给替代方案、按轮次向用户取决定、未决项留痕且 `ready` 机械拦截；未完成澄清不进入实施。

边界：

- 不引入模型侧校验或外呼；核心继续只做确定性核对。
- 不新增 status／stage 或独立需求状态机；沿用 start（讨论）、task.md 与 ready 入口。
- 不强制固定轮数，不允许形式化盘问：已有资料能回答的不问、一次不塞一堆问题、闲聊与非正式小修改不套用。
- 不以「多问」为由拖延明确需求；用户明确授权或给出结论后按该结论推进。
- 真实宿主中的行为验收已由用户延期；本任务只做提示词／注入一致性与夹具级验证，行为效果另记待验收。

## 已确认决策（2026-11-06 讨论）

- **A（约束力）**：提示词协议与结构化记录两者都上。task.md 增加固定「待澄清」区段；存在 `blocking` 项时 `task ready` 拒绝；桥接每轮显示未决数量。不做独立状态机。
- **B（取证范围）**：采用 Trellis 的 Non-Negotiable Evidence Rule——先查代码、测试、配置、文档、既有规范与任务历史，再问用户；归档任务、run 记录与提交说明可用于核对「是否已有决定」。同时保留 Trellis 的界限：仓库证据只证明现状与约束，不能代替产品意图；既有模式是选项与推荐依据，不是决定。
- **C（节奏）**：按 Agent 建议：一轮最多 3 个决定，一个问题只问一件事；每个问题给出「要定的决定、为什么重要、推荐项、选另一个的代价」；用户不答时允许按推荐推进，但必须写成假设并落盘。
- **D（顺序）**：不变——先确认是否建任务，再展开需求；澄清本身不要求先建任务。
- **E（强度）**：发现与既有规范／决定／架构冲突时必须先指出冲突、影响与替代方案，再等用户选择；用户已明确决定的不重复建议。
- **F（验收）**：采用分层——提示词与注入一致性、ready 拦截、桥接展示做机械验证；真实会话中的提问行为另记待验收，不冒充已验证。

具体协议、区段格式、拦截与展示规则、文档改动点见同目录 [design.md](design.md)。

## 参考：Trellis 的对应做法（0.6.17，本地安装核对）

核对位置：`@mindfoldhq/trellis@0.6.17` 的 `dist/templates/common/skills/brainstorm.md`（Planning Contract、Evidence Rule、Question Rules、Convergence Gate）与 `dist/templates/trellis/workflow.md`（Phase 1.1–1.5）。与 [RESEARCH.md](../../../docs/research/RESEARCH.md) 的 Trellis 基线来源一致，新核对部分只作本轮设计依据。

- **先取证再提问（强制）**：brainstorm.md L11-15「If a question can be answered by exploring the codebase, explore the codebase instead. This is mandatory.」取证来源明确包含 `code, tests, configs, docs, existing specs, or task history`；L17-19 同时限定「Repository evidence establishes current behavior and technical constraints. The user's intended behavior, feature scope boundaries, and UX preferences are never answerable by repository evidence alone… existing patterns are options and recommendation evidence, not decisions.」
- **一次只问最高价值的问题**：L9「While any user-owned product, scope, UX, compatibility, risk, or acceptance decision remains unresolved, end the turn with exactly one highest-value question. Do not edit product code, dispatch implementation…」；L62-70 每个问题必须含决定、为什么重要、推荐答案与取舍。
- **推荐项不等于默认值**：L73「Recommendations are not default selections. Never choose a recommended product decision on the user's behalf merely because the user asked for implementation.」
- **不得硬造问题**：L75「Do not manufacture clarification questions when the request and repository evidence already resolve every decision.」
- **决策清单逐轮重算**：L44-53 把事实分为已确认事实、仍需的产品意图、仍需的范围／风险决定、可能不做项，每轮答复后更新 `prd.md` 并重算。
- **收敛门与最终评审**：L128-133 要求目标与价值、范围内外、可观察验收、用户决定、阻塞问题为空、技术未知已研究或明确延期；L135 最终摘要须含 Goal／In Scope／Out of Scope／Acceptance Criteria／Key Decisions／Risks or Deferred／artifact status；L188-194 最终摘要展示后，须**后续一条消息**明确批准才能 `task.py start`。
- **PRD 收敛**：L160-176 要求把临时区段、假设与已解决的开放问题合并进正文并删除空壳，保留 file:line 锚点与决定。

对照 Knit：现行规则已借鉴其中一部分（澄清门、假设标注、创建≠授权），缺少「强制取证含任务历史」「每问必带推荐与代价」「阻塞项必须为空且可核对」「解决后折入正文」四条可执行约束。Trellis 一次只问一个问题，Knit 放宽为一轮最多 3 个，理由是 Knit 的讨论在本机会话内连续进行、用户通常愿意一次处理少量小决定；单个问题仍只承载一个决定。

## 完成条件

- 澄清协议写入受管块模板、桥接注入与 ROLE-CONTRACT：取证优先（含任务历史）、缺口维度、每问四要素、冲突须给替代方案、假设落盘、禁止「完整方案＋是否正确」作为唯一确认。
- task.md 模板含固定「待澄清」区段与 `[blocking]`／`[assumed]` 标记；解决的项折入目标与完成条件后删除，不保留空壳。
- 核心核对：存在 `blocking` 项时 `task ready` 拒绝并给出可读原因与条目；无区段或仅 `assumed` 不阻挡（兼容既有任务）。
- 桥接注入显示当前任务的未决（`blocking`）数量；无未决时不显示噪音。
- 历史查询口径更新：需求澄清期间的取证检索允许主动进行并须引用来源；普通对话仍不主动检索历史，相关记录不作为因果结论。
- 文档同步：DESIGN 4.2、ROLE-CONTRACT start 行与第 3 节、AGENTS 受管块、`docs/design` 中历史检索段落。
- 测试：模板与注入一致性、`ready` 拦截与放行、`status` 新增字段、既有任务兼容；真实会话行为另记待验收。

## 输入引用

- 本次会话用户反馈与 A–F 决策（2026-11-06）。
- [design.md](design.md)：澄清协议、区段格式、核心核对与文档改动点。
- [DESIGN.md](../../../docs/design/DESIGN.md) 4.2 主会话工作流、9.6 每轮上下文注入；[ROLE-CONTRACT.md](../../../docs/design/ROLE-CONTRACT.md) 第 1、3 节；[STATES.md](../../../docs/design/STATES.md) 讨论与 ready。
- `src/application/templates.ts`（受管块）、`.pi/extensions/knit.ts`（注入）、`src/application/task-service.ts`（ready 结构核对、status）、`src/contracts/task-inputs.ts`（输入区解析）。
- Trellis 0.6.17：`dist/templates/common/skills/brainstorm.md`、`dist/templates/trellis/workflow.md`。
- 前作：归档任务 `k-efc748322ccf`「完善任务创建前的需求澄清与复杂任务拆分提示」。

<!-- knit:progress:start -->
## 当前位置

A–F 已确认，协议与实现点落在 design.md；未实施。

## 关键经过

- 2026-11-06：登记问题，核对现行澄清门文本、ready 结构核对与注入内容。
- 2026-11-06：核对 Trellis 0.6.17 的 Brainstorm 契约与 Evidence Rule，确认其把任务历史纳入取证范围，并区分「仓库证据证明现状」与「用户决定产品意图」。
- 2026-11-06：确认 A（提示词＋记录＋ready 拦截）、B（采纳含任务历史的取证规则）、C–F 按建议。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-1fa9c2507943 -->
- 操作: op-1fa9c2507943
- 时间: 2026-11-06T16:53:59.721Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: 76edc51fcb63d67412f34632e7cfe1898d2c8138
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-requirement-intake-depth

### 任务资料提交记录

<!-- knit:metadata-commit:op-1fa9c2507943 -->
- 任务资料提交: 398b02f312d981b546c82f29acedc431ffa4fcfb
- 归档目标: .knit/tasks/archive/2026-11/11-06-requirement-intake-depth

<!-- knit:progress:end -->
