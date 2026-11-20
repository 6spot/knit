---
id: k-2adaa21aaf85
title: W7：取消任务时删掉它的 Worktree 和分支
status: delivered
stage: null
verification: independent
parent: k-7c16fc6dfc6f
dependsOn:
  - k-475c307a870a
priority: P1
createdAt: 2026-11-20T15:43:22.666Z
---

## 目标与范围

派发过的任务被取消（`knit task cancel`）之后，它的 Worktree 和 `knit/<任务目录名>` 分支现在一直留着：占着磁盘，`git worktree list` 和分支列表里越积越多，也没有命令会再去清它。

做完之后：取消任务时把它的 Worktree 和分支一起删掉。取消的任务不会接着做，要做就重新开任务，所以里面没提交的改动不保留。

规则：

- 先照现在的做法取消并归档任务。任务文件写不进去（版本冲突）时照旧拒绝，什么都不删。
- 取消成功之后清理：Worktree 的目录在就用 `git worktree remove --force` 删；目录不在而分支还登记着时先 `git worktree prune`；然后用 `git branch -D` 删任务分支。位置和分支用现有的算法算出来（`taskWorktree`），只删这个任务自己的，不碰别的任务的。
- 输出里写明删了哪个 Worktree、哪个分支；Worktree 里有没提交的改动时，写明这些改动已经丢掉，并列出有几个文件。
- 删不掉时任务照样是取消的，输出 Git 的原话和留下来的位置，退出码仍然是 0。
- 没有派发过的任务（没有 Worktree，也没有任务分支）取消时，行为和输出与现在逐字相同。
- 有执行还没结束的任务照旧不能取消（现有的检查），所以不会删掉正在跑的执行者脚下的目录。

跟着改的说明：

- 交付规范的模板 `assets/templates/standards/delivery.md` 里「派发过的任务」一节加一条：取消派发过的任务会强制删掉它的 Worktree 和分支，里面没提交的改动找不回来；取消由用户决定，主会话不自己取消。
- `docs/design/DESIGN.md`：第 8.3 节里「取消任务时的清理留到后续子任务」的说法，以及讲 `knit task cancel` 的地方。

不能变的行为（都有测试）：

- 已经交付或已经取消的任务不能取消；`--reason` 不能为空；取消的理由写进「结果」；任务目录归档到主检出。
- 交付和自动合并里的清理不强制（W6）：强制删除只在取消任务时用。

不能动的：

- `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`、`.pi/extensions/knit.ts` 是受保护的或者是生成的副本，改了这次执行会记为失败。本仓库自己的交付规范由主会话照模板补。
- 交付的代码（`src/application/delivery.ts`、`src/cli/deliver.ts`）和派发的代码（`src/application/run-*.ts`）；可以在 `src/application/worktree.ts` 里加新函数。
- 并行、依赖的规则：都是后面的子任务。
- `validation/`、`docs/history/`、`docs/research/` 是历史记录，不改。不加依赖。

环境：

- 这个任务在它自己的 Worktree 里执行。`node_modules` 不在时先运行 `npm ci`；装不上时停下来报告。
- 主检出只读，不要在里面改任何东西。
- 强制删除只在测试的临时仓库里试，不在本仓库里试。测试辅助已经把 `KNIT_HOME` 指到临时目录。

验证：

- 新的场景先写测试，看到它失败再改代码。
- `npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。平时有 7 条跨文件系统的交付测试是跳过的，属于正常。
- 运行前后各看一次 `git worktree list` 和 `git branch --list 'knit/*'`，应当只有主检出和这个任务自己的 Worktree、分支。

交回：不提交。做完之后改动留在 Worktree 里，由主会话核对，用 `knit deliver` 交付。

## 完成条件

### Requirement: 取消任务时删掉它的 Worktree 和分支

#### Scenario: 取消派发过的任务

- GIVEN 一个任务派发过，执行已经结束，它的 Worktree 里有没提交的改动；另一个任务也有自己的 Worktree
- WHEN 取消第一个任务
- THEN 它是 `cancelled` 并且已经归档，它的 Worktree 和任务分支都不在了
- AND 输出里有删掉的位置和分支，并写明没提交的改动已经丢掉；另一个任务的 Worktree 和分支没有变

#### Scenario: 取消没有派发过的任务

- GIVEN 一个任务没有派发过
- WHEN 取消它
- THEN 输出和现在的逐字相同，`git worktree list` 和分支列表没有变

#### Scenario: 删不掉时任务照样取消

- GIVEN 一个派发过的任务，它的 Worktree 被 `git worktree lock` 锁住了
- WHEN 取消它
- THEN 它是 `cancelled` 并且已经归档，退出码是 0
- AND 输出里有 Git 的原话和留下来的 Worktree 的位置

## 待澄清

- [assumed] 交付规范里加「取消由用户决定，主会话不自己取消」这一条（现在的规范里没有讲取消）：取消之后改动找不回来。（用户 2026-11-20 同意）
- [assumed] 删不掉时退出码是 0，和 W6 里清理被拒绝时一致。（用户 2026-11-20 同意）

## 相关资料

- `.knit/tasks/11-20-worktree/design.md#5. 交付、合并和清理` — 取消任务的一段，和在临时仓库里试过的 Git 行为
- `docs/design/DESIGN.md#8. 完成与交付` — 现行的规则，本任务要改 8.3 节

## 结果

做成了：`knit task cancel` 取消并归档成功之后，强制删掉任务的 Worktree（`git worktree remove --force`）和任务分支（`git branch -D`）；Worktree 目录已经不在时先运行 `git worktree prune` 再删分支。输出写明删了哪个位置、哪个分支，丢掉了几个没提交的文件（未跟踪的目录按里面的文件逐个数）。Git 拒绝时原样输出错误和保留的位置，任务照样取消并归档，退出码 0；Worktree 删不掉时不去删分支。没派发过的任务输出和原来一样。交付规范的模板加了「取消会强制删除、找不回来；取消由用户决定，主会话不自己取消」，设计文档同步改了。交付和派发的代码没动。

三个完成条件都有测试并通过：取消派发过、带各类未提交改动的任务后 Worktree 和分支都没了，输出有位置和丢弃 6 个文件，另一个任务的 Worktree 不受影响；取消没派发过的任务输出逐字不变；Worktree 被锁住删不掉时任务照样取消、退出码 0、错误和位置都在输出里。

独立审查 r-61bb61a6245c 结论 pass，没有要修的问题，没有改文件。

主会话在任务的 Worktree 里核对（实现 r-3aa8623c6474）：
- `npm test` 363 条，356 通过、0 失败、7 条跨文件系统的跳过（改之前 354 条）；Rex 终端里和去掉 REX_SESSION、REX_BLOCK 之后各一次，结果相同。
- `npm run typecheck`、`git diff --check`、设计链接检查退出码 0。
- 改坏再还原 6 处：取消后不调清理（6 条测试失败）、删 Worktree 不加 `--force`（1 条）、目录不在时不 prune（1 条）、删分支改用 `-d`（1 条）、未跟踪目录只算一个文件（1 条）、Worktree 删不掉也去删分支（1 条）；还原后文件逐字节一致。

主会话补的一处：本仓库的 `.knit/standards/delivery.md` 照模板改了同样的 2 行（执行者不能改受保护的路径），审查没有看过这处。

没有验证的：在本仓库真的取消一个派发过的任务（强制删除只在临时仓库里试过）；Windows；用真实的 Pi 和模型走一遍。
