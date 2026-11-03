# 054 参考 Trellis 审视提示词、角色职责与任务分流

- 里程碑：工作流使用体验改进
- 执行角色：工作流／提示词设计 Agent
- 来源：2026-11-03 用户反馈只读调研任务被纳入 implement → check，要求参考 Trellis 的提示词与角色设计，并先创建开发任务；登记轮只登记，后续执行研究与建议交付，不实施产品修改。
- 实际依赖：044–051 已交付的主会话工作流、角色上下文、入口识别及模板升级；参考当前阶段执行与状态规则。可独立调研，不以其它缺陷修复为前置。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 目标与范围

从 Trellis 的真实提示词、角色模板、派发与上下文装配实现中找出适合 Knit 的做法，形成可评审的提示词、角色职责与任务分流改进方案。覆盖主 Agent 以及调研／咨询、实施、检查、交付职责，不预设必须新增同名角色或完整照搬其工作流。

重点解决：用户要求“阅读、检查、调研一个外部项目并给结论”时，怎样选择直接回答、只读委派或正式任务，避免因为调用了子 Agent 就自动进入实施、独立检查和 Git 交付流程。同时保留用户明确要求正式跟踪、独立复核时的路径。

本任务先交付对照研究、建议方案及后续实施清单；不把提示词建议写成已生效规则，不自行修改核心阶段转移或迁移现有真实项目。

## 先读与研究来源

- 遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md)、[BLOCKERS.md](../BLOCKERS.md)，按需读取 DESIGN、STATES、OPERATIONS 及 [RESEARCH.md](../RESEARCH.md) 的 Trellis 来源。
- 核对 Knit 的 `assets/templates/.knit/workflow.md`、`assets/templates/.knit/agents/`、桥接源模板、`src/application/context-planner.ts`、`src/application/stage.ts`、`src/application/run-acceptance.ts`、`src/domain/task.ts`，以及相关工具说明和验收证据。
- Trellis 固定研究基线为 `mindfold-ai/Trellis@f089cb3286071199e84118dee86b6d76aab032f1`（CLI 0.6.17）。读取 workflow、common/commands、Pi 的 research／implement／check 角色及项目扩展；需要时对照其它平台，区分通用角色与宿主特有机制。
- 本机研究副本 `/tmp/agent-framework-research-20261031/Trellis/` 只作便利入口，先核对版本；交付必须包含固定提交的仓库链接与文件位置。若参考更新版本，单独记录提交及差异，不能将不同版本行为混为一谈。

## 已知问题与核对线索

- 真实案例：`knit-demo` 的任务 `k-748f2087202d`（目录 `11-03-eval-pi-rexagents`）只要求静态调研，不安装、不运行扩展、不修改项目代码；以 implement 派发并接收报告后，任务阶段变为 check。截图时主 Agent 仅提议独立检查，尚未启动 check run。
- `onImplementationAccepted` 当前固定将 implement 转为 check。这是核心规则，不能归因于模型误读，也不能单靠提示词绕过。
- 当前入口模板列出普通问答、非正式小修改和正式需求，但未明确较长只读调查与委派的处理路径；实施章节以代码改动为表述基础，需要核对对研究成果是否产生误导。
- 现有 advisory 接收结果不推进阶段，但它是否适合独立调研、是否必须依附正式任务及如何结束，需要按实际接口核实，不能当作现成的轻量任务闭环。
- Trellis 有独立 research 角色是调查入口，不能据角色名称推断它一定免建任务、免检查或已解决上述问题。

## 必需工作

1. 建立“Trellis 来源与实际行为／Knit 当前对应点／差异与问题／采用或不采用的理由／影响位置”对照表。读实际注入和调用链，不只比较 Markdown 文案。
2. 审视主 Agent 的请求识别、任务创建、授权继承、角色选择、上下文读取、完成判断与用户汇报；核对正常打开 Pi 后的自动入口，不增加手动 start 前置条件。
3. 按职责比较 research／advisory、implement、check、deliver：输入、允许的副作用、产出与证据、停止条件、主会话接收方式，以及是否改变任务阶段。说明职责能否复用现有角色，新增角色须有具体必要性。
4. 给出请求分流与完成方式建议，至少覆盖普通问答、只读代码审阅／外部项目评估、已有任务的辅助调查、小修改、正式代码开发、正式研究报告、用户明确要求独立复核和跨会话继续。
5. 将建议区分为提示词／工具描述可解决、上下文装配需修正、核心状态或任务完成规则需改变三类。涉及正式调研能否跳过 check、免 Git 交付如何完成／归档等产品决定，列明选项、代价与推荐，不将本次登记视为用户已批准改变业务规则。
6. 为建议提供具体文案草案、角色职责表、受影响文件和后续实施步骤；核对源模板、包内生成物、旧项目保留规则与升级路径，不能只改当前工程的生成文件。
7. 提供后续验收场景与预期工具／阶段轨迹，覆盖“不需要建任务或派检查”的情况，以及正式开发仍必须经过有效独立检查的情况；授权和提交／发布边界沿用既有约定。

## 交付与完成条件

- 在 `validation/trellis-prompts-and-roles/` 保存研究报告、固定来源、对照表、建议文案与实施／验收清单；后续 Agent 无需依赖本机会话和截图即可理解问题。
- 清楚回答哪些 Trellis 提示词与角色机制值得借鉴、哪些不适用、Knit 应如何处理上述真实案例；建议与已确认规则、已实现能力分别标明。
- 若发现必需用户决定或能力缺口，按 BLOCKERS 规则记录并交接；研究材料与建议完成不代表相关功能已实现或验证通过。
- 完成引用、术语与方案一致性检查；纯研究与文案草案无需运行真实模型或新增实现镜像测试。

## 边界与执行记录

- 登记轮仅创建排程及任务说明，不执行本任务、不修改产品提示词、角色、桥接或状态机。
- 不修改 `knit-demo` 的任务、成果和安装，不自动派发其检查或交付；真实案例只读取必要事实，交付中保留可移植摘要。
- 不引入 Worktree、并行调度、其它客户端、Pi SDK／RpcClient 或新的模型运行时，不提交、推送或发布。
- 2026-11-03：按用户要求登记，研究与方案尚未执行。
- 2026-11-03：按用户“查看任务列表并开发”的指令执行研究与建议交付；执行者：主 Agent（Pi session `01a1a086-1eea-700e-bd9e-e6afeaa93c25`）。
  - 读取固定基线 Trellis `f089cb3286071199e84118dee86b6d76aab032f1`（CLI 0.6.17）的 workflow、common skills／commands、Pi research／implement／check 角色、Pi 扩展与 shared hook 注入路径；任务提到的旧副本 `/tmp/agent-framework-research-20261031/Trellis/` 本机不存在，改用该固定提交的新克隆 `/tmp/trellis-054` 并核对版本。未启动 Trellis CLI／模型。核对 Knit 的 workflow、角色模板、桥接注入、`context-planner.ts`、`stage.ts`、`run-acceptance.ts`、`domain/task.ts`、`informal-check.ts` 与 044–052 验收。
  - 产出 [validation/trellis-prompts-and-roles/README.md](../validation/trellis-prompts-and-roles/README.md)、[sources.md](../validation/trellis-prompts-and-roles/sources.md)、[comparison.md](../validation/trellis-prompts-and-roles/comparison.md)、[proposal.md](../validation/trellis-prompts-and-roles/proposal.md)、[implementation-and-acceptance.md](../validation/trellis-prompts-and-roles/implementation-and-acceptance.md)。
  - 结论：真实案例根因是只读调查无显式入口、正式任务只有 implement 写入阶段且核心固定 implement → check；Trellis research 角色仍依附任务、check 会自修，不能照搬。推荐 A：不新增 research 阶段／角色，只读调查不建任务，正式研究报告仍走 implement → check → 受权 deliver。
  - 未修改产品源码、模板、桥接、状态机或 `knit-demo`；未运行真实模型、未提交／推送／发布。需要用户决定的事项登记为 [B006](../BLOCKERS.md)（正式调研免检查／免 Git 完成路径）与 [B007](../BLOCKERS.md)（`task close --outcome completed` 未核对检查资格）。
  - 核对：引用的 Trellis 文件与行号均存在于固定提交；术语统一为 discuss／implement／check／deliver，不把 research 写成新阶段；建议与已实现／已确认规则分栏标注。
  - 文档检查：本地 Markdown 链接全部存在，代码围栏成对、表格列数一致、无尾随空白；未运行 build／全量测试（本轮无代码改动）。
