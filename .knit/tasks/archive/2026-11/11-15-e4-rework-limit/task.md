---
id: k-d8f1940a24df
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-c7a5dd15772a
order: null
createdAt: 2026-11-15T15:02:37.540Z
title: E4 数环节的进入次数，到返工上限时不再往下走
---

# E4 数环节的进入次数，到返工上限时不再往下走

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。审查不通过时任务回到实现环节返工，返工有上限：流程里每个环节有 `maxVisits`，表示第一次进入之后还能再进入几次，不写时用返工上限（缺省 5）。每个环节进入过几次不另外保存，从执行记录里数（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.3、6.1、7.1 节）。上一个任务的 `nextStep` 已经能推出下一步做哪个环节，还不管上限。

做完之后的不同：`nextStep` 在下一个环节已经到上限时返回 `limit`，不再返回那个环节。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/progress.ts`（修改） | 新增 `stageEntries(record, stageId)`；`nextStep` 多一种结果 `limit` |
| `next/test/progress-limit.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`stageEntries(record, stageId)` 返回这个环节进入过几次。数法：

- 只看算数的执行（`countedRuns`），按先后排成一串环节。
- 连着的同一个环节只算一次进入：审查结论 `blocked` 之后留在审查环节再做一次，不算新的进入。
- 失败的执行本来就不算数，所以失败之后重新派发同一个环节也不算新的进入。
- 这一串里某个环节出现几段，就是进入过几次。例如实现、审查、审查、实现、审查：实现进入 2 次，审查进入 2 次。

`nextStep` 的变化：按原来的规则得到下一个环节之后，再判断一次。

- 下一个环节和最后一次算数的执行是同一个环节（留在原环节）：不判断上限，照常返回。
- 否则，这个环节的 `maxVisits` 不是 `null`，并且 `stageEntries` 已经大于 `maxVisits`：返回 `{ kind: "limit", stage, entries }`，`entries` 是已经进入的次数。
- 其余情况照常返回。

按这个规则，`maxVisits` 是 5 时一个环节一共能进入 6 次（第一次加 5 轮返工），第 7 次得到 `limit`；`maxVisits` 是 0 时不能再次进入；`maxVisits` 是 `null` 时不设上限。

上一个任务的测试 `next/test/progress.test.mjs` 不改，继续通过。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function nextStep" next/src/domain/progress.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `domain/progress.ts`。
4. 写测试：流程和执行记录的写法照 `next/test/progress.test.mjs`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/domain/progress.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json next/test/progress.test.mjs`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): stop at the rework limit`。

## 完成条件

### Requirement: 进入次数与返工上限

#### Scenario: 留在原环节和失败后重做不算新的进入

- GIVEN 执行记录依次是：实现正常结束、审查 `blocked`、审查 `changes_requested`、实现失败、实现正常结束
- WHEN 数进入次数
- THEN 实现环节是 2 次，审查环节是 1 次
- AND 没有执行过的环节是 0 次

#### Scenario: 到上限时返回 limit

- GIVEN 流程没写 `maxVisits`，返工上限是缺省的 5；实现和审查交替各做了 6 次，最后一次审查的结论是 `changes_requested`
- WHEN 推下一步
- THEN 得到 `limit`，环节是实现，`entries` 是 6
- AND 只各做了 5 次时，同样的结论得到的是实现环节

#### Scenario: 上限可以改，也可以不设

- GIVEN 实现、审查各做了一次，审查的结论是 `changes_requested`
- WHEN 实现环节的 `maxVisits` 分别是 0 和 `null` 时推下一步
- THEN 分别得到 `limit` 和实现环节
- AND 到上限之后把 `confirmedDigest` 换成另一个值（需求改过并重新确认），下一步是实现环节，进入次数回到 0

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#61-流程` — 进入次数怎么数、`maxVisits` 的含义
- `.knit/tasks/11-14-slim-refactor/design.md#71-返工` — 返工上限
- `.knit/standards/development.md` — 开发规范
- `next/src/domain/progress.ts` — 要改的文件
- `next/src/domain/workflow.ts` — `WorkflowStage.maxVisits` 和缺省的返工上限
- `next/test/progress.test.mjs` — 流程和执行记录在测试里的写法；修改后要继续通过

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-15T15:02:38.373Z
- 方式: self → independent；理由: 状态推进、改动对比、受保护的路径属于正确性没法自证的改动

### 交付记录

<!-- knit:delivery:op-f16d4672af18 -->
- 操作: op-f16d4672af18
- 时间: 2026-11-15T23:03:20.631Z
- 分支: refs/heads/main
- 授权来源: user:1d2d626e
- 调用: bridge
- 工作提交: c868595549c69e86548506da5b30ff284436b48b
- 结果: 正常交付；检查 run-2284d2e1f181 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-15-e4-rework-limit

### 任务资料提交记录

<!-- knit:metadata-commit:op-f16d4672af18 -->
- 任务资料提交: f77bf7f3e28d59c03ce2caa263efd2beb2404479
- 归档目标: .knit/tasks/archive/2026-11/11-15-e4-rework-limit

<!-- knit:progress:end -->
