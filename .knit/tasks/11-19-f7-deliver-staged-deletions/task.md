---
id: k-7c9ba52b575b
title: F7 交付时任务里有已经暂存的删除也能一次提交
status: draft
stage: null
verification: independent
parent: k-19c962be9fb8
dependsOn:
  - k-1a73047ca4d5
priority: P1
createdAt: 2026-11-18T17:22:54.979Z
---

## 目标与范围

任务里有文件是用 `git mv` 或 `git rm` 改的（删除已经暂存）时，`knit deliver` 第一次会失败：

```
fatal: pathspec 'd/a.md' did not match any files
Git 没有接受这次提交，交付已经撤回：任务目录在 .knit/tasks/…，状态是 done
```

撤回时暂存被撤掉，原样再运行一次就成功。2026-11-18 在临时仓库里试过三种改法：`git mv` 和 `git rm` 第一次失败、第二次成功；普通的 `mv` 一次成功。

原因在 `src/application/delivery.ts` 的 `commitDelivery`：要提交的文件是用 `git status` 列出来的，里面有「已经暂存的删除」；接着 `git add -A -- <这些文件>`，而这个路径在工作区和暂存区里都已经没有了，Git 对不上就报错。

本任务让这种情况一次交付成功。

怎么改由执行者定，改动限制在 `commitDelivery` 里。一种在临时仓库里试过可行的做法：`git add` 之前先对同一批路径运行 `git reset -q -- <这些文件>`，把它们的暂存撤掉，再照原样 `add -A` 和 `commit --only`；没有提交过的仓库里 `git reset -- <路径>` 也以退出码 0 返回。

不能变的行为（都有测试，在 `test/deliver-commit.test.mjs`、`test/deliver-problems.test.mjs`）：

- 只提交这个任务的文件；交付之前已经暂存的别的文件不进这次提交，交付之后还是暂存着的。
- Git 拒绝提交时撤回：任务目录移回原处，状态改回 `done`，原样报告 Git 的错误。
- 没有要提交的文件时不提交。

不能动的：

- `src/cli/deliver.ts` 里撤回的步骤、`previewDelivery`、提交文案和 `Knit-Task:` 那一行。
- 不加依赖，不提交、不推送。

先写测试，看到它因为上面的错误失败，再改代码。

## 完成条件

### Requirement: 任务里有已经暂存的删除时一次交付成功

#### Scenario: 用 git mv 移动过的文件

- GIVEN 一个 Git 仓库里已经提交了 `d/a.md`，任务把它用 `git mv` 移到 `e/a.md`，`knit task close` 时 `--paths` 登记了这两个路径
- WHEN 运行 `knit deliver <任务> --authorization <引用> --message-file <文件>`
- THEN 退出码是 0，输出里有 `已交付`
- AND 这次提交里有 `d/a.md` 的删除和 `e/a.md` 的新增，之后 `git status --porcelain` 没有输出

#### Scenario: 用 git rm 删除的文件

- GIVEN 一个 Git 仓库里已经提交了 `d/a.md`，任务把它用 `git rm` 删掉，`knit task close` 时 `--paths` 登记了这个路径
- WHEN 运行 `knit deliver <任务> --authorization <引用> --message-file <文件>`
- THEN 退出码是 0，这次提交里有 `d/a.md` 的删除

#### Scenario: 别的已经暂存的文件不受影响

- GIVEN 任务里有一个用 `git mv` 移动过的文件，另外有一个不属于这个任务的文件已经 `git add` 过
- WHEN 交付这个任务
- THEN 那个文件不在这次提交里，交付之后 `git status --porcelain` 里它还是已暂存的（开头是 `M ` 或 `A `）

## 待澄清

无。

## 相关资料

- `src/application/delivery.ts` — 要改的函数 `commitDelivery`
- `test/deliver-commit.test.mjs` — 新测试加在这里，夹具和断言的写法照现有的
- `docs/design/DESIGN.md#8.2 交付` — 交付的步骤和不交付的几种情况

验证：`npm test` 全部通过，测试个数比改之前多（改之前先运行一次记下个数，写这个任务时是 227；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0。

交付：本任务要求独立审查。提交文案首行建议 `fix: deliver tasks whose deletions are already staged`。交付之后 `validation/slim-h5-2026-11/README.md`「做这些时发现的问题」那一段可以删掉，由主会话在资料提交里做。
