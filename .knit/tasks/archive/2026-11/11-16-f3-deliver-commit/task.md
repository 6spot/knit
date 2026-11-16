---
id: k-4922b3e6da70
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-24749f3aa449
order: null
createdAt: 2026-11-16T09:01:04.470Z
title: F3 交付：在 Git 仓库里提交
---

# F3 交付：在 Git 仓库里提交

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。交付是把一个已经完成（`done`）的任务归档；项目在 Git 仓库里时，再把这个任务的改动提交成一次提交。Git 不是必须的：项目不在 Git 仓库里时只归档，不提交。Knit 任何时候都不推送。

`knit deliver <任务> --authorization <引用>` 现在会核对、记下授权、把状态改成 `delivered`、把任务目录移到归档目录（`next/src/cli/deliver.ts`），在 Git 仓库里还不提交。本任务补上提交。

做完之后的不同：在 Git 仓库里交付一个任务，会多出一次提交，里面只有这个任务的文件；工作区里别的改动原样不动。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/delivery.ts`（修改） | 新增 `commitDelivery`，见下 |
| `next/src/cli/deliver.ts`（修改） | 在 Git 仓库里交付时要提交文案；归档之后提交 |
| `next/test/helpers/deliver.mjs`（修改） | 新增 `gitIdentity(dir)`：在临时仓库里用 `git config` 设 `user.name`、`user.email`，把 `commit.gpgsign` 设成 `false`，把 `core.hooksPath` 设成 `.git/hooks`，这样提交不依赖机器上的 Git 配置 |
| `next/test/deliver-commit.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

在 Git 仓库里（`insideGit`）时，`knit deliver <id>` 多做这些：

1. 核对授权之后、改任何东西之前，核对提交文案：没有给 `--message-file` 时拒绝，`在 Git 仓库里交付要给提交文案：加 --message-file <文件>`；文件读不到时 `读不到提交文案：<路径>`；去掉首尾空白之后是空的时 `提交文案是空的：<路径>`。不检查格式。
2. 归档之后调用 `commitDelivery`，输出的第三行是 `提交: <提交号> <首行>`（`git log -1 --format=%h %s` 的输出）；没有要提交的文件时是 `提交: 没有要提交的文件`。

`commitDelivery(root, 输入)`，输入是任务 id、原来的任务目录、归档之后的目录、记录的路径、提交文案：

1. 要提交的文件：`changedAmong(root, [...记录的路径, 原来的任务目录, 归档之后的目录])`。这时任务目录已经移走，所以原目录里跟踪过的文件是删除，归档目录里的文件是新增。
2. 一个文件都没有时不运行 `git add`、`git commit`，返回“没有提交”。不带路径的 `git add -A` 会暂存整个工作区，所以这一步不能省。
3. `git --literal-pathspecs add -A -- <文件…>`。
4. `git --literal-pathspecs commit -q --only -m <说明> -- <文件…>`。说明是文案去掉首尾空白，后面空一行，再加一行 `Knit-Task: <id>`。`--only` 让原来已经暂存的别的文件不进这次提交。不加 `--no-verify`：仓库的 hook 照常运行。
5. 返回提交号和首行。

第 3、4 步 Git 的退出码不是 0 时：本任务先把 Git 的标准错误原样写到标准错误，退出码 1，别的不处理。撤回在下一个任务里做。

提交在当前分支，不核对分支；不推送。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`，不在本仓库里运行 `git add`、`git commit`、`git reset`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "authorization" next/src/cli/deliver.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `delivery.ts`、`cli/deliver.ts`。
4. 写测试，用 `gitProject`、`gitIdentity`、`doneTask`。`next/test/deliver.test.mjs` 用的是不在 Git 仓库里的项目，不需要改；改了它才能通过就停下报告。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): commit only the task's files on delivery`。

## 完成条件

### Requirement: 交付时提交

#### Scenario: 只提交这个任务的文件

- GIVEN Git 仓库里一个已经完成的任务，任务目录已经提交过；记录的路径是 `src/a.ts`（改了）和 `src/b.ts`（新文件）；另外 `src/c.ts` 改了并且已经暂存，`other.txt` 是没有跟踪的新文件
- WHEN 运行 `knit deliver <id> --authorization user:1a2b3c4d --message-file <文件>`
- THEN 退出码是 0，输出是 `已交付 <id>`、`归档: <归档之后的目录>`、`提交: <提交号> <文案的首行>`
- AND 多了一次提交；它的文件是 `src/a.ts`、`src/b.ts`、原任务目录里被删除的文件和归档目录里新增的文件，没有别的；提交里的 `task.md` 状态是 `delivered`；提交说明是文案加一个空行加 `Knit-Task: <id>`
- AND `git status --porcelain` 只剩 `src/c.ts`（仍然是已暂存）和 `other.txt`（仍然没有跟踪）

#### Scenario: 没有提交文案时拒绝

- GIVEN Git 仓库里一个已经完成的任务
- WHEN 运行不带 `--message-file` 的 `knit deliver <id> --authorization user:1a2b3c4d`；再用一个只有空白的文件运行一次
- THEN 退出码都是 1，标准输出是空的，标准错误分别是上面两句话
- AND 任务目录在原处，`task.md`、`record.json` 逐字没有变，`HEAD` 和 `git status --porcelain` 没有变

#### Scenario: 没有要提交的文件时不提交

- GIVEN Git 仓库的 `.gitignore` 里有 `/.knit/` 并且已经提交；一个已经完成的任务，没有记录的路径
- WHEN 运行 `knit deliver <id> --authorization user:1a2b3c4d --message-file <文件>`
- THEN 退出码是 0，输出的第三行是 `提交: 没有要提交的文件`
- AND `HEAD` 没有变，暂存区是空的；任务已经归档，状态是 `delivered`

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付做什么、提交哪些文件
- `.knit/standards/development.md` — 开发规范
- `next/src/application/delivery.ts` — 要改的文件；`insideGit`、`changedAmong`、`previewDelivery` 里记录的路径怎么算
- `next/src/cli/deliver.ts` — 要改的文件
- `next/src/infrastructure/process.ts` — `gitSync`
- `next/test/helpers/deliver.mjs` — `doneTask`
- `next/test/helpers/git.mjs` — `git`、`gitProject`、`commitAll`
- `next/test/deliver.test.mjs` — 上一个任务的测试

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-3d973a098f98 -->
- 操作: op-3d973a098f98
- 时间: 2026-11-16T11:41:58.113Z
- 分支: refs/heads/main
- 授权来源: user:562bcbd5
- 调用: bridge
- 工作提交: 92a820721b75087fbec58f07f11bf3be3295bbe5
- 结果: 正常交付；检查 run-b472d460140b 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-16-f3-deliver-commit

### 任务资料提交记录

<!-- knit:metadata-commit:op-3d973a098f98 -->
- 任务资料提交: 7c60ce6e9ca65fd34fc1fd4da421ad1b67883116
- 归档目标: .knit/tasks/archive/2026-11/11-16-f3-deliver-commit

<!-- knit:progress:end -->
