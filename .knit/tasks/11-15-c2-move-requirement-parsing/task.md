---
id: k-355b59a06e15
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-d5b1b45edf09
order: null
createdAt: 2026-11-15T07:48:49.790Z
title: C2 搬完成条件场景和待澄清项的解析到 next/
---

# C2 搬完成条件场景和待澄清项的解析到 next/

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。`task.md` 的「完成条件」用 `### Requirement: 名称`、`#### Scenario: 名称` 和 `- WHEN …`／`- THEN …` 写场景，「待澄清」用 `- [blocking] …`／`- [assumed] …` 写还没定的事。旧代码里解析这两样的函数已经验证过，写法在小核心里不变（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.1 节、第 12 节），所以搬过来用。

做完之后的不同：`next/` 里可以从需求部分的文本里解析出场景清单、写法问题和待澄清项的数量。确认需求（C5）和查看任务（C4）要用。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/task-requirements.ts`（新增） | 从 `src/contracts/task-inputs.ts` 搬来两个函数和它们用到的常量、类型 |
| `next/test/task-requirements.test.mjs`（新增） | 搬来 2 个测试，新写 1 个 |

从 `src/contracts/task-inputs.ts` 搬这些，其它都不搬：

- 待澄清：`CLARIFY_HEADING`、`CLARIFY_BLOCKING_PREFIX`、`CLARIFY_ASSUMED_PREFIX`、`ClarifyState`、`clarifyItemText`、`clarifyStateOf`。
- 完成条件：`ACCEPTANCE_HEADING`、`REQUIREMENT_PREFIX`、`SCENARIO_PREFIX`、`ScenarioStepKeyword`、`ScenarioStep`、`AcceptanceScenario`、`ScenarioIssueKind`、`ScenarioIssue`、`ScenarioState`、`SCENARIO_FORMAT_EXAMPLE`、`ScenarioNode`、`RequirementNode`、`STEP_PATTERN`、`scenarioStateOf`。

搬的时候只改两处：

- 两个函数原来先调用 `inputsRegionOf` 去掉旧格式的记录区。新格式没有记录区，改成直接解析传入的文本；调用方传入的是需求部分。`inputsRegionOf` 不搬。
- 注释里指向旧任务编号、旧设计文档章节的说法删掉；“输入区”“输入引用”改成现在的说法（需求部分、相关资料）。

其余逐字照搬，不按开发规范的「写法」重写：那一节只约束新写的代码。

测试：

- 从 `test/scenarios.test.mjs` 搬头两个测试（名字以 `R1.S1–S4 解析` 和 `R2.S1–S4 结构错误` 开头）以及它们用到的 `scenario`、`THREE`。名字里的编号前缀去掉。第一个测试里有一条断言用到 `

<!-- knit:progress:start -->
`，它测的是旧格式的记录区，删掉这一条。
- 那个文件里其余 7 个测试不搬：它们测的是报告、确认需求的服务、模板和桥接，不是这两个函数。
- 旧测试里没有直接测 `clarifyStateOf` 的，新写一个：`[blocking]` 和 `[assumed]` 各自计数；`blockingItems` 最多 3 条、单条超过 120 个字符时截断并以省略号结尾；缩进的行和大小写不同的标记不算；区段到下一个一级或二级标题为止；没有「待澄清」区段时都是 0。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件：本任务只新增。
- 不加依赖，不提交、不推送。

前置条件：C1 已完成。运行 `npm run test:next` 能通过。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 新增源文件，按上面的清单搬并改那两处。
4. 新增测试文件。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `grep -n "inputsRegionOf\|knit:progress\|输入区\|输入引用" next/src/domain/task-requirements.ts`：没有输出。
- `git status --short`：和开始前相比，只多出上表的 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、哪些测试没搬及原因、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): move scenario and open question parsing`。

## 完成条件

### Requirement: 解析完成条件和待澄清

#### Scenario: 解析出场景

- GIVEN 需求部分的「完成条件」里有两个 Requirement、三个 Scenario
- WHEN 调用 `scenarioStateOf`
- THEN 得到三个场景，编号是 `R1.S1`、`R1.S2`、`R2.S1`，没有写法问题
- AND 关键字加粗与否结果相同，代码围栏里的内容不解析

#### Scenario: 指出写法问题

- WHEN 「完成条件」里有没有场景的 Requirement、缺 `WHEN` 或 `THEN` 的场景、全角冒号的标题
- THEN 每处各得到一条问题，说明里有对应的名称

#### Scenario: 数出待澄清项

- GIVEN 「待澄清」里有两行 `- [blocking] …` 和一行 `- [assumed] …`
- WHEN 调用 `clarifyStateOf`
- THEN `blocking` 是 2，`assumed` 是 1，`blockingItems` 是那两行的正文

## 相关资料

- `src/contracts/task-inputs.ts` — 要搬的代码
- `test/scenarios.test.mjs` — 要搬的两个测试
- `.knit/tasks/11-14-slim-refactor/design.md` 第 3.1 节、第 12 节 — 完成条件和待澄清的写法；可以搬的代码
- `.knit/standards/development.md` — 开发规范（「写法」一节不约束搬来的代码）

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-85ee4c1ace60 -->
- 操作: op-85ee4c1ace60
- 时间: 2026-11-15T09:06:42.192Z
- 分支: refs/heads/main
- 授权来源: user:0f1c5bab
- 调用: bridge
- 工作提交: 83f0d71f26462621ef70b50c5a71f1a19d789a34
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-c2-move-requirement-parsing

<!-- knit:progress:end -->
