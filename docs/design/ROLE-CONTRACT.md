# 阶段契约：提示词、报告与工具

本文件说明 Knit 各阶段的配置事实，供 [DESIGN.md](DESIGN.md) 第 4、5、8.1 节、[OPERATIONS.md](OPERATIONS.md)、[STATES.md](STATES.md) 和 `.knit/workflow.yaml` 对照。文件名 `ROLE-CONTRACT.md` 是历史命名；当前模型中没有独立“角色”对象，角色概念已并入阶段：阶段 = 可选提示词文件 + 可选能力白名单 + 可选报告字段 + 可选回退目标。

一次阶段调用的实际行为由核心阶段指令、核心生成的顶部提示行、`.knit/workflow.yaml` 中该阶段的配置、阶段提示词文件、runtime 补充、适用规范与任务输入共同决定。提示词文件只是系统提示中的一个分节；写动作仍由核心按授权、阶段、锁和版本重新核对。

## 1. 阶段与锚点

| 阶段 | 来源与职责 | 停止／交回条件 | 报告字段 | 工具与副作用 |
| --- | --- | --- | --- | --- |
| `start`（准备／讨论锚点） | 主会话先取证再提问（代码、测试、配置、文档、规范与任务历史，含归档），按缺口维度逐项扫描；每问给出决定、原因、推荐与代价，一轮最多 3 个，假设落盘 `[assumed]`；确认任务选择与授权，`blocking` 清零后做 ready 检查；不可配置、无提示词 | 需要用户取舍、授权不明、有待应用草案或活动 run、`blocking` 未清零时停在讨论并说明缺口 | 使用普通回复，不产生 worker `StageReportSchema` 报告 | 主会话工具；不代写阶段成果，不自动提交或发布 |
| 配置阶段（默认 `implement`） | 按 task.md 目标与完成条件产出代码、测试、配置、文档或研究报告，运行范围验证；提示词由该阶段 `prompt` 指定 | 需求／规范冲突、需要用户决定、保护路径或无法确认的副作用时记录后停止产出，在报告中说明阻塞并交回主会话；没有可核对产出时报告缺少成果 | 固定 `summary`／`validation`／`blockers`，加上该阶段声明的额外字段（默认实施字段为 `changedPaths`／`unverified`） | 由 `tools` 白名单决定，不写或 `all` 则全部放开，`[]` 则全部禁用；可写项目文件与运行验证；不写 `.knit/`，不 commit／push／rebase，不委派其他 Agent |
| 配置阶段（默认 `check`） | 独立核对完成条件、冻结输入、实际成果与上一阶段报告；运行声明验证；在既定需求内、问题与修复方向明确时直接修复并验证 | 需求解释、取舍、验收变化或扩大范围时不改代码，以 `blocked` 交回主会话；仍有未解决缺陷时以 `changes_requested` 交回 | 固定字段加 `verdict`（pass／changes_requested／blocked）；有修改时 `changedPaths` 必填且与实际 diff 一致，另含 `coverage`／`selfVerified`／`findings`／`unverified` | 由 `tools` 白名单决定，不写或 `all` 则全部放开，`[]` 则全部禁用；写权限仅覆盖任务范围内、问题与修复方向明确的缺陷；不写 `.knit/`，不 commit／push／rebase，不推进阶段，不委派 |
| `deliver`（收尾锚点） | 主会话接收实施／检查结果、核对完成条件、在授权交付前起草一次产物提交文案并展示、协调 `deliver`／`archive`；不虚构验证结论；不可配置、无提示词 | 完成资格无效、有待应用草案、活动 run、检查 stale 或提交／推送／发布未授权时停在收尾并说明缺口 | 使用普通回复；交付事实来自核心操作结果 | 主会话与确定性工具；不启动交付辅助 worker；不把子进程完成当作授权 |
| 非正式检查（`run check --scope`） | 对显式范围做独立只读核对，返回结论 | 范围无法确认或需要正式交付资格时停止，改走正式任务 | `summary`、`verdict`、`coverage`、`findings`、`unverified` | 只读；不建 Task／binding，不推进 stage，不赋交付资格 |
| Pi runtime 补充 | 说明阶段会话的 CLI、资源、能力白名单、恢复与工具事实 | 资源不可用、恢复来源不明、发现保护路径或未授权副作用时报告，不借新会话重置状态 | 按所属阶段字段输出 | 阶段不加载项目扩展；`tools` 不写或 `all` 全部放开，`[]` 全部禁用（`--no-tools`），`external`／`network` 才放开扩展、MCP、技能与网络 |

`.knit/`（task.md、规范、配置、任务资料）是所有阶段的保护路径。主会话通过核心命令修改任务资料；worker 阶段不直接写，需要变更时记录问题交回。

**主会话派发分层**：主会话在动手前按 W1–W4 判断是否派 Knit worker——W1 独立检查（任务要求 `independent`，或正确性无法自证）、W2 改动面（≥ 3 个文件或跨 ≥ 2 个模块／包）、W3 摸底成本（需读 ≥ 8 个文件或 ≥ 1500 行，或依赖大量搜索／长日志）、W4 用户指定；不满足则主会话直接做。判断顺序、矩阵与阈值边界见 [DESIGN.md 第 4.2 节](DESIGN.md#42-主会话工作流)；阈值是判断辅助，不以时长、步骤数、阶段数或是否需要恢复作判据。worker 仍只在任务内派发：`run prepare/start/implement/check` 都要求 `--task`，没有任务就没有 Knit worker；该派但无任务时先向用户提议建任务，不代建，复杂但不建任务时用宿主通用子 Agent。`independent` 不得用主会话自检或 `run check --scope` 代替，也不得用 `task implement` 绕开 W1。

锚点 `start`／`deliver` 不产生 worker 报告。配置阶段可以有任意 id；默认模板使用 `implement`／`check`，只是示例，不是固定枚举。同一提示词文件可被多个阶段复用；阶段 id 是 Session 引用、访问计数与任务 `stage` 的稳定键。

## 2. `StageReportSchema` 对照

核心只把报告当证据，不因模型自报直接改变阶段、修复次数或完成结论。

| 字段 | 必填 | 类型／来源 | 核心核对 |
| --- | --- | --- | --- |
| `summary` | 是 | string，固定字段 | 概括产出与实际执行的验证 |
| `validation` | 固定字段 | string[]，可省略；给出时必须为字符串数组 | 每项记录方法、结果与证据；未执行标 `not_run` |
| `blockers` | 固定字段 | string[]，可省略；给出时必须为字符串数组 | 阻塞或待决事项；无则空数组 |
| 阶段声明字段 | 按 `report` | `string`／`string[]`／`paths`／`bool`／非空枚举数组 | 按声明类型校验；未声明只校验固定字段 |
| `changedPaths` | 当阶段声明 `paths` 时 | string[]，通常名为 `changedPaths` | 路径与实际 Git 可见差异完全一致，不得省略实际改动、不得虚报未改文件 |

`onVerdict` 的键必须是某报告枚举字段声明的值，目标必须是已声明阶段 id 或 `deliver`；未命中走顺序下一阶段。回退目标必须是有限环，阶段访问超过 `maxVisits` 时停止并报告 `repair_round_limit`。

报告中的路径使用项目相对路径。未执行或证据不足的验证写入 `unverified`，不写成通过。正式检查以核心写入的检查凭据为准；检查阶段自报 pass 不替代核心核对。

## 3. 停止条件与交回

- **需求澄清是查明事实，不是用户意图推定**：仓库证据只证明现状与约束，产品意图、范围、验收与风险取舍仍由用户决定；先取证并引用来源，提问时给推荐与代价，假设落盘为 `[assumed]`，不以「完整方案＋是否正确」的一次确认代替逐项决定。
- **需求不明／需要用户取舍**：记录问题、证据、可选项与待决事项，停在当前环节；不自行补齐目标、验收或产品偏好。
- **规范冲突或未覆盖**：先说明冲突、影响和建议，取得决定后再改正式规范或扩大实施范围。
- **保护路径**：`.knit/` 下文件由核心流程维护；阶段内发现必须修改时交回主会话，不绕过。
- **未授权副作用**：发现 Git 提交、推送、发布、环境清理或范围外写入时保留事实并报告，不把正常报告当作追认。
- **检查结论**：`pass` 只证明当前目标版本通过；`changes_requested` 按 `onVerdict` 回实施阶段；`blocked` 保留检查阶段或按配置跳转，由主会话处理。目标或输入变化后旧检查失效。
- **没有可核对产出**：明确报告缺少成果，不用形式性通过结束流程。

## 4. 工具事实

| 能力 | 展开与边界 |
| --- | --- |
| `read` | read、grep、find、ls，只读 |
| `write` | write、edit，改项目文件 |
| `exec` | bash，可执行验证命令，也可能间接改文件 |
| `task` | Knit 任务／上下文工具 |
| `external` | 放开项目扩展、MCP 与技能；声明后工具不存在要报错，不静默降级 |
| `network` | 放开网络；默认阶段离线执行 |

不写 `tools` 或写标量 `all`（大小写不敏感）表示全部放开；写 `[]` 表示全部禁用（无任何工具，保持离线并禁用扩展／MCP／技能）；写了非空列表就是白名单，没列出的能力不能用，列表里不能混入 `all`（如 `[all, read]` 报 `invalid_tools`）。`knit workflow set-tools <id> all|[]|<清单>` 分别设为全部放开、全部禁用或白名单，`--clear` 删除字段（等同全部放开）。`external`／`network` 明确改变可移植性与安全边界，应由项目显式声明。能力不是操作系统沙箱，shell 仍可能产生未声明副作用；阶段边界核对 HEAD／分支、index 与实际成果，发现无法确认的副作用时保留事实并报告。

| 事实 | 说明 |
| --- | --- |
| 会话 | 每个阶段按阶段 id 创建或恢复独立 Session；阶段不同即不同原生对象。内部 Session 记录的 `role` 字段与 CLI `--role` 是历史命名，值即阶段 id，新调用优先使用 `--stage` |
| 提示词 | `prompt` 缺省或文件缺失时用核心默认 agent 指令，不阻断执行，也不使整份流程降级 |
| 流程降级 | 配置非法时生效流程为 `start → deliver`，不套提示词；`workflowMode`、`workflow show`、顶部提示与 `doctor` 显示原因 |
| 交付与 Git | 阶段不执行 commit／push／rebase；交付由主会话在授权后协调确定性工具，子进程完成不等于授权 |
| 委派 | 阶段执行器不是主 Agent，不递归派发其他阶段 |
| 扩展与资源 | Pi 阶段默认 `--no-extensions`、`--no-mcp`、`--no-skills`、`--offline`，只加载受控阶段提示词、规范与任务资料；`external`／`network` 才显式放开 |
| 报告与状态 | 报告是待核对证据；阶段、修复次数、scope 和完成由核心维护 |

## 5. 装配、初始化与升级

- **完整装配**：核心阶段指令给出“独立阶段执行器、不修改 `.knit/`、不提交、不委派、按报告字段输出”；顶部提示行给出流程、当前阶段、本步目标与完成条件；`workflow.yaml` 给出阶段顺序、提示词、能力白名单、报告字段与回退；runtime 补充平台事实；规范与任务输入提供当前依据。评估阶段行为时应看这些部分的组合，而不是单文件长度。
- **新项目**：`knit init` 从安装包 `assets/templates/` 生成 `.knit/workflow.yaml`（带完整注释）、阶段提示词、规范索引、AGENTS 受管块和桥接；受管块内容由 `agentsManagedBlock()` 统一生成。
- **已有项目**：`.knit/workflow.yaml`、阶段提示词和规范属于 project 所有权，已存在即保留原文；模板升级不会静默替换。需要迁移时由主会话按模板差异显式同步并单独提交。上次清单记录、当前模板不再生成但项目里仍存在的文件作为“模板已移除文件”报告，默认只报不删。
- **受管内容**：桥接在旧基线匹配时更新，人工改动或未知来源报告冲突；AGENTS 受管块按块内容核对，人工差异报告，`--force` 才显式覆盖。

## 6. Trellis 来源映射（固定历史材料）

固定来源：`mindfold-ai/Trellis` 提交 `f089cb3286071199e84118dee86b6d76aab032f1`，核对材料见 [validation/trellis-prompts-and-roles/](../../validation/trellis-prompts-and-roles/)。下表按固定提交源码与注入路径核对（路径相对 Trellis 仓库根），未运行 Trellis CLI 或模型。表中的 `workflow.md` 是 Trellis 的固定历史文件，不是 Knit 当前配置。

| 项 | 固定来源与观察到的行为 | Knit 采用与差异 | 当前落点 |
| --- | --- | --- | --- |
| 任务选择先问 | `packages/cli/src/templates/trellis/workflow.md` L155-159、L179-183：简单请求也先问是否建任务，用户拒绝则本次跳过 | 采用“新事项先问是否建任务再展开需求”；不复制“本次跳过”的会话标记，Knit 用用户决定持续有效、实施前再确认表达 | AGENTS 受管块、桥接注入 |
| 创建≠实施 | Trellis `workflow.md` L159、L323-339：创建同意不等于实施同意，规划后仍需 `start` | 采用；Knit 用 start／ready 与实施授权分开，不新增独立 planning 状态 | AGENTS 受管块、DESIGN §4.2 |
| 先取证再问 | `packages/cli/src/templates/common/skills/brainstorm.md` L5-19、L42-55：先查代码与资料，只问必须由用户决定的产品问题 | 部分采用：保留先取证、只问取舍；不引入 Trellis 的 PRD／design／implement 三件套 | AGENTS 受管块、讨论流程 |
| research 历史子角色 | Trellis `workflow.md` L367-390；`pi/agents/trellis-research.md` L1-25：研究仍依附任务，产物写任务 `research/` | 不新增 research 阶段；任务材料写 `research/`，正式报告写项目路径并走实施→检查 | DESIGN §4.2、实施阶段提示词 |
| implement 工具与禁止项 | `pi/agents/trellis-implement.md` L19-35：读任务产物、运行验证，禁止 commit／push／merge | 采用产出范围、验证与禁止 Git；差异：Knit 工具策略由 `tools` 白名单与核心核对给出 | `.knit/agents/implement.md`、runtime pi.md |
| check 直接修复 | `pi/agents/trellis-check.md` L19-26、L35-37：看 diff、对任务产物、范围内直接修、跑验证 | 采用“范围内直接修”；差异：Knit 检查从独立上下文开始，必须报告 `changedPaths`／`selfVerified`，需求或验收变化用 blocked 交回 | `.knit/agents/check.md` |
| 自动修复边界 | Trellis `workflow.md` L543-553：检查自动修复发现 | 采用“问题与修复方向明确”的有限修复；不采用无条件 auto-fix，冲突或需求变化停止 | check.md、`maxVisits` |
| 任务状态不可读 | Trellis `workflow.md` L187-191：活动任务记录不可读时不要创建或激活另一任务 | 采用停止与不伪造状态的原则；Knit 由核心报告 missing／blocked，阶段不自行切换任务 | 停止条件 |
| 每轮状态注入 | `packages/cli/src/templates/pi/extensions/trellis/index.ts.txt` L1124-1151、L2066-2085：从 workflow 状态块解析并注入 | 采用每轮注入；差异：Knit 桥接调用核心 `session resolve`／`status`，不解析 workflow 文本 | `.pi/extensions/knit.ts` |
| 必需提交与收尾 | Trellis `workflow.md` L600-640；`common/commands/finish-work.md` L1-20：提交是 required step | 不采用自动提交；Knit 把业务完成与提交／归档分开，交付由主会话按授权协调 | AGENTS 受管块 |

## 7. GSD 来源映射

固定来源：`open-gsd/gsd-core` 提交 `1ec5c812b79dc1cc487d0873d18b03449b11c106`，研究摘要见 [RESEARCH.md 第 17.5 节](../research/RESEARCH.md#175-gsd-core)。下表按固定提交文件文本核对（路径相对 GSD 仓库根），未运行 GSD CLI 或模型。

| 项 | 固定来源与观察到的行为 | Knit 采用与差异 | 当前落点 |
| --- | --- | --- | --- |
| 阻塞与续做摘要 | `gsd-core/templates/state.md` L67-98：Decisions、Pending Todos、Blockers/Concerns、Session Continuity、Stopped at | 采用“阻塞、关键决定、停在哪里必须可续做”的事实分类；差异：Knit 写入 task.md 记录区与 run 报告，不维护第二份 STATE.md | task.md 记录区、停止条件 |
| 暂停交接字段 | `gsd-core/workflows/pause-work.md` L48-55：当前位置、已完成、剩余、决定、阻塞、待人工动作、修改文件 | 采用阻塞报告需说明待决项、实际修改与未验证项；不引入 HANDOFF.json | 报告字段、workflow 记录区 |
| 偏差与停止边界 | `gsd-core/workflows/execute-plan.md` L268-285：规则 1-3 自动修复并记录，规则 4 架构变更 STOP 等用户决定；限制重试次数 | 采用“范围内修复、需求／架构变化停止、不修无关范围”；差异：修复轮次由核心 binding 计数，不在提示词文件自定上限 | check.md、`maxVisits` |
| 检查点与人工动作 | `execute-plan.md` L230-240：checkpoint STOP，验证失败先修复或升级偏差；L257-266 认证／人工动作单独记录 | 采用“需要用户决定或人工动作时停止并如实报告”；差异：Knit 不新增 checkpoint 类型 | 停止条件、主会话交付 |
| 恢复前置核对 | `gsd-core/workflows/resume-project.md` L35-61、L116-125：状态缺失／初始化未完成先修复，blockers 立即呈现 | 采用“输入／状态不可读先报告，不伪造或新建重复任务”；差异：Knit 的恢复由核心会话与运行记录完成 | 恢复、blocked 报告 |

## 8. 行为场景与验收边界

下表用于核对主会话与配置阶段的行为方向，不是字符串存在性证明。机械测试只能证明模板、注入与初始化内容一致；真实宿主对话中的任务选择、授权、规范沉淀、历史查询与交付行为由后续真实宿主验收任务 k-da599e3b5cd4 在真实会话中验收。

| 场景 | 用户表达 | 期望轨迹 | 不应发生 |
| --- | --- | --- | --- |
| 任务选择：新事项 | 提出可能形成实施、文档或成果的新需求 | 先问这次是否建任务；用户不建时继续讨论；转到实施前再确认；明确不建后同一事项不重复追问 | 按“看起来很小”或“只是调研”跳过任务选择；实施前遗漏选择仍直接开工 |
| 任务选择：实施前补问 | 之前只讨论、未决定是否建任务，现在要求“做吧” | 先补问任务选择；不能把“做吧”当作任务选择或实施授权 | 直接 `task new`／派发 run，或用“你做吧”替代选择 |
| 创建与授权 | 用户同意登记任务，但只说“先记下来” | 创建只覆盖登记；需求未确认时保持 start；实施授权另行确认 | 把创建当作需求确认或实施授权；自行 ready／派 run |
| 明确实施 | 用户说“按这个方案做”且范围清楚 | 可同时确认范围与实施授权，不重复确认；进入 start／ready 后按验证要求推进 | 机械重复询问同一授权；或只确认范围却不记录实施授权 |
| 规范沉淀 | 用户给出明确长期规则；或讨论出现未决可复用内容 | 明确规则直接采纳并说明依据；冲突先提决定；未明确内容存项目候选；回复末尾告知内容、范围与位置 | 把一次性要求写成通用规则；与正式规范冲突时静默覆盖 |
| 历史查询 | 用户明确要求查历史、上次决定或追溯原因；或需求澄清取证 | 明确要求时按意愿用 `knit task search`／`knit_task action=search` 只读检索；澄清取证可主动检索；均引用 path:line、run ID 或 commit；说明相关不等于因果 | 普通对话未表达意愿时因话题相关主动检索；把相关记录当因果结论 |
| 交付与授权 | 实施／检查完成，用户未授权提交 | 主会话接收结果、核对完成条件并汇总；业务完成与 Git 收尾分开；提交／推送／发布另行授权 | 把子进程完成当提交授权；未授权时提交、推送或发布 |
| 阶段停止 | 实施或检查遇到需求取舍、规范冲突或保护路径 | 实施阶段停止产出并报告阻塞；检查阶段在问题与修复方向明确时范围内修复，否则 `blocked` 交回 | 自行选择产品取舍、修改 `.knit/`、扩大范围或递归派发阶段 |

机械证据包括：`npm test` 中的 init／bridge／session／stage 回归，模板与 AGENTS 受管块逐字比较，桥接两分支注入断言；真实模型行为不因这些断言自动通过。
