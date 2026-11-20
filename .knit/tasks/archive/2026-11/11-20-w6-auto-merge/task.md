---
id: k-475c307a870a
title: W6：交付之后自动合并并清理 Worktree
status: delivered
stage: null
verification: independent
parent: k-7c16fc6dfc6f
dependsOn:
  - k-08cbeee4ff9a
priority: P1
createdAt: 2026-11-20T15:43:22.530Z
---

## 目标与范围

派发过的任务现在交付之后，提交留在任务分支上，主会话再手工运行三条 Git 命令：合并、删 Worktree、删分支。每个任务都要做一遍，漏掉合并时主检出里就没有这个任务的代码，下一个任务从主检出建出来的 Worktree 里也没有。

做完之后：项目在 `.knit/config.json` 里打开开关，`knit deliver` 交付成功之后接着做这三步。

```json
{
  "worktree": { "autoMerge": true }
}
```

规则：

- `worktree.autoMerge` 是布尔值，缺省 `false`。关着时，交付的行为和现在逐字相同。
- 只对在任务分支上交付的任务起作用（任务的 Worktree 存在）。主会话直接做的任务和不在 Git 仓库里的项目不变。
- 交付成功之后，在主检出里把任务分支合并进主检出当前所在的分支。用普通的 `git merge`，加 `--no-edit`：能快进就快进，不能时生成一个合并提交，不打开编辑器。不要求快进：几个任务并行时，前一个合并之后主分支已经往前走了。不用 `--squash`、`--no-commit`：合并的结果要落成提交，主检出里不留没提交的合并结果。
- 合并成功之后运行 `git worktree remove <位置>`，再运行 `git branch -d <分支>`，都不加强制。Git 拒绝时（例如 Worktree 里还有没入库的新文件）留着，输出 Git 的原话和位置。
- 合并失败：进入了合并状态就运行 `git merge --abort`；Worktree 和分支都留着；任务仍然是 `delivered`，提交留在任务分支上。输出里写明任务已经交付、提交在哪个分支上、合并没有成功、Git 的原话，以及由主会话把这些给用户看并问他怎么处理。主检出里没提交的改动挡住合并时 Git 不进入合并状态，这时不用放弃合并，其余相同。
- 合并失败或清理被拒绝时命令的退出码仍然是 0：任务已经交付，没做成的是后面的步骤。原因是桥接在命令失败时只把标准错误交给主会话，交付成功的那几行就看不到了。
- 这次交付没有要提交的文件时（任务分支上没有新提交），照样清理 Worktree 和分支。
- 交付被撤回（移动任务目录失败、Git 拒绝提交）时不合并、不清理。
- 预览里写明：交付之后会合并进哪个分支，然后删掉 Worktree 和分支。
- 一次交付的授权同时覆盖合并和清理，不另外要授权。

跟着改的说明：

- 交付规范的模板 `assets/templates/standards/delivery.md` 里「派发过的任务」一节：开关开着时合并和清理由 `knit deliver` 做，主会话不再重复；合并失败时把 Git 的错误给用户看并问他，不自己解决冲突，不强行合并。开关关着时的做法保留。
- 桥接模板 `assets/templates/pi/extensions/knit.ts` 里 `knit_deliver` 的工具说明现在写的是「不自动合并或清理」，改成和开关一致。
- `docs/design/DESIGN.md`：第 2 节里 `config.json` 的说明，第 8 节（8.2 的步骤和输出、8.3 的合并和清理）。

不能变的行为（都有测试）：

- W2、W3 的交付场景：提交在任务分支上、撤回、跨文件系统、被 Git 忽略的任务目录归档留在主检出。
- 没有 Worktree 的任务和不在 Git 仓库里的项目，交付方式不变。
- 任何情况下不推送，不用 `--force` 删 Worktree，不用 `git branch -D`。

不能动的：

- `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`、`.pi/extensions/knit.ts` 是受保护的或者是生成的副本，改了这次执行会记为失败。本仓库自己的交付规范和配置由主会话照模板补。
- 派发和执行的代码（`src/application/run-*.ts`、`src/application/worktree.ts` 里已有的函数的行为）；可以在 `worktree.ts` 里加新函数。
- 取消任务时的清理、并行、依赖的规则：都是后面的子任务。
- `validation/`、`docs/history/`、`docs/research/` 是历史记录，不改。不加依赖。

环境：

- 这个任务在它自己的 Worktree 里执行。`node_modules` 不在时先运行 `npm ci`；装不上时停下来报告。
- 主检出只读，不要在里面改任何东西。
- 测试都在临时仓库里做，不在本仓库里试合并。测试辅助已经把 `KNIT_HOME` 指到临时目录。

验证：

- 新的场景先写测试，看到它失败再改代码。
- `npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。平时有 7 条跨文件系统的交付测试是跳过的，属于正常。
- 运行前后各看一次 `git worktree list`，应当只有主检出和这个任务自己的 Worktree。

交回：不提交。做完之后改动留在 Worktree 里，由主会话核对，用 `knit deliver` 在任务分支上提交。

## 完成条件

### Requirement: 交付之后自动合并并清理 Worktree

#### Scenario: 开关开着时交付之后合并并清理

- GIVEN 开关开着，一个派发过的任务已经完成；主检出的分支在建任务分支之后又有了新提交，改的是别的文件
- WHEN 交付这个任务
- THEN 主检出的当前分支上有这个任务的代码和归档，多出一个合并提交，工作区没有没提交的改动
- AND 这个任务的 Worktree 和任务分支都不在了，输出里写明合并进了哪个分支、删了什么

#### Scenario: 合并有冲突时放弃合并，都留着

- GIVEN 开关开着，主检出的分支和任务分支改了同一个文件的同一行
- WHEN 交付这个任务
- THEN 任务是 `delivered`，提交在任务分支上，Worktree 和分支都在
- AND 主检出不在合并状态，工作区和交付之前一样；输出里有 Git 的原话，并写明由主会话问用户

#### Scenario: 开关关着时不合并

- GIVEN 配置里没有写这个开关
- WHEN 交付一个派发过的任务
- THEN 输出和 W3 之后的逐字相同，主检出的 `HEAD` 没有变，Worktree 和分支都在

## 待澄清

- [assumed] 合并失败或清理被拒绝时退出码是 0，靠输出里的说明让主会话知道（主任务的设计没有写退出码）。（用户 2026-11-20 同意）
- [assumed] 没有要提交的文件时也清理 Worktree 和分支。（用户 2026-11-20 同意）

## 相关资料

- `.knit/tasks/11-20-worktree/design.md#5. 交付、合并和清理` — 自动合并的设计和在临时仓库里试过的 Git 行为；取消任务不在本任务里
- `.knit/tasks/11-20-worktree/design.md#6. 配置` — 配置的字段
- `docs/design/DESIGN.md#8. 完成与交付` — 现行的交付规则，本任务要改

## 结果

做成了：`.knit/config.json` 的 `worktree.autoMerge`（布尔值，缺省 `false`）打开时，`knit deliver` 交付成功之后在主检出运行 `git merge --no-edit <任务分支>`，合并的结果落成提交；合并成功再运行 `git worktree remove`（不加 `--force`）和 `git branch -d`（不加强制）。合并失败时进入了合并状态就运行 `git merge --abort`，任务仍是 delivered，提交、Worktree 和分支都留着，输出 Git 的原话和「由主会话问用户」的说明，退出码 0。主检出没提交的改动挡住合并时不进入合并状态，不运行 `--abort`，改动原样保留。清理被 Git 拒绝时保留，输出错误和位置，退出码 0。预览列出要合并进的分支和要删的 Worktree、分支。开关关着或没写时输出和行为不变。交付规范的模板、桥接 `knit_deliver` 的说明和设计文档同步改了。

三个完成条件都有测试并通过：开关开着且主分支有别的新提交时合并落成双亲提交并清理；同一行冲突时放弃合并、都留着、任务仍是 delivered；开关关着时和原来一样。

独立审查 r-ccf6305beaf4 结论 pass。审查修了一个问题：任务目录入过库时，冲突之后 `git merge --abort` 会把旧的任务目录恢复到主检出，和 Worktree 里的归档重复；现在合并失败之后清掉主检出里被恢复出来的旧目录，并加了入过库的任务目录的冲突和脏工作区测试。

主会话在任务的 Worktree 里核对（实现 r-720ff7035c75）：
- `npm test` 354 条，347 通过、0 失败、7 条跨文件系统的跳过（改之前 337 条）；Rex 终端里和去掉 REX_SESSION、REX_BLOCK 之后各一次，结果相同。
- `npm run typecheck`、`git diff --check`、设计链接检查退出码 0；派发和执行的代码、历史目录没有改动。
- 改坏再还原 6 处：冲突之后不放弃合并（2 条测试失败）、开关没开也合并（4 条）、强制删 Worktree（1 条）、强制删分支（1 条）、去掉审查补的那一行（1 条）、合并改用 `--squash`（6 条）；还原后文件逐字节一致。

主会话补的一处：本仓库的 `.knit/standards/delivery.md` 照模板改了同样的 5 行（执行者不能改受保护的路径），补完和模板只差本仓库自己的提交文案规则。

没有验证的：用安装版在本仓库真的自动合并一次（这次交付用的还是旧安装版，由主会话手工合并；下一个任务 W7 是第一次）；Windows；用真实的 Pi 和模型走交付。
