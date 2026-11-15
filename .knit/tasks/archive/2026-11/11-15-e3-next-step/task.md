---
id: k-c7a5dd15772a
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-e75083172b7d
order: null
createdAt: 2026-11-15T15:02:36.172Z
title: E3 从执行记录推出下一步做哪个环节
---


# E3 从执行记录推出下一步做哪个环节

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。小核心不单独保存“任务走到哪了”：下一步做哪个环节，每次都从流程定义和 `record.json` 里的执行记录推出来（`.knit/tasks/11-14-slim-refactor/design.md` 第 6.1 节）。现在 `next/` 里能解析流程（`next/src/domain/workflow.ts`）、能读写执行记录（`next/src/domain/task-record.ts`），还没有把两者合起来的代码。

做完之后的不同：`next/` 里有了 `nextStep`，给它流程、任务的验证方式和执行记录，得到下一步是派发哪个环节，还是所有环节都做完了。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/progress.ts`（新增） | `countedRuns(record)`、`nextStep(workflow, verification, record)`；只做计算，不读写文件 |
| `next/test/progress.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`countedRuns(record)` 返回算数的执行，保持原来的先后。一次执行同时满足下面三条才算数：

- 已经结束：`endedAt` 不是 `null`。
- 没有失败：`failure` 是 `null`。
- 是按现在的需求做的：`requirementDigest` 等于 `record.confirmedDigest`。需求改过并重新确认之后摘要会变，以前的执行就都不算数了。

`nextStep(workflow, verification, record)` 返回 `{ kind: "stage", stage }`（`stage` 是流程定义里的那个环节）或 `{ kind: "close" }`（所有环节都做完了，交回主会话 `task close`）。规则：

1. 任务要走的环节：`verification` 是 `independent` 时是流程里的全部环节；是 `self` 或 `none` 时去掉审查环节。审查环节指 `report` 里声明了 `verdict` 的环节。旧 Knit 也是这样：`self`、`none` 的任务做完实现就收尾。
2. 没有算数的执行：下一步是任务要走的第一个环节；一个都没有时是 `close`。
3. 有算数的执行：看最后一次。
   - 它的 `verdict` 在它所在环节的 `onVerdict` 里有去向：去向是 `deliver` 时是 `close`，否则是那个环节。去向按流程里的全部环节找。
   - 否则是流程里排在它后面的环节中、任务要走的第一个；没有就是 `close`。
   - 它所在的环节已经不在流程里（流程改过）：从任务要走的第一个环节开始。
4. 正在跑的执行不影响结果；有没有执行者在跑由调用方另外判断。

进入次数和返工上限不在本任务里，由下一个任务加。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里已有的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "failure" next/src/contracts/task.ts` 有输出（执行记录已经有 `failure` 字段）。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 写 `domain/progress.ts`。
4. 写测试：流程用 `parseWorkflow`（`next/dist/domain/workflow.js`）解析一段 YAML 得到，写法照 `next/test/workflow.test.mjs`；执行记录直接手写对象。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 2 个新文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): derive the next stage from the run records`。

## 完成条件

### Requirement: 推出下一步

#### Scenario: 按顺序往下走

- GIVEN 流程是实现、审查两个环节，审查环节声明了 `verdict`
- WHEN 分别对没有执行过的任务、实现正常结束的任务、审查结论是 `pass` 的任务推下一步
- THEN `independent` 任务依次得到实现环节、审查环节、`close`
- AND `self` 任务没有执行过时得到实现环节，实现正常结束后得到 `close`

#### Scenario: 按结论跳转

- GIVEN 审查环节的 `onVerdict` 是 `changes_requested: implement`、`blocked: review`
- WHEN 最后一次算数的执行是审查，结论分别是 `changes_requested`、`blocked`
- THEN 下一步分别是实现环节、审查环节
- AND 某个环节的 `onVerdict` 把结论指到 `deliver` 时，下一步是 `close`

#### Scenario: 不算数的执行不影响下一步

- GIVEN 实现正常结束过一次，之后还有三次审查的执行：一次失败、一次正在跑、一次的 `requirementDigest` 和 `confirmedDigest` 不同
- WHEN 推下一步
- THEN 得到审查环节，`countedRuns` 只返回那一次实现
- AND 把 `confirmedDigest` 换成另一个值之后，`countedRuns` 是空的，下一步是实现环节

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#61-流程` — 下一步怎么推、`self`／`none` 的任务不进审查环节
- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — 执行记录的字段
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/workflow.ts` — `WorkflowDefinition`、`WorkflowStage`、`parseWorkflow`
- `next/src/contracts/task.ts` — `TaskRecord`、`TaskRun`、`TaskFrontmatter`
- `next/test/workflow.test.mjs` — 在测试里解析流程的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-15T15:02:37.023Z
- 方式: self → independent；理由: 状态推进、改动对比、受保护的路径属于正确性没法自证的改动

### 交付记录

<!-- knit:delivery:op-2af563856ac4 -->
- 操作: op-2af563856ac4
- 时间: 2026-11-15T23:03:15.087Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: c216ef00241fe74b4c530cef02cff56a50115c2c
- 结果: 正常交付；检查 run-990a9202f25a 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-15-e3-next-step

### 任务资料提交记录

<!-- knit:metadata-commit:op-2af563856ac4 -->
- 任务资料提交: 870b8e083bc8d795f646e28c75ea921c618cee04
- 归档目标: .knit/tasks/archive/2026-11/11-15-e3-next-step

<!-- knit:progress:end -->
