---
id: k-efc748322ccf
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T14:51:35.014Z
title: 完善任务创建前的需求澄清与复杂任务拆分提示
---

需求冻结（主会话核查 assets/templates/.knit/workflow.md 主会话分流段与 discuss 段、assets/templates/pi/extensions/knit.ts 无任务注入 L316-321、src/application/templates.ts agentsManagedBlock、test/bridge-query.test.mjs L160-180 既有断言、test/init.test.mjs 模板安装/受管块一致性、validation/trellis-prompts-and-roles/ 今日固定提交研究后决策）：

Trellis 借鉴点（来源 validation/trellis-prompts-and-roles/sources.md，固定提交 f089cb3286071199e84118dee86b6d76aab032f1、@mindfoldhq/trellis 0.6.17，2026-11-03 核对，当日新鲜可直接引用；/tmp/trellis-054 若存在可复核）：先取证再问用户（brainstorm.md L39-70）；创建同意与实施批准分开（workflow.md L325-365）；简单/复杂分流提问（workflow.md L155-183）。不引入其状态面包屑/jsonl 上下文清单机制。

交付设计：
1. workflow.md「主会话：识别请求与任务入口」段新增需求澄清门（替换现"新正式需求"条目并扩写）：
   a) 关键缺口判断：目标、范围、行为或完成条件任一存在需用户取舍的缺口→先向用户呈现缺口与可选项讨论，不得把 Agent 自行补齐的理解写成"已确认要求"后创建待执行任务；已有资料/代码能查清的事实先自行调查，不为查证类问题打扰用户。
   b) 需求已明确（用户已给出目标/范围/完成条件，或唯一合理解释可从资料核实）→直接登记，不机械追问、不固定多轮。
   c) 想法登记路径：用户只要登记想法/待讨论时允许建任务，但 task.md 需求区标注"需求未确认，仅登记想法"，保持 discuss 不 ready；phase=discuss 本身不证明需求已确认。
   d) 假设标注：Agent 提出的假设、方案、验收建议写入 task.md 时标注"（Agent 建议，待确认）"，用户确认后才升级为已确认要求；两者不混写。
   e) 复杂拆分：非常复杂需求先提出多任务拆分方案（各任务边界、依赖、执行顺序、各自交付物与验证），经用户确认范围后逐个登记；每任务只携带自身必需输入与上游结果，不复制全部讨论；上下文可集中时优先用任务内 plan.md 而非强行拆任务。
   f) 创建同意≠实施授权：task new 征得同意只覆盖登记；ready/派发实施仍按既有授权规则。
2. workflow.md discuss 段补一句：讨论先取证后提问（已有基础），明确"任务创建同意不等于需求确认或实施授权"。
3. knit.ts 无任务注入：加一行澄清门提示（关键缺口先讨论、需求明确直接登记、Agent 建议须标注、复杂需求先给拆分方案）。
4. templates.ts 受管块「主会话工作流」行扩写加"关键缺口先讨论再创建待执行任务"；同步重新生成本仓库 AGENTS.md 受管块（与 agentsManagedBlock 输出逐字一致，保持基线不漂移）；templateVersion 随包版本机制不变。
5. 测试：a) init 安装出的 workflow.md 含澄清门关键句（缺口/明确/想法登记/Agent 建议/拆分）；b) 受管块一致性（仓库 AGENTS.md 受管块与 agentsManagedBlock("npx --no-install knit") 输出一致，或按既有基线校验方式通过）；c) bridge-query 无任务注入含澄清门提示且既有断言仍过；d) templates 既有 force/不覆盖项目正文测试回归。全量 npm test 绿。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-090db35cc64f，已接收 implementation_accepted）：assets/templates/.knit/workflow.md 主会话段将"新正式需求"扩为六条需求澄清门（关键缺口先讨论／需求明确直接登记／想法登记标注"需求未确认"不 ready／假设标注"（Agent 建议，待确认）"／复杂需求先给拆分方案经确认后逐个登记／创建同意≠实施授权），discuss 段补"先取证后提问、创建同意不等于需求确认或实施授权"；assets/templates/pi/extensions/knit.ts 与 .pi/extensions/knit.ts 无任务注入同步加澄清门提示；src/application/templates.ts agentsManagedBlock 主会话工作流行加"关键缺口先讨论再创建待执行任务"，本仓库 AGENTS.md 受管块同步重生成保持基线一致。Trellis 参考来源为 validation/trellis-prompts-and-roles（固定提交 f089cb3、0.6.17、2026-11-03 核对），未引入其状态面包屑等机制。验证（self）：npm test 311/311 绿（init 模板含澄清门、受管块一致性、桥接注入提示、既有不覆盖/force 回归）。

### 交付记录

<!-- knit:delivery:op-bed479b99c4f -->
- 操作: op-bed479b99c4f
- 时间: 2026-11-03T17:58:51.534Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: e281604189b0c2d68cdf106e9419f44573be9be8
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-clarify-before-task-creation-and-split-complex-work

### 任务资料提交记录

<!-- knit:metadata-commit:op-bed479b99c4f -->
- 任务资料提交: abfc20af16c5165c32622173c1a2488c6c6f419c
- 归档目标: .knit/tasks/archive/2026-11/11-03-clarify-before-task-creation-and-split-complex-work

<!-- knit:progress:end -->
