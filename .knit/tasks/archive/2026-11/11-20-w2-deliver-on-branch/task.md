---
id: k-3f3bbb09b4f1
title: W2：派发过的任务在任务分支上交付
status: delivered
stage: null
verification: independent
parent: k-7c16fc6dfc6f
dependsOn:
  - k-28cd41e01e93
priority: P1
createdAt: 2026-11-20T09:56:00.375Z
---

## 目标与范围

上一个子任务（W1，提交 `9d91707`）之后，派发的执行者在任务自己的 Git Worktree 和 `knit/<任务目录名>` 分支里工作，改动都在 Worktree 里。`knit deliver` 还只认主检出：它在主检出里找记录下来的改动文件，一个也找不到，提交的只剩任务目录。所以现在派发过的任务没法正常交付。

本任务让 `knit deliver` 对派发过的任务在任务分支上交付：代码和任务记录一起，在 Worktree 里提交一次。做完之后，派发过的任务可以照常预览和交付，提交落在任务分支上，主检出的分支不动；合并进主分支和删掉 Worktree 由用户或主会话用 Git 做（自动合并是后面的子任务）。

要做到的：

- 怎么算「派发过」：任务的 Worktree 存在（位置的算法在 `src/application/worktree.ts`）。没有 Worktree 的任务交付方式不变，仍然在主检出的当前分支上归档并提交；不在 Git 仓库里的项目仍然只归档。
- 预览：多列出 Worktree 的位置和分支，写明提交在任务分支上、不会合并。要提交的文件、「记录里的路径现在没有改动」「不属于这个任务的改动」「审查通过之后又改过」这几项都看 Worktree（结束时的工作区记录本来就是在 Worktree 里拍的）。
- 交付的步骤：状态改成 `delivered`、记下授权，把任务目录从主检出移到 Worktree 里的 `.knit/tasks/archive/<YYYY-MM>/`；在 Worktree 里只暂存这个任务的文件，在任务分支上提交一次，末尾照旧加 `Knit-Task: <id>`；核对提交内容的做法不变。
- Git 拒绝提交时撤回到运行之前的样子：任务目录移回主检出原来的位置，状态改回 `done`，Worktree 里不留暂存和归档目录，原样报告 Git 的错误。
- 任务目录在交付之前就入过库时（主分支上有一份，任务分支上也带着建分支时的那一份）：这次提交把任务分支上原位置的那一份删掉，归档里放主检出当前的内容。这样合并时两边不冲突（见「相关资料」里试过的结果）。
- 交付成功的输出写明：归档位置、提交号和首行、分支名、Worktree 的位置，以及这个提交还没有合并进主检出的分支。
- 交付规范的模板（`assets/templates/standards/delivery.md`）加一节，写给主会话：
  - 派发过的任务交付之后提交在任务分支上；在主检出里用 `git merge knit/<任务目录名>` 合并，再用 `git worktree remove <位置>` 和 `git branch -d knit/<任务目录名>` 清理。这一步由主会话接着做，不用再问用户：交付的授权同时覆盖合并和清理。（用户 2026-11-20 定）
  - 合并失败时：进入了合并状态就 `git merge --abort`，把 Git 的错误原样给用户看并问他怎么处理；不自己解决冲突，不强行合并，不用 `--force` 删 Worktree。（用户 2026-11-20 定）
  - 派发过的任务，主会话要补改动时在它的 Worktree 里改，不在主检出里改。
- `docs/design/DESIGN.md` 第 8 节改成现行做法；第 7 节里「在任务分支上交付还没有实现」那一条和第 11 节延后表里相应的说法一并改。桥接工具的说明（`assets/templates/pi/extensions/knit.ts`）里有和新做法不符的说法时改模板。

不能变的行为（都有测试）：

- 没有派发过的任务、不在 Git 仓库里的项目，交付的结果和输出不变。
- 授权、提交文案、只暂存本任务的文件、不推送、hook 照常运行，这些规则不变。

不能动的：

- `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/` 是受保护的，改了这次执行会记为失败。本仓库的 `.knit/standards/delivery.md` 比模板多几条本仓库自己的规则，由主会话照着模板补；报告里给出模板新加的那一节的原文。`.pi/extensions/knit.ts` 是生成的副本，也不改。
- 执行相关的代码（`src/application/run-*.ts`、`src/application/worktree.ts` 里位置和分支的算法）：W1 刚定下来，本任务只用它，不改它的行为。
- 交接内容（`src/application/handoff.ts`、`src/application/task-materials.ts`）、配置字段、自动合并、清理、取消任务时的清理、并行：都是后面的子任务。
- `validation/`、`docs/history/`、`docs/research/` 是历史记录，不改。不加依赖。

环境（这个任务自己就在一个新建的 Worktree 里执行）：

- Worktree 里没有 `node_modules`：开始之前先在 Worktree 里运行 `npm ci`。装不上时停下来报告。
- Worktree 里没有 `.knit/tasks/` 下这个任务和主任务的目录，它们只在主检出里，内容已经附在交接里。主检出的位置是 `git worktree list` 的第一行；主检出只读，不要在里面改任何东西。
- 测试不在真实的用户目录下建东西：测试辅助已经把 `KNIT_HOME` 指到临时目录。运行 `npm test` 前后各看一次 `git worktree list`，应当只有主检出和这个任务自己的 Worktree。

代码怎么组织由执行者定。新的场景先写测试，看到它失败再改代码。

验证：`npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。

交回：不提交。做完之后改动留在 Worktree 里，由主会话核对和提交。

## 完成条件

### Requirement: 派发过的任务在任务分支上交付

#### Scenario: 提交落在任务分支上

- GIVEN 一个派发过的任务已经完成，执行者在它的 Worktree 里新建了 `src/a.txt`，任务目录没有入过库
- WHEN 带授权和提交文案运行 `knit deliver`
- THEN 任务分支上多了一个提交，里面是 `src/a.txt` 和归档位置下的任务目录，说明末尾有 `Knit-Task: <id>`
- AND 主检出的当前分支和 `HEAD` 都没有变，主检出里原来的任务目录不在了
- AND 输出里有分支名、提交号和 Worktree 的位置

#### Scenario: Git 拒绝提交时撤回

- GIVEN 一个派发过的任务已经完成，仓库的 `pre-commit` hook 会以非零退出
- WHEN 带授权和提交文案运行 `knit deliver`
- THEN 命令失败，输出里有 hook 给的错误
- AND 任务目录回到主检出原来的位置，状态是 `done`
- AND 任务分支的 `HEAD` 没有变，Worktree 里没有暂存的改动，也没有归档目录

#### Scenario: 任务目录入过库的任务交付之后合并得进去

- GIVEN 一个任务的目录在派发之前已经提交过，派发之后主检出里它的 `task.md` 又变了，任务已经完成
- WHEN 运行 `knit deliver`，再在主检出里运行 `git merge knit/<任务目录名>`
- THEN 合并成功
- AND 主检出里原位置没有这个任务目录，归档位置下的 `task.md` 是交付时主检出里的内容
- AND `git status` 里没有这个任务的路径

## 待澄清

无。

## 相关资料

- `.knit/tasks/11-20-worktree/design.md#5. 交付、合并和清理` — 交付的设计；其中自动合并、合并之后的清理和取消任务不在本任务里
- `docs/design/DESIGN.md#8. 完成与交付` — 现行的交付规则，本任务要改
- `.knit/tasks/11-20-w2-deliver-on-branch/tracked-task-dir.md` — 任务目录入过库时在分支上交付再合并，在临时仓库里试出来的结果

## 结果

`knit deliver` 现在对派发过的任务在任务分支上交付：任务的 Worktree 存在时，把任务目录从主检出移到 Worktree 的归档位置，在 `knit/<任务目录名>` 分支上提交一次，主检出的分支和 `HEAD` 不动。预览和输出多了 Worktree 的位置、分支和「还没有合并」的说明。没有 Worktree 的任务和不在 Git 仓库里的项目，交付方式不变。合并和清理由主会话接着用 Git 做，写进了交付规范。

改了 9 个文件：`src/application/delivery.ts`、`src/application/task-store.ts`、`src/cli/deliver.ts`；`test/deliver-preview.test.mjs`、新增 `test/deliver-worktree.test.mjs`；`docs/design/DESIGN.md` 第 2、8、11 节（新增 8.3）；模板 `assets/templates/standards/delivery.md`、`assets/templates/pi/extensions/knit.ts`；本仓库的 `.knit/standards/delivery.md`（主会话照模板补的「派发过的任务」一节，执行者不能改受保护的文件）。

实现由 `r-024a32985140` 做，独立审查 `r-bdb6b35c4fca` 结论 pass、没有改文件（都用 magpie/group/openai，都在任务的 Worktree 里执行）。这是 Worktree 功能第一次用真实的 Pi、Rex 和模型跑：派发建出了 Worktree 和分支，两次执行的工作目录都是它，主检出没有被动过。

主会话在 Worktree 里自己重跑的检查和结果：

- `npm test`：Rex 终端里 294/294 通过；去掉 Rex 环境变量 294/294 通过；补完本仓库的规范之后再跑一次 294/294 通过。改之前是 290 条。
- `npm run typecheck` 退出码 0；`git diff --check` 退出码 0；设计和两份规范的链接检查退出码 0。
- 任务正文里不能动的文件都没有改动（执行相关的代码、交接、配置、历史资料、`package.json`）。
- 三个完成条件各有测试对应（`test/deliver-worktree.test.mjs`），用的是临时仓库和真实的命令行。

主会话另外试出来的两个缺陷，审查没有发现，这次没有修，留给下一个子任务：

1. 跨文件系统时交付失败并且卡住。移动目录用的是重命名，跨文件系统会报 `EXDEV`。用内存盘试过两种情况都复现：Knit 的用户目录和项目不在同一个文件系统（任务目录没入过库也会）；系统临时目录在另一个文件系统并且任务目录入过库。失败时任务状态已经是 `delivered`、目录还在主检出、没有提交，再交付一次被拒绝（「已经结束」）。
2. 任务目录被 Git 忽略的项目会丢任务记录。交付把任务目录移进 Worktree，提交里没有它，合并之后主检出里也没有，`git worktree remove` 成功之后任务记录就不在任何地方了，`knit task show` 报没有这个任务。在临时仓库里复现过。

这台机器上这两个条件都不成立：临时目录、Worktree 和主检出在同一个设备上，本仓库的任务目录没有被忽略。

没有验证的：Windows 上没有试过；任务目录入过库、之后主分支又提交过它的情况没有试过；没有在独立的普通终端应用里跑测试（只去掉了 Rex 环境变量）。

交付方式：这个任务派发时装着的 Knit 还不会在任务分支上交付，代码由主会话在 Worktree 里手工提交并合并进主分支。
