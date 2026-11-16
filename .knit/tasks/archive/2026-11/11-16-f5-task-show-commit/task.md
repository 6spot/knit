---
id: k-03153b12d5f2
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-556ab550faf6
order: null
createdAt: 2026-11-16T09:01:05.935Z
title: F5 task show：显示交付的提交
---

# F5 task show：显示交付的提交

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。在 Git 仓库里交付一个任务会产生一次提交，提交说明的最后一行是 `Knit-Task: <任务 id>`（`commitDelivery`，`next/src/application/delivery.ts`）。提交号不写进任务文件，要看的时候从 Git 记录里查。现在 `knit task show` 不显示它。

做完之后的不同：`knit task show <已交付的任务>` 多一行，写着交付它的那次提交。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/task.ts`（修改） | `task show` 对已交付的任务多输出一行 `提交` |
| `next/test/task-show-commit.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

`task show` 的改动：

- 任务的状态是 `delivered` 时，运行 `git log -1 --format=%h %s --fixed-strings --grep "Knit-Task: <id>"`（用 `gitSync`，参数是数组，不拼成一条命令）。退出码是 0 并且有输出时，在 `目录:` 一行的后面加一行 `提交: <提交号> <首行>`。
- 别的状态不运行 Git。
- 项目不在 Git 仓库里、仓库还没有提交（这时 `git log` 的退出码不是 0）、或者找不到这样的提交时，没有这一行，也不报错。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`，不在本仓库里运行 `git add`、`git commit`、`git reset`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "Knit-Task" next/src/application/delivery.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `cli/task.ts`。
4. 写测试：用 `knit deliver` 把任务交付掉，再运行 `knit task show`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): show the delivery commit in task show`。

## 完成条件

### Requirement: task show 显示交付的提交

#### Scenario: 在 Git 仓库里交付过的任务

- GIVEN Git 仓库里一个任务，已经用 `knit deliver` 交付并产生了提交
- WHEN 运行 `knit task show <id>`
- THEN 退出码是 0，输出里 `目录:` 一行的后面是 `提交: <提交号> <提交文案的首行>`，提交号和 `git log -1 --format=%h` 的输出相同

#### Scenario: 没有提交可以显示

- GIVEN 不在 Git 仓库里的项目里一个已经交付的任务；和 Git 仓库里一个已经完成、还没有交付的任务
- WHEN 分别运行 `knit task show <id>`
- THEN 退出码都是 0，输出里没有以 `提交:` 开头的行，标准错误是空的

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 提交说明里的 `Knit-Task` 一行
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/task.ts` — 要改的文件；`task show`
- `next/src/infrastructure/process.ts` — `gitSync`
- `next/test/helpers/deliver.mjs` — `doneTask`、`gitIdentity`
- `next/test/deliver-commit.test.mjs` — 在 Git 仓库里交付一个任务的写法
- `next/test/task-view.test.mjs` — `task show` 现有的测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-e381afd3595e -->
- 操作: op-e381afd3595e
- 时间: 2026-11-16T11:42:22.452Z
- 分支: refs/heads/main
- 授权来源: user:562bcbd5
- 调用: bridge
- 工作提交: e05ad1860b2a657de7780bf6a7569ecf1a638691
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-f5-task-show-commit

### 任务资料提交记录

<!-- knit:metadata-commit:op-e381afd3595e -->
- 任务资料提交: e4fbf7546a185ad7c634a6b9ef315d1b3f248555
- 归档目标: .knit/tasks/archive/2026-11/11-16-f5-task-show-commit

<!-- knit:progress:end -->
