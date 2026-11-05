# Trellis 工作流可配置性核对（0.6.17 / `f089cb3`）

## 状态

- 本目录是任务 `k-2edd6475a67c` 的**调研交付**，不是已生效的产品规则。
- 只读核对固定提交 `mindfold-ai/Trellis` `f089cb3`（`packages/cli` version 0.6.17）。未运行 Trellis CLI、hook 或 channel；未在本机执行任何 Trellis 命令。
- 未修改 Trellis 检出，也未修改 Knit 代码、现行规范或桥接。
- 结论只对这种提交负责；逐条来源、行号与文件摘要见 [sources.md](sources.md)。Knit 侧改造建议见 [knit-options.md](knit-options.md)，其中每条都是待确认建议。
- 既有材料 [../reference-boundaries/](../reference-boundaries/) 与 [../trellis-prompts-and-roles/](../trellis-prompts-and-roles/) 已覆盖取消、恢复、提交隔离与角色职责；本文件只补"工作流本身能不能配置"这一条线，不重复其结论。

## 术语

- **流程叙事**：阶段名、阶段顺序、步骤说明、每轮提示文本。Trellis 放在项目文件里，脚本解析。
- **机器状态**：`task.json.status`，Trellis 唯一的任务状态字段，类型是自由字符串。
- **逐轮提示（breadcrumb）**：按 status 每轮注入 `<workflow-state>` 的那段文字。
- **恢复路由**：按 status 加产物存在性决定"下一步做哪个步骤"的表格。

## 结论速览

1. **Trellis 的流程是数据，不是代码。** 阶段与步骤清单写在 `.trellis/workflow.md`：`## Phase Index` 定义三段，正文用 `#### X.Y` 小节保存每个步骤的详细指引，命令行按编号取用。模板文件原话："All customization is done by editing this file; the scripts are parsers only."（`templates/trellis/workflow.md:658-660`）
2. **步骤是按需抽取的，不是一次性全灌进上下文。** `get_context.py --mode phase --step 1.1` 走 `common/git_context.py:86` → `workflow_phase.py:100` 的 `get_step`，用正则 `^####\s+(\d+\.\d+)` 切出单个步骤。编号因此是接口：模板里写明 step 3.1 已折进 2.2、编号保持不变以免破坏外部引用（`workflow.md:260`）。
3. **每轮提示按 status 查表。** hook 解析 `workflow.md` 里所有 `[workflow-state:STATUS]…[/workflow-state:STATUS]` 块，用当前 status 查表注入；查不到就不注入。解析器不内嵌任何文本（`workflow-state-contract.md:29-42, 67-85`）。
4. **加了状态块不等于有了状态。** 状态写入者只有 7 处代码（`planning` / `in_progress` / `completed` 及 4 处初始化），"No other writer exists"，也没有 `set-status` 命令。自定义状态要靠 `task.json.hooks.after_*` 或 `config.yaml` 的 hook，在 `after_create / after_start / after_finish / after_archive` 这四个固定事件之一顺带写入（`workflow-state-contract.md:251-290, 318-329`）。
5. **粗粒度 phase 投影是硬编码的。** `planning→plan`、`in_progress→implement`、`review→review`、`completed|done→completed`，其余一律 `unknown`（`packages/core/src/task/phase.ts:21-40`）。它只用于渲染，不影响注入。
6. **恢复路由是文件里的表格，不是代码。** `/trellis:continue` 命令按 status + 产物存在性列出续做步骤；官方 customize 文档明确要求"加自定义状态时同时补 workflow.md 状态块和这张表"（`templates/common/commands/continue.md:25-34`、`customize-local/change-workflow.md`）。
7. **整份流程可以换模板。** `trellis workflow --template native|<marketplace-id>` 替换整份 `workflow.md`；`native` 内置，其余从 marketplace 索引拉取。带 `.template-hashes.json` 追踪与手改保护：`native` 保留哈希条目，非 native 移除条目，手改文件会提示或需 `--force` / `--create-new`（`utils/workflow-resolver.ts:1-20, 40, 90-108`、`commands/workflow.ts:1-20`）。
8. **`config.yaml` 里没有流程开关。** 只有 journal、生命周期 hook、monorepo packages、channel worker 上限、Codex 派发模式、子 Agent 上下文限额、逐轮注入 skip 词（`.trellis/config.yaml:7-166`）。

**对"Trellis 是否支持可配置流程"的回答：分层地支持。** 叙事与提示层是纯数据，且官方把改这份文件当作正规用法；状态集合、状态写入时机、生命周期事件、phase 投影属于代码；恢复路由属于"要手改的文件内容"。它没有做到"项目能自定义状态机"，但做到了"项目能自定义每一步说什么、什么时候说什么"。

## 1. 流程定义在哪些载体上

| 载体 | 内容 | 谁读它 |
| --- | --- | --- |
| `.trellis/workflow.md` → `## Phase Index`（模板 `:147`） | 三段摘要、请求分流、规划产物要求、父子任务、规则、Active Task Routing、Guardrails | SessionStart hook 注入；`get_phase_index()` 单独抽取 |
| `.trellis/workflow.md` → `## Phase 1/2/3` 下 `#### X.Y`（`:319, 480, 578`） | 每个步骤的详细操作指引 | `get_context.py --mode phase --step X.Y` 按需抽取 |
| `.trellis/workflow.md` → `[workflow-state:STATUS]` 块（`:179-272`） | 每轮注入的短提示 | `inject-workflow-state.py` / `.js` 按 status 查表 |
| `.trellis/workflow.md` → 平台标记 `[Claude Code, Cursor, …]` | 同一文档的平台差异段 | `filter_platform()` 按当前平台裁剪 |
| `.trellis/scripts/*` | 解析器、任务命令、hook | CLI 与平台 hook |
| `.trellis/config.yaml` | hook 命令、journal、packages、channel、注入限额 | 各脚本读取 |
| `.trellis/agents/*.md` | 子 Agent / channel 角色定义（`architect, check, implement, plan, research`） | channel spawn、`getAllAgents()` 回填 |
| `.trellis/spec/cli/backend/workflow-state-contract.md` | 运行时契约：解析正则、写入者表、可达矩阵 | 维护者文档，非运行时 |

## 2. 逐层可配置性

| 层 | 载体 | 可配置 | 依据 |
| --- | --- | --- | --- |
| 阶段名与顺序 | `workflow.md` 的 Phase Index 与三段标题 | ✅ 改文件即生效 | `workflow.md:147-160, 662-679` |
| 步骤清单与每步内容 | `#### X.Y` 小节 | ✅ 按编号解析，编号即接口 | `workflow_phase.py:32-38, 100` |
| 每轮提示文本 | `[workflow-state:STATUS]` 块 | ✅ 纯文本，改完重启会话即可 | `workflow.md:681-683` |
| 平台差异 | `[平台名…]` 包裹块 | ✅ 但要同步各平台入口文件 | `change-workflow.md` 修改步骤 3 |
| 整份流程模板 | `trellis workflow --template` | ✅ 内置 native + marketplace | `commands/workflow.ts:1-20`、`utils/workflow-resolver.ts:1-20, 40, 90-108` |
| 任务状态取值 | `task.json.status` | ⚠️ 数据上自由，语义上封闭（写入者只有 7 处） | `schema.ts:18`、`workflow-state-contract.md:251-269` |
| 状态写入时机 | 4 个生命周期钩子 | ⚠️ 只能在这 4 个事件写入自定义值 | `workflow.md:700-714`、`workflow-state-contract.md:273-283` |
| 粗粒度 phase 投影 | `phase.ts` | ❌ 硬编码映射，未知值 → `unknown` | `packages/core/src/task/phase.ts:21-40` |
| 恢复路由 | `continue` 命令里的表 | ⚠️ 数据在文件里，但每个平台一份，要手改 | `continue.md:25-34` |
| 生命周期事件集 | `after_create/start/finish/archive` | ❌ 固定四个 | `workflow-state-contract.md:273-283` |
| `config.yaml` 开关 | 见上文 8 | ✅ 但都不含流程结构 | `.trellis/config.yaml` |

## 3. 三个"看起来是配置、实际不生效"的坑

1. **加了状态块但没有写入者 → 死块。** 契约文档写得很直白：没有 hook 写 `status`，该标签永远不会被读到，因为没有任务会带那个状态（`workflow-state-contract.md:322-325`）。而且 hook 只能挂在四个固定事件上，想在"人为判断需要返工时"随时切到 `in-review` 没有入口。
2. **加了自定义状态但没改恢复路由 → 掉默认分支。** `/trellis:continue` 的表格是逐条 if/else 文本，官方文档明说"没有路由条目时会落到默认分支，用户不会落到你想要的步骤"（`customize-local/change-workflow.md`）。
3. **`inferTaskPhase` 不认识新状态。** 任何 TS 侧渲染 phase 的地方拿到 `unknown`；自定义状态要在两套表示（文档表格 + 代码投影）里各维护一次。

这三点的共同结构是：Trellis 把"说什么"做成了数据，把"什么时候说、说了算不算"留在了代码与固定表里。可配置性换来的是**多处表示需要手工同步**，而它用一份契约文档（`workflow-state-contract.md`）加可达矩阵来管理这个同步成本。

## 4. 与 Knit 对照

| 维度 | Trellis 0.6.17 | Knit 当前工作区 |
| --- | --- | --- |
| 阶段集合 | 文档三段 + status 映射，两个地方各写一次 | 枚举，`TaskPhaseSchema`（`src/contracts/task-inputs.ts:17-22`）与 `TaskPhase`（`src/domain/task.ts:13`） |
| 阶段转移 | 隐式：由命令与 hook 写 status 实现 | 显式：`src/domain/task.ts` 的 `onXxx` 转移函数 |
| 步骤粒度 | 有，`#### X.Y` 按需加载 | 无；只有 plan.md 自由文本 |
| 每轮提示 | 按 status 从文档取块 | 桥接按固定结构注入当前任务与下一步规则 |
| 流程文本可改 | ✅ 官方支持的用法 | ✅ `.knit/workflow.md` 与 `.knit/agents/*` 属 project 所有权，init 只补缺（`src/application/templates.ts:21-27`、`src/application/initialization.ts:181-183`） |
| 改流程的副作用 | `trellis update` 会提示冲突，`--force` 覆盖 | 计入 `inputsDigest`，在途检查立刻 stale（`src/application/context-planner.ts:405-431`） |
| 整份模板切换 | `trellis workflow --template` | 无；project 所有权永远 `keep`，`--force` 只作用于 managed |
| 配置文件形态 | `config.yaml`，注释即文档；无 schema 校验 | `config.json`，顶层封闭校验，未知键报错（`src/application/config.ts:15-64`） |
| 上限类参数 | 分散在 yaml + 代码 | `workflow.maxRepairRounds`、`limits.*` |
| 扩展新阶段 | 叙事层可加；状态层要写 hook + 改路由表 | 要改枚举、转移函数、STATES.md、历史任务兼容 |

两处关键差异值得记住：

- **Knit 把流程文本当成需求身份的一部分。** `context-planner` 把 workflow、角色、运行指令都计入 `countsTowardInputs`，注释写明"工作流、角色、运行指令变化同样使旧凭据过期"。所以 Knit 里"改流程说明"不是纯提示词调整，它会让已有检查失效。Trellis 没有这个耦合，代价是它也无法用摘要证明"检查时用的流程和现在一致"。
- **Trellis 的可配置性依赖"多处表示 + 一份契约文档"来维持一致**；Knit 依赖"枚举 + 转移函数"在代码里保证一致。前者灵活但容易漂，后者死板但可静态核对。

## 5. 方法与限制

- 取证方式：在干净检出的 `f089cb3` 上读取文件并记录 `path:line`；对全部被引用文件记录全文 sha256（见 [sources.md](sources.md)）。
- 未执行：`trellis init` / `update` / `workflow --template` 的实际行为，hook 的真实注入效果，自定义状态端到端是否真能跑通。这些是按代码与契约文档推断的，不是运行验证。
- 固定提交的 `.trellis/` 是 Trellis 仓库自己 dogfood 的副本，可能与 `packages/cli/src/templates/trellis/` 模板有版本差；涉及用户侧行为时以模板为准，本报告已按此选择引用。
- Trellis 版本迭代快（0.6.17 已引入 `trellis workflow` 模板切换），更早版本的能力边界不作推断。

## 文件导航

- [knit-options.md](knit-options.md)：Knit 侧的五个选项、影响面、兼容处理与建议（待确认）。
- [sources.md](sources.md)：固定提交、版本、文件摘要、行号与 URL。
