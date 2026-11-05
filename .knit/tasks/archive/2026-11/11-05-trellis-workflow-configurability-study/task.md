---
id: k-2edd6475a67c
status: closed
outcome: cancelled
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-05T06:51:26.812Z
title: Trellis 工作流可配置性调研与 Knit 改造方案建议
stage: deliver
---

## 目标与边界

在固定提交的 Trellis（mindfold-ai/Trellis 0.6.17 / `f089cb3286071199e84118dee86b6d76aab032f1`）上核对它的工作流配置机制，回答"哪些可配置、靠什么载体、代价是什么"，并据此给出 Knit 是否以及如何让流程可配置的改造方案建议。

范围：

- 只读调研；不修改本机 Trellis 检出，不运行其 CLI／hook，不做真实模型或真实项目操作。
- 交付物两份，均落项目内可追溯位置：
  - 调研报告：逐层核对 Trellis 的可配置性，每条带固定提交的 `path:line` 来源。
  - Knit 改造方案建议：选项对比、取舍、影响面与升级路径，标注"Agent 建议，待确认"。
- 本轮不实施任何 Knit 代码或现行产品规范改动；改造方案是否立项由用户另行决定。
- 不复述既有材料：`validation/reference-boundaries/` 与 `validation/trellis-prompts-and-roles/` 已覆盖的结论按引用处理，本任务只补充工作流可配置性这一条线，发现冲突时指明。

关联现状（本会话已核对，作为对照基线）：

- 阶段枚举与转移在 `src/domain/task.ts`、`src/contracts/task-inputs.ts`；run 阶段枚举在 `src/contracts/run.ts`。
- `config.json` 顶层对象封闭，未知键校验失败（`src/application/config.ts`）。
- `.knit/workflow.md`、`.knit/agents/*.md` 属 project 所有权，init 只补缺；内容计入 `inputsDigest`（`src/application/context-planner.ts`）。
- `.knit/workflow.md` 同时是交付授权来源（`src/application/delivery.ts`）。

## 完成条件

- 报告给出 Trellis 的逐层可配置性结论，至少覆盖：阶段／步骤清单与命名、每轮注入提示、任务状态取值、粗粒度状态机、恢复路由、生命周期事件、配置文件开关、角色与子 Agent 定义；每条附固定提交来源。
- 明确回答"Trellis 是否支持可配置流程"，写清支持的边界以及仍需手改代码或逐平台同步文件的部分，不只给总判断。
- 与 Knit 现状对照，说明两种做法的取舍：可配置换来的是什么成本，以及各自在哪里失效。
- 改造方案建议给出至少两个可选方案（含"最小改动"方案和"保持现状"对照），每个写清受影响的结构／字段／命令／文档、历史任务与已冻结摘要的兼容处理、风险与不做的理由；方案内容标注为待确认建议。
- 来源固定到提交、版本与 URL；`/tmp` 临时检出不作为长期证据。
- 不把只读调查写成已做真实运行验证；未执行项如实记录。

## 输入引用

- 用户要求（本会话）：先检查 Knit 流程配置是写死还是可配置；随后要求调研 Trellis 的做法并判断是否支持；确认交付物范围为"调研报告 + Knit 改造方案建议"。
- 本机 Trellis 检出：`/tmp/trellis-054`（HEAD `f089cb3`，`packages/cli` version 0.6.17）。临时目录只作取证途径，报告固定提交与 URL。
- 既有材料：[validation/reference-boundaries/README.md](../../../validation/reference-boundaries/README.md)、[SOURCES.json](../../../validation/reference-boundaries/SOURCES.json)（同一固定提交）、[validation/trellis-prompts-and-roles/](../../../validation/trellis-prompts-and-roles/)。
- 仓库规范：[AGENTS.md](../../../AGENTS.md)、[docs/README.md](../../../docs/README.md)、[.knit/workflow.md](../../workflow.md)。
- 设计材料：[DESIGN.md](../../../docs/design/DESIGN.md) 第 4、13、15 节，[STATES.md](../../../docs/design/STATES.md)。
- 关键代码：`src/domain/task.ts`、`src/contracts/task-inputs.ts`、`src/application/config.ts`、`src/application/context-planner.ts`、`src/application/delivery.ts`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 实施结果

在干净检出 `mindfold-ai/Trellis` `f089cb3`（0.6.17）上只读核对工作流配置机制，产出三份材料：

- `validation/trellis-workflow-config/README.md`：逐层可配置性结论、三个"看起来可配其实不生效"的坑、与 Knit 的对照。
- `validation/trellis-workflow-config/knit-options.md`：Knit 侧 A–E 五个选项、影响面与建议（全部标注待确认）。
- `validation/trellis-workflow-config/sources.md`：固定提交、13 个文件的全文 sha256、引用行号与 Knit 侧对应位置。

核心结论：Trellis 把流程叙事（阶段与步骤清单、每轮提示、步骤详情）放在 `.trellis/workflow.md`，脚本只解析；状态写入者封闭在 7 处代码，生命周期事件固定 4 个，粗粒度 phase 投影硬编码，恢复路由是需手改的文件表格。整份流程可换模板（native 内置，其余走 marketplace）。因此是"叙事层可配置、状态机层不可配置"，代价是多处表示需手工同步。

## 自检

- 逐条核对文档中出现的 `path:line`：修正 5 处偏差（workflow.md 状态块范围 176→179、编号说明 259→260、workflow_phase.py 正则行 31-34→32-38、workflow-resolver native 条目 86-100→90-108、config.ts 15-64）。
- 核对 Knit 侧 9 个文件共 30 余处引用，均落在声称内容上。
- 校验相对链接与文件交叉引用；`git status` 只有本任务目录与新增 validation 目录，未改动任何源码或现行规范。
- 未运行 Trellis CLI／hook，报告已声明该限制，不把静态推断写成运行验证。

## 边界

业务完成但未提交、未推送、未归档。`knit-options.md` 全部内容为待确认建议，未据此改动产品规范或代码。

## 提交记录

用户 2026-11-05 授权提交（仅本地提交，不含推送／发布／归档）。工作产物与任务资料分开提交：

- 工作提交：`12b6c75`（`validation/trellis-workflow-config/` 三个文件，276 行新增）
- 任务资料提交：`a6e8e77`（本任务 `task.md`）

提交前 `git status --porcelain` 只有上述两个新增目录，未改动源码或现行规范。未推送。

### 交付记录

<!-- knit:delivery:op-b3cdf3e635e5 -->
- 操作: op-b3cdf3e635e5
- 时间: 2026-11-05T22:26:02.744Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：取消并归档 Trellis 调研任务 k-2edd6475a67c
- 工作提交: 无
- 结果: 业务cancelled；未提交半成品代码
- 归档目标: .knit/tasks/archive/2026-11/11-05-trellis-workflow-configurability-study

<!-- knit:progress:end -->
