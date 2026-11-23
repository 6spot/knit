---
id: k-7771a2fd5a7f
title: 梳理项目文件拆分粒度与收敛方案
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-23T15:40:48.577Z
---

## 目标与范围

本任务只做深度梳理、实测诊断、根因分析与方案设计，不直接修改源码、测试或规范文件，产出报告写入 `docs/research/file-granularity-and-test-review.md`。

**为什么做**：
经过多轮演进与重构，仓库文件出现明显碎片化：`src/` 共 77 个文件（8,738 行，近三成不足 50 行、约三分之二不足 100 行），`test/` 共 77 个文件（68 个测试文件 + 9 个 helper，12,667 行），同时日常变更跑 `npm test` 耗时偏长。需要一次系统盘点，不仅要区分“有价值的架构边界”与“过细拆分／冗余测试”，还要查清为什么会演进成如此细碎的结构（规范、角色提示、任务拆分方式或架构设计哪里诱发了这种倾向），以便后续同步修正规范／提示／设计并分批重构。

**梳理范围（范围内）**：
1. `src/` 全部 6 层（`cli`、`application`、`domain`、`contracts`、`adapters`、`infrastructure`）：评估文件拆分粒度、极薄封装、同主题分散文件和依赖关系，给出合并／保留判断标准与具体方案。
2. `test/` 全部测试文件与 `test/helpers/`：
   - 评估文件碎片化与用例冗余度（哪些测试文件过碎、哪些场景重复覆盖、哪些只需直接调用应用层／领域层函数却反复走 CLI 或 Git 子进程）。
   - 实测全量 `npm test` 及单个测试文件的耗时分布，定位主要慢测试与耗时根因（如重复子进程启动、重复初始化 Git 夹具、等待超时等），给出在不削弱核心不变量前提下的精简与提速方案。
3. 根因溯源与制度／设计改进建议：
   - 结合 Git 提交与归档任务演化轨迹、现行规范（`AGENTS.md`、`assets/standards/`、`.knit/standards/`）、角色提示（`.knit/agents/`）及设计（`docs/design/DESIGN.md`），找出导致源码与测试持续碎片化、测试变慢的真正原因（如是否规范或提示诱导“一任务一新文件／一新测试文件”、缺少归并约束，或某些设计边界导致不得不写大量胶水文件与重型集成测试）。
   - 给出针对规范、角色提示和设计的可执行修改建议（只写进报告，不在本任务直接改这些文件）。
4. 顶层目录与遗留规范（补充节）：
   - 默认保留现有分层与依赖方向，重点做层内收敛；同时单列一节客观评估顶层目录（例如较薄的 `contracts/`）是否值得合并及其迁移代价，供决策参考。
   - 顺带标注 `.knit/standards/` 中 4 份旧版遗留同名规范副本的清理建议。

**不做的事（范围外与边界）**：
- 不修改 `src/`、`test/`、`assets/`、`docs/design/`、`docs/history/`、`.knit/`、`AGENTS.md` 下的任何现有文件——本任务只产出研究、根因分析与收敛方案，实际代码、测试与规范调整留待方案审阅后再分批实施。
- 不将 `assets/`（运行时按路径加载的模板与内置规范）和 `docs/history/`（历史档案）纳入文件合并对象（仅可作为根因排查的只读对象）。
- 不修改主检出任务目录；报告统一写在 Worktree 的 `docs/research/file-granularity-and-test-review.md`。
- 不运行 `npm run pack:install`、不调用真实外部模型。

**分析思路**：
- 结合 `docs/design/DESIGN.md` 的现行设计与 `.knit/standards/development.md` 的复杂度和测试原则（“逻辑留在一个函数里，除非拆出的部分可组合或会被重用”、“按副作用和不变量选测试，只保留必要的；只读的操作不套崩溃场景”），先给出可复用的划分准绳，再逐层落到具体文件清单。
- 采集测试耗时时，先构建 `npm run build`，再在本地隔离环境下采集全量 `npm test` 总耗时与各 `test/*.test.mjs` 的单项耗时（保持测试代码原样），报告中如实给出采集命令与实测数据。
- 做根因排查时，用具体证据说话：结合 `git log` 中文件/测试增长的典型提交、归档任务拆分方式、规范条款和角色提示原文，指出哪些条文缺失或措辞诱发了过度拆分，以及哪些设计抽象造成了极薄胶水层或测试高成本，避免泛泛而谈。
- 对每项合并、精简或规范修改建议说明：现状、建议目标、预期收益（减少的文件数、耗时或长期防反弹效果）以及不能丢弃的边界或不变量。

**验证与交付**：
- 核对 `docs/research/file-granularity-and-test-review.md` 覆盖全部完成条件且引用的文件路径、行数、测试耗时、Git／规范证据与仓库实际一致。
- 运行 `git status --short` 确认 Worktree 中仅新增 `docs/research/file-granularity-and-test-review.md`，没有其他文件改动。
- 完成后改动留在任务分支，由主会话将报告呈给用户审阅；待用户拍板采纳哪些建议及后续子任务拆法后，再决定归档交付。

## 完成条件

### Requirement: 源码文件拆分粒度诊断与收敛方案
#### Scenario: 输出按层整理的源码合并与保留方案
- WHEN 执行者梳理 `src/` 下全部 6 层文件的职责、体量与依赖关系
- THEN `docs/research/file-granularity-and-test-review.md` 包含：(1) 区分“过细拆分”与“合理边界”的判断原则；(2) 按层列出的具体合并清单（源文件路径、合并目标、理由）与明确建议保留独立的文件及原因；(3) 独立小节评估顶层目录（含 `contracts/`）是否需要调整及其利弊和迁移成本。

### Requirement: 测试碎片化、冗余度与耗时瓶颈诊断及精简方案
#### Scenario: 输出基于实测耗时的测试收敛与提速方案
- WHEN 执行者梳理 `test/` 全部测试与 helper 并实测 `npm test` 总耗时与单文件耗时分布
- THEN `docs/research/file-granularity-and-test-review.md` 包含：(1) 实测总耗时、慢测试排名与耗时根因分析；(2) 识别过碎测试文件、重复覆盖用例及不必要的重型子进程／夹具测试，给出具体的合并、降级或删减方案并写明必须保留的核心不变量；(3) 顺带标注 `.knit/standards/` 中旧版遗留同名副本的处理建议。

### Requirement: 过度拆分根因溯源、规范／设计改进建议与分批重构路线
#### Scenario: 找出诱发过碎拆分的根因并给出改进建议与重构路线，且严守只读边界
- WHEN 执行者对照 Git 演进、现行规范、角色提示与设计完成根因分析并检查工作区状态
- THEN `docs/research/file-granularity-and-test-review.md` 包含：(1) 有具体仓库／规范／提交证据支撑的根因分析（区分规范缺失或诱导、角色提示影响、设计缺陷与任务推进习惯）；(2) 对应规范、角色提示和设计的具体修改建议；(3) 按模块与风险排序的后续重构子任务分批建议（范围、收益、验证方式）；且 `git status --short` 显示仅新增 `docs/research/file-granularity-and-test-review.md`，无任何现有源码、测试、规范或配置被修改。

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 现行架构与目录布局设计
- `.knit/standards/development.md` — 开发、复杂度与测试规范
- `.knit/standards/discussion.md` — 讨论规范（排查流程与讨论要求）
- `.knit/standards/task-splitting.md` — 任务拆分规范（排查是否诱发文件／测试碎片化）
- `.knit/standards/task-writing.md` — 任务编写规范（排查对执行者落文件方式的影响）
- `.knit/agents/implement.md` — 实现环节角色提示
- `.knit/agents/review.md` — 审查环节角色提示
- `AGENTS.md` — 本仓库根目录协作规范
- `package.json` — 构建与测试脚本入口

## 结果

已完成项目文件拆分粒度、测试冗余与耗时瓶颈及过度拆分根因的梳理，在任务分支新增 docs/research/file-granularity-and-test-review.md（516 行），3 个完成条件均已满足。已核对：报告覆盖基线 bf0108a 全部 76 个源码文件、68 个测试文件与 9 个 helper，并实测 npm run build（1.28s）及全量/单文件测试耗时（real 119.52s；JUnit 583 用例中 463 pass、7 skip、113 fail）；git status --short 确认 Worktree 仅新增该报告文件，未改任何现有源码、测试、规范或配置。

未验证：1）执行者处于 macOS 沙箱环境，antigravity.test.mjs（硬编码 /private/tmp 且需嵌套 sandbox-exec）、work-choice.test.mjs（沙箱缺 rg 致 42/84 提前失败）及 4 个依赖 /bin/ps 或 pgrep 的测试存在沙箱受限失败，宿主机非沙箱下的精确全量耗时待补测；2）收敛与提速后的预期收益（~20–30s）属工程估算，待后续重构批次实测。
