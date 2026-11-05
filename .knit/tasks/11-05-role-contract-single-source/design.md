# 设计：YAML 驱动的可配置流程（k-8ed2dceaaa4d）

状态：讨论收敛，等待实施授权。本文件是实现依据，不构成实施授权。

## 1. 问题

"删掉一个角色"（`k-aeda178a77b5`）要改 11 个源文件、5 份文档、3 个模板，并留下墓碑残留。根因不是字面量多，而是一个角色被拆成三套互不相干的概念各自硬编码：

| 概念 | 现状位置 |
| --- | --- |
| 任务阶段 phase | `contracts/task-inputs.ts:17`、`domain/task.ts:13` |
| run 阶段 | `contracts/run.ts:20`、`cli/run.ts:151` |
| 角色 | `context-planner.ts:62-70,204`、`templates.ts:23-25` |

三者靠特判连接（`stage-runner.ts:88`、`worker/knit-worker.ts:259`、`run-acceptance.ts:186`）。

## 2. 目标／非目标

目标：流程由 `.knit/workflow.yaml` 声明；角色 = 阶段引用的提示词文件；按配置顺序自动流转；增删环节只改配置；配置可读可注释。

非目标：旧任务迁移；多人协作；Worktree；跨机同步；流程模板市场。

## 3. 概念

- **锚点**（内置、不可配置、无提示词）：`start`（准备／讨论）、`deliver`（待收尾）。
- **阶段 stage**：用户配置，有序。= 可选提示词文件 + 可选能力白名单 + 可选报告字段 + 可选回退目标。
- **角色**不再独立存在：角色就是阶段引用的提示词文件，可被多个阶段复用。
- **展示字段**：`name`（显示名）与 `description`（本步说明）只供人和顶部提示使用，不参与机器判定。

## 4. 配置格式

`.knit/workflow.yaml`（复用已有 `yaml@2.9.0`）。`knit workflow init` 生成带完整注释的模板。

```yaml
version: 1
stages:
  - id: implement
    name: 实现
    description: 按 task.md 完成产出并运行范围验证
    prompt: .knit/agents/implement.md
    tools: [read, write, exec]
  - id: check
    name: 检查
    description: 独立核对完成条件与实现成果
    prompt: .knit/agents/check.md
    tools: [read, exec]
    report:
      verdict: [pass, changes_requested, blocked]
    onVerdict:
      changes_requested: implement
```

| 字段 | 必填 | 语义 |
| --- | --- | --- |
| `version` | 是 | 当前为 `1` |
| `stages` | 是 | 有序数组，顺序即流转顺序，非空 |
| `id` | 是 | `^[a-z][a-z0-9-]{0,31}$`，写入 task.md 的 `stage` |
| `name` | 否 | 显示名，缺省用 `id` |
| `description` | 否 | 本步说明，用于顶部提示与 `workflow show` |
| `prompt` | 否 | 项目相对路径；缺省或文件缺失 → 核心默认 agent 指令 |
| `tools` | 否 | 能力白名单；缺省 = 全部放开 |
| `report` | 否 | 额外报告字段：`string`／`string[]`／`paths`／`bool`／枚举数组 |
| `onVerdict` | 否 | 命中字段值时的跳转目标；未命中走顺序下一阶段 |

## 5. 流转

1. 阶段完成、报告被接收 → 顺序进入下一阶段；最后一个阶段完成 → `deliver` 锚点。
2. `onVerdict` 命中 → 跳到指定阶段（回退边合法）。
3. 回退必须有上限：阶段 `maxVisits`，缺省 `workflow.maxRepairRounds`；超限停止并报告 `repair_round_limit`。无上限的环写入拒绝。
4. 流转不询问用户。
5. 每轮上下文**最上方**由核心生成提示行：

   ```text
   流程：准备 → 实现 → 检查 → 收尾 ｜ 当前：检查
   本步目标：独立核对完成条件与实现成果
   完成条件：pass → 收尾；changes_requested → 实现
   ```

   使用 `name`／`description` 渲染，agent 不需要解析 id 或配置结构。
6. 自动流转只推进业务阶段，**不代表提交／推送／发布授权**。

## 6. 报告与交接

- 固定字段：`summary`（string）、`validation`（string[]）、`blockers`（string[]）。
- 阶段声明的额外字段按声明校验；未声明只校验固定字段。
- `paths` 类型沿用严格校验：必须与实际 Git 可见差异一致（`changedPaths` 即 `paths`）。
- `onVerdict` 引用未声明字段 → 写入拒绝。
- 非正式检查（`knit run check --scope`）保留独立固定格式，不依赖阶段声明。

## 7. 权限（能力白名单）

- **不写 `tools` = 全部放开**；写了就是白名单，没列出的不能用。
- 能力映射：

| 能力 | 展开 | 说明 |
| --- | --- | --- |
| `read` | read, grep, find, ls | 只读 |
| `write` | write, edit | 改文件 |
| `exec` | bash | 能间接改文件 |
| `task` | knit_* 任务／上下文工具 | 任务操作 |
| `external` | 放开 `--no-extensions`／`--no-mcp`／`--no-skills` | 用户装的扩展、MCP、技能 |
| `network` | 放开 `--offline` | 出网 |

- 现状（`adapters/pi/runtime.ts:82-98`）阶段固定以 `--offline --no-mcp --no-skills ... --no-extensions` 启动，且 `--tools` 只取 7 个内置名；因此外部工具今天完全不可用，`external`／`network` 是显式 opt-in。
- 声明 `external` 后配置可能因机器差异不可移植：报错要说清"阶段声明了 external 但工具不存在"，不静默降级。

## 8. 完成资格与机械事实

可配：是否检查、检查几轮、阶段顺序、能否跳过检查。

不可配（核心强制）：run 已终态且报告已接收；无待应用输入草案；提交路径限定在本任务；分支与绑定一致；存在检查凭据时凭据摘要必须与当前任务输入一致（无凭据则跳过，支持"只调研直接交付"）。

**流程配置不进 `inputsDigest`**：摘要保护"输入版本"（任务输入／规范／提示词文件／资料）；流程重排不使已有凭据过期。删除 `workflow.md` 后 `workflow` 分节退出摘要，与之保持一致。

## 9. 降级

触发：YAML 解析失败、`version` 不支持、`stages` 为空、`id` 非法或重复、`onVerdict` 目标不存在、回退环无上限。

行为：生效流程 = `start → deliver`，不套提示词，用默认 agent 行为。

可见性（四处，禁止静默）：`knit workflow show` / 每轮顶部提示行 / run 记录 `workflowMode: config|fallback` / `knit doctor`。

不降级但需说明：`prompt` 文件缺失（用默认指令）、阶段未声明报告字段（只校验固定字段）。

降级发生时正在运行的 run 继续跑完并正常接收，只对新 run 生效。

## 10. 写入与校验

- `knit workflow validate`：只读，输出结构化问题清单（含 YAML 行号）。
- 写入命令：原子写 + 全量校验，失败拒绝并给出行号与原因。
- 手改文件：允许；读取时按第 9 节降级。
- 注释不参与解析结果，也不参与任何比较。

## 11. CLI 与桥接

CLI：`knit workflow init | show | validate | add | remove | move | set-prompt | set-tools | set-report | set-next`；`run prepare/start --stage <id>`；`knit context --stage <id>`。

桥接：新增 `knit_workflow`；`knit_run` 的 action、`knit_context` 的目标一律按读取到的配置派生，**不再有静态枚举**；读取失败退回字符串参数，由核心返回合法阶段清单。删除 `knit_run.mode`、`assist <mode>`、`assist_deliver_removed`、`advisory` 相关全部入口与文档行。

## 12. 删除 `.knit/workflow.md`

现状注入路径（已核对）：

| 消费者 | 路径 | 内容 |
| --- | --- | --- |
| 阶段 worker | `context-planner.ts:186-196` 的 `workflow` 分节 | 全文 |
| 主会话（主动） | `knit_context` → `knit context` | 全文 |
| 主会话（每轮） | `.pi/extensions/knit.ts:303-335` | 仅一句"按 workflow.md 推进" |

内容搬家：

1. 流程结构 → `workflow.yaml`；worker 改收核心生成的顶部提示行。
2. 主会话规则 → 已在 `AGENTS.md` 受管块，不重复维护。
3. 阶段职责与停止条件 → `.knit/agents/<stage>.md`。

同步修：`context-planner` 的 workflow 分节、桥接与模板副本的"按 workflow.md 推进"、`TEMPLATE_SPECS`、init 模板、`docs/design` 引用。

## 13. 代码落点

| 文件 | 目标 |
| --- | --- |
| 新增 `domain/workflow.ts` | YAML 解析、校验、`WorkflowDefinition`、降级、默认模板 |
| `contracts/task-inputs.ts` | `TaskPhase` → `TaskStage`（锚点 + 阶段 id） |
| `domain/task.ts` | 逐阶段 `onXxx` → `transition(workflow, stage, event)` |
| `contracts/run.ts` | `RunPhaseSchema` → 阶段 id + `workflowMode`；报告改为固定字段 + 声明字段 |
| `cli/run.ts` | `--stage`；删除 `assist <mode>` 与 `advisory` 分支 |
| `cli/workflow.ts`（新增） | `workflow` 命令组 |
| `application/context-planner.ts` | 删除 workflow 分节；能力 → 工具策略；顶部提示行；`--stage` |
| `application/stage-runner.ts` | 删除 `roleOf` 特判；按阶段给 `--tools` 与 external／network 开关 |
| `application/run-acceptance.ts` | 按声明的报告字段校验；配置驱动转移与访问计数 |
| `application/templates.ts` | `workflow.yaml` 模板、删除 `workflow.md`、孤儿报告 |
| `domain/check.ts`、`domain/completion.ts` | 凭据存在性 + 机械事实 |
| `worker/knit-worker.ts` | 删除 `advisory` 特判 |
| `adapters/pi/runtime.ts` | 能力 → 参数（`--tools`、`--no-extensions`、`--no-mcp`、`--offline`） |
| `.pi/extensions/knit.ts` + `assets/templates/pi/extensions/knit.ts` | schema 派生、`knit_workflow`、删除 mode、修复 turn context 提示 |
| `docs/design/DESIGN.md` §15.1、`STATES.md` §3/§8、`OPERATIONS.md`、`GLOSSARY.md`、`ROLE-CONTRACT.md` | 重写为配置解释规则 |

## 14. 验收场景

1. 默认 YAML → 行为与当前四环节一致。
2. 自定义三阶段 + `onVerdict` 回退 → 按配置流转；超 `maxVisits` 停止并报告。
3. 阶段无 `prompt` → 默认 agent 指令，不报错。
4. 不写 `tools` → 不限制；`[read]` → 无写权限；`[read, external]` → 扩展工具可见。
5. 配置无检查阶段 → 实现后可直达收尾交付。
6. 坏 YAML → 降级 `start → deliver`，四处可见性齐全，在途 run 跑完。
7. 自定义阶段在桥接可见可调（无静态枚举）。
8. 非法 id／重复 id／引用不存在／无上限回退环 → 写入拒绝并给出行号。
9. 每轮顶部出现"流程 + 当前阶段 + 本步目标 + 完成条件"，用 `name`／`description` 渲染。
10. 删除 `workflow.md` 后无悬空引用，init 不再生成该文件。

## 15. 已确认决定

1. 角色并入阶段，配置中无独立 `roles`。
2. 流程配置不进 `inputsDigest`。
3. 不兼容旧任务；不在配置里的旧阶段值只读原样展示，写操作拒绝。
4. 固定报告字段 `summary`／`validation`／`blockers`。
5. 降级时在途 run 继续跑完；`workflowMode` 记录模式。
6. 回退环必须有上限。
7. 桥接取消静态枚举。
8. 阶段 id 限 `^[a-z][a-z0-9-]{0,31}$`。
9. 每轮顶部说明本步目标与完成条件。
10. 写入拒绝坏配置；读取降级不阻断。
11. 配置格式 YAML；能力名 `read/write/exec/task/external/network`；不写 `tools` 全放开。
12. 删除 `assist discuss`／`advisory` 整条链路。
13. 删除 `.knit/workflow.md`，内容三分搬家。
14. 默认模板沿用 `implement`／`check` 同名 id，现有任务天然可读（非迁移逻辑）。
