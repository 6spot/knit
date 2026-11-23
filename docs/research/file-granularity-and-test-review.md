# 项目文件拆分粒度、测试效率与过度拆分根因梳理报告

> **采集基准**：提交 `bf0108a`（`knit/11-23-review-file-granularity`），macOS（darwin arm64），Node.js `v26.13.1`。
> **范围声明**：本报告仅作深度盘点、实测诊断、根因溯源与收敛方案设计，未修改任何现有源码、测试、规范或配置。

---

## 1. 现状盘点总览

### 1.1 代码与测试规模（精确统计）

在当前基线 `bf0108a` 上核实（任务说明中的 77 文件 / 8,738 行与 12,667 行对应主检出另一状态，以下均以当前 Worktree 实测为准）：

| 区域 | 文件数 | 总行数 | `< 50` 行文件数（占比） | `< 100` 行文件数（占比） | 说明 |
| --- | ---: | ---: | ---: | ---: | --- |
| `src/contracts/` | 7 | 427 | 5（71.4%） | 6（85.7%） | 除 `workflow.ts`（227 行）外均 ≤ 55 行 |
| `src/infrastructure/` | 6 | 545 | 2（33.3%） | 5（83.3%） | 仅 `process.ts`（222 行）超 100 行 |
| `src/domain/` | 11 | 1,597 | 3（27.3%） | 8（72.7%） | `workflow.ts` 占 731 行，其余 10 文件均值为 86.6 行 |
| `src/application/` | 24 | 2,896 | 3（12.5%） | 11（45.8%） | 9 个 `run-*` 文件、3 个 `task-*`、2 个 15–17 行 store |
| `src/cli/` | 10 | 771 | 5（50.0%） | 7（70.0%） | `root.ts` 8 行、`worktree.ts` 29 行，4 个命令文件 32–36 行 |
| `src/adapters/` | 18 | 2,328 | 5（27.8%） | 11（61.1%） | 含 1 个 C 源码（67 行）与多个 6–18 行薄入口/空壳 barrel |
| **`src/` 合计** | **76** | **8,564** | **23（30.3%）** | **48（63.2%）** | 含 75 个 `.ts` + 1 个 `.c` |
| `test/*.test.mjs` | 68 | 11,912 | 3（4.4%） | 21（30.9%） | 静态 `test()` 412 处，动态展开 **583 个用例** |
| `test/helpers/*.mjs` | 9 | 660 | 4（44.4%） | 7（77.8%） | `setup.mjs` 6 行、`deliver.mjs` 20 行、`cli.mjs` 38 行、`git.mjs` 39 行 |
| **`test/` 合计** | **77** | **12,572** | **7（9.1%）** | **28（36.4%）** | 测试代码量约为源码的 1.47 倍 |

### 1.2 核心结论摘要

1. **源码碎片化主要集中在层内**：`src/` 可在**不改变 6 层依赖方向**的前提下，从 **76 个文件收敛至 50 个（-26，降幅 34.2%）**，`< 50` 行文件从 23 个降至 3 个；同时顺手消除 `adapters/antigravity/execution.ts -> application/run-lock.ts` 的反向层级依赖及 `adapters/antigravity/broker.ts -> adapters/pi/session-env.ts` 的跨适配器依赖。
2. **`npm test` 耗时近 2 分钟（实测 `119.52s`，其中 `build` 仅 `1.28s`）的根本原因不是用例多，而是“重型测试错配 + 秒级轮询空等 + CLI 夹具冷启动”**：
   - Top 3 文件（`run-pane.test.mjs` 单跑 93.16s、`work-choice.test.mjs` 单跑 85.63s 且尚有一半用例因沙箱缺 `rg` 提前失败、`deliver-worktree.test.mjs` 单跑 40.15s）主导了全部墙钟时间；而全部 14 个纯单元测试文件（100+ 用例）合计不到 **0.35 秒**。
   - 测试文件可从 **68 个收敛至 29 个（-39，降幅 57.4%；若进一步合并 `task-cancel-worktree` 与 `config` 可达 27 个）**，helper 从 **9 个收敛至 7 个**；通过将纯逻辑回归降级为内存直调、缩短/可配置 `waitRun` 轮询间隔、改造 `readyTask`/`doneTask`/`gitProject` 夹具，预计全量 `npm test` 可从 **~120s 压缩至 ~20–30s（提速 4–5 倍）**。
3. **过度拆分的根源是制度性“单向熵增”**：`.knit/standards/task-splitting.md` 的硬规则“不超过 3 个场景，超过就拆”被实质执行成了“一子任务一新测试文件、一新辅助文件”；`.knit/standards/development.md` 只约束函数粒度而缺失文件与测试粒度规则；`.knit/agents/implement.md` 与 `review.md` 缺少归并要求与慢测试审查把关。

---

## 2. 区分“过细拆分”与“合理边界”的判断原则

结合 `docs/design/DESIGN.md` 的分层意图与 `.knit/standards/development.md` 的复杂度原则（“逻辑留在一个函数里，除非拆出的部分可组合或会被重用”、“不预先提取只用一次的辅助函数”），将函数级准则外推到文件与模块级，确立 6 条可复用准绳：

### 2.1 应该保留独立的“合理边界”（即便行数少）

1. **物理执行入口与加载隔离**：被外部进程直接按文件路径执行的入口（如 `cli/knit.ts`、`adapters/pi/pane-worker.ts` 传给 `pi --extension`、`adapters/antigravity/client.ts` 供 hook/command 转发、`command-processes.c` 独立编译），或用 `await import(...)` 延迟加载以保护常规 CLI 冷启动的宿主模块（如 `adapters/antigravity/host-hook.ts`、`adapters/workbuddy/host-hook.ts`）。
2. **依赖方向防火墙 / 多层共享契约**：被 3 个以上不同层引用、用于切断反向或循环依赖的薄契约/装配点（如 `contracts/workflow.ts`、`contracts/task.ts`、`contracts/agent.ts`、`adapters/agents.ts` 注册表）。
3. **高风险不变量边界**：`task-splitting.md` 点名需要独立审查的核心逻辑（状态推进 `domain/progress.ts`、快照与保护 `application/workspace.ts`、执行结算 `application/run-finish.ts`、交付事务 `application/delivery.ts`），保持清晰可读的独立边界，避免与普通 CRUD 或文案渲染混写。
4. **独立外部协议/技术域**：对接不同外部系统或协议（Pi RPC、Antigravity 沙箱、Rex 窗格、WorkBuddy 钩子、`sh-syntax` AST 解析），独立演化且不互相依赖。

### 2.2 应该合并的“过细拆分”信号

满足以下任意两条即应合并：
1. **单调用方极薄文件（fan-in = 1 且 < 80 行）**：仅被同目录或邻近唯一文件导入，且无独立复用意图或物理入口需求（如 `contracts/frames.ts` 31 行、`infrastructure/directory.ts` 42 行、`domain/stage-rules.ts` 40 行、`application/task-materials.ts` 56 行、`application/run-pane.ts` 66 行）。
2. **空壳重导出（barrel）或单函数转发文件（< 25 行）**：无逻辑增量，仅做 `export *` 或单函数包装（如 `adapters/pi/index.ts` 7 行、`cli/root.ts` 8 行、`application/workflow-store.ts` 15 行、`application/standards-store.ts` 17 行、`adapters/antigravity/pane.ts` 6 行、`adapters/pi/session-env.ts` 7 行）。
3. **同主题强耦合碎块**：多个 30–100 行文件围绕同一聚合根或同一条连续生命周期拆分，彼此频繁互导内部类型或常量，合并后仍保持在 **150–350 行** 的舒适阅读区间（如 `task-document`/`task-record`/`task-references`、`run-execute`/`run-pane`/`run-session`、`session-context`/`session-output`、`cli/init`/`standards`/`context`/`workflow`）。
4. **跨层错位导致反向或横向污染**：如 `application/run-lock.ts` 被 `adapters/antigravity/execution.ts` 反向导入、`adapters/pi/session-env.ts` 被 `adapters/antigravity/broker.ts` 跨适配器导入——归位到 `infrastructure/` 既消碎片又修分层。

---

## 3. `src/` 全量 6 层诊断与收敛方案

以下清单覆盖 `src/` 全部 **76 个文件**，明确每个文件的去留、目标与不能丢弃的不变量。

### 3.1 `src/contracts/`（7 文件 427 行 → 4 文件，-3）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `contracts/pane.ts`（15 / in:3） | **合并** | `contracts/agent.ts` | 仅定义 `PaneOptions`/`PaneHost`，与 `AgentAdapter.paneCommand` 共属执行适配器端口；合并后 `agent.ts` 仅 63 行，仅需改 3 处导入。 |
| `contracts/digest.ts`（15 / in:5） | **合并** | `contracts/primitives.ts`（与 `schema.ts` 合并） | 二者皆为跨层共享的零业务依赖纯工具（SHA-256 摘要 + pi-schema 校验封装），合并后 51 行；**不变量**：绝不引入 `node:fs` 或反向依赖 `infrastructure/`。 |
| `contracts/schema.ts`（36 / in:5） | **合并** | `contracts/primitives.ts` | 同上。 |
| `contracts/frames.ts`（31 / in:1） | **迁回合并** | `adapters/pi/connection.ts` | 唯一调用方是 `adapters/pi/connection.ts`，并非跨层契约；迁回后保持 `LfFrameDecoder` 的增量 UTF-8 流解码与仅按 `\n` 切帧行为不变。 |
| `contracts/agent.ts`（48 / in:12） | **保留并吸收 `pane.ts`** | `contracts/agent.ts`（~63 行） | 12 处跨层引用，切断 `application` 与 `adapters` 双向依赖的核心端口契约。 |
| `contracts/task.ts`（55 / in:13） | **保留独立** | — | 13 处跨层引用，定义 `TaskFrontmatterSchema`/`TaskRunSchema`/`TaskRecordSchema` 持久化契约。 |
| `contracts/workflow.ts`（227 / in:19） | **保留独立** | — | 19 处跨层引用，集中维护工作流 schema 与 `AGENT_SPECS` 单一规格表。 |

### 3.2 `src/infrastructure/`（6 文件 545 行 → 3 文件，-3）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `infrastructure/atomic.ts`（98 / in:9） | **合并** | `infrastructure/fs.ts` | 与 `directory.ts`、`fingerprint.ts`、`errors.ts` 同属本地文件系统基础原语；合并后约 235 行，职责高内聚。**不变量**：保持同目录临时文件 + `fsync` + `rename` + `expectedSha256` 乐观锁。 |
| `infrastructure/directory.ts`（42 / in:1） | **合并** | `infrastructure/fs.ts` | 仅 `application/delivery.ts` 使用；**不变量**：保留 `EXDEV` 跨文件系统复制/补回源与只读子目录清理（`removeCopy`）。 |
| `infrastructure/fingerprint.ts`（79 / in:2） | **合并** | `infrastructure/fs.ts` | 仅 `atomic.ts` 与 `workspace.ts` 使用；**不变量**：保留 `lstatSync` 不追踪符号链接语义及 `FileFacts` 形状。 |
| `infrastructure/errors.ts`（16 / in:2） | **合并** | `infrastructure/fs.ts` | 仅 16 行，仅被 `atomic.ts` 与 `paths.ts` 使用；`paths.ts` 单向导入 `fs.ts` 的 `InfrastructureError` 无循环依赖。 |
| `infrastructure/paths.ts`（88 / in:4） | **保留独立** | — | 路径规范化与 `safeJoin` 防符号链接逃逸边界清晰，保持独立利于安全复核。 |
| `infrastructure/process.ts`（222 / in:14） | **保留独立（并吸收 2 个跨层原语）** | `infrastructure/process.ts`（~250 行） | 14 处引用，进程身份/进程树信号/`gitSync`/`shellQuote`。同时吸收：① `adapters/pi/session-env.ts`（7 行，消除 `antigravity -> pi` 跨适配器引用）；② `application/run-lock.ts` 中通用的 14 行 `withRunLock`（改名 `withFileLock`，消除 `adapters/antigravity/execution.ts -> application/run-lock.ts` 反向依赖！）。 |

### 3.3 `src/domain/`（11 文件 1,597 行 → 6 文件，-5）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `domain/agent-target.ts`（22 / in:2） | **合并** | `domain/workflow.ts` | 仅 22 行，纯粹校验工作流与派发阶段的 `(agent, model, thinking)`，只被 `workflow.ts` 和 `run-prepare.ts` 使用。 |
| `domain/stage-rules.ts`（40 / in:1） | **合并** | `domain/report.ts` | 仅 40 行且仅 `run-prepare.ts` 调用；与 `report.ts`（92 行）同属“环节硬规则与报告字段契约”，合并后 132 行（避免继续扩大 731 行的 `workflow.ts`）。**不变量**：`stageRules` 受保护路径列表必须与 `workspace.ts:protectedChanges` 保持一致。 |
| `domain/task-document.ts`（97 / in:8） | **合并** | `domain/task.ts` | `task-document`（97）+ `task-record`（51）+ `task-references`（39）+ `markdown`（56）全部围绕任务文档纯文本解析与渲染，合计 243 行，清晰紧凑。 |
| `domain/task-record.ts`（51 / in:1） | **合并** | `domain/task.ts` | 仅被 `task-store.ts` 引用，与 `task-document.ts` 共同构成任务双文件编解码。 |
| `domain/task-references.ts`（39 / in:2） | **合并** | `domain/task.ts` | 仅 39 行，解析 `task.md` 的 `## 相关资料` 小节。 |
| `domain/markdown.ts`（56 / in:3） | **合并（或可选保留）** | `domain/task.ts` | 当前仅用于 `task-document`、`task-references` 与 `handoff`/`task-materials`（取 `#标题` 章节），合并后不产生外部依赖；若未来扩展通用 Markdown 工具可再拆出。 |
| `domain/task-requirements.ts`（278 / in:2） | **保留独立** | — | 278 行，独立实现 Requirement/Scenario 与 `[blocking]`/`[assumed]` 语法校验，体量与职责恰当。 |
| `domain/progress.ts`（126 / in:5） | **保留独立** | — | 核心流程推进、并行批次汇合（Join）、`maxVisits` 返工上限计算，高风险独立审查单元。 |
| `domain/report.ts`（92 / in:3） | **保留并吸收 `stage-rules.ts`** | `domain/report.ts`（~132 行） | 报告 JSON 代码块解析、字段校验与补报文案，与 `stage-rules` 互为输出/校验闭环。 |
| `domain/standards.ts`（65 / in:5） | **保留独立** | — | 纯领域解析 `parseStandard` 与 `standardsForStage`，5 处引用，与文件系统加载解耦。 |
| `domain/workflow.ts`（731 / in:10） | **保留并吸收 `agent-target.ts`** | `domain/workflow.ts`（~753 行） | YAML AST 行号诊断与回退环校验核心；行数偏大（731 行），后续只宜按需做内部函数整理，不额外拆零碎导出文件。 |

### 3.4 `src/application/`（24 文件 2,896 行 → 16 文件，-8）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `application/config.ts`（57 / in:4） | **合并** | `application/project-config.ts`（或沿用 `config.ts`） | 与 `standards-store.ts`（17）、`workflow-store.ts`（15）同为 `.knit/` 下只读项目配置加载，合计仅 89 行。 |
| `application/standards-store.ts`（17 / in:4） | **合并** | `application/project-config.ts` | 仅 17 行；保留按路径排序递归扫描 `.knit/standards/**/*.md` 的行为。 |
| `application/workflow-store.ts`（15 / in:3） | **合并** | `application/project-config.ts` | 仅 15 行；保留缺文件提示 `knit init` 的错误文案。 |
| `application/task-materials.ts`（56 / in:1） | **合并** | `application/handoff.ts` | 唯一调用方是 `handoff.ts`；合并后 249 行。**不变量**：仓库资料读 Worktree、`.knit/tasks/` 下资料读主检出并给绝对路径。 |
| `application/run-pane.ts`（66 / in:1） | **合并** | `application/run-execute.ts` | 仅被 `run-execute.ts` 调用，与 `run-session.ts`（100）共属单次执行运行时外壳；三者合并为 **235 行**，消除三文件间互导 `PANE_FILE`/`PANE_OUTCOME_FILE`/`SESSION_FILE_LOCATOR`。 |
| `application/run-session.ts`（100 / in:8） | **合并** | `application/run-execute.ts` | 同上。**不变量**：保留窗格先发布 `outcome.json` 再退出、仅补报一次、续聊先写 `session-file.txt`。 |
| `application/run-execute.ts`（69 / in:1） | **保留并吸收 `run-pane` + `run-session`** | `application/run-execute.ts`（~235 行） | 统一执行运行时主流程（窗格优先、失败回退后台、续聊回退全量交接）。 |
| `application/run-process.ts`（89 / in:5） | **合并** | `application/run-control.ts` | 与 `run-control.ts`（115）同属执行进程控制（启动/等待/取消/进程探活/停进程树），合并后 ~222 行。 |
| `application/run-lock.ts`（32 / in:5） | **拆分合并** | 通用 `withFileLock` → `infrastructure/process.ts`；任务锁薄封装（14 行）→ `application/run-control.ts` | 彻底消除 `adapters/antigravity/execution.ts` 反向依赖 `application/`，同时消灭 32 行独立文件。 |
| `application/run-control.ts`（115 / in:1） | **保留并吸收 `run-process` + 任务锁** | `application/run-control.ts`（~222 行） | 集中管理 `startRun`/`waitRun`/`cancelRun` 及进程生命周期控制。 |
| `application/session-output.ts`（80 / in:3） | **合并** | `application/session-context.ts` | `session-context.ts`（60）与 `session-output.ts`（80）互为数据构造与文案渲染，合并后 140 行，消除双向类型耦合。 |
| `application/session-context.ts`（60 / in:4） | **保留并吸收 `session-output.ts`** | `application/session-context.ts`（~140 行） | 保持任务状态不变时输出逐字不变的不变量。 |
| `application/run-prepare.ts`（293 / in:7） | **保留独立** | — | 派发前置校验、依赖分支检查、交接落盘、setup 命令与 Worktree 回滚，体量与职责完整。 |
| `application/run-finish.ts`（122 / in:2） | **保留独立** | — | 结算快照对比、HEAD 篡改检测、受保护文件检测、乐观锁重试与批锁，高风险独立审查边界。 |
| `application/handoff.ts`（193 / in:3） | **保留并吸收 `task-materials.ts`** | `application/handoff.ts`（~249 行） | 完整交接与增量续聊拼装、字节预算裁剪。 |
| `application/delivery.ts`（284 / in:1） | **保留独立** | — | 交付预览、事务归档、Worktree 分支提交与失败撤回，高风险独立审查边界。 |
| `application/task-store.ts`（278 / in:11） | **保留独立** | — | 任务扫描、活跃优先+Worktree 归档查找、冲突检测保存与目录名分配。 |
| `application/task-lifecycle.ts`（109 / in:1） | **保留独立** | — | `ready`/`close`/`cancel` 业务用例；与 11 处引用的 `task-store.ts` 分离，避免执行层间接拉入生命周期校验。 |
| `application/worktree.ts`（119 / in:8） | **保留独立** | — | Worktree 确定性路径算法、建删、回滚、自动合并与取消清理，8 处引用。 |
| `application/workspace.ts`（77 / in:3） | **保留独立** | — | Git 工作区快照、差异计算与受保护路径检查，高风险独立审查边界。 |
| `application/init.ts`（140 / in:1） | **保留独立** | — | 模板初始化、宿主检测、`--force` 备份恢复、引导任务生成。 |
| `application/host-hook.ts`（132 / in:4） | **保留独立** | — | 多宿主零 MCP 会话状态持久化和工具前核对入口。 |
| `application/host-command.ts`（198 / in:3） | **保留独立** | — | 基于 `sh-syntax` AST 的 shell 命令静态解析、环境改写与交付原话提取（重依赖动态导入隔离）。 |
| `application/work-choice.ts`（195 / in:3） | **保留独立** | — | 从对话转录判定范围扩大、委派条件与建任务选择。 |

### 3.5 `src/cli/`（10 文件 771 行 → 6 文件，-4）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `cli/root.ts`（8 / in:4） | **合并** | `cli/shared.ts` | 仅 8 行；与 `cli/worktree.ts`（29 行）及当前散落在 `cli/task.ts` 中被 `context`/`deliver`/`run` 跨引用的 `fail`/`knitRoot`/`loadTask`/`shownStatus` 合为 `cli/shared.ts`（~70 行），理顺 CLI 内部依赖。 |
| `cli/worktree.ts`（29 / in:2） | **合并** | `cli/shared.ts` | 仅 29 行，纯 Worktree 清理/合并文案格式化，被 `cli/deliver.ts` 与 `cli/task.ts` 共用。 |
| `cli/init.ts`（32 / in:1） | **合并** | `cli/project.ts` | `init`（32）+ `context`（33）+ `standards`（36）+ `workflow`（79）均为轻量项目级命令，合计 180 行。 |
| `cli/context.ts`（33 / in:1） | **合并** | `cli/project.ts` | 同上。 |
| `cli/standards.ts`（36 / in:1） | **合并** | `cli/project.ts` | 同上。 |
| `cli/workflow.ts`（79 / in:3） | **合并** | `cli/project.ts` | 同上（同时保留导出的 `loadWorkflow` 供 `run.ts` 使用，或移至 `cli/shared.ts`）。 |
| `cli/knit.ts`（52 / in:0） | **保留独立** | — | `package.json` `bin.knit` 入口，负责 EPIPE 处理、子命令注册与 `hook` 动态路由。 |
| `cli/task.ts`（235 / in:4） | **保留独立（迁出公共函数后 ~195 行）** | — | `task` 下 6 个子命令的选项绑定与展示渲染。 |
| `cli/run.ts`（158 / in:1） | **保留独立** | — | `run` 下 5 个子命令与执行器/Rex 宿主装配入口。 |
| `cli/deliver.ts`（109 / in:1） | **保留独立** | — | 交付预览与交付结果展示渲染。 |

### 3.6 `src/adapters/`（18 文件 2,328 行 → 15 文件，-3）

| 源文件（行数 / 被引用数） | 处理建议 | 合并目标 | 理由与不变量 |
| --- | --- | --- | --- |
| `adapters/pi/index.ts`（7 / in:0） | **删除** | 直接导入具体模块 | 源码零引用，仅 `test/pi-runtime.test.mjs` 一处引用；属于无增量价值的空壳 barrel。 |
| `adapters/pi/session-env.ts`（7 / in:2） | **迁出合并** | `infrastructure/process.ts` | 仅 7 行，同时被 `pi/runtime.ts` 与 `antigravity/broker.ts` 使用；移入 `infrastructure/process.ts` 消除 `antigravity -> pi` 跨适配器耦合。 |
| `adapters/antigravity/pane.ts`（6 / in:0） | **合并** | `adapters/antigravity/client.ts` | 仅 6 行，与 `client.ts`（30 行）同为 `node <script> <kind>` 拉起的子进程薄入口；合并为统一入口 `client.ts`（~38 行，支持 `hook`/`command`/`pane` 三种 `kind`），注意 `pane` 分支按需动态导入 `./execution.js` 以免 `hook`/`command` 短进程多加载重模块。 |
| `adapters/agents.ts`（18 / in:1） | **保留独立** | — | **合理极薄边界示例**：全仓库唯一执行器注册表装配点，与 `DESIGN.md` 第 7 节对应。 |
| `adapters/rex/pane.ts`（69 / in:1） | **保留独立** | — | 独立终端宿主 Rex 协议实现（`PaneHost`）。 |
| `adapters/workbuddy/host-hook.ts`（97 / in:0） | **保留独立** | — | 独立桌面主会话宿主适配，由 `cli/knit.ts` 动态导入。 |
| `adapters/antigravity/host-hook.ts`（63 / in:0） | **保留独立** | — | 独立主会话钩子适配，由 `cli/knit.ts` 动态导入，与执行器隔离路径解耦。 |
| `adapters/antigravity/protocol.ts`（51 / in:4） | **保留独立** | — | 轻量的无 IO 协议工具，被 `host-hook`、`client`、`broker`、`execution` 4 处共用；若并入 `execution.ts` 会导致主会话热路径 `host-hook` 拉入重型沙箱与 broker 代码。 |
| `adapters/antigravity/broker.ts`（203 / in:1） | **保留独立** | — | Unix socket 本地命令/钩子代理。 |
| `adapters/antigravity/execution.ts`（326 / in:2） | **保留独立** | — | AGY 流式/窗格会话与共享钩子安装清理。 |
| `adapters/antigravity/isolation.ts`（289 / in:3） | **保留独立** | — | macOS `sandbox-exec` 策略生成、预检与命令进程回收。 |
| `adapters/antigravity/command-processes.c`（67 / in:0） | **保留独立** | — | 物理约束：macOS 独立编译为原生进程跟踪器二进制。 |
| `adapters/pi/connection.ts`（320 / in:2） | **保留并吸收 `contracts/frames.ts`** | `adapters/pi/connection.ts`（~351 行） | Pi RPC 子进程连接、请求-响应关联与帧切分。 |
| `adapters/pi/runtime.ts`（421 / in:2） | **保留独立** | — | Pi 运行时启动参数、能力开关映射与会话驱动。 |
| `adapters/pi/execution.ts`（110 / in:2） | **保留独立** | — | 实现 `AgentAdapter`/`AgentSession` 端口，与 421 行 `runtime.ts` 分离保持单文件适度规模。 |
| `adapters/pi/native-file.ts`（165 / in:4） | **保留独立** | — | Pi 原生 JSONL 会话核验与系统提示恢复。 |
| `adapters/pi/pane-worker.ts`（79 / in:0） | **保留独立** | — | 物理约束：必须作为独立模块路径传给 `pi --extension`。 |

### 3.7 源码收敛汇总

| 层级 | 现行文件数 | 收敛后文件数 | 净减少 | 主要收益 |
| --- | ---: | ---: | ---: | --- |
| `contracts` | 7 | 4 | -3 | 清除单调用方 `frames.ts`，合并极薄端口与基础原语 |
| `infrastructure` | 6 | 3 | -3 | 归拢文件系统原语；收编锁与环境工具，消除反向/横向依赖 |
| `domain` | 11 | 6 | -5 | 任务文档编解码收成一体，`agent-target`/`stage-rules` 归位 |
| `application` | 24 | 16 | -8 | `run-*` 9→4、只读配置 3→1、会话上下文 2→1、`task-materials` 归位 |
| `cli` | 10 | 6 | -4 | 消除 `root.ts` 8 行文件与跨命令引用 `task.ts`，聚合 4 个轻命令 |
| `adapters` | 18 | 15 | -3 | 删除零引用 barrel、合并 6 行 `pane.ts`、迁出跨适配器 `session-env.ts` |
| **合计** | **76** | **50** | **-26（-34.2%）** | **`< 50` 行文件 23 → 3；消除 2 处分层违例** |

---

## 4. 顶层目录结构评估（含 `contracts/`）

默认推荐**保留现有 6 层顶层目录**并优先做层内收敛，但有必要单独客观评估较薄的 `contracts/`（收敛后 4 文件 / 396 行）是否值得并入 `domain/`（6 层 → 5 层）：

| 维度 | 方案 A：保留 `contracts/`，仅做层内收敛（7→4 文件）**[推荐]** | 方案 B：将 `contracts/` 并入 `domain/`（6 层 → 5 层） |
| --- | --- | --- |
| **依赖方向洁净度** | `infrastructure`、`domain`、`application`、`adapters`、`cli` 全部单向依赖 `contracts`，零循环风险。 | `infrastructure/fs.ts` 不能反向依赖 `domain/`，需在 `infrastructure/` 另保留一份 `sha256`（或允许 `domain` 依赖 `infrastructure`，破坏纯领域边界）。 |
| **代码阅读体验** | `contracts/` 仅剩 4 个高信号文件（`workflow.ts`、`task.ts`、`agent.ts`、`primitives.ts`），打开即见全部持久化 Schema、外部端口与纯基础原语。 | 消除 `contracts/workflow.ts` + `domain/workflow.ts`、`contracts/task.ts` + `domain/task.ts` 的双文件对照跳转。 |
| **迁移代价** | 低：仅改被合并的 4 个极薄文件的少量导入（约 10–15 处）。 | 中高：需批量改写 `contracts/workflow.ts`（19 处）、`contracts/task.ts`（13 处）、`contracts/agent.ts`（12 处）合计 **50+ 处源码导入与 10+ 处测试导入**，且需同步更新 `docs/design/DESIGN.md` 第 7 节中对 `src/contracts/agent.ts` 的点名引用。 |
| **演进弹性** | 未来若新增第三套执行器或第三套宿主，端口契约位置明确。 | 端口接口与纯业务规则混放，易回退到旧架构耦合。 |

**建议**：当前阶段采用 **方案 A**（保留 6 层顶层目录，完成 `contracts/` 层内 7→4 收敛）。其他 5 层（`cli`、`application`、`domain`、`adapters`、`infrastructure`）职责与依赖方向清晰，**不建议合并顶层目录**。

---

## 5. 测试碎片化、冗余度与耗时瓶颈诊断

### 5.1 实测采集命令、环境与基线数据

#### 采集命令与全量耗时

1. **单独构建耗时**：
   ```sh
   /usr/bin/time -p npm run build
   ```
   实测：**`real 1.28s`**（`user 1.95s`、`sys 0.19s`）。构建不是瓶颈。

2. **全量 `npm test` 耗时**：
   ```sh
   npm run build && /usr/bin/time -p node --test "test/*.test.mjs"
   ```
   实测：**`real 119.52s`**（`user 360.78s`、`sys 110.62s`）。

3. **全量单文件与单用例耗时分布（JUnit 报告精确采集）**：
   ```sh
   node --test --test-reporter=junit "test/*.test.mjs"
   ```
   实测总墙钟：**`123.81s`**，共 **583 个用例**（68 个文件）。

4. **关键子进程冷启动基线（单次空载实测）**：
   - `node dist/cli/knit.js --version`：**`139.4ms`**（多进程并行争抢 CPU 时膨胀至 250–400ms）
   - `import("sh-syntax").then(m => m.parse("echo hi"))`：**`149.3ms`**
   - `git --version`：**`10.7ms`**

5. **代表性慢文件单跑（无多文件并行争抢）墙钟耗时**：
   ```sh
   node --test --test-reporter=tap <file>
   ```
   - `test/run-pane.test.mjs`：**`93.16s`**（27 用例）
   - `test/work-choice.test.mjs`：**`85.63s`**（84 用例，见下方沙箱说明）
   - `test/deliver-worktree.test.mjs`：**`40.15s`**（28 实跑 + 7 跳过 = 35 用例）
   - `test/antigravity.test.mjs`：**`5.53s`**（沙箱下 63/64 失败，仅为严重低估值，见下）
   - `test/cli.test.mjs`：**`0.72s`**（2 用例）

> **沙箱采集环境透明说明**：本轮实测在 Antigravity 执行者沙箱内运行，68 个测试文件中有 62 个全部通过（463 pass + 7 skip），另有 6 个文件受沙箱环境限制出现预期外失败，不影响瓶颈定位但需如实标注：
> 1. `test/antigravity.test.mjs`（63/64 失败）：第 45 行硬编码 `mkdtempSync("/private/tmp/knit-test-agy-")` 而非 `os.tmpdir()`，沙箱拒绝写 `/private/tmp`，且不支持嵌套 `sandbox-exec`。其在并行表中显示的 `11.84s`（单跑 `5.53s`）为**严重低估值**；在宿主机未沙箱环境下（64 条真实 `sandbox-exec` + fake-agy + fake-rex 用例全跑）属于主要慢测试之一，具体耗时待宿主机补测。
> 2. `test/work-choice.test.mjs`（42/84 失败）：沙箱 `/bin/sh` 环境下未安装 `rg`，42 条依赖 `rg -l` 的用例提前中止——**即便一半用例提前失败，它仍耗去 `88.14s`（并行表第 1 名）**；宿主机全量跑通时只会更慢。
> 3. `test/process.test.mjs`（4/7）、`test/run-cancel.test.mjs`（2/5）、`test/run-pane.test.mjs`（1/27）、`test/run-start.test.mjs`（1/19）：因 macOS 沙箱禁止执行 setuid `/bin/ps` 与 `pgrep` 失败（与提交 `8098b4d` 记录的限制一致）。

### 5.2 慢测试排名（全量并行采集）

#### Top 20 最慢测试文件（按文件内用例耗时之和排序）

| 排名 | 测试文件 | 用例总耗时 | 用例数 | `knit()` CLI 次 | `git*()` 次 | 主要耗时特征 |
| ---: | --- | ---: | ---: | ---: | ---: | --- |
| 1 | `test/work-choice.test.mjs` | **88.14s**（单跑 85.63s，仅半数跑完） | 84 | 5（+ 每次 `h.call` 启 hook 子进程） | 2 | 3 宿主 × 28 场景全走 `/bin/sh` + `knit hook` + `sh-syntax` 冷启动 |
| 2 | `test/run-pane.test.mjs` | **86.93s**（单跑 93.16s） | 27 | 13（+ `rex.knit` 数十次） | 15 | 10 种 resume 模式 × 3 轮 E2E（每轮 `run start` + `run wait` 1s 轮询） |
| 3 | `test/deliver-worktree.test.mjs` | **57.13s**（单跑 40.15s） | 35（7 skip） | 18（+ 每次 `completed()` 3 次 CLI） | **125** | 28 次 `completed()` × (10+ git + 4–5 CLI 子进程) |
| 4 | `test/run-start.test.mjs` | **31.06s** | 19 | 18 | 13 | 反复完整启动后台 worker + fake-pi + setup node 子进程 |
| 5 | `test/bridge-notice.test.mjs` | **26.78s** | 5 | 4 | 2 | 5 个用例均走 `loadBridge` + 后台 worker + `run wait` 1s 轮询 |
| 6 | `test/run-worktree.test.mjs` | **22.76s** | 21 | 11 | 38 | 21 次 `runProject` + `readyTask` CLI + `git worktree` |
| 7 | `test/run-dependencies.test.mjs` | **20.96s** | 10 | 6 | 24 | 反复构建多任务 + 交付 + 分支合并夹具 |
| 8 | `test/run-wait.test.mjs` | **19.32s** | 8 | 13 | 8 | 多处真实 `sleep(1000)` / `sleep(1500)` + 轮询等待 |
| 9 | `test/bridge-run.test.mjs` | **18.00s** | 8 | 3 | 2 | `loadBridge`（含 `knit init --pi`）+ 后台执行 |
| 10 | `test/task-cancel-worktree.test.mjs` | **16.21s** | 9 | 9 | 33 | 9 次 `runProject` + `readyTask` CLI + worktree 建删 |
| 11 | `test/context.test.mjs` | **15.97s** | 7 | **22** | 3 | 纯读接口却调用 22 次 CLI 子进程 |
| 12 | `test/host-hook.test.mjs` | **13.93s** | 4 | 4 | 0 | 反复通过 CLI 跑 `knit hook agy` 加载 `sh-syntax` |
| 13 | `test/workbuddy-host-hook.test.mjs` | **13.27s** | 4 | 5 | 0 | 反复通过 `/bin/sh` 跑 `.workbuddy/knit-hook.sh` |
| 14 | `test/antigravity.test.mjs` | **11.84s***（沙箱低估） | 64 | 13 | 23 | 宿主机实跑为 64 条真实 `sandbox-exec` + fake-agy E2E |
| 15 | `test/run-cancel.test.mjs` | **10.82s** | 5 | 6 | 5 | 含 1 个故意忽略 `SIGTERM` 触发 5 秒 `SIGKILL` 超时的用例 |
| 16 | `test/handoff-worktree.test.mjs` | **10.76s** | 8 | 1 | 22 | 8 次 `runProject` + `readyTask` CLI + 22 次 git |
| 17 | `test/run-parallel.test.mjs` | **10.49s** | 2 | 7 | 7 | 2 个双任务并行全流程用例各 ~5s |
| 18 | `test/run-execute-edges.test.mjs` | **10.37s** | 5 | 0 | 6 | 5 次 `runProject` + `readyTask` CLI + 多次 fake-pi |
| 19 | `test/deliver-commit.test.mjs` | **10.36s** | 7 | 4 | 34 | 7 次 `gitProject` + `doneTask`（3 CLI）+ 34 git |
| 20 | `test/deliver-preview.test.mjs` | **10.23s** | 5 | 14 | 11 | 只读预览却调用 14 次 CLI |

**鲜明对比——最快的 14 个纯单测文件（合计 115 个用例，总计仅 `0.35s`！）**：
`report.test.mjs`（0.00s）、`task-requirements.test.mjs`（0.00s）、`markdown.test.mjs`（0.00s）、`task-record.test.mjs`（0.00s）、`progress.test.mjs`（0.00s）、`progress-limit.test.mjs`（0.01s）、`task-document.test.mjs`（0.02s）、`standards.test.mjs`（0.03s）、`workflow.test.mjs`（**40 用例仅 0.03s！**）、`templates.test.mjs`（0.03s）、`task-materials.test.mjs`（0.04s）、`config.test.mjs`（14 用例 0.05s）、`infrastructure.test.mjs`（0.14s）。

#### Top 15 最慢单用例（并行实测）

| 耗时 | 测试文件 :: 用例名 | 直接根因 |
| ---: | --- | --- |
| 6.72s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 pane` | 3 轮派发（4 个执行者）+ 3 次 `run wait` 1s 轮询 + fake-rex |
| 6.69s | `host-hook.test.mjs :: 交付只接受本次调用的预览选项或转录中完整的用户原话` | 单用例内连续启动十余次 `knit hook agy`（每次冷加载 `sh-syntax`） |
| 6.60s | `bridge-notice.test.mjs :: 两个任务同时执行，桥接各等一次结束并各发一条通知` | 双任务后台执行 + 两次 `run wait` 1s 轮询 |
| 6.08s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 deleted` | 仅为测“原生会话文件被删时回退”，却跑完整 3 轮 E2E |
| 6.05s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 corrupt` | 仅为测“JSONL 损坏时回退”，却跑完整 3 轮 E2E |
| 5.59s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 rpc` | 同上（3 轮 E2E + 3 次 `run wait`） |
| 5.58s | `workbuddy-host-hook.test.mjs :: 实际事件从启动到每轮提交按会话注入...` | 单用例连续多次通过 `knit-hook.sh` 冷启动 CLI |
| 5.57s | `run-parallel.test.mjs :: 不同任务同时派发，各在自己的 Worktree 结束...` | 双任务 Worktree + 后台 worker + `run wait` |
| 5.57s | `host-hook.test.mjs :: AGY 从 stdin 注入、按会话去重...` | 单用例连续多次冷启动 CLI |
| 5.47s | `workbuddy-host-hook.test.mjs :: Bash 交付只接受转录中完整的用户原话...` | 连续多次冷启动 CLI + `sh-syntax` |
| 5.45s | `bridge-notice.test.mjs :: 同一批审查等最后一名结束才通知...` | 2 轮派发（实现 + 双人审查）+ `run wait` 轮询 |
| 5.43s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 truncated` | 仅为测“JSONL 截断时回退”，却跑完整 3 轮 E2E |
| 5.40s | `work-choice.test.mjs :: workbuddy 原话回放：读、跳过提问的调用、答复和恢复` | 单用例调用 15+ 次 `h.call()`，每次拉起 `/bin/sh` + `knit hook` |
| 5.16s | `run-pane.test.mjs :: 实现经双人审查返工，Pi 会话模式 changed` | 仅为测“需求摘要变更回退”，却跑完整 3 轮 E2E |
| 5.04s | `bridge-notice.test.mjs :: 会话结束之后不再等` | 后台进程 + `run wait` + 取消等待 |

### 5.3 五大耗时根因精准定位

1. **纯内存逻辑被包在跨宿主 E2E 子进程笛卡尔积里（最大单源：`work-choice.test.mjs`，单跑 85.63s+）**：
   - `work-choice.ts`（195 行）除 `searchProjectFiles` 外全是纯字符串/正则状态判定，且与宿主无关。但 `work-choice.test.mjs` 对 `pi`/`agy`/`workbuddy` 三宿主完整重复 **28 组对话组合**（`3 × 28 = 84` 用例），每条用例先 `knit init --<host>`，再对每次工具调用拉起 `/bin/sh -c` → `node dist/cli/knit.js hook <host> PreToolUse` → 冷加载 `sh-syntax`（~149ms）。全文件累计触发**数百次 Node + shell 冷启动**。
2. **并行墙钟长尾锁死在 `run-pane.test.mjs`（单跑 93.16s）与 `waitRun` 固定 1000ms 轮询**：
   - `run-pane.test.mjs` 第 77 行用 `for (const mode of ["rpc", "pane", "deleted", "corrupt", "truncated", "rejected", "fresh", "changed", "legacy", "other-agent"])` 展开 10 条全链路 E2E，每条都走“实现 → 双人并行审查 → 返工实现”共 3 轮派发（4 个后台 worker + 4 个假 Pi + 3 次 `knit run wait`），仅这一个循环就占 **~55 秒**！其中 `deleted`/`corrupt`/`truncated`/`changed`/`legacy`/`other-agent` 6 种回退条件完全由 `inspectNativeSessionFile` + `prepareRun` 决定，根本无需启动 4 个假 Pi。
   - `src/application/run-control.ts:82` 硬编码 `await sleep(Math.min(1000, remaining))`。凡是走 `knit run wait` 的测试（`run-pane`、`bridge-notice`、`run-wait`、`run-parallel`、`run-start`、`antigravity`），即便假执行者 80ms 就做完，也必须空等 1000ms 整轮。
3. **测试夹具本身在疯狂拉起 CLI 和 Git 子进程（`test/helpers/run.mjs`、`deliver.mjs`、`git.mjs`）**：
   - `readyTask()`（`test/helpers/run.mjs:75`）为了建一个已确认任务，竟然调用了 **2 次 `knit(...)` CLI 子进程**（`task new` + `task ready`）；`doneTask()`（`test/helpers/deliver.mjs:7`）再叠加第 **3 次 CLI 子进程**（`task close`）。
   - `runProject()`（`test/helpers/run.mjs:53`）+ `gitIdentity()`（`deliver.mjs:15`）每条用例都要跑 `git init` + `5× git config` + `2× git add` + `2× git commit` = **10 个 Git 子进程**。
   - 结果在 `deliver-worktree.test.mjs` 里，光是 28 次 `completed()` 建夹具就消耗了 **84 次 Node CLI 冷启动 + 280+ 次 Git 子进程**，再叠加用例本身 125 次 `git()` 和 28+ 次 `deliver` CLI，把一个文件推到 **40.15s（并行 57.13s）**。
4. **参数校验与只读命令过度走 CLI 子进程（全套 321 次 `knit()` 调用）**：
   - 典型案例 `test/workflow-thinking.test.mjs`（78 行，5.34s）：对 7 个合法等级 + 8 个非法值 × 2 个路径 = **23 个组合**，每条在调用完 `parseWorkflow()`（0.1ms）后，又起一次完整的 `knit workflow validate` 子进程（200ms+）重复校验完全相同的错误文案！
   - `test/context.test.mjs`（15.97s，22 次 CLI）、`test/task-{new,ready,close,cancel,view}.test.mjs`（合计 25.79s，64 次 CLI）、`test/deliver-preview.test.mjs`（10.23s，14 次 CLI）在 `178eba3` 把业务用例下沉到 `src/application/` 之后，仍停留在历史 CLI 子进程写法。
   - `test/handoff-limits.test.mjs`（1.12s）与 `test/handoff.test.mjs`（0.91s）本是纯应用层单测，却为建夹具调了 `knit(dir, "task", "new", ...)`。
5. **不可压缩但可隔离的真实等待**：
   - `run-cancel.test.mjs` 的 `stubborn` 测试故意等待 `stopProcesses` 的 5000ms `SIGTERM → SIGKILL` 宽限期；`run-wait.test.mjs` 有 `sleep(1500)` 与 `--timeout 1` 真实计时。若允许测试通过参数或环境变量注入更短宽限期（如 200ms，生产默认仍 5000ms），这两处还可再省 ~6 秒。

### 5.4 测试文件收敛与提速改造方案（68 → 29 文件，-39）

#### A. Helper 层收敛与提速改造（`test/helpers/` 9 → 7 文件）

| 现行 Helper（行数） | 改造方案 | 收益与保留不变量 |
| --- | --- | --- |
| `helpers/setup.mjs`（6）+ `helpers/deliver.mjs`（20） | **并入 `helpers/run.mjs`** | 消除 6 行与 20 行碎文件；`doneTask`、`gitIdentity`、`nodeCommand`、`setupConfig` 归于一处。 |
| `helpers/run.mjs`（94）中的 `readyTask`/`doneTask` | **改调应用层函数**（`createTask` + `readyTask` + `closeTask`） | 每次建夹具从 2–3 次 CLI 冷启动（~500–900ms）降至 **< 2ms**；仅保留 `task-lifecycle.test.mjs` 中的 CLI 冒烟覆盖命令行入口。 |
| `helpers/git.mjs`（39）中的 `gitProject`/`runProject` | **每进程缓存只读模板仓库 + `cpSync` 复制** | 模板仓库一次性 `git init` + `maintenance.auto=false` + `gitIdentity` + 初始提交；每个用例直接 `cpSync` 到独立临时目录（~1–2ms，替代 10 次 `git` 子进程），完全保持用例间隔离，不污染当前工作区。 |
| `helpers/cli.mjs`（38）、`bridge.mjs`（63）、`fake-pi.mjs`（180）、`fake-agy.mjs`（154）、`fake-rex.mjs`（66） | **保留独立**（`antigravity.test.mjs` 建议改为 `os.tmpdir()` 以兼容沙箱，不属本任务改动范围） | 三个假客户端协议完整且有独立可执行头，保持独立清晰。 |

#### B. 测试文件按主题合并与降级清单（68 → 29 文件）

| 合并后目标文件（共 29 个） | 吸收的现行测试文件（共 68 个） | 降级 / 精简操作 | 必须保留的核心不变量 |
| --- | --- | --- | --- |
| `test/workflow.test.mjs` | `workflow.test.mjs` + `workflow-model.test.mjs` + `workflow-thinking.test.mjs` | `workflow-model`/`workflow-thinking` 中的全部 27 组解析/行号断言改为纯内存 `parseWorkflow()` 校验；删除重复的 23 次 CLI 子进程调用 | 版本校验、并行只读限制、回退环无限循环检测、Agent 规格模型/思考等级精确行号 |
| `test/workflow-cli.test.mjs` | `workflow-cli.test.mjs` | 保留 `show`/`validate` 正常、报错（含 thinking/model/parallel）、缺文件 4–5 条 CLI 冒烟 | CLI 退出码 0/1、中文展示与标准错误行号输出 |
| `test/task-domain.test.mjs` | `task-document.test.mjs` + `task-record.test.mjs` + `task-requirements.test.mjs` + `markdown.test.mjs` + `task-materials.test.mjs` | 纯合并文件，全为毫秒级单测，零删减 | frontmatter 校验、需求摘要稳定性、围栏内标题忽略、场景/blocking 语法、`resumeId` 向后兼容、Worktree vs 主检出资料路径分流 |
| `test/task-lifecycle.test.mjs` | `task-new.test.mjs` + `task-ready.test.mjs` + `task-close.test.mjs` + `task-cancel.test.mjs` + `task-view.test.mjs` + `task-runs.test.mjs` + `task-show-commit.test.mjs` + `application-use-cases.test.mjs`（任务部分） | `ready`/`close`/`cancel`/`createTask` 的全部业务分支改调应用层函数（毫秒级）；CLI 层仅对 6 个子命令各留 1–2 条参数/输出冒烟；删去 `application-use-cases.test.mjs` 中的重复路径 | `blocking` 拦截、`independent` 必须有场景与审查 pass、运行中禁止 close/cancel、需求改动回退 draft、乐观并发冲突、`Knit-Task` trailer 提交查询 |
| `test/task-cancel-worktree.test.mjs` | 保留独立（或并入 `task-lifecycle.test.mjs`） | 改用 `cpSync` 仓库模板 + 应用层 `cancelTask` 覆盖主要分支，CLI 留 2 条冒烟 | 取消强制删 Worktree 与分支、丢弃文件计数、Git 拒绝时退出码仍 0 且保持已归档 |
| `test/standards.test.mjs` | `standards.test.mjs` + `standards-cli.test.mjs` | 合并文件；保留 `standards list` 对缺声明、坏 YAML、未知环节与缺流程的 CLI 断言 | frontmatter 校验、按路径排序、未知环节标注 |
| `test/handoff.test.mjs` | `handoff.test.mjs` + `handoff-limits.test.mjs` + `handoff-own.test.mjs` | `taskNaming` 改用 `createTask()` 去掉 CLI 启动；`handoff-own` 改用模板仓库 | 角色/规范/需求永不截断、单文件 16KB / 合计 64KB 字节上限、`own-last-report` 仅再次进入时附上、不泄露 `结果` 与 `record.json` |
| `test/handoff-worktree.test.mjs` | 保留独立 | 改用模板仓库 + 应用层夹具 | 仓库资料读 Worktree、未提交资料明确提示、`.knit/tasks/` 读主检出绝对路径 |
| `test/progress.test.mjs` | `progress.test.mjs` + `progress-limit.test.mjs` | 纯合并，0.01s 全量保留 | `onVerdict` 跳转、`self`/`none` 跳过审查、`blocked` 与失败不计进入次数、`maxVisits` 与并行 Join 裁决 |
| `test/run-prepare.test.mjs` | `run-prepare.test.mjs` + `stage-rules.test.mjs` + `run-dependencies.test.mjs` + `run-limit.test.mjs` | 合并并统一用模板仓库 + 应用层 `prepareRun`；`run-limit` 仅留 1 条 CLI 输出检查 | 派发前置校验、依赖未交付/未合并拒绝并给 `git merge` 命令、返工上限四条固定路径、`stageRules` 与受保护路径一致 |
| `test/run-execute.test.mjs` | `run-execute.test.mjs` + `run-execute-edges.test.mjs` + `run-report-retry.test.mjs` + `run-finish.test.mjs` | 合并并用模板仓库；保留全部假 Pi 场景与结算边界 | 4 种 `tools` 参数映射、报告补报且仅补一次、模型错误与重试成功、HEAD 篡改与受保护文件修改判失败、并行批次快照排除共享临时文件 |
| `test/run-control.test.mjs` | `run-start.test.mjs` + `run-status.test.mjs` + `run-wait.test.mjs` + `run-cancel.test.mjs` + `run-parallel.test.mjs` | 引入测试轮询间隔（如 50ms）与短 SIGKILL 宽限期（测试 200ms）；`run-status`/`run-wait` 无运行态等只读校验改调 `buildTaskStatus`/`waitRun`；保留命名管道竞态、并行批锁、setup 失败回滚、stubborn SIGKILL、双任务并发等真实进程测试 | `worker.json` 进程身份防 PID 复用、取消回收整棵进程树、setup 失败回滚脏 Worktree、`wait` 读记录与探活竞态、不同任务并行互不干扰 |
| `test/run-worktree.test.mjs` | 保留独立 | 改用模板仓库 + 应用层夹具 | 确定性 Worktree 路径与分支、复用与重建（`prune`）、主检出改动不计入执行者、无提交仓库拒绝 |
| `test/run-pane.test.mjs` | 保留独立 | **重点瘦身**：10 路 resume 模式拆分为「6 路纯 `checkResume`/`prepareRun`/`executeRun` 内存/轻夹具单测（< 1s）」+「4 路真实进程 E2E（`rpc`、`pane`、`rejected`、`fresh`）」；配合 50ms `waitRun` 轮询 | Rex 开窗/最小化/关窗、20s 超时与开窗失败回退后台、Esc 中止续跑、窗格意外关闭记失败、进程树取消、原生续聊系统提示保持一致 |
| `test/deliver.test.mjs` | `deliver.test.mjs` + `deliver-preview.test.mjs` + `deliver-commit.test.mjs` + `deliver-problems.test.mjs` + `application-use-cases.test.mjs`（交付部分） | 改用模板仓库 + 应用层 `deliverTask`/`previewDelivery` 覆盖各种拒交付/提示/staging 场景；CLI 保留预览、无 Git 交付、Git 交付、hook 拒交付撤回 4 条冒烟 | 无授权/未完成/无文案拒绝、`--only` 不污染无关暂存、`git mv`/`git rm` 暂存删除处理、hook 拒绝全量撤回、hook 篡改提交差异提示、审查通过后改动标记 |
| `test/deliver-worktree.test.mjs` | 保留独立 | 改用模板仓库 + 应用层 `doneTask`；将 2×2 笛卡尔积（`tracked × conflict/dirty` 等）中大部分场景改调 `deliverTask()` 直接断言，CLI 仅留代表性 3–4 条 | 任务分支交付与主检出 HEAD 不变、已入库旧任务目录临时备份与撤回、被忽略任务目录留主检出、自动合并快进/合并提交/冲突 abort、拒绝清理不强制、跨文件系统移动与恢复 |
| `test/context.test.mjs` | 保留独立 | 纯状态矩阵（各状态/去重/嵌套目录/稳定性）改调 `buildSessionContext` + `contextLines`；CLI 仅留 2 条冒烟 | `discuss` 始终提供、按路径去重、状态未变输出逐字不变、已交付任务可读 Worktree 归档 |
| `test/bridge.test.mjs` | `bridge-task.test.mjs` + `bridge-use.test.mjs` + `bridge-context.test.mjs` + `bridge-deliver-preview.test.mjs` + `bridge-deliver.test.mjs` | 合并 5 个小型 Pi 桥接文件，共享 `bridged()` 模板夹具 | 工具声明与转交、`use` 写入 Pi 会话、每轮注入与去重、交付授权严格核对当前会话用户原话 |
| `test/bridge-run.test.mjs` | `bridge-run.test.mjs` + `bridge-notice.test.mjs` | 合并 2 个运行/通知桥接文件，受益于 50ms `waitRun` 轮询 | `knit_run` 透传模型/思考/多行指令、单执行与并行批次结束通知、主动取消与会话重载后停止等待 |
| `test/host-hook.test.mjs` | `host-hook.test.mjs` + `workbuddy-host-hook.test.mjs` | 合并；AST 校验与交付原话边界改直接调 `checkHostCommand()` + `agyHostHook()` / `workbuddyHostHook()`（内存复用 `sh-syntax`，毫秒级）；每个宿主仅留 1–2 条真实 `knit hook` / `knit-hook.sh` 子进程冒烟 | 会话状态去重与刷新、多行/桌面 `user_query` 原话核对、`<system-reminder>` 与宿主合成消息排除、WorkBuddy 极简 PATH 引导 |
| `test/work-choice.test.mjs` | 保留独立 | **重点重构降级**：将 28 组对话意图/搜索范围/澄清/恢复/范围扩大矩阵改为**纯内存直接调用 `workTurn` + `workQuestion` + `checkSessionTool`**（耗时 < 0.2s）；`pi`/`agy`/`workbuddy` 三宿主各保留 2–3 条端到端协议冒烟（共 6–9 条，验证转录提取、hook 拒绝文案、草稿幂等） | 讨论与只读零干扰、单点小改直通、命中委派条件先问再做、无关已选任务不替代本次选择、同意草稿停在 `draft`、澄清与恢复沿用选择、换话题重判 |
| `test/init.test.mjs` | `init.test.mjs` + `init-force.test.mjs` + `templates.test.mjs` + `cli.test.mjs` | 合并 4 个小型初始化/模板/CLI 基础测试；`initProject` 多数场景直接调用应用层，CLI 保留 `--version`/EPIPE/各标志冒烟 | 不覆盖已有规范与配置、`--force` 覆盖前备份、宿主按标志或已有文件恢复、首次初始化建引导任务、模板自检合法 |
| `test/antigravity.test.mjs` | 保留独立 | 保持覆盖完整；后续单列小改把 `/private/tmp` 改遵循 `os.tmpdir()`（受 macOS sandbox 路径长度限制时做受控回退）并复用模板仓库 | macOS 外层与命令沙箱边界、工具能力白名单、`external` 预检、共享钩子并发计数、stream/pane 补报与权限阻塞 |
| `test/pi-runtime.test.mjs` | 保留独立 | 直接导入 `connection.js`/`runtime.js`/`native-file.js`（配合删 `pi/index.ts`），现仅 0.82s | RPC 帧协议、工具开关映射、超时/异常退出与原生 JSONL 核验 |
| `test/infrastructure.test.mjs` | 保留独立 | 0.14s 保持原样 | 原子写冲突检测、符号链接逃逸拦截、指纹不追踪符号链接 |
| `test/process.test.mjs` | 保留独立 | 0.62s 保持原样 | Linux `/proc` 与 macOS `ps` 解析、`/bin/ps` 不可用回退 `kill(pid,0)`、进程树清理 |
| `test/workspace.test.mjs` | 保留独立 | 1.05s，改用模板仓库可降至 ~0.2s | 新增/修改/删除快照差异、HEAD 变更、受保护路径识别、并发消失未跟踪文件容错 |
| `test/config.test.mjs` | 保留独立 | 0.05s 保持原样 | 缺省值、非法字段报错、`worktree.setup`/`autoMerge` 校验 |
| `test/report.test.mjs` | 保留独立 | 0.00s 保持原样 | JSON 代码块提取（含嵌套反引号）、声明字段类型与枚举校验、补报提示 |

*(注：若将 `task-cancel-worktree` 并入 `task-lifecycle`、将 `config` 并入 `init`，可进一步收至 **27 个测试文件**；保持 27–29 个之间均处于健康密度。)*

#### C. 预期提速收益估算

| 优化项 | 影响文件 | 预期单核耗时削减 | 对全量并行墙钟（~120s）的影响 |
| --- | --- | ---: | --- |
| 1. `work-choice.test.mjs` 矩阵降级为内存单测 + 少量宿主冒烟 | `work-choice.test.mjs` | 88s+ → ~3–5s（**-83s+**） | 消除当前并列第 1 的长尾瓶颈 |
| 2. `run-pane.test.mjs` 6 路 resume 降级 + 50ms `waitRun` 轮询 | `run-pane.test.mjs`、`bridge-notice`、`run-wait`、`run-parallel`、`run-start` | ~175s → ~25–35s（**-140s**） | 打破当前最大长尾（93s → ~15s） |
| 3. Helper 改造（模板仓库 `cpSync` + 应用层 `readyTask`/`doneTask`） | `deliver-worktree` 及 30+ 集成测试 | ~200s → ~50s（**-150s**） | `deliver-worktree` 40s → ~12s，大幅压低 CPU 争抢 |
| 4. 只读/参数校验用例降级直调应用层/领域层 | `workflow-thinking`、`context`、`host-hook`、`task-*`、`deliver-*` | ~80s → ~10s（**-70s**） | 消除数百次 Node CLI 与 `sh-syntax` 重复冷启动 |
| **综合预期** | **全套测试** | **总 CPU 降幅 > 75%** | **全量 `npm test` 墙钟从 ~120s → ~20–30s（提速 4–5×）** |

---

## 6. `.knit/standards/` 4 份同名通用规范副本的现状核实与处理建议

### 6.1 事实核查（基线 `bf0108a`）

对照 `.knit/standards/`（7 份）与 `assets/templates/standards/`（4 份）及 `src/application/standards-store.ts`、`src/application/init.ts`：

| 文件名 | 相对 `assets/templates/standards/` 状态 | 本仓库专属差异 |
| --- | --- | --- |
| `.knit/standards/discussion.md` | **已漂移过时**（2,912B vs 模板 4,150B） | 提交 `bf0108a` 更新了模板（新增 `## 从讨论转入实施` 并调整 `## 谁来做`），但 `.knit/standards/discussion.md` 仍停留在旧版。 |
| `.knit/standards/delivery.md` | **含本仓库定制内容**（3,912B vs 模板 3,495B） | `## 提交文案` 多了本仓库专属规范（英文、`type(scope): summary` ≤ 72 字符、`Validation:` / `Not verified:` 段）。 |
| `.knit/standards/task-splitting.md` | **字节完全一致**（1,302B） | 无差异。 |
| `.knit/standards/task-writing.md` | **字节完全一致**（2,336B） | 无差异。 |
| `development.md` / `pitfalls-main.md` / `pitfalls-worker.md` | 本仓库专属（模板中无同名文件） | 必须保留。 |

> **关键风险提示**：在当前提交 `bf0108a` 中，`src/application/standards-store.ts`（第 9–17 行）**仅读取项目 `.knit/standards/`**，并未在运行时自动加载 `assets/templates/standards/`（或 `assets/standards/`）作为内置规范；同时 `11-23-ask-before-task-implementation/task.md` 第 67 行提到主检出另有一项尚未合并到本分支的“规范迁移”工作。

### 6.2 分场景处理建议

- **情形 1（在主检出已合入“运行时内置加载 4 份通用规范”的前提下）**：
  1. 确认运行时加载器已默认注入 `discussion`、`task-splitting`、`task-writing`、`delivery` 4 份内置规范，且全局安装版已重新 `pack:install`。
  2. 直接删除 `.knit/standards/` 下 3 份纯副本：`discussion.md`、`task-splitting.md`、`task-writing.md`。
  3. 对 `.knit/standards/delivery.md` **不可整份直接删除**——先将其中本仓库专属的 `## 提交文案` 规则（英文、`type(scope)` 72 字符、`Validation`/`Not verified`）抽离保留为独立项目补充规范（例如 `.knit/standards/commit-style.md`，声明 `stages: [deliver]`），再删除同名遗留副本 `.knit/standards/delivery.md`，避免与内置 `delivery.md` 重名覆盖或丢失约定。
- **情形 2（若仍在现行 `bf0108a` 加载机制下，尚未改为运行时内置加载）**：
  1. **绝不能直接删除这 4 份文件**，否则本仓库 `knit context` 与执行者交接将丢失全部 4 份通用规范。
  2. 应立即同步 `.knit/standards/discussion.md` 与 `assets/templates/standards/discussion.md`，消除已发生的规则漂移；并尽快立项将 4 份通用规范改为运行时内置加载（`standards-store` 默认内置 + 项目可追加/覆盖），从根源杜绝模板与副本双份维护。

---

## 7. 过度拆分与测试变慢的根因溯源

通过追溯 `git log`（自瘦身重构 `1dc1e15` 及此前 B–G 批至 `bf0108a`）、归档任务计划（`11-14-slim-refactor/plan.md`、`11-20-worktree/task.md`、`11-22-architecture-hardening/task.md`、`11-23-ask-before-task-implementation/task.md`）、现行规范、角色提示与设计，确认当前碎片化与慢测试并非偶然，而是四股力量叠加造成的**结构性单向熵增**：

### 7.1 规范缺失与条款诱导（第一根因）

1. **任务拆分硬上限被机械映射为“文件/测试文件拆分”**
   - **证据**：`.knit/standards/task-splitting.md:8` 规定：“**一个任务的完成条件不超过 3 个场景，超过就拆。**”
   - **演化证据**：在 `.knit/tasks/archive/2026-11/11-14-slim-refactor/plan.md` 中，仅因“不超过 3 个场景”，C 批多拆 3 个任务（行 69）、D 批多拆 3 个（行 93）、E 批多拆 11 个（行 131，E0–E19 共 20 任务）、F 批多拆 3 个（行 177）、G 批多拆 5 个（行 211）。每完成一个子任务，测试数仅增 2–3 条（行 142 实录：`116 → 118 → 121 → 124 → 127 → 130 ...`），但几乎每个子任务都新建了独立的 `*.test.mjs` 文件——最终 `1dc1e15` 搬入根目录时就已带有 **48 个 `src/` 文件和 56 个测试文件**（如 `task-new`/`task-view`/`task-ready`/`task-close`/`task-cancel`/`task-runs`/`task-show-commit` 共 7 个文件，`deliver`/`deliver-preview`/`deliver-commit`/`deliver-problems` 共 4 个文件，`bridge-task`/`bridge-use`/`bridge-run`/`bridge-context`/`bridge-notice`/`bridge-deliver-preview`/`bridge-deliver` 共 7 个文件）。
   - **延续惯性**：`1dc1e15` 之后的 19 次功能/重构提交完全沿袭了“一任务一新测试文件”的习惯（`0825bee` 加 `workflow-thinking.test.mjs`，`11-20-worktree` 的 W1–W9 接连新增 `run-worktree`、`deliver-worktree`、`handoff-worktree`、`task-cancel-worktree`、`run-parallel`、`run-dependencies` 6 个独立测试文件；`178eba3` 再增 `application-use-cases.test.mjs`；`bf0108a` 再增 `work-choice.test.mjs`）。
   - **症结**：`task-splitting.md` 缺少一条关键澄清——**拆的是任务与验证节奏，不是源码模块或测试文件**。

2. **开发规范只管函数粒度，不管文件粒度和测试金字塔**
   - **证据**：`.knit/standards/development.md` 的 `## 复杂度` 写了“逻辑留在一个函数里，除非拆出的部分可组合或会被重用”、“不预先提取只用一次的辅助函数”，但全文**没有任何一条规则约束文件创建门槛、何时应并入既有模块、或单调用方薄文件的处理**。
   - **证据**：`.knit/standards/development.md` 的 `## 测试` 写了“按副作用和不变量选测试，只保留必要的；只读的操作不套崩溃场景”、“测真实实现，尽量不用 mock”，但**没有区分单元测试与 CLI/子进程集成测试的边界**，也没有为测试耗时设定预算或禁止对纯计算逻辑套用重型 CLI/shell 笛卡尔积。
   - **叠加效应**：`.knit/standards/pitfalls-worker.md` 强调“测试全过但没覆盖真实路径”、“夹具用真实数据的形状”，在缺乏“测试分层”平衡条款时，执行者为了怕被审查以“未覆盖真实路径”打回，便防御性地把所有场景都写成全栈 CLI + Git + Hook 子进程测试——`bf0108a`（`work-choice.test.mjs`，单文件 84 个全宿主子进程用例，耗 85s+）和 `run-pane.test.mjs`（10 路全流程 E2E，耗 93s）就是最典型产物。

3. **讨论规范的文件数委派门槛与 `dependsOn` 倾向**
   - **证据**：`.knit/standards/discussion.md` 规定“要改 3 个以上的文件，或跨 2 个以上的模块”进入委派。虽然条目注明“数字只帮助判断”，但在多任务并行/串行推进时，新建一个独立测试文件（而非修改已有大测试文件）天然减少合并冲突与 diff 噪音，久而久之演变成默认习惯。

### 7.2 角色提示诱导“只增不并”的单向熵增

1. **`.knit/agents/implement.md`**：第 2 条规定“只做需求写明的事。需求以外的问题写进报告，不顺手改”。该条款对防范围蔓延很有必要，但副作用是：当增量需求只写“新增 X 能力”而不指明“并入现有 Y 文件”时，执行者倾向于**新建独立文件 + 新建独立测试文件**以规避误改既有代码风险，从未主动归并既有极薄文件。
2. **`.knit/agents/review.md`**：审查流程只核对完成条件是否通过，**完全不把“无必要新增极薄文件/碎片测试”、“纯逻辑滥用重型子进程测试”、“单文件耗时异常拉长 `npm test`”纳入审查清单**。因此在多轮独立审查中，这类结构债一路绿灯。

### 7.3 架构与设计演进带来的胶水层与测试成本

1. **架构加固“只抽不收”**
   - **证据**：`11-22-architecture-hardening`（提交 `4e18620`、`178eba3`、`976eac2`）正确地解决了依赖方向与 CLI 过胖问题，但一口气新建了 `domain/agent-target.ts`（22 行）、`contracts/pane.ts`（15 行）、`cli/worktree.ts`（29 行）、`application/session-context.ts`（60 行）、`application/task-lifecycle.ts`（109 行）及 `test/application-use-cases.test.mjs`（78 行），随后 `d7184e2` 又新拆出 `application/session-output.ts`（80 行），却没有把同层早已存在的 8–56 行极薄文件（`cli/root.ts`、`standards-store.ts`、`workflow-store.ts`、`run-pane.ts`、`task-materials.ts`、`contracts/frames.ts`）顺手归位，也没有把既有 CLI 重型测试迁移到刚抽出的应用层函数上。
2. **共享基础原语未及时下沉**
   - `application/run-lock.ts`（32 行）与 `adapters/pi/session-env.ts`（7 行）诞生于局部功能提交（`031cb8b`、`3faeea6`），被其他模块复用时直接跨层/跨目录导入，未归位至 `infrastructure/process.ts`。
3. **测试可观测性/等待机制缺少测试注入点**
   - `waitRun` 写死 1000ms 轮询（`src/application/run-control.ts:82`）、`stopProcesses` 写死 5000ms `SIGTERM` 等待（`src/application/run-process.ts:66`），导致所有涉及等待和取消的集成测试被迫按真实秒级时间空等。
   - `docs/design/DESIGN.md` 第 10 节第 4 条仅要求“测试只在临时目录里建夹具”，未对测试夹具构建方式（直接调应用层 vs 反复调 CLI、`cpSync` 模板仓库 vs 反复 `git init`）给出工程约定。

### 7.4 任务编写与推进习惯

- `.knit/standards/task-writing.md` 规定“知道会动哪些模块或目录时写上，不逐个文件、逐行列出”，导致任务作者很少在 `task.md` 里明确指出“测试追加到既有 `test/<topic>.test.mjs` 中，不新建测试文件”，把文件布局决定权留给了每次全新上下文的执行者。

---

## 8. 规范、角色提示与设计的可执行修改建议

> **提醒**：按 `AGENTS.md` 约定，通用规范模板在 `assets/templates/standards/`，角色文件模板在 `assets/templates/agents/`；实施时应改模板（项目专属规范改 `.knit/standards/development.md` 与 `pitfalls-worker.md`），升级全局安装版后再同步副本。本任务不直接修改以下文件。

### 8.1 `.knit/standards/development.md`（项目专属开发规范）

1. **在 `## 复杂度` 增加「文件与模块粒度」小节**：
   - 新增条款：
     - 「默认在既有同主题文件内扩展，不为单次增量或单个小函数新建文件。」
     - 「新建文件必须满足至少一条：独立外部入口或延迟加载边界、跨 3 处以上复用的共享契约/原语、高风险独立审查边界（状态推进/快照保护/结算/交付），或原文件超过 ~350 行且存在清晰内聚子域。」
     - 「禁止创建无逻辑增量的空壳重导出文件（barrel）或仅被单个调用方使用的 `< 60` 行碎片文件。」
     - 「跨层或跨适配器共享的底层原语（锁、环境变量清理、进程/文件工具）下沉到 `infrastructure/`，禁止 `adapters` 反向依赖 `application` 或跨适配器互导。」
2. **在 `## 测试` 增加「测试分层与性能预算」条款**：
   - 新增条款：
     - 「测试按主题文件组织，新场景优先追加到对应主题的既有测试文件，不按任务编号或单个子功能新建 `*.test.mjs`。」
     - 「遵循测试金字塔：纯解析、校验、规则与状态机矩阵（尤其是多参数笛卡尔积）直接内存调用 `domain/` 或 `application/` 函数；CLI 与宿主钩子层只保留少量端到端协议冒烟（入口参数、退出码、输出格式、权限/钩子封包），不在 CLI 子进程里重复遍历纯逻辑分支。」
     - 「测试夹具优先通过应用层函数与只读模板仓库复制构造，不在夹具准备阶段反复启动 `knit` CLI 或重复 `git init`。」
     - 「新增或改动的单个测试文件耗时原则上控制在 5 秒内；需要等待异步进程的测试优先使用事件/短轮询间隔，不引入无意义的整秒 `sleep`。」

### 8.2 `assets/templates/standards/task-splitting.md`（通用任务拆分规范）

- 在第 3 条（“一个任务的完成条件不超过 3 个场景，超过就拆”）紧后补充一条反制规则：
  - 「**拆分的是交付节奏与验收范围，不是源码模块或测试文件**：同一主题拆出的多个子任务应落入同一批既有源码文件与主题测试文件，不按子任务一对一新建文件。」

### 8.3 `assets/templates/standards/task-writing.md`（通用任务编写规范）

- 在“写清产出”或“写清验证”补充一句：
  - 「若改动属于既有主题的增量，在任务中点名归属模块与应追加的既有测试文件，明确要求优先复用而不另起新文件；对纯逻辑变更注明以应用层/领域层直测为主、CLI 仅做冒烟。」

### 8.4 `.knit/standards/pitfalls-worker.md`（执行者避坑清单）

- 在 `## 测试` 新增一条平衡条目，与“测试全过但没覆盖真实路径”形成对照：
  - **标题**：`### 为防漏测把纯逻辑全写成重型 CLI / 子进程矩阵`
  - **现象**：新增一个规则改动，写了数十个跨宿主 CLI/Git 子进程用例，把全量 `npm test` 拖慢数十秒。
  - **原因**：把“用真实数据形状测边界”误解为“每个分支都必须从命令行进程跑通”。
  - **做法**：用真实输入样本直接调用领域层/应用层函数覆盖全部规则分支（毫秒级），再用 1–2 个端到端冒烟验证真实 CLI/宿主钩子接线。

### 8.5 角色提示模板（`assets/templates/agents/implement.md` 与 `review.md`）

1. **`assets/templates/agents/implement.md`**（在 `怎么做` 第 2 条后补一条轻量提醒）：
   - 「新增代码和测试优先放进既有同主题文件，不按任务新建碎片文件；若遇到无法避免的新文件，在报告中写明新建理由。」
2. **`assets/templates/agents/review.md`**（在 `怎么做` 第 2 条或检查维度补一条）：
   - 「审查改动的结构与验证成本：若发现无必要新增的极薄文件/空壳重导出/碎片测试文件，或对纯逻辑滥用重型 CLI/子进程矩阵显著拖慢测试，视为 `changes_requested`（单执行器具备 `write` 时可直接收敛）。」

### 8.6 `docs/design/DESIGN.md`

1. **第 7 节（执行）**：在共用流程说明中明确 `waitRun` 轮询策略（如短间隔退避 `50ms → 200ms → 1000ms` 或保持 1000ms 默认但允许测试参数化），兼顾生产低占用与测试快速响应。
2. **第 10 节（用 Knit 开发 Knit）**：在第 4 条后补一句工程约定——测试夹具优先复用应用层入口与模板仓库克隆，减少重复子进程启动；并明确 4 份通用规范的唯一事实来源（同步推进内置规范方案后更新第 4 节说明）。

---

## 9. 分批重构实施路线（按收益与风险排序）

遵循 `task-splitting.md`，将后续重构拆为 **6 批独立可验证的子任务**，**先立规矩与提速测试（让后续每批源码重构都能享受 20–30s 极速全量回归）**，再按低风险到高风险逐层收敛源码：

| 批次 | 子任务主题 | 改动范围 | 预期收益 | 风险与验证方式 |
| --- | --- | --- | --- | --- |
| **Batch 0** | **规范、角色模板与遗留规范对齐** | `development.md`、`pitfalls-worker.md`、`assets/templates/{standards,agents}/`、`docs/design/DESIGN.md`；核对并处理 `.knit/standards/` 4 份同名副本 | 堵住继续产生碎片文件和慢测试的制度漏口，消除 `discussion.md` 漂移 | 低风险；验证：`self`（`knit standards list`、`npm test`、通读核对） |
| **Batch 1** | **测试提速核心改造（先提速！）** | ① `waitRun` 轮询退避/可配 + `stopProcesses` 测试宽限期注入；② `test/helpers/` 收敛（9→7）+ 模板仓库 `cpSync` + 应用层 `readyTask`/`doneTask`；③ 重构降级 `work-choice.test.mjs` 与 `run-pane.test.mjs` 6 路 resume；④ 修复 `antigravity.test.mjs` 硬编码 `/private/tmp` | **核心收益**：`npm test` 从 **~120s 降至 ~25–35s**，后续所有重构批次反馈速度提升 4 倍 | 中风险（涉及测试夹具与等待逻辑）；验证：`independent`（Rex 与普通终端全量 `npm test` + 变更变异验证不变量未削弱） |
| **Batch 2** | **低层与 CLI 层源码收敛（`contracts` + `infrastructure` + `cli` + `adapters` 薄文件）** | `contracts` 7→4（`frames` 迁回 `pi/connection`，`pane` 并入 `agent`，`digest+schema`→`primitives`）；`infrastructure` 6→3（`fs.ts`、`paths.ts`、`process.ts` 吸收 `session-env` 与 `withFileLock`）；`cli` 10→6（`shared.ts`、`project.ts`）；`adapters` 18→15（删 `pi/index.ts`，`antigravity/pane.ts` 并入 `client.ts`） | 减少 **13 个**源码文件，彻底消除 `adapters -> application` 反向依赖与跨适配器依赖，CLI 内部不再跨引 `task.ts` | 低-中风险（以搬迁和导入改写为主，行为零变化）；验证：`self`（`typecheck` + `npm test` + `pack:check`） |
| **Batch 3** | **`domain/` 层源码收敛** | `domain` 11→6（`agent-target`→`workflow.ts`，`stage-rules`→`report.ts`，`task-document+task-record+task-references+markdown`→`task.ts`） | 减少 **5 个**源码文件，任务文本编解码收口 | 低风险（纯函数搬迁）；验证：`self`（`typecheck` + `npm test`） |
| **Batch 4** | **`application/` 层源码收敛** | `application` 24→16（`config+standards-store+workflow-store`→`project-config.ts`，`task-materials`→`handoff.ts`，`run-execute+run-pane+run-session`→`run-execute.ts`，`run-control+run-process+taskLock`→`run-control.ts`，`session-context+session-output`→`session-context.ts`） | 减少 **8 个**源码文件，`run-*` 从 9 个压到 4 个核心职责文件 | **较高风险**（触及执行控制、锁与会话结算链路）；验证：**`independent`**（全量 `npm test`、Rex/普通终端双跑、`pack:check`） |
| **Batch 5** | **测试文件主题合并与冗余 CLI 降级** | 按第 5.4 节清单将 `test/*.test.mjs` 从 **68 个合并至 29 个（可选 27 个）**，清理 `workflow-thinking`/`context`/`task-*`/`deliver-*`/`host-hook` 中重复的 CLI 子进程用例 | 减少 **39–41 个**碎片测试文件，`npm test` 进一步收敛至 **~20–25s**，测试目录一览无余 | 中风险（防止合并时误删断言）；验证：**`independent`**（合并前后对照不变量清单 + 全量 `npm test`） |

### 批次依赖关系

```text
Batch 0（立规矩 & 清规范漂移）
   ↓
Batch 1（测试提速核心：~120s → ~30s）
   ↓
Batch 2（contracts / infrastructure / cli / adapters 收敛，-13 文件）
   ↓
Batch 3（domain 收敛，-5 文件）
   ↓
Batch 4（application 收敛，-8 文件，独立审查）
   ↓
Batch 5（测试文件主题合并与余量降级，68 → 29 文件，独立审查）
```

> **落地建议**：Batch 1 单独交付即可立刻拿到最大的日常开发体验收益（测试提速 3–4 倍）；Batch 2–5 可按团队节奏分批推进，每批均可独立交付、独立验证且保持 `npm test`、`npm run typecheck`、`npm run pack:check` 全绿。
