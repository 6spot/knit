---
id: k-8ffe28f210d4
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-d8f1940a24df
order: null
createdAt: 2026-11-15T15:02:38.877Z
title: E5 从报告里读出环节声明的字段
---


# E5 从报告里读出环节声明的字段

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。执行者的最后一条消息就是这个环节的报告，全文是给人和下一个环节读的自由文本。流程里的环节可以在 `report` 里声明字段，例如审查环节声明 `verdict: [pass, changes_requested, blocked]`；声明了字段时，报告结尾要有一个 json 代码块给出这些字段，程序读出来决定下一步（`.knit/tasks/11-14-slim-refactor/design.md` 第 6.1、7 节）。

做完之后的不同：`next/` 里有了 `readReport`，给它环节声明的字段和报告全文，得到读出的字段，或者读不出来的原因。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/report.ts`（新增） | `readReport(declared, text)`；只处理文本，不读写文件 |
| `next/test/report.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`readReport(declared, text)`：`declared` 是流程定义里环节的 `report`（字段名到类型，见 `next/src/contracts/workflow.ts` 的 `ReportFieldType`），`text` 是报告全文。返回 `{ fields, problems }`：读得出时 `fields` 是读出的对象、`problems` 是空的；读不出时 `fields` 是 `null`、`problems` 一处一句。

规则：

- 没有声明字段（`declared` 是空的）：不要求 json 代码块，`fields` 是空对象，没有问题；报告里即使有代码块也不读。
- 声明了字段：取报告里最后一个内容能解析成 JSON 对象的代码块。代码块用三个反引号围起来，开头那一行的语言标注（`json`）不算内容。
- JSON 的字符串值里带着三个反引号时也要能取出来。旧代码为这种情况写过 `fenceCandidates`（`src/application/stage.ts` 第 20–52 行），可以照着搬：它把每个开头标记和相邻的、最后一个结尾标记各配一次，逐个试着解析。
- 找不到这样的代码块：问题是 `报告结尾没有能解析的 json 代码块`。
- 声明的每个字段都要有，类型要对：

  | 声明的类型 | 值 | 不对时的问题 |
  | --- | --- | --- |
  | `string` | 字符串 | `报告的字段 <名字> 应当是字符串` |
  | `string[]` | 字符串数组 | `报告的字段 <名字> 应当是字符串数组` |
  | `paths` | 字符串数组，每一项都不为空 | `报告的字段 <名字> 应当是路径数组` |
  | `bool` | `true` 或 `false` | `报告的字段 <名字> 应当是 true 或 false` |
  | 枚举，例如 `[pass, blocked]` | 其中一个值 | `报告的字段 <名字> 只能是 pass、blocked` |

  缺少字段时的问题是 `报告缺少字段 <名字>`。有几处问题就给几句，按声明的先后。
- 没有声明的字段不算问题，原样留在 `fields` 里。
- `paths` 只核对类型，不和实际改动的文件比对：改动文件以程序对比工作区的结果为准。

把结论记进执行记录、读不出时要求执行者补报，都不在本任务里。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。`src/application/stage.ts` 只读，不改。
- `next/` 里已有的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export type ReportFieldType" next/src/contracts/workflow.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `domain/report.ts`。
4. 写测试。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): read the declared fields of a report`。

## 完成条件

### Requirement: 读报告里声明的字段

#### Scenario: 没有声明字段时不要求代码块

- GIVEN 环节没有声明报告字段
- WHEN 读一份只有文字的报告，再读一份结尾带 json 代码块的报告
- THEN 两次的 `fields` 都是空对象，都没有问题

#### Scenario: 读出声明的字段

- GIVEN 环节声明了 `verdict: [pass, changes_requested, blocked]`、`findings: string[]`、`selfVerified: bool`；报告里先有一个示例代码块，结尾的代码块里 `findings` 的一项带着三个反引号，另外多一个没有声明的字段 `note`
- WHEN 读报告
- THEN `fields` 是结尾那个代码块的内容，`verdict`、`findings`、`selfVerified` 和 `note` 都在，没有问题

#### Scenario: 读不出时说明原因

- GIVEN 环节声明了 `verdict: [pass, blocked]` 和 `changedPaths: paths`
- WHEN 分别读：没有代码块的报告；代码块里缺 `verdict` 的报告；`verdict` 是 `ok`、`changedPaths` 是字符串的报告
- THEN `fields` 都是 `null`；问题分别是 `报告结尾没有能解析的 json 代码块`、`报告缺少字段 verdict`、`报告的字段 verdict 只能是 pass、blocked` 和 `报告的字段 changedPaths 应当是路径数组`

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 报告是什么、放在哪里
- `.knit/standards/development.md` — 开发规范
- `next/src/contracts/workflow.ts` — `ReportFieldType`、`isReportEnum`
- `src/application/stage.ts` — 旧的 `fenceCandidates`（第 20–52 行）和 `parseStageReport`（第 95–117 行），只读

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-694fd14e5941 -->
- 操作: op-694fd14e5941
- 时间: 2026-11-15T23:03:26.139Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: f1611368ce5b83d38854ab55dac1c214399bcfa1
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e5-read-report

<!-- knit:progress:end -->
