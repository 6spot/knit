---
id: k-28cd41e01e93
title: W1：派发的执行者在任务自己的 Worktree 里执行
status: delivered
stage: null
verification: independent
parent: k-7c16fc6dfc6f
dependsOn: []
priority: P1
createdAt: 2026-11-20T07:16:40.399Z
---

## 目标与范围

现在 `knit run start` 派发的执行者在主检出里工作。一次执行改了哪些文件，是拿派发时和结束时的工作区对比出来的，分不出是谁改的：2026-11-19 的执行 `r-5f861db2a268` 进行期间，用户在主检出里手动改了 `.knit/workflow.yaml`，结束时被记成「执行者改了受保护的文件」，这次执行算失败。

本任务让派发的执行者在任务自己的 Git Worktree 和分支里工作。做完之后：执行者改的文件落在 Worktree 里，主检出不变；改动对比、「执行者不能提交」和受保护文件的检查都看 Worktree，主检出里别人的改动不再算到执行者头上。

这是 Worktree 功能的第一个子任务。整体设计在主任务的 `design.md`，本任务只做其中第 2 节（不含准备命令）和第 3 节（不含交接内容）。

要做到的：

- 位置和分支：Worktree 在 `<Knit 的用户目录>/worktrees/<项目目录名>-<摘要>/<任务目录名>/`，分支是 `knit/<任务目录名>`。Knit 的用户目录缺省是用户主目录下的 `.knit`，环境变量 `KNIT_HOME` 有值时用它。摘要是主检出真实路径的 SHA-256 前 8 位。两者都是算出来的，不往任务记录里存。
- 什么时候建：派发时没有就建，从主检出当时的 `HEAD` 开分支；已经有了就直接用，返工和审查用的是同一个。目录不在了而分支还在时，按那个分支重新检出。
- 建 Worktree 放在其它拒绝派发的条件都通过之后。建不出来时拒绝派发，原样给出 Git 的错误，任务的执行记录里不留这一次。
- 仓库还没有提交时拒绝派发，提示先提交一次：这时建出来的 Worktree 是空的，执行者看不到项目。
- 执行者（后台和 Rex 窗格两种方式）的工作目录是 Worktree。派发时和结束时的工作区记录在 Worktree 里拍，记下的改动文件是 Worktree 里的相对路径。
- Knit 自己读的东西仍然来自主检出：流程、规范、配置、角色文件、任务目录、运行资料（`.knit/.runtime/`）。
- 主会话要知道去哪里核对：`knit run start` 的输出，以及看任务状态的地方（`knit run status`、每轮给主会话的任务状态），在任务有 Worktree 时多一行它的位置和分支。这一行的内容在任务状态不变时不能变。
- Windows 上也要成立：用户主目录用 `os.homedir()` 取，文件路径用 `node:path` 拼，不手写 `/`；Git 仍然用参数数组调用。Windows 上没法在这台机器上试，报告里照实写没有试过。
- `docs/design/DESIGN.md` 改成现行做法：第 2 节目录布局加上 Worktree 的位置，第 7 节「只在主检出执行」那一条，第 11 节延后表里「Worktree 并行」一行（隔离做了，并行还没有）。别的现行文档里有同样说法的一并改。

不能变的行为（都有测试）：

- 执行者提交了改动（现在看的是 Worktree 的 `HEAD`），这次执行记为失败。
- 执行者改了受保护的文件（现在看的是 Worktree 里的那一份），这次执行记为失败。
- 整个项目同一时间只有一个执行者。并行是后面的子任务。
- 主会话直接做的任务不建 Worktree。

不能动的：

- `src/application/delivery.ts`、`src/cli/deliver.ts`：在任务分支上交付是下一个子任务。本任务做完之后，派发过的任务暂时不能用 `knit deliver` 正常交付，这是已知的，不在这里修。
- 交接内容（`src/application/handoff.ts`、`src/application/task-materials.ts`）：资料的路径怎么写是后面的子任务。
- `.knit/config.json` 不加字段，不做准备命令、合并和清理。
- `validation/` 和 `docs/history/`、`docs/research/` 是历史记录，不改。
- 测试不能碰真实的用户目录：都用 `KNIT_HOME` 指到临时目录，用完删掉。
- 不加依赖。

代码怎么组织由执行者定。新的场景先写测试，看到它失败再改代码。现有测试里假定「执行者写的文件在项目目录里」的要跟着改；改的时候保持它原来核对的行为，不要为了通过把核对删掉。

验证：`npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0；运行 `npm test` 前后，真实用户目录下的 `.knit/` 没有变化。

## 完成条件

### Requirement: 派发的执行者在任务自己的 Worktree 里执行

#### Scenario: 执行者的改动落在 Worktree 里

- GIVEN 一个有提交的 Git 项目，里面有一个已经确认的任务，`KNIT_HOME` 指向一个临时目录
- WHEN 派发这个任务，执行者新建了文件 `src/a.txt` 之后正常结束
- THEN `<KNIT_HOME>/worktrees/<项目目录名>-<摘要>/<任务目录名>/src/a.txt` 存在，那个目录的当前分支是 `knit/<任务目录名>`
- AND 主检出里没有 `src/a.txt`，主检出的当前分支和 `HEAD` 都没有变
- AND 这次执行没有失败原因，记下的改动文件是 `src/a.txt`

#### Scenario: 主检出里的改动不算到执行者头上

- GIVEN 一次执行正在进行
- WHEN 主检出里 `.knit/standards/` 下的一个文件被改了，还新建了一个不相干的文件，之后执行者正常结束
- THEN 这次执行没有失败原因
- AND 记下的改动文件里没有这两个文件

#### Scenario: 再次派发用同一个 Worktree

- GIVEN 一个任务的实现环节已经在它的 Worktree 里结束，执行者在里面新建过一个文件
- WHEN 派发下一个环节
- THEN 这一次的执行者的工作目录是同一个 Worktree，看得到那个文件
- AND `git worktree list` 里这个任务仍然只有一个 Worktree

## 待澄清

无。

## 相关资料

- `.knit/tasks/11-20-worktree/design.md#2. 一个任务一个 Worktree` — 位置、分支和什么时候建；其中的准备命令不在本任务里
- `.knit/tasks/11-20-worktree/design.md#3. 执行` — 哪些看 Worktree、哪些仍然用主检出；其中交接内容那一条不在本任务里
- `.knit/tasks/11-20-worktree/design.md#7. Windows` — 新代码在 Windows 上要守的几条
- `docs/design/DESIGN.md#7. 执行` — 现行的执行规则，本任务要改其中「只在主检出执行」的说法
- `docs/design/DESIGN.md#2. 目录布局` — 现行的目录布局，要加上 Worktree 的位置

## 结果

派发的执行者现在在任务自己的 Git Worktree 和分支里执行：位置 `<Knit 的用户目录>/worktrees/<项目目录名>-<摘要>/<任务目录名>/`，分支 `knit/<任务目录名>`；改动对比、「执行者不能提交」和受保护文件的检查都看 Worktree。整个项目仍然一次只跑一个执行者。

改了 19 个文件：新增 `src/application/worktree.ts`、`test/run-worktree.test.mjs`；`src/` 下另改 5 个（`run-prepare.ts`、`run-execute.ts`、`run-pane.ts`、`run-finish.ts`、`cli/run.ts`）；`docs/design/DESIGN.md` 第 2、7、11 节；其余 11 个是跟着调整的测试和测试辅助。

实现由 `r-60a704ecfe37` 做，独立审查 `r-bf516f9b0afa` 结论 pass（都用 magpie/group/openai）。审查自己修了一处：`KNIT_HOME` 是相对路径时，建 Worktree 和拍快照用的基准不一样；现在统一按主检出的真实路径解析成绝对路径，并加了一条回归测试、在设计里补了这条规则。这条规则是审查定的，用户没有单独定过。

主会话核对时自己重跑的检查和结果：

- `npm test`：Rex 终端里 290/290 通过；去掉 Rex 环境变量再跑一次 290/290 通过。改之前是 279 条。
- `npm run typecheck` 退出码 0。
- 运行两次 `npm test` 前后，真实的 `~/.knit` 没有变化（空目录）；没有残留的 Worktree、`knit/*` 分支、临时 `KNIT_HOME` 目录和进程。
- 任务正文里不能动的文件都没有改动：`delivery.ts`、`cli/deliver.ts`、`handoff.ts`、`task-materials.ts`、`.knit/config.json`、`validation/`、`docs/history/`、`docs/research/`、`package.json`。
- 现有测试里被改掉的 6 条断言逐条看过：都是把位置从主检出换成 Worktree，或者在输出里加上 Worktree 那一行，并且多了「主检出里没有这个文件」的核对；没有删掉核对。
- 三个完成条件各有一条测试对应（`test/run-worktree.test.mjs` 前三条），用的是真实的临时 Git 仓库和假 Pi。

没有验证的：Windows 上没有试过；没有用真实的 Pi、Rex 和模型在 Worktree 里跑过（这个任务自己是用改之前的安装版在主检出里执行的）；没有在真实的用户目录下建过 Worktree。

已知的限制：在任务分支上交付还没有做，装上这一版之后派发过的任务暂时不能用 `knit deliver` 正常交付，要等下一个子任务。
