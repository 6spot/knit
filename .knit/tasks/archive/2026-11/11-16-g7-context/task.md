---
id: k-952f2f199c14
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-3e355531eadb
order: null
createdAt: 2026-11-16T15:19:34.071Z
title: G7 knit context：主会话每轮收到的内容
---

# G7 knit context：主会话每轮收到的内容

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。规范文件在 `.knit/standards/`，每份在开头声明适用的环节。派给执行者时，程序已经会按环节挑出规范放进交接内容。主会话还收不到：本任务做一条命令，输出主会话每一轮该看到的内容——一个任务的状态、下一步，和适用它当前环节的规范。桥接在后面的任务里把这段输出放进系统提示。

做完之后的不同：`knit context <任务>` 输出这个任务的状态、下一步和当前环节的规范；任务的状态没变时，输出逐字不变。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/domain/progress.ts`（修改） | 新增 `sessionStage`，见下 |
| `next/src/cli/run.ts`（修改） | 把 `run status` 里拼输出的那几行提成导出的 `statusLines(root, workflow, document, record)`，`run status` 改用它，输出不变 |
| `next/src/cli/context.ts`（新增） | `registerContextCommand(program)`：命令 `knit context <id>`，选项 `--dir <目录>` |
| `next/src/cli/knit.ts`（修改） | 注册这个命令 |
| `next/test/context.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`sessionStage(workflow, verification, record, status)`：主会话现在该按哪个环节的规范做事，返回环节的 id 或 `null`。`status` 是 `currentStatus` 算出来的状态。

| 状态 | 返回 |
| --- | --- |
| `draft` | `discuss` |
| `ready`、`active`，有一次执行还没结束 | 那次执行的环节 |
| `ready`、`active`，没有在跑的执行 | 按 `nextStep`：下一步是某个环节（包括已经到进入上限的）就是它的 id；环节都做完了（等主会话核对和 `task close`）是 `deliver` |
| `done` | `deliver` |
| `delivered`、`cancelled` | `null` |

`knit context <id>` 的输出：

```
任务: 加问候语（k-1a2b3c4d5e6f）
状态: ready
还没有派发过
下一步: 派发实现环节（knit run start k-1a2b3c4d5e6f）
目录: .knit/tasks/11-16-greeting
规范（implement 环节）:
<standard path=".knit/standards/development.md" title="开发规范">
……规范的正文……
</standard>

<standard path=".knit/standards/pitfalls.md" title="避坑清单">
……
</standard>
```

- 前几行就是 `statusLines` 的结果，和 `knit run status <id>` 的输出相同。
- 接着是 `目录:` 一行，任务目录相对项目根的路径。
- `sessionStage` 是 `null` 时到此为止。
- 否则是 `规范（<环节 id> 环节）:` 一行，后面是适用这个环节的每份规范（`loadStandards` 加 `standardsForStage`，已经按路径排好），每份的写法和交接内容里的一样（`next/src/application/handoff.ts` 里 `standard` 那一块），两份之间空一行。一份也没有时这一行写成 `规范（<环节 id> 环节）: 没有`。
- 任务不存在、任务文件有格式问题、流程文件不存在或有错：和 `knit run status` 一样报错，退出码 1。
- 输出里不能有每次运行都会变的内容（当前时间、耗时）。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。本仓库的 `assets/templates/`、`.pi/extensions/knit.ts` 和 `.knit/` 下的流程、角色文件是旧 Knit 的，不改。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/` 和 `.pi/`，不调用真的 Pi 和模型。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "knit_run" next/assets/templates/pi/extensions/knit.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `progress.ts`、`cli/run.ts`，写 `cli/context.ts`，在 `cli/knit.ts` 里注册。
4. 写测试。规范文件直接写进临时项目的 `.knit/standards/`；要一次已经结束的执行时，照 `next/test/run-status.test.mjs` 的做法用 `prepareRun` 和 `finishRun`，不启动假 Pi。`next/test/run-status.test.mjs`、`next/test/run-limit.test.mjs` 不需要改；改了它们才能通过就停下报告。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add knit context for the main session`。

## 完成条件

### Requirement: 按任务的状态给出当前环节的规范

#### Scenario: 各个状态给对应环节的规范

- GIVEN 临时仓库里有三份规范：`a.md` 适用 `discuss`，`b.md` 适用 `implement` 和 `review`，`c.md` 适用 `deliver`；一个要求独立审查的任务
- WHEN 在这几个时候各运行一次 `knit context <id>`：需求还没确认；确认之后；实现环节的执行正常结束之后；审查环节的执行以 `pass` 结束之后；`task close` 之后
- THEN 退出码都是 0；`规范（…环节）:` 一行里的环节依次是 `discuss`、`implement`、`review`、`deliver`、`deliver`
- AND 后面的规范依次只有 `a.md`、`b.md`、`b.md`、`c.md`、`c.md`，每份是 `<standard path="…" title="…">`、正文、`</standard>`
- AND 每一次，`目录:` 之前的那几行都和这时候 `knit run status <id>` 的输出相同

#### Scenario: 没有规范和已经结束的任务

- GIVEN 临时项目里只有一份适用 `discuss` 的规范；一个已经确认的任务，一个已经取消的任务
- WHEN 对两个任务各运行 `knit context <id>`
- THEN 前一个的输出最后一行是 `规范（implement 环节）: 没有`
- AND 后一个的输出最后一行是 `目录:` 那一行，里面没有 `规范`

#### Scenario: 状态没变时输出逐字不变

- GIVEN 上面第一个场景里确认之后的任务
- WHEN 连着运行两次 `knit context <id>`
- THEN 两次的标准输出逐字相同
- AND 对一个不存在的任务运行：退出码是 1，标准输出是空的，标准错误和 `knit run status` 对不存在的任务报的相同

## 待澄清



## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#51-给谁什么` — 主会话每轮收到什么；按任务的状态给哪个环节的规范
- `.knit/tasks/11-14-slim-refactor/design.md#4-规范` — 规范怎么声明适用的环节；固定的 `discuss` 和 `deliver`
- `.knit/tasks/11-14-slim-refactor/design.md#9-命令与工具` — 每轮注入的内容就是这条命令的输出
- `next/src/domain/progress.ts` — 要改的文件：`nextStep`
- `next/src/cli/run.ts` — 要改的文件：`run status`
- `next/src/cli/task.ts` — `loadTask`、`fail`
- `next/src/cli/workflow.ts` — `loadWorkflow`
- `next/src/application/standards-store.ts` — `loadStandards`
- `next/src/domain/standards.ts` — `standardsForStage`
- `next/src/application/handoff.ts` — 交接内容里一份规范的写法
- `next/test/run-status.test.mjs` — 不启动假 Pi 就得到一次结束的执行的做法
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`
- `.knit/standards/development.md` — 开发规范

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-6c3eb8c59e54 -->
- 操作: op-6c3eb8c59e54
- 时间: 2026-11-17T01:01:45.347Z
- 分支: refs/heads/main
- 授权来源: user:a743f72d
- 调用: bridge
- 工作提交: bb38eda65a2d3d5f250110019b45de24894dcbc6
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-g7-context

### 任务资料提交记录

<!-- knit:metadata-commit:op-6c3eb8c59e54 -->
- 任务资料提交: 3a90397c1b24787474f0c0c6631ec4c5c7908006
- 归档目标: .knit/tasks/archive/2026-11/11-16-g7-context

<!-- knit:progress:end -->
