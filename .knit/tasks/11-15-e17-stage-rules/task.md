---
id: k-1496c8099b1d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-efa866531ee9
order: null
createdAt: 2026-11-15T15:02:52.989Z
title: E17 系统提示里加上对所有环节都成立的规则
---

# E17 系统提示里加上对所有环节都成立的规则

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。交给执行者的系统提示里现在有两样：角色文件（Knit 的模板）和适用本环节的规范（项目自己的）。另有几条规则对所有环节都成立，由程序给，不写在角色文件里：不能提交、不能改受保护的文件、报告怎么给（`.knit/tasks/11-14-slim-refactor/design.md` 第 6.2、7 节）。现在执行者不知道这些规则，只会在违反之后被记为失败。

做完之后的不同：派发时写出的 `system.md` 末尾多一段规则，其中报告要带哪些字段按环节的声明生成。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/stage-rules.ts`（新增） | `stageRules(workflow, stage)`，返回一段文本；只做计算，不读写文件 |
| `next/src/application/run-prepare.ts`（修改） | `system.md` 的内容是 `assembleHandoff` 的系统提示，空一行，再接这段规则 |
| `next/test/stage-rules.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`stageRules(workflow, stage)` 返回的文本：

```
<rules>
- 不要提交，也不要切换或新建分支。结束时 HEAD 变了，这次执行记为失败。
- 不要修改这些文件，改了这次执行记为失败：.knit/standards/ 下的文件、.knit/workflow.yaml、.knit/config.json、.knit/agents/implement.md、.knit/agents/review.md。
- 你的最后一条消息就是这个环节的报告，会原样交给下一个环节和用户。
- 报告的结尾放一个 json 代码块，给出这些字段：
  - verdict：pass、changes_requested、blocked 之一
  - findings：字符串数组
</rules>
```

- 第二条末尾列的是流程里各环节的角色文件（`stage.prompt`），按流程里的先后，同一个文件只列一次；没有环节指定角色文件时就只有前三项。
- 第四条只在这个环节的 `report` 声明了字段时才有，一个字段一行，按声明的先后。类型的说法：`string` 是 `字符串`，`string[]` 是 `字符串数组`，`paths` 是 `路径数组`，`bool` 是 `true 或 false`，枚举是各个值用顿号隔开再加 ` 之一`。
- 同样的输入得到逐字相同的输出。
- 这段规则不计入交接的字节上限。

已有的测试里核对 `system.md` 全文的地方（`next/test/run-prepare.test.mjs`）跟着改；除此之外不改已有的测试。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试（上面说的那一处除外）。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "system.md" next/src/application/run-prepare.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `domain/stage-rules.ts`，改 `application/run-prepare.ts`。
4. 运行 `npm run test:next`，按失败的测试改 `run-prepare.test.mjs` 里核对 `system.md` 全文的地方。
5. 写测试：前两个场景直接调用 `stageRules`，流程用 `parseWorkflow` 解析一段 YAML 得到；第三个场景用 `runProject`、`readyTask`、`prepareRun`。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件、`next/src/application/run-prepare.ts` 的修改，以及 `next/test/run-prepare.test.mjs` 里那一处的改动（有的话）。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): tell every stage the fixed rules`。

## 完成条件

### Requirement: 对所有环节都成立的规则

#### Scenario: 没有声明报告字段的环节

- GIVEN 流程是实现、审查两个环节，各有一份角色文件；实现环节没有声明报告字段
- WHEN 取实现环节的规则
- THEN 文本以 `<rules>` 开头、`</rules>` 结尾，里面正好三条，第二条列着两份角色文件
- AND 文本里没有 `json`

#### Scenario: 声明了报告字段的环节

- GIVEN 审查环节声明了 `verdict: [pass, changes_requested, blocked]`、`findings: string[]`、`changedPaths: paths`、`selfVerified: bool`、`note: string`
- WHEN 取审查环节的规则
- THEN 第四条下面依次是 `verdict：pass、changes_requested、blocked 之一`、`findings：字符串数组`、`changedPaths：路径数组`、`selfVerified：true 或 false`、`note：字符串`
- AND 两个环节共用一份角色文件时，第二条里它只出现一次

#### Scenario: 派发时写进系统提示

- GIVEN 一个已确认的任务
- WHEN 准备一次执行
- THEN `system.md` 的内容是 `assembleHandoff` 给出的系统提示，空一行，再接 `stageRules` 给出的文本
- AND `message.md` 没有变化

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#62-角色文件` — 哪些规则由程序给
- `.knit/tasks/11-14-slim-refactor/design.md#7-执行` — 不能提交、受保护的文件、报告的写法
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-prepare.ts` — 要改的文件
- `next/src/contracts/workflow.ts` — `ReportFieldType`、`isReportEnum`
- `next/src/domain/workflow.ts` — `WorkflowDefinition`、`WorkflowStage`
- `next/test/run-prepare.test.mjs` — 准备执行的测试写法；有一处要跟着改

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-a4bd6344accc -->
- 操作: op-a4bd6344accc
- 时间: 2026-11-15T23:04:51.234Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: 1fb95ed3f6f833df3a255e6e578b75ae6c1e9675
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-e17-stage-rules

<!-- knit:progress:end -->
