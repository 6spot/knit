---
id: k-556ab550faf6
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-4922b3e6da70
order: null
createdAt: 2026-11-16T09:01:05.185Z
title: F4 交付：提交被拒绝时撤回，提交的内容不对时报告
---

# F4 交付：提交被拒绝时撤回，提交的内容不对时报告

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。交付是把一个已经完成（`done`）的任务归档；项目在 Git 仓库里时，再把这个任务的改动提交成一次提交。Git 不是必须的：项目不在 Git 仓库里时只归档，不提交。Knit 任何时候都不推送。

在 Git 仓库里，`knit deliver` 先把任务归档，再用 `commitDelivery`（`next/src/application/delivery.ts`）提交。现在提交出问题时没有处理：

- Git 拒绝提交（例如 pre-commit hook 失败）时，任务已经归档、状态已经是 `delivered`，文件已经暂存，却没有提交。
- hook 改了提交的内容（多加或者拿掉了文件）时，没有人知道。

做完之后的不同：Git 拒绝提交时，交付撤回到运行之前的样子，可以修好之后再交付一次；提交里的文件和预期的不一样时，输出里说出差在哪里。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/delivery.ts`（修改） | `commitDelivery` 在 Git 拒绝时返回 Git 的错误和已经暂存的文件；提交之后核对提交里的文件 |
| `next/src/cli/deliver.ts`（修改） | Git 拒绝时撤回；文件不一样时在输出里说明 |
| `next/test/deliver-problems.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

Git 拒绝（`git add` 或 `git commit` 的退出码不是 0）时，依次：

1. `git --literal-pathspecs reset -q -- <要提交的文件…>`：把这次暂存的撤掉。这些文件里如果有交付之前就已经暂存的，撤回之后也变成没有暂存，内容不丢；不为此在交付之前保存暂存区。
2. 把任务目录从归档目录移回原处。
3. 重新读出这个任务（`findTask`），用 `saveTask` 把 `task.md` 和 `record.json` 写回交付之前读到的内容：状态 `done`，`authorization` 是原来的值。
4. 把 Git 的标准错误原样写到标准错误，后面加一行 `Git 没有接受这次提交，交付已经撤回：任务目录在 <原目录>，状态是 done`，退出码 1。

提交成功之后核对：`git show --name-only --no-renames -z --format= HEAD` 列出的文件，和提交之前算出来的要提交的文件比。不一样时提交保留、任务仍然是已交付，在输出的三行后面加：

```
注意：提交里的文件和预期的不一样，提交保留
  多了: <路径>、<路径>
  少了: <路径>
```

“多了”“少了”各自有内容才出现，路径按字典序。退出码是 0：交付已经做完，没有可以重试的。

不做的：撤回本身失败（例如任务目录移不回去）的处理；这时让错误直接抛出来。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`，不在本仓库里运行 `git add`、`git commit`、`git reset`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function commitDelivery" next/src/application/delivery.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `delivery.ts`、`cli/deliver.ts`。
4. 写测试。hook 写在临时仓库的 `.git/hooks/pre-commit`，要有执行权限；先调用 `gitIdentity`，它把 `core.hooksPath` 设成了 `.git/hooks`。拒绝的 hook：往标准错误写一行然后 `exit 1`。改内容的 hook：`git rm -q --cached src/b.ts`，再新建 `hooked.txt` 并 `git add hooked.txt`。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：本任务要求独立审查，由另一个执行者对照完成条件审查；提交由用户另行授权，文案首行建议 `feat(next): undo a delivery that Git refuses to commit`。

## 完成条件

### Requirement: 提交出问题时

#### Scenario: Git 拒绝提交时撤回

- GIVEN Git 仓库里一个已经完成的任务，任务目录已经提交过，记录的路径是 `src/a.ts`（改了）和 `src/b.ts`（新文件）；另外 `src/c.ts` 改了并且已经暂存；pre-commit hook 往标准错误写 `lint failed` 然后失败
- WHEN 运行 `knit deliver <id> --authorization user:1a2b3c4d --message-file <文件>`
- THEN 退出码是 1，标准输出是空的，标准错误里有 `lint failed`，最后一行是 `Git 没有接受这次提交，交付已经撤回：任务目录在 <原目录>，状态是 done`
- AND `HEAD` 没有变；`git status --porcelain` 和运行之前相同；任务目录在原处，归档目录里没有它；`task.md`、`record.json` 和运行之前逐字相同
- AND 去掉 hook 之后再运行同一条命令，退出码是 0，任务交付成功

#### Scenario: hook 改了提交的内容时报告差别

- GIVEN 同样的任务；pre-commit hook 把 `src/b.ts` 从提交里拿掉，又加进一个 `hooked.txt`
- WHEN 运行 `knit deliver <id> --authorization user:1a2b3c4d --message-file <文件>`
- THEN 退出码是 0，输出的前三行是 `已交付`、`归档`、`提交`，后面是 `注意：提交里的文件和预期的不一样，提交保留`、`  多了: hooked.txt`、`  少了: src/b.ts`
- AND 提交还在，任务已经归档，状态是 `delivered`

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — Git 拒绝时怎么办、提交之后核对什么
- `.knit/standards/development.md` — 开发规范
- `next/src/application/delivery.ts` — 要改的文件；`commitDelivery`
- `next/src/cli/deliver.ts` — 要改的文件
- `next/src/application/task-store.ts` — `findTask`、`saveTask`
- `next/test/helpers/deliver.mjs` — `doneTask`、`gitIdentity`
- `next/test/deliver-commit.test.mjs` — 上一个任务的测试，准备仓库和任务的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-da8253e91ce3 -->
- 操作: op-da8253e91ce3
- 时间: 2026-11-16T11:42:10.288Z
- 分支: refs/heads/main
- 授权来源: user:562bcbd5
- 调用: bridge
- 工作提交: daa0a121e0563fe5060cbc330ab015d4837270ab
- 结果: 正常交付；检查 run-7869846711d4 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-16-f4-deliver-problems

<!-- knit:progress:end -->
