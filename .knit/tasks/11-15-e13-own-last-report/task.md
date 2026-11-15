---
id: k-5a71e2a2fb37
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-54553f65659d
order: null
createdAt: 2026-11-15T15:02:48.435Z
title: E13 再次进入一个环节时带上它自己上一次的报告
---

# E13 再次进入一个环节时带上它自己上一次的报告

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。审查不通过时任务回到实现环节返工。现在派发时执行者只拿到上一个环节的报告：返工的实现者拿到审查报告，但看不到自己上一次是怎么做的；再次审查的人拿到新的实现报告，但看不到自己上一轮提了哪些问题，只能从头看，每轮可能提出不同的问题，返工就收不住。所以再次进入一个环节时，要把这个环节自己上一次的报告也交给它（`.knit/tasks/11-14-slim-refactor/design.md` 第 5.1、7.1 节）。规则对所有环节相同，不专为审查写。

做完之后的不同：再次进入一个环节的执行者，除了上一个环节的报告，还拿到这个环节自己上一次的报告。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/handoff.ts`（修改） | `assembleHandoff` 的参数多一项 `own` |
| `next/src/application/run-prepare.ts`（修改） | `prepareRun` 算出 `own` 并传进去 |
| `next/test/handoff-own.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`assembleHandoff` 的参数多一项 `own`，可以不给，不给和给 `null` 一样；形状和 `previous` 相同：`{ stage, path, changedPaths, text }`。

- 有 `own` 时，第一条消息里在上一个环节的报告之后多一块，内容的写法和上一个环节的报告相同（先是改动的文件，再是报告原文）：

  ```
  <own-last-report stage="review" path=".knit/.runtime/runs/r-…/report.md">
  改动的文件：无

  报告原文
  </own-last-report>
  ```

- 这一块和上一个环节的报告一样受字节上限约束，超出时换成同样的说明。
- 不给 `own` 时输出和现在逐字相同：`next/test/handoff.test.mjs`、`next/test/handoff-limits.test.mjs` 不改，继续通过。

`prepareRun` 里 `own` 的取法：在算数的执行（`countedRuns`）里，取环节和这次要派发的环节相同的最后一次；它就是 `previous` 那一次时（留在原环节再做）不重复给，`own` 是 `null`；没有这样的执行时也是 `null`。报告路径、改动文件、原文的取法和 `previous` 相同，报告文件不在时原文是 `报告原文不在这台机器上。`。

按这个取法：

| 这次派发 | `previous` | `own` |
| --- | --- | --- |
| 第一次实现 | 没有 | 没有 |
| 第一次审查 | 实现的报告 | 没有 |
| 返工的实现 | 审查的报告 | 自己上一次的实现报告 |
| 再次审查 | 新的实现报告 | 自己上一轮的审查报告 |
| 审查 `blocked` 之后再审查 | 上一次审查的报告 | 没有（就是 `previous`） |

报告里怎么写问题、返工报告怎么逐条回应，写在角色文件里，不在本任务里；程序不校验报告里问题的写法，不给问题编号，也不跨轮比对。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`；不启动真的 Pi，不调用模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "previous-report" next/src/application/handoff.ts` 和 `grep -n "export function prepareRun" next/src/application/run-prepare.ts` 都有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `application/handoff.ts` 和 `application/run-prepare.ts`。
4. 写测试：前两个场景用 `runProject`、`readyTask`、`prepareRun`、`finishRun` 把任务推到要返工的位置，每次执行结束前自己往执行目录里写一份 `report.md`，然后读下一次的 `message.md`；第三个场景直接调用 `assembleHandoff`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/application/handoff.ts`、`next/src/application/run-prepare.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json next/test/handoff.test.mjs next/test/handoff-limits.test.mjs`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): hand a stage its own last report`。

## 完成条件

### Requirement: 带上自己上一次的报告

#### Scenario: 返工和再审时两份报告都拿到

- GIVEN 一个 `independent` 任务：实现结束，审查结论 `changes_requested`
- WHEN 准备返工的实现；它结束之后再准备审查
- THEN 返工的实现的 `message.md` 里，`<previous-report stage="review" …>` 是审查的报告，`<own-last-report stage="implement" …>` 是第一次实现的报告
- AND 再次审查的 `message.md` 里，`<previous-report stage="implement" …>` 是返工的实现报告，`<own-last-report stage="review" …>` 是第一轮的审查报告

#### Scenario: 第一次进入和留在原环节时不多给

- GIVEN 一个 `independent` 任务
- WHEN 准备第一次实现、第一次审查；审查结论 `blocked` 之后再准备一次审查
- THEN 三次的 `message.md` 里都没有 `<own-last-report`
- AND 第三次的 `<previous-report stage="review" …>` 是那次 `blocked` 的审查报告，只出现一次

#### Scenario: 受字节上限约束，不给时和原来相同

- GIVEN 同一个任务，`own` 的报告原文超过 `fileBytes`
- WHEN 分别给 `own`、不给 `own`、给 `own: null` 拼交接内容
- THEN 给的时候 `<own-last-report …>` 块里是“超过单个文件的上限”的说明，`path` 还在
- AND 不给和给 `null` 的结果逐字相同，里面没有 `<own-last-report`

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#71-返工` — 再次进入环节时给什么
- `.knit/tasks/11-14-slim-refactor/design.md#5-交接` — 交接内容和字节上限
- `.knit/standards/development.md` — 开发规范
- `next/src/application/handoff.ts` — 要改的文件
- `next/src/application/run-prepare.ts` — 要改的文件；`previous` 的取法
- `next/src/application/run-finish.ts` — `finishRun`，测试里用它结束一次执行
- `next/test/handoff-limits.test.mjs` — 字节上限的测试写法；修改后要继续通过
- `next/test/run-prepare.test.mjs` — 准备执行的测试写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
