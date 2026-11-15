---
id: k-7d0b4cd7be3b
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-5a71e2a2fb37
order: null
createdAt: 2026-11-15T15:02:49.581Z
title: E14 到返工上限时列出各轮报告和可以走的路
---

# E14 到返工上限时列出各轮报告和可以走的路

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。返工到了上限，程序停下，把事情交回主会话。这时不生成汇总：只列出各轮报告在哪里，以及可以走的四条路，四条路是固定的文字（`.knit/tasks/11-14-slim-refactor/design.md` 第 7.1 节）。现在到上限时 `run start` 和 `run status` 只有一句“到了上限”。

做完之后的不同：到返工上限时，`knit run start` 的拒绝和 `knit run status` 的“下一步”都列出各轮报告的路径和四条可以走的路。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/run-prepare.ts`（修改） | 新增 `limitNotice(taskId, workflow, record, step)`，`prepareRun` 到上限时返回它 |
| `next/src/cli/run.ts`（修改） | `run status` 到上限时用它 |
| `next/test/run-limit.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`limitNotice(taskId, workflow, record, step)` 返回一组行，`step` 是 `nextStep` 给出的 `limit` 结果：

```
<环节名>环节已经进入 <次数> 次，到了上限，不再派发。各轮的报告：
  <环节名>（<run-id>）<结论>：<执行目录>/report.md
  …
可以走的路：
  1. 主会话直接修，改完运行 knit task close <id> --paths <改动的文件>
  2. 拆成更小的任务
  3. 需求本身有问题就改需求，再运行 knit task ready <id>；进入次数从头数
  4. 用户决定带理由接受：knit task close <id> --reason <理由>
```

- “各轮的报告”列的是算数的执行（`countedRuns`），按先后一行一次；有结论的写结论，没有结论的这一处不写。失败的、需求改之前的执行不列。
- 环节名用流程里的 `name`。
- 不读报告的内容，不生成汇总。

`prepareRun`：`nextStep` 是 `limit` 时，`problems` 是这一组行（代替原来那一句）。

`knit run status`：`nextStep` 是 `limit` 时，“下一步”那一行换成 `下一步: ` 接这一组行的第一行，其余的行照原样跟在后面。

已有的测试里核对“到了上限”那一句的地方跟着改；除此之外不改已有的测试。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "到了上限" next/src/application/run-prepare.ts next/src/cli/run.ts` 两个文件都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `application/run-prepare.ts` 和 `cli/run.ts`。
4. 运行 `npm run test:next`，按失败的测试改已有测试里核对那一句的地方。
5. 写测试：流程里把实现环节的 `maxVisits` 写成 1，用 `prepareRun`、`finishRun` 把任务推到上限，不用真的走 5 轮。
6. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件、`next/src/application/run-prepare.ts` 和 `next/src/cli/run.ts` 的修改，以及已有测试里核对“到了上限”那一句的改动（有的话）。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): list the reports at the rework limit`。

## 完成条件

### Requirement: 到上限时停下

#### Scenario: 派发被拒绝时列出各轮报告和四条路

- GIVEN 实现环节的 `maxVisits` 是 1；任务依次做过实现、审查（`changes_requested`）、实现、审查（`changes_requested`），中间还有一次失败的实现
- WHEN 运行 `knit run start <任务>`
- THEN 退出码是 1；标准错误的第一行是 `实现环节已经进入 2 次，到了上限，不再派发。各轮的报告：`，后面四行是四次算数的执行，审查的两行带着 `changes_requested`，失败的那次不在里面
- AND 再后面是 `可以走的路：` 和四条，里面的任务 id 是这个任务的；没有建出新的执行目录

#### Scenario: run status 的下一步显示同样的内容

- GIVEN 同一个任务
- WHEN 运行 `knit run status <任务>`
- THEN 退出码是 0；有一行是 `下一步: 实现环节已经进入 2 次，到了上限，不再派发。各轮的报告：`
- AND 后面跟着各轮的报告和四条路，和派发被拒绝时的相同

#### Scenario: 改需求并重新确认之后可以再派发

- GIVEN 同一个任务
- WHEN 改 `task.md` 的需求部分，运行 `knit task ready <任务>`，再运行 `knit run status <任务>`
- THEN 下一步是 `派发实现环节（knit run start <id>）`
- AND 这时 `prepareRun` 能准备出实现环节的执行

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#71-返工` — 到上限时做什么、四条路
- `.knit/standards/development.md` — 开发规范
- `next/src/application/run-prepare.ts` — 要改的文件
- `next/src/cli/run.ts` — 要改的文件
- `next/src/domain/progress.ts` — `countedRuns`、`nextStep` 的 `limit` 结果
- `next/test/run-status.test.mjs` — `run status` 的测试写法
- `next/test/run-prepare.test.mjs` — 准备执行的测试写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
