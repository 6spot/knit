---
id: k-185ace3b9556
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-11T01:32:12.470Z
title: 场景化完成条件：借鉴 OpenSpec 的 Requirement／Scenario 写法
---

# 场景化完成条件：借鉴 OpenSpec 的 Requirement／Scenario 写法

## 目标与边界

### 背景与问题

task.md 的「完成条件」现在是自由文本列表。检查阶段按“逐条核对”执行，但一条完成条件常常混着多个触发条件和多个期望结果，检查报告也只被核对“scope 路径都出现过”（`check_scope_incomplete`），没有任何机制保证每条验收都被判过。验收含糊在独立检查里代价最高：每次误判消耗一轮修复。

OpenSpec 用 `### Requirement:` 加 `#### Scenario:`（WHEN／THEN）表达行为契约，每个场景是一个可单独验证的例子。Knit 借用这套写法写完成条件，并由核心解析：准备阶段核对结构，检查阶段要求逐场景给结论，接收时机械核对。

### 交付范围

- 场景解析：从 task.md 输入区的「完成条件」解析 Requirement／Scenario，给出稳定编号与结构错误。
- `task ready`：核对场景结构；`independent` 任务必须有场景。
- 阶段指令：任务有场景时，把带编号的场景清单注入阶段提示；声明了 `scenarios` 的阶段附带条目格式与报告示例。
- 检查报告：新增报告字段约定 `scenarios`，worker 收尾与主会话接收共用同一核对，失败走现有补报机制。
- 默认流程：安装包 `workflow.yaml` 模板与内置默认流程的检查阶段声明 `scenarios: string[]`。
- 模板与指引：任务模板占位、实施与检查提示词模板、AGENTS 受管块（含本仓库 `AGENTS.md`）、桥接模板的每轮上下文。
- 设计文档：DESIGN、STATES、OPERATIONS、ROLE-CONTRACT、GLOSSARY、RESEARCH。
- 测试：新增覆盖，并把因新规则失效的既有夹具改成合格场景。

### 格式与规则

写法示例（标题关键字与步骤关键字用英文，正文用中文）：

```markdown
### Requirement: 待澄清阻挡冻结
存在未决项时 `task ready` MUST 拒绝。

#### Scenario: 有 blocking 项
- GIVEN 「待澄清」含一条顶格 blocking 项
- WHEN 执行 task ready
- THEN 以 clarify_blocking 拒绝
- AND 任务仍在 start
```

解析规则：

| 项 | 规则 |
| --- | --- |
| 区段 | 输入区内固定标题 `## 完成条件`，到下一个一级或二级标题为止；围栏代码块内的内容不解析 |
| Requirement | 三级标题，固定前缀 `Requirement: `（半角冒号），名称非空 |
| Scenario | 四级标题，固定前缀 `Scenario: `，必须位于某个 Requirement 之下，名称非空 |
| 步骤 | 顶格列表项，关键字 GIVEN／WHEN／THEN／AND 大写；`- WHEN …` 与 `- **WHEN** …` 等价；每个 Scenario 至少一条 WHEN 和一条 THEN，GIVEN 与 AND 可选 |
| 编号 | 按文档顺序从 1 起：第 n 个 Requirement 的第 m 个 Scenario 为 `Rn.Sm` |
| 自由内容 | 区段内的普通文字和列表不解析、不报错；没有任何场景标题的区段场景数为 0 |
| 结构错误 | Requirement 没有 Scenario；Scenario 缺 WHEN 或 THEN；Scenario 不在任何 Requirement 之下；名称为空；Requirement 重名或同一 Requirement 内 Scenario 重名；三、四级标题以 requirement／scenario 开头（不分大小写）但不符合固定前缀，例如全角冒号 |

核对规则与原因码：

| 时机 | 条件 | 结果 |
| --- | --- | --- |
| `task ready` | 存在结构错误 | 拒绝，`scenarios_invalid`；消息列出前 3 条问题并附格式示例 |
| `task ready` | 任务为 `independent` 且场景数为 0 | 拒绝，`scenarios_required`；消息附格式示例 |
| `task ready` | 其余情况 | 放行；输出包含场景数量 |
| 检查报告 | 阶段声明了 `scenarios` 且任务场景数大于 0 | 进行下面三项核对；否则不核对 |
| 检查报告 | 条目不合格式、编号不存在、编号重复或缺证据 | `report_field_value:scenarios` |
| 检查报告 | 有场景没有条目（含整个字段缺失） | `check_scenarios_incomplete:<编号列表>` |
| 检查报告 | 结论为 `pass` 但有条目不是 pass | `check_scenarios_inconsistent:<编号列表>` |

`scenarios` 条目格式：`<编号> <结论>：<证据>`，结论只能是 `pass`、`fail`、`not_verified`，证据非空；分隔用全角或半角冒号均可。例：`R1.S2 pass：test/task.test.mjs「blocking 拒绝」通过`。

### 非目标

- 不做增量规格（ADDED／MODIFIED／REMOVED）、长期行为规格目录与归档合并；这是第二期，本任务验收后另行决定是否建任务。
- 不依赖 `openspec` CLI，不读写项目里的 `openspec/` 目录，不新增 npm 依赖、CLI 命令或目录约定。
- 核心不区分 MUST／SHOULD／MAY，不判断场景内容是否合理，只核对结构与报告覆盖。
- 不改 `coverage` 的含义与 `check_scope_incomplete` 的判定。
- 不核对主会话直接实施（`task implement`）与非正式检查（`run check --scope`）的场景覆盖。
- 不写兼容或迁移代码：旧任务、旧流程配置与旧提示词不符合新规则时，直接按新格式覆盖。

## 关键决定

- 格式与 OpenSpec 兼容、不依赖其 CLI；首期只做场景化验收；完成验证为 `independent`。（用户决定）
- 核心解析场景并在 `ready` 与检查报告接收两处机械核对；`independent` 任务强制写场景，`self`／`none` 任务可用自由列表。（用户决定）
- 检查结论用独立报告字段 `scenarios` 加稳定编号，不混进 `coverage`。（用户决定）
- 不考虑旧项目与旧任务的兼容，统一直接覆盖：已初始化的项目用 `knit init --force` 取得新的流程配置与提示词，旧任务再次 `ready` 时按新规则改写完成条件。（用户决定）
- 写法指引进 AGENTS 受管块与每轮上下文的需求澄清门，`ready` 的拒绝消息带格式示例。（用户决定）
- 写成场景的验收一律视为必须：结论 `pass` 要求全部场景为 pass。当前检查环境验证不了的验收（如延期的真机验收）不写成场景，写在「目标与边界」里作为延期项。
- 任何结论（含 `blocked`）都要求每个场景有条目，验证不了的写 `not_verified` 并说明原因；与 scope 路径覆盖的现有做法一致。
- `scenarios` 核对按报告字段声明生效（与 `coverage` 相同），由流程作者决定哪个阶段评判验收；不对所有结论阶段隐式生效，避免把设计评审这类阶段也卡住。
- 编号按位置生成，输入变化后可能改变；输入一变旧检查本来就失效，不需要跨版本稳定。
- 本仓库里与模板成对的副本，和模板在同一次改动里一起改：`.pi/extensions/knit.ts` 与 `AGENTS.md` 受管块由 worker 直接改，保持与模板逐字一致。开发阶段不对 worker 设“不得改某路径”的额外限制，只保留核心真实强制的保护。（用户决定）
- 术语：写法叫“行为场景”，内容叫“行为契约”；“规范”继续专指 `.knit/standards/` 的项目规则。

## 完成条件

### Requirement: 场景解析与编号

核心 MUST 从输入区的「完成条件」解析出场景并按位置编号。

#### Scenario: 按文档顺序编号

- GIVEN 完成条件含两个 Requirement，分别有 2 个和 1 个 Scenario
- WHEN 解析该任务输入
- THEN 得到编号 R1.S1、R1.S2、R2.S1，各自带 Requirement 名与 Scenario 名
- AND 没有结构错误

#### Scenario: 加粗步骤关键字等价

- GIVEN 一个 Scenario 的步骤写成加粗关键字形式
- WHEN 解析该任务输入
- THEN 结果与不加粗的写法相同

#### Scenario: 围栏代码块不解析

- GIVEN 完成条件的围栏代码块里含 Requirement 与 Scenario 标题
- WHEN 解析该任务输入
- THEN 代码块内的标题不计入场景，也不产生结构错误

#### Scenario: 自由列表

- GIVEN 完成条件只有普通列表，没有场景标题
- WHEN 解析该任务输入
- THEN 场景数为 0 且没有结构错误

### Requirement: 结构错误识别

解析 MUST 报告「格式与规则」列出的每一类结构错误，并指明所在的 Requirement 或 Scenario。

#### Scenario: Requirement 没有 Scenario

- WHEN 解析一个其下没有任何 Scenario 的 Requirement
- THEN 报告一条结构错误，指明该 Requirement 名称

#### Scenario: Scenario 缺 WHEN 或 THEN

- WHEN 解析一个只有 WHEN 没有 THEN 的 Scenario，以及一个只有 THEN 没有 WHEN 的 Scenario
- THEN 各报告一条结构错误，指明缺少的关键字

#### Scenario: 名称重复或为空

- WHEN 解析含重名 Requirement、同一 Requirement 内重名 Scenario、以及名称为空的标题的完成条件
- THEN 每种情况各报告一条结构错误

#### Scenario: 近似标题与游离 Scenario

- WHEN 解析含全角冒号的 Requirement 标题、小写关键字的 Scenario 标题、以及不在任何 Requirement 之下的 Scenario
- THEN 每种情况各报告一条结构错误，而不是静默忽略

### Requirement: 冻结输入时核对场景

`task ready` MUST 在冻结输入前核对场景结构与验证级别的要求。

#### Scenario: 结构错误拒绝

- GIVEN 完成条件含一个缺 THEN 的 Scenario
- WHEN 执行 `task ready`
- THEN 以 `scenarios_invalid` 拒绝，消息含问题描述与格式示例
- AND 任务仍在 start，输入未冻结

#### Scenario: independent 任务没有场景

- GIVEN 一个 `independent` 任务，完成条件是自由列表
- WHEN 执行 `task ready`
- THEN 以 `scenarios_required` 拒绝，消息含格式示例

#### Scenario: self 与 none 任务可用自由列表

- GIVEN 一个 `self` 任务和一个 `none` 任务，完成条件都是自由列表
- WHEN 分别执行 `task ready`
- THEN 都放行

#### Scenario: 合格场景放行并报告数量

- GIVEN 一个 `independent` 任务，完成条件含 3 个合格场景
- WHEN 执行 `task ready`
- THEN 放行，输出包含场景数量 3

#### Scenario: 待澄清核对不受影响

- GIVEN 完成条件含合格场景，「待澄清」含一条顶格 blocking 项
- WHEN 执行 `task ready`
- THEN 以 `clarify_blocking` 拒绝，未决数量为 1

### Requirement: 阶段指令带场景清单

任务有场景时，阶段提示 MUST 给出带编号的场景清单。

#### Scenario: 声明 scenarios 的阶段

- GIVEN 任务有场景，阶段的 `report` 声明了 `scenarios`
- WHEN 生成该阶段的提示
- THEN 提示含每个场景的编号、Requirement 名与 Scenario 名
- AND 说明条目格式与三种结论，报告示例含 `scenarios` 字段

#### Scenario: 未声明 scenarios 的阶段

- GIVEN 任务有场景，阶段的 `report` 没有声明 `scenarios`
- WHEN 生成该阶段的提示
- THEN 提示含场景清单，但不要求报告 `scenarios` 字段

#### Scenario: 任务没有场景

- GIVEN 任务的完成条件是自由列表
- WHEN 生成任一阶段的提示
- THEN 不出现场景清单，也不要求 `scenarios` 字段

### Requirement: 检查报告逐场景核对

阶段声明了 `scenarios` 且任务有场景时，核心 MUST 核对报告覆盖每个场景且与结论一致。

#### Scenario: 覆盖完整且一致

- GIVEN 任务有 3 个场景，报告结论为 pass，`scenarios` 含 3 条 pass 条目
- WHEN 核对该报告
- THEN 不因场景被拒

#### Scenario: 缺少场景条目

- GIVEN 任务有 3 个场景，报告的 `scenarios` 缺 R1.S2
- WHEN 核对该报告
- THEN 原因为 `check_scenarios_incomplete:R1.S2`

#### Scenario: 整个字段缺失

- GIVEN 任务有 3 个场景，报告没有 `scenarios` 字段
- WHEN 核对该报告
- THEN 原因为 `check_scenarios_incomplete`，列出全部 3 个编号

#### Scenario: 结论与场景矛盾

- GIVEN 报告结论为 pass，但 R2.S1 的条目为 fail 或 not_verified
- WHEN 核对该报告
- THEN 原因为 `check_scenarios_inconsistent:R2.S1`

#### Scenario: 条目不合格式

- WHEN 核对含以下任一条目的报告：结论不是三种之一、编号不存在、编号重复、缺证据
- THEN 原因为 `report_field_value:scenarios`

#### Scenario: 要求修改时允许失败场景

- GIVEN 报告结论为 changes_requested，条目齐全且含 fail
- WHEN 接收该报告
- THEN 不因场景被拒，按 `onVerdict` 回到实施阶段

#### Scenario: 不适用时不核对

- WHEN 核对报告时阶段未声明 `scenarios`，或任务场景数为 0
- THEN 不做场景核对，结果与改动前一致

#### Scenario: 路径覆盖判定不变

- GIVEN scope 含路径 `src/a.ts`，报告的 `coverage` 为空而 `scenarios` 齐全
- WHEN 接收该报告
- THEN 仍报 `check_scope_incomplete:src/a.ts`

### Requirement: 场景问题可补报

场景相关的报告失败 MUST 走现有的同会话补报机制。

#### Scenario: 三种原因可补报

- WHEN 判断 `check_scenarios_incomplete:`、`check_scenarios_inconsistent:` 与 `report_field_value:scenarios` 是否可补报
- THEN 三者都可补报

#### Scenario: 补报提示指明问题场景

- GIVEN worker 收尾时报告缺 R1.S2
- WHEN 生成补报提示
- THEN 提示含缺失场景的编号与名称，以及条目格式

### Requirement: 默认流程与模板

新项目 MUST 开箱获得场景核对与写法提示。

#### Scenario: 默认检查阶段声明 scenarios

- WHEN 读取 `assets/templates/.knit/workflow.yaml` 与核心内置默认流程
- THEN 两者的检查阶段 `report` 都声明 `scenarios: string[]`，且两者一致

#### Scenario: 任务模板占位

- WHEN 执行 `knit task new`
- THEN 「完成条件」的占位注释提示 Requirement／Scenario 与 WHEN／THEN 写法，并说明 `independent` 任务必须写场景
- AND 输入区四个区段的标题与顺序不变

#### Scenario: 阶段提示词模板

- WHEN 读取 `assets/templates/.knit/agents/check.md` 与 `implement.md`
- THEN 检查模板要求逐场景核对 WHEN 与 THEN、在 `scenarios` 中逐项给结论与证据，并说明 `coverage` 只列路径
- AND 实施模板要求按场景实现、在 `validation` 中按编号记录验证，场景有歧义或冲突时停止并交回主会话

### Requirement: 主会话写法指引

主会话写完成条件时 MUST 能从常驻指引得知场景写法。

#### Scenario: AGENTS 受管块

- WHEN 调用 `agentsManagedBlock()` 并读取本仓库 `AGENTS.md` 的受管块
- THEN 需求澄清门含“验收写成场景”的指引与 `independent` 任务的强制要求
- AND 两者逐字一致

#### Scenario: 桥接每轮上下文

- WHEN 读取 `assets/templates/pi/extensions/knit.ts` 的每轮上下文文案
- THEN 需求澄清一条含同一指引

### Requirement: 设计文档同步

设计文档 MUST 写明格式、核对规则、原因码与术语边界。

#### Scenario: 现行规范已更新

- WHEN 通读 DESIGN.md 第 3.3 节、`task ready` 命令说明与报告补报说明，STATES.md 的 ready 转移条件，OPERATIONS.md 的实施前核对，ROLE-CONTRACT.md 第 1、2、5 节，GLOSSARY.md
- THEN 能找到场景格式、`ready` 的两条拒绝规则、`scenarios` 字段与三个原因码
- AND GLOSSARY 区分“行为场景／行为契约”与“规范”
- AND 文档内的规则、示例与原因码和实现一致

#### Scenario: 研究依据已记录

- WHEN 阅读 RESEARCH.md
- THEN 有一节说明借鉴 OpenSpec 的内容、未借鉴的内容与理由，并引用固定提交 `a959be77cf045ea3156dc5089c9e2f1d6ce9ce70`

### Requirement: 保持轻量

本任务 MUST NOT 引入新依赖、新命令或新目录约定。

#### Scenario: 依赖与命令面不变

- WHEN 对比改动前后的 `package.json` 与 `knit --help`、`knit task --help`
- THEN 依赖列表与命令列表不变
- AND 仓库中没有新增 `openspec/` 目录

### Requirement: 回归通过

#### Scenario: 全量测试

- WHEN 执行 `npm test`
- THEN 全部通过
- AND 新增测试覆盖前六个 Requirement 的各个场景

### Requirement: 已完成任务的正式恢复入口

本节是 2026-11-13 用户明确选择「补齐恢复入口，再完成归档」后增加的范围。保留原场景化功能、independent 验证级别与原任务身份；不处理本机真实 Pi 验收及其他任务。当前阻塞与代码证据见 `research/delivery-recovery-review-2026-11-13.md`。

#### Scenario: 有来源地复核被后续提交更新的成果

- GIVEN 任务已有正式实施来源和非空成果 scope，部分成果路径随后被其他已提交工作合法更新
- WHEN 主会话通过显式公开恢复入口提供待复核的既有成果路径及可核验的当前提交来源
- THEN 核心核对来源提交、分支、路径内容与本机当前指纹后，记录旧新指纹和来源，形成可供新独立检查使用的当前成果范围
- AND 原成果路径集合及原实施来源保留，不把复核声明成恢复者的新实际写入，不依赖假改动或非真实 changedPaths

#### Scenario: 未经核验的成果不得恢复

- GIVEN 某路径不在既有成果范围内，或声明来源不存在、内容不匹配、分支不符、运行未结束
- WHEN 尝试恢复该路径的成果资格
- THEN 拒绝对应不合法请求，不产生可以绕过检查的有效资格

#### Scenario: 恢复后必须完整独立检查

- GIVEN 旧检查因提示词或成果指纹变化失效，成果范围已按可核验来源复核
- WHEN 派发并接收新的独立检查
- THEN 提示与覆盖校验包含完整历史成果范围和本任务全部场景，新检查基于当前输入、提示词与成果指纹
- AND 缺任何既有路径覆盖或场景结论时不能完成任务，不能以空 scope、降低验证级别或 task implement 补录非实际改动代替
- AND 原 run、旧检查与恢复前证据的审计来源保留；现行完成资格仍按正式失效与重建规则处理

#### Scenario: 交付策略变化后显式恢复

- GIVEN 已有交付操作因当前交付策略与操作记录不一致而被拒绝
- WHEN 主会话在既有用户授权覆盖下显式按当前策略重核并恢复
- THEN 当前策略、授权来源、分支和已有副作用重新核验并留下可追溯记录
- AND 未核验的旧提交或不充分授权仍被拒绝，不能直接跳过 policy_changed 或覆写旧策略历史

#### Scenario: 放弃的无副作用操作不阻塞后续正规交付

- GIVEN 一个交付操作在产生实际副作用前被公开取消为 abandoned
- WHEN 任务通过当前资格核验后重新正式交付
- THEN abandoned 操作保留为历史，不被错误复用成仍需执行的最新操作

#### Scenario: 当前任务可正常提交与归档

- GIVEN 当前任务的成果已按当前来源复核，全部原功能与恢复场景通过独立检查
- WHEN 正式执行 deliver 与归档
- THEN 实际产生的资料提交、封存与归档位置一致，当前任务移出活跃任务列表
- AND 目录选择与提交文件展开保持一致，不把合法目录集合误判为选中内容被改写
- AND 不 force、不手改凭据或归档状态，不提交其他任务及无关工作区改动

## 实施要点

- 解析器与「待澄清」解析放在同一层（`src/contracts/task-inputs.ts` 或相邻文件），纯函数，输入是 task.md 文本。
- `ready` 的核对加在 `assertReadyStructural`（`src/application/task-service.ts:504`）；核对走到 `ready` 结构核对的所有入口行为一致。
- 报告核对做成一个共用函数，`stage-runner.ts`（worker 收尾）与 `run-acceptance.ts`（主会话接收）都调用，做法与 `uncoveredScopePaths` 相同，避免两处规则分叉。
- 新原因码加入 `isRetryableReportFailure`（`src/domain/report.ts:73`）；`report_field_value:` 前缀已在其中。
- 阶段指令在 `src/application/stage.ts` 的 `stageRequirementOf`、`reportTemplateOf` 与 `buildUserPrompt`；场景清单来自该 run 的任务输入。
- 内置默认流程在 `src/domain/workflow.ts` 的默认 YAML，需与 `assets/templates/.knit/workflow.yaml` 同步。
- 既有测试里 `independent` 任务调用 `ready` 的夹具会被新规则拒绝，需改成带合格场景的输入；建议抽一个共用的夹具文本。
- 改 `agentsManagedBlock()` 后必须同步本仓库 `AGENTS.md` 的受管块：`test/init.test.mjs:617` 逐字比对。
- 改 `assets/templates/pi/extensions/knit.ts` 时同一次改动里改 `.pi/extensions/knit.ts`，改完用 `cmp` 确认两份逐字节相同。
- 实施进度与主会话对已提问题的答复见 [plan.md](plan.md)，续做前先读。

## 风险与回滚

- 不做兼容：没有用 `knit init --force` 覆盖流程配置的项目，`independent` 任务会被要求写场景，但检查阶段不做场景核对。
- `independent` 的文档或研究类任务也必须写场景，写法成本上升；可以把验证级别改为 `self` 来回避。
- 夹具改动面较大（约 18 个测试文件含 `independent` 任务），容易漏改；以 `npm test` 全绿为准。
- 回滚：还原 `ready` 的两条核对与报告核对的调用即可停用强制，解析器与文案可保留。

## 输入引用

- OpenSpec 格式事实与 Knit 现状代码位置：[research/openspec-format.md](research/openspec-format.md)。阶段 worker 离线，以该文件为准。
- 适用规范：[AGENTS.md](../../../AGENTS.md) 的开发约定与交付检查；`.knit/standards/index.md` 目前无条目。
- 设计材料：[DESIGN.md](../../../docs/design/DESIGN.md)、[STATES.md](../../../docs/design/STATES.md)、[OPERATIONS.md](../../../docs/design/OPERATIONS.md)、[ROLE-CONTRACT.md](../../../docs/design/ROLE-CONTRACT.md)、[GLOSSARY.md](../../../docs/design/GLOSSARY.md)、[RESEARCH.md](../../../docs/research/RESEARCH.md)。
- 代码范围：`src/contracts/task-inputs.ts`、`src/application/task-service.ts`、`src/application/stage.ts`、`src/application/stage-runner.ts`、`src/application/run-acceptance.ts`、`src/domain/report.ts`、`src/domain/workflow.ts`、`src/application/templates.ts`、`assets/templates/`、`AGENTS.md`。
- 测试入口：`npm test`。

## 依赖与交接

- 无前置任务。
- worker 直接改 `.pi/extensions/knit.ts`，与 `assets/templates/pi/extensions/knit.ts` 保持逐字一致。核心不保护该路径；`test/m1-cli.test.mjs:362`、`test/host-selection.test.mjs:427`、`test/init.test.mjs:680` 逐字比对两份文件。
- worker 不改 `.knit/` 下的流程配置、提示词与规范：这是核心强制的保护，改动会让整个 run 以 `protected_path_modified` 失败。没有测试比对这些副本，不影响 `npm test`。
- 主会话负责：派发前给本仓库 `.knit/workflow.yaml` 的检查阶段加 `scenarios: string[]`，让本任务自己的检查按新规则执行；任务完成后按模板直接覆盖本仓库的 `.knit/agents/check.md`、`.knit/agents/implement.md`。这些覆盖与任务产物分开提交。
- macOS 上 `npm test` 需在 Rex 终端与普通终端各跑一次；worker 跑一次，另一次由主会话在收尾时补跑并记录。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### run-4725f81f73af 实施自检
- 已复核交接九文件，补齐场景解析空步骤／尾部输入、声明字段接收边界、提示词与成对桥接／AGENTS、设计文档和测试夹具。
- src/application/stage.ts、src/domain/workflow.ts、src/cli/task.ts、assets/templates/.knit/workflow.yaml 的既有改动本轮只读核对，未为归属造改动，交主会话核对完整 scope。
- Rex 终端 npm test 最终通过：719 tests、719 pass、0 fail，245132.699459ms；完整日志 /tmp/knit-scenarios-verified-test.log。
- test/scenarios.test.mjs 覆盖 R1–R6 正反例、ready 冻结拒绝／数量、报告接收与同会话补报；模板／桥接／文档检查通过。
- cmp 成对 Pi 桥接和 git diff --check 通过；package 依赖与 CLI command 声明相对 HEAD 不变，无 openspec/ 目录。
- 普通终端全量测试、全新 independent 检查、任务关闭后本仓库 .knit/agents/ 同步由主会话完成；真实用户项目／外部模型验收仍延期。
- 本轮未改受保护 .knit 配置／规范／提示词，未提交、推送或全局安装。

主会话普通终端全量复验：env -u REX_SESSION -u REX_BLOCK -u REX_SERVER -u REX_BIN_DIR -u TERM_PROGRAM -u TERM_PROGRAM_VERSION npm test；退出 1，719 tests / 718 pass / 1 fail，232706.112833ms。失败：test/bridge-query.test.mjs:1019 的观察器 run-list 查询恢复测试，在 finally rmSync(:1069) 报 ENOTEMPTY，临时目录 knit-042-observer-scan-failure-176vCJ。失败完整日志 /tmp/knit-session-handoff-ts14l3da/normal-npm-test.log；未认定通过，先核对根因、单测复验再重跑全量。此前 worker Rex 719/719 pass 保留为该次证据；正式 independent 检查尚未开始。

普通终端复验：719 tests / 719 pass / 0 fail，退出 0，236874.347792ms；日志 /tmp/knit-session-handoff-ts14l3da/normal-npm-test-retry.log。此前失败与观察器单测五次通过的证据一并保留，未通过代码改动消除竞态。用户新授权原文：“测试通过就提交推送”；来源 user:sha256:92b97b54f1671078daa8b0bf70607fed266b83ac70a6c4fe21c7cc34ddd8d20c。待全新正式 independent 检查也通过后，逐任务分开提交产物与任务元数据、推送当前分支；保持 .knit/config.json 无关修改，不强制推送，不发布、部署或全局安装。

主会话接收并通读正式独立检查 run-bc7506733800（check_pass）：35/35 场景 pass，coverage 全部 41 业务路径；checker Pi 原生会话 24655541-fa0c-42b1-990f-76fd430cfc1a（create_new），与实施会话 2f419d04-acfb-43b6-bf71-3ead8e454530 不同。changedPaths=[]、findings=[]、blockers=[]；HEAD/index 未变，无保护路径或忽略区变化。Rex 隔离源码副本（成果逐字节匹配）再次 npm test：719 tests / 719 pass / 0 fail / 0 skipped，退出 0，271257.966625ms。普通终端、原 worker Rex 和这次独立复验均全量通过；原 ENOTEMPTY 清理失败与延期真实验收仍如实保留，不宣称竞态已修复。已审阅长期候选，r-7afda7cc131a deferred，不改变正式规范。下一步正常业务关闭（不 force），关闭后同步 .knit/agents 副本；用户只授权提交推送，不自动归档，随后定向 Git 分开提交产物与任务资料并推送，保留 .knit/config.json。

关闭后已按批准方案同步 .knit/agents/check.md、implement.md、runtimes/pi.md；三文件与已独立检查的模板逐字节一致，workflow validate 通过。额外直接 node --test test/scenarios.test.mjs 的调用未遵循 package.json 测试脚本：继承 TERM_PROGRAM=rex/REX_*，也未创建隔离 KNIT_KEYS_ROOT，6/8 pass、两个 fake-worker 用例 run 未收敛；日志 /tmp/knit-session-handoff-ts14l3da/post-sync-scenarios-test.log 保留，不能记为通过。此前 env -u REX_* npm test 的 719/719 结果是真实脚本隔离复验，但只凭清空环境变量不足以证明来自实际普通终端；普通终端证据待补，不据此直接提交。已准备普通 Terminal.app 验证脚本 /tmp/knit-session-handoff-ts14l3da/ordinary-terminal-verification.sh，按原 npm test 脚本隔离 env/密钥；osascript 启动 Terminal 应用但 AppleEvent 30s 超时，未产生验证日志或结果，可能在等待 macOS 自动化许可。Git 收尾暂阻塞，仍未 add/commit/push，不绕过系统许可；等待用户选择普通终端手动运行或允许自动化。独立 check_pass、既有 Rex 全量测试、来源不明 config 保留与未归档事实均不改写。

收尾验证缺口已补齐：用户选择允许 Terminal 自动化后，真实 Terminal.app 窗口 12635 启动标准 npm test；TERM_PROGRAM=Apple_Terminal 488.9、tty=/dev/ttys007，Node v26.3.0，typecheck/build 与隔离测试脚本完整执行。719/719 pass、0 fail、0 skipped，238869.374ms，退出 0，完成于 2026-11-11T11:32:29.409Z；日志 /tmp/knit-session-handoff-ts14l3da/ordinary-terminal-npm-test-final.log 和结果 JSON 保留，原环境-only 标签的普通终端证明以本次实际 App 证据补足。关闭后同步的三个 .knit/agents 副本与已独立检查模板字节相同，workflow validate 通过。之前直接 node --test 未按脚本隔离 env/密钥的 6/8 失败日志保留，后续标准全量包含并通过这些用例；不虚构代码修复。正式 independent 35/35 场景和 41 路径、Rex 全量 719/719 仍成立。授权 Git 条件已满足，提交文案已展示；定向分开提交 41 产物和 8 元数据并推送 origin/main，排除 .knit/config.json，采用 hooks skip，不归档或安装。

实际宿主 Git 产物提交已成功：66f2d3f1c4e585e04efb214817166cd441aad139（66f2d3f），父节点 c5dab24573a44d34a500d41ebd2db5b20a9d3471。提交仅含已核对的 41 产物路径；逐路径核对 index 与提交树 blob，全部等于已选中的工作区字节；提交后 index 为空。Source trailer 为 Knit-Task k-185ace3b9556／Knit-Stage artifact／Knit-Verification independent；hooks skip，未创建 Knit delivery operation。来源不明 .knit/config.json 未暂存、内容 blob 仍为 7ee20f4858d8a405de82e05aeb59daad84a119dc，仓库配置未改。下一步单独提交 8 条任务／流程／提示词资料后，按既有授权非强制推送 origin/main；这里尚不记推送成功，真实后续结果以 Git 和主会话回报为准。

2026-11-12 实际 deliver 被 stale_input 拒绝；原需求 inputsDigest、正式 standardsDigest 均匹配，但 role:check / runtime:pi 的冻结内容摘要与当前不同，effectiveInputsDigest 不匹配。未提交、未暂存，全部临时物化源文件已恢复并验明字节/模式；不退回当前受管提示词或修改凭据。待通过正常正式独立复核重建资格，既有远端产物 66f2d3f / 58a2dc2 不重复提交。

其他已获授权成果已按任务保留历史写入后，现行分支上的旧 scope 有 10 个路径指纹已被后续已完成任务合法更新。正常正式 check 不仅要求当前提示词，还在接收时校验 untouched scope 的现行指纹（run-acceptance.ts scope_changed）；不能用非正式 check --scope 或 task implement 替代，也不能用旧快照重新提交已在远端的成果。故本任务资料收尾需先通过正式来源/实施链重建当前 scope 再做独立检查；在不自动生产修复的授权边界内暂记阻塞，不启动已知无法接收的空检查。

主会话已接收正式实现 run-df1727de11fb。使用本次构建的公开 task rebind --recover，以 refs/heads/main 的当前提交 2d6801411158253beda3d5016ab0b781d12b37c8 和原本机 HMAC 签名实施记录审计备份核验 9 个历史成果路径；scope 从48扩充为51条、所有当前指纹一致，原run-4725f81f73af及新实施来源保留，无假changedPaths。恢复请求与测试日志在原审计目录。实现方报告普通终端全量750/750通过；主会话Rex全量运行中，尚未声称新增独立检查通过、提交或归档。

最终普通Terminal.app和Rex的npm test均743/743、0失败、0跳过、退出0，保留此前失败/中断日志。仅18条产物路径形成已授权本地提交876dcefbdf8d73416cfedbd41169de300b698fad；随后公开rebind --recover按该提交更新已登记的夹具实际修改路径。scope仍51路径、来源与两次复核记录保留，准备全新完整independent检查；资料提交与归档尚未完成，未推送。实际证据详见research/recovery-validation-2026-11-13.md。

补充最终范围核对：第二次公开恢复同时纳入本轮主会话真实修改并签名登记的test/bridge-query.test.mjs，最终scope实际为52条（此前51为夹具实际修改纳入前的范围）；所有52条指纹当前有效，2次恢复记录、原实施来源保留。新独立检查以52条完整范围为准，资料相应更正。

正式独立run-8b454443fb55报告pass（coverage52、scenarios41、changedPaths=[]、标准npm test743/743），但检查期间另一会话P1任务k-b9ea41e9eec0改动本P2范围内两份桥接，核心接收以scope_changed拒绝：run状态failed、接收needs_attention，未发布有效新检查，不能close或归档。来源与后续路径见research/parallel-scope-block-2026-11-13.md。用户在本会话明确选择“暂不授权P1提交”；不提交、覆盖或接管P1，不将其未提交内容混入本P2。保留本P2已授权产物提交876dcefbdf8d73416cfedbd41169de300b698fad与普通Terminal.app/Rex各743/743历史证据，任务维持open/check，等待受影响路径形成经授权的真实提交，再公开恢复范围、新独立检查、close和正式deliver/archive。未推送、未归档。

续接只读核对：HEAD仍876dcef，未产生新的真实来源提交。52条scope条目的当前指纹漂移增至3条（两份桥接及docs/design/DESIGN.md），第三条diff为并行P1的通知唤醒说明；其ARCHITECTURE.md修改不在本P2 scope。用户暂不授权P1提交的决定保持有效。未重复实施/检查、未触碰并行成果、未提交或推送、未close或归档。详细证据补记research/parallel-scope-block-2026-11-13.md。

2026-11-14 续接收口（主会话，授权来源用户消息 9698c2d8，范围为本地提交与归档，不含推送）：并行 P1 k-b9ea41e9eec0 及后续两项核心修复（k-e7876542ec29、k-2af2e1208325）均已独立检查通过并各自提交归档，本任务 scope 内 19 条被更新的路径由此取得真实提交来源。以 refs/heads/main 的 2dff2a3e922eecdb694e77ad6fa80f990f897d65 为来源执行公开 task rebind --recover（请求 /tmp/knit-k185/recovery-request.json），19 条全部复核，scope 52 条、当前指纹 0 漂移，恢复记录 3 条，原实施来源 run-4725f81f73af、run-df1727de11fb 保留；未手改凭据、检查点或阶段。新的完整独立检查 run-ea809fc9bab1（magpie / group/deepseek）pass：coverage 52、scenarios 41 全 pass、无 findings、检查者未改文件，接收 check_pass；检查者在 Rex 终端跑标准 npm test 782/782。同一份源码在本会话的普通 Terminal.app 首次 781/782（test/run.test.mjs 锁目录轮询的 find 竞态，单独重跑 6/6 通过）、重跑 782/782，Rex 782/782。旧检查 run-8b454443fb55 的报告与拒绝接收证据保留。未验证：真实 Pi 会话端到端与 macOS 安装验收按任务边界延期。

### 交付记录

<!-- knit:delivery:op-82859126c85c -->
- 操作: op-82859126c85c
- 时间: 2026-11-13T21:50:20.282Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 无
- 结果: 正常交付；检查 run-ea809fc9bab1 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-11-scenario-acceptance-criteria

<!-- knit:progress:end -->
