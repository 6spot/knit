---
id: k-d1b61be8d0d8
title: W4：交接里的资料按执行者所在的 Worktree 给
status: delivered
stage: null
verification: self
parent: k-7c16fc6dfc6f
dependsOn:
  - k-75cc3b6ec983
priority: P1
createdAt: 2026-11-20T14:14:55.245Z
---

## 目标与范围

派发的执行者在任务的 Worktree 里执行，而交接内容（第一条消息）还是照主检出拼的。实际跑 W2、W3 时看到两个问题（见「相关资料」里的证据）：

1. 点名的仓库资料附的是主检出里的那一份。实现环节在 Worktree 里改过的文件，审查环节收到的还是没改之前的内容。
2. 任务目录里的资料、`plan.md`、`task.md` 和以前各次的报告，给的是相对路径（`.knit/tasks/...`、`.knit/.runtime/runs/...`）。执行者在 Worktree 里按这个路径读不到：任务目录和运行资料只在主检出里。超过上限没有附上的资料，提示是「按路径自己读」，这时就读不到了。

做完之后：

- 仓库里的资料（不在任务目录下的）从任务的 Worktree 读，路径照旧是相对路径：执行者按路径读到的就是附上的那一份。
- 任务目录里的资料、`plan.md`、`task.md` 和各次的报告仍然从主检出读，路径写成主检出里的绝对路径。
- 第一条消息里有一段说明：执行者在任务的 Worktree 里工作；任务目录和以前的报告在主检出，只读，不要改。这段由 Knit 生成，放在第一条消息里，不改角色文件模板。内容相同的输入得到逐字相同的输出（现有的约定）。
- 点名的仓库资料在 Worktree 里读不出来时，照旧拒绝派发。主检出里有、Worktree 里没有时，提示里多说一句：它还没有提交，所以任务的 Worktree 里没有。

要处理的先后问题：现在是交接内容拼得出来之后才建 Worktree，而第一次派发时要读 Worktree 里的资料就得先有 Worktree。怎么调整由执行者定（例如把建 Worktree 提到拼交接之前）。要保证的是：派发被拒绝时，这次派发新建的 Worktree 和分支不留下（留下的话，用户把资料提交之后再派发，复用的还是从旧提交建出来的 Worktree）；派发之前就有的 Worktree 不动；照旧不留下这次执行的记录。

不能变的行为（都有测试）：

- 规范和角色文件仍然从主检出读，放在系统提示里，路径和内容不变。
- 字节上限、分块的先后、「结果」和 `record.json` 不给，都不变。
- W1 的行为：其它拒绝条件（需求没确认、依赖没完成、有别的执行者在跑、没有模型、仓库没有提交）不建 Worktree；改动对比和受保护文件的检查看 Worktree。

不能动的：

- `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/` 是受保护的，改了这次执行会记为失败。`.pi/extensions/knit.ts` 和 `assets/templates/agents/` 也不改。
- 交付相关的代码（`src/application/delivery.ts`、`src/cli/deliver.ts`、`src/infrastructure/directory.ts`）。
- 准备命令、自动合并、清理、取消任务时的清理、并行：都是后面的子任务。
- `validation/`、`docs/history/`、`docs/research/` 是历史记录，不改。不加依赖。

`docs/design/DESIGN.md` 跟着改：第 5 节写清资料各从哪里读、路径怎么写；第 7 节里「交接资料的路径调整留到后续子任务」那一句去掉，建 Worktree 的时机有变化时一起改。

环境（这个任务在一个新建的 Worktree 里执行）：

- Worktree 里没有 `node_modules`：开始之前先在 Worktree 里运行 `npm ci`。装不上时停下来报告。
- 这个任务的目录只在主检出里（`/Users/me/IdeaProjects/knit/.knit/tasks/11-20-w4-handoff-paths/`），内容已经附在交接里。主检出只读，不要在里面改任何东西。
- 测试不在真实的用户目录下建东西：测试辅助已经把 `KNIT_HOME` 指到临时目录。

验证：

- 新的场景先写测试，看到它失败再改代码。
- `npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。平时有 7 条跨文件系统的交付测试是跳过的，属于正常。
- 运行前后各看一次 `git worktree list`，应当只有主检出和这个任务自己的 Worktree。

交回：不提交。做完之后改动留在 Worktree 里，由主会话核对，用 `knit deliver` 在任务分支上提交。

## 完成条件

### Requirement: 交接里的资料按执行者所在的 Worktree 给

#### Scenario: 仓库里的资料给的是 Worktree 里的那一份

- GIVEN 一个任务点名了 `docs/a.md`，实现环节在它的 Worktree 里改了这个文件，主检出里的没有变
- WHEN 派发下一个环节
- THEN 第一条消息里这份资料的内容是 Worktree 里改过的那一份
- AND 它的路径仍然是 `docs/a.md`

#### Scenario: 任务目录里的资料和报告给主检出的绝对路径

- GIVEN 一个任务的目录里有 `plan.md` 和一份点名的资料，实现环节已经结束并留下报告
- WHEN 派发下一个环节
- THEN 第一条消息里 `task.md`、这份资料、`plan.md` 和上一个环节的报告的路径都是主检出里的绝对路径，按这些路径都读得到文件
- AND 第一条消息里说明了任务目录和以前的报告在主检出、只读

#### Scenario: 点名的资料还没有提交时拒绝派发，不留下新建的 Worktree

- GIVEN 一个还没有派发过的任务点名了 `docs/new.md`，这个文件在主检出里有，但没有提交
- WHEN 派发
- THEN 派发被拒绝，提示里有这个路径，并说明它还没有提交
- AND 没有留下这个任务的 Worktree、任务分支和这次执行的记录

## 待澄清

无。

## 相关资料

- `.knit/tasks/11-20-w4-handoff-paths/evidence.md` — W2、W3 实际执行时看到的现象和现在的代码位置
- `docs/design/DESIGN.md#5. 交接` — 现行的交接规则，本任务要改

## 结果

交接内容现在按执行者所在的 Worktree 给：仓库里的资料从任务的 Worktree 读，路径仍是相对路径；`.knit/tasks/` 下的资料（本任务的和别的任务的）、`task.md`、`plan.md` 和各次报告从主检出读，路径是主检出里的绝对路径。第一条消息开头多一段说明：在哪个 Worktree 里工作，任务目录和以前的报告在主检出、只读。

建 Worktree 提到了拼交接之前。交接拼不出来或写任务文件有冲突而拒绝派发时，这次新建的 Worktree 和分支会撤回，原来就有的不动。点名的仓库资料在主检出有、Worktree 里没有时，提示里说明它还没有提交。

主会话核对时补了一处：执行者照正文只把「本任务目录」算作任务资料，点名别的任务目录（例如主任务的设计，没有入库）时会被当成没提交的仓库资料而拒绝派发，后面的子任务都会碰到。改成 `.knit/tasks/` 下的都从主检出读，加了一条测试，设计第 5.2 节同步改了。这一处没有经过独立审查。

验证（主会话在任务的 Worktree 里运行）：`npm test` 315 条，308 通过、0 失败、7 条跨文件系统的跳过，Rex 终端和去掉 Rex 变量各一次；`npm run typecheck`、`git diff --check`、设计的链接检查退出码都是 0。改坏再还原：仓库资料仍从主检出读有 2 条测试失败，拒绝时不撤回 Worktree 有 3 条失败，`task.md` 仍给相对路径有 4 条失败；还原后文件逐字节一致。

没有验证：用真实模型派发一次（测试里用的是假 Pi）；Linux 和 Windows；撤回 Worktree 本身失败时的情况只看了代码，没有测试。
