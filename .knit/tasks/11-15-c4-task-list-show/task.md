---
id: k-0e1db9419488
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-f0af41e0619b
order: null
createdAt: 2026-11-15T07:48:51.692Z
title: C4 next 的 knit task list 和 show：查看任务
---

# C4 next 的 knit task list 和 show：查看任务

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。C3 已经能创建任务并扫描任务目录。本任务加上两个只读的查看命令。

做完之后的不同：`node next/dist/cli/knit.js task list` 列出任务，`task show <id>` 显示一个任务的情况。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/task.ts`（修改） | 注册 `task list` 和 `task show` |
| `next/test/task-view.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

两个命令都接受 `--dir <目录>`（默认当前目录），都只读、不改任何文件，只做人读的输出，不做 `--json`。任务的状态一律用 C1 的 `currentStatus` 算。

`task list`：

- 默认列 `.knit/tasks/` 下没归档的任务；带 `--archive` 时改列已归档的。
- 先按优先级（`P0` 在前），同一优先级按创建时间（早的在前）。
- 一个任务一行：优先级、id、状态、标题。状态是 `active` 时写成 `active(<环节 id>)`。文件里是 `ready` 或 `active`、但确认后改过需求的任务，状态写 `draft`，行尾加 `（确认后改过需求）`。
- `task.md` 读不出来的任务排在最后，一个一行：目录和第一条问题。
- 一个任务都没有时打印 `没有任务`。退出码都是 0。

`task show <id>`：按下面的顺序一行一项，没有内容的项照写“无”：

```
标题: 交接只传需求部分
ID: k-19c962be9fb8
状态: ready
验证: self
优先级: P2
父任务: 无
依赖: 无
目录: .knit/tasks/11-15-handoff
完成条件: 2 个场景
待澄清: 1 项 blocking，0 项 assumed
改动文件（2）:
  next/src/a.ts
  next/src/b.ts
```

- 「状态」的写法同 `task list`；确认后改过需求的写 `draft（确认后改过需求，需要重新 task ready）`。
- 「完成条件」「待澄清」用 C2 的 `scenarioStateOf`、`clarifyStateOf` 对需求部分算；场景有写法问题时在后面加 `，N 处写法问题`。
- 「改动文件」是 `record.json` 里 `changedPaths` 和各次执行的 `changedPaths` 合起来，去重后按路径排序；一个都没有时不打印这一项。
- 已归档的任务也能查到。
- 任务不存在时在标准错误里打印 `没有任务 <id>；用 knit task list 查看现有任务`，退出码 1。任务的 `task.md` 有格式问题时把问题逐条打印到标准错误，退出码 1。
- 提交号不在本任务里做：它要按提交说明里的任务标记去查 Git，等交付的任务定了标记再加。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- C1、C2 的文件和 `next/src/application/task-store.ts`：本任务只调用。发现问题写进报告，不在本任务里改。
- 不要拿本仓库的 `.knit/tasks/` 验证：这里的任务还是旧格式，会全部显示成格式有问题。所有验证都在临时目录里做。
- 不加依赖，不提交、不推送。

前置条件：C3 已完成。运行 `npm run test:next` 能通过，并且 `ls next/src/application/task-store.ts next/src/domain/task-requirements.ts next/test/helpers/cli.mjs` 都存在。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 在 `cli/task.ts` 里加两个命令。
4. 写测试：用 `next/test/helpers/cli.mjs` 建临时项目，用 `task new` 建任务，需要别的状态或 `record.json` 时直接改写临时项目里的文件。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和 `next/src/cli/task.ts` 的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add task list and show`。

## 完成条件

### Requirement: 查看任务

#### Scenario: 列出任务

- GIVEN 项目里有一个 `P2` 的任务、一个 `P0` 的任务和一个 `task.md` 写坏了的任务目录
- WHEN 运行 `task list`
- THEN `P0` 的任务排在 `P2` 的前面，每行有 id、状态和标题
- AND 写坏的那个排在最后并带着问题说明，退出码为 0

#### Scenario: 显示一个任务

- GIVEN 一个任务的「完成条件」里有两个场景、「待澄清」里有一项 `[blocking]`，`record.json` 里登记了两个改动文件
- WHEN 运行 `task show <id>`
- THEN 输出里有标题、状态、`完成条件: 2 个场景`、`待澄清: 1 项 blocking，0 项 assumed` 和两个改动文件

#### Scenario: 确认后改过需求

- GIVEN 一个任务文件里的状态是 `ready`，`record.json` 里的确认摘要和现在的需求部分不一致
- WHEN 运行 `task list` 和 `task show <id>`
- THEN 两处显示的状态都是 `draft`，并说明确认后改过需求

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 3 节、第 9 节 — 任务资料与状态；命令清单
- `.knit/standards/development.md` — 开发规范
- `next/src/application/task-store.ts` — 扫描和查找任务
- `next/src/domain/task-document.ts`、`next/src/domain/task-requirements.ts` — `currentStatus`、场景和待澄清的解析
- `next/src/cli/task.ts`、`next/test/task-new.test.mjs`、`next/test/helpers/cli.mjs` — 命令和命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-5cc834e8603b -->
- 操作: op-5cc834e8603b
- 时间: 2026-11-15T09:06:44.732Z
- 分支: refs/heads/main
- 授权来源: user:0f1c5bab
- 调用: bridge
- 工作提交: 13ef0193ed0cfd6b92a757e31cc8558e25585991
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-c4-task-list-show

<!-- knit:progress:end -->
