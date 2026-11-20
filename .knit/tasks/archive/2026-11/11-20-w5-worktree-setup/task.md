---
id: k-08cbeee4ff9a
title: W5：新建 Worktree 之后运行准备命令
status: delivered
stage: null
verification: self
parent: k-7c16fc6dfc6f
dependsOn:
  - k-d1b61be8d0d8
priority: P1
createdAt: 2026-11-20T15:43:22.393Z
---

## 目标与范围

任务的 Worktree 是从提交建出来的，里面只有入库的文件，没有 `node_modules` 这类被 Git 忽略的目录。现在每个派发的任务都要在正文里写「先运行 `npm ci`」，执行者忘了或者装错了，后面的测试结果就不可信。

做完之后：项目在 `.knit/config.json` 里写上准备命令，Knit 建好 Worktree 就替执行者运行。

```json
{
  "worktree": { "setup": ["npm ci"] }
}
```

规则：

- `worktree.setup` 是一组命令，可以不写。写了就要是非空字符串的数组；写错时照现在的做法报出配置文件的问题。
- 这次派发新建了 Worktree 的目录才运行：第一次派发，以及目录丢了、按原分支重建的那一次。返工和审查复用已有的 Worktree，不再运行。
- 按顺序在 Worktree 里运行，经系统的 shell（Windows 上的 `npm` 是 `npm.cmd`，不经 shell 启动不了）。环境变量沿用 `knit` 进程的。不设超时，不重试：命令本身对不对由项目负责。
- 交接内容拼得出来之后才运行，免得白跑一次再被拒绝。
- 有一条命令退出码不是 0：后面的不再运行，拒绝派发，输出是哪一条命令、退出码和它的输出；把这次新建的 Worktree 删掉，分支是这次新建的也删掉（W4 已经有撤回的做法，但那里不用强制删除；准备命令跑到一半会留下没入库的文件，这里要能删干净）。不留下这次执行的记录。下次派发重新建、重新运行。
- 派发前的工作区记录（`before.json`）在准备命令运行之后拍：准备命令产生的文件不算执行者的改动。
- `knit run start` 要等准备命令跑完才返回。成功时输出里说明运行了几条准备命令。

不能变的行为（都有测试）：

- 没有配置 `worktree.setup` 时，派发的行为和现在逐字相同。
- 其它拒绝条件（需求没确认、依赖没完成、有别的执行者在跑、没有模型、仓库没有提交、交接拼不出来）都不运行准备命令。
- 派发之前就有的 Worktree 和分支，任何情况下都不删。

不能动的：

- `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/` 是受保护的，改了这次执行会记为失败。本仓库自己的 `.knit/config.json` 由主会话在交付之后加上 `npm ci`，这个任务不改它。配置模板 `assets/templates/config.json` 也不加准备命令：每个项目要运行什么不一样。
- 交付相关的代码（`src/application/delivery.ts`、`src/cli/deliver.ts`、`src/infrastructure/directory.ts`）。
- 自动合并、清理、取消任务时的清理、并行：都是后面的子任务。`worktree.autoMerge` 这个字段不在这个任务里加。
- `validation/`、`docs/history/`、`docs/research/` 是历史记录，不改。不加依赖。

`docs/design/DESIGN.md` 跟着改：第 2 节里 `config.json` 的说明，第 7 节里「不运行准备命令」的说法和派发的先后。

环境（这个任务在一个新建的 Worktree 里执行，这时准备命令还没有）：

- 开始之前先在 Worktree 里运行 `npm ci`。装不上时停下来报告。
- 主检出只读，不要在里面改任何东西。
- 测试不在真实的用户目录下建东西：测试辅助已经把 `KNIT_HOME` 指到临时目录。测试里的准备命令不要真的运行 `npm ci`，用几条很快的命令。

验证：

- 新的场景先写测试，看到它失败再改代码。
- `npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。平时有 7 条跨文件系统的交付测试是跳过的，属于正常。
- 运行前后各看一次 `git worktree list`，应当只有主检出和这个任务自己的 Worktree。

交回：不提交。做完之后改动留在 Worktree 里，由主会话核对，用 `knit deliver` 在任务分支上提交。

## 完成条件

### Requirement: 新建 Worktree 之后运行准备命令

#### Scenario: 第一次派发时按顺序运行，之后不再运行

- GIVEN 配置里写了两条准备命令，一个任务还没有派发过
- WHEN 派发它的实现环节，结束之后再派发审查环节
- THEN 第一次派发时两条命令按顺序在任务的 Worktree 里运行过一次
- AND 第二次派发没有再运行

#### Scenario: 有一条失败时拒绝派发，不留下新建的 Worktree

- GIVEN 配置里的第二条准备命令会以非零退出，并且在这之前第一条已经在 Worktree 里留下了没入库的文件
- WHEN 派发一个还没有派发过的任务
- THEN 派发被拒绝，输出里有这条命令、它的退出码和输出
- AND 没有留下这个任务的 Worktree、任务分支和这次执行的记录；把命令改对之后再派发能成功

#### Scenario: 准备命令产生的文件不算执行者的改动

- GIVEN 准备命令在 Worktree 里新建了一个没有被 Git 忽略的文件
- WHEN 派发的执行者改了另一个文件之后正常结束
- THEN 这次执行记下的改动文件里只有执行者改的那一个

## 待澄清

- [assumed] 目录丢了、按原分支重建 Worktree 的那一次也运行准备命令（主任务的设计只写了「只在新建时跑」）：重建出来的目录里同样没有 `node_modules`。（用户 2026-11-20 同意）
- [assumed] 不设超时：准备命令卡住时 `knit run start` 也跟着卡住，由用户中断。（用户 2026-11-20 同意）

## 相关资料

- `.knit/tasks/11-20-worktree/design.md#2. 一个任务一个 Worktree` — 准备命令的设计在最后一条
- `.knit/tasks/11-20-worktree/design.md#6. 配置` — 配置的字段；`autoMerge` 不在本任务里
- `.knit/tasks/11-20-worktree/design.md#7. Windows` — 新代码在 Windows 上要守的几条
- `docs/design/DESIGN.md#7. 执行` — 现行的派发规则，本任务要改

## 结果

做成了：`.knit/config.json` 的 `worktree.setup` 里写的命令，在这次派发新建了 Worktree 目录时（第一次派发，以及目录丢了按原分支重建）按顺序经系统 shell 在 Worktree 里运行；返工和审查复用时不运行。交接拼得出来之后才运行；有一条退出码不是 0 就停下、拒绝派发，输出命令、退出码和它的输出，强制删掉这次新建的 Worktree，分支是这次新建的也删掉，不留执行记录。`before.json` 在准备命令之后拍。成功时 `knit run start` 多输出一行「已运行准备命令：N 条」。没有配置时输出不变。

三个完成条件都有测试并通过：第一次派发按顺序运行、之后不再运行；第二条失败时拒绝派发、不留下 Worktree、分支和执行记录，改对之后能派发；准备命令产生的文件不算执行者的改动。

主会话在任务的 Worktree 里核对（实现 r-988ce466abac，自查，没有独立审查）：
- `npm test` 337 条，330 通过、0 失败、7 条跨文件系统的跳过（改之前 315 条）；Rex 终端里和去掉 REX_SESSION、REX_BLOCK 之后各一次，结果相同。
- `npm run typecheck`、`git diff --check`、设计链接检查退出码 0。
- 受保护路径、配置模板、交付代码、历史目录没有改动；HEAD 仍是 f252856。
- 改坏再还原 4 处：复用时也运行（1 条测试失败）、失败后不强制删除（2 条）、失败后继续运行后面的（1 条）、失败也照样派发（2 条）；还原后文件逐字节一致。

主会话补的一处：`docs/design/DESIGN.md` 第 11 节「Worktree 并行」一行里还写着准备命令、交接路径留到后续子任务，这两项已经做完，删掉了这半句（执行者在报告里指出、没有改）。

没有验证的：Windows 上经 `cmd.exe` 运行；用真实的 `npm ci` 作准备命令（测试里用的是很快的 Node 命令，本仓库的配置在交付之后才加）；准备命令卡住时由用户中断。
