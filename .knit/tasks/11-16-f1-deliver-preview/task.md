---
id: k-3f89354bec0b
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-16T09:01:03.153Z
title: F1 交付预览：knit deliver --preview
---

# F1 交付预览：knit deliver --preview

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。交付是把一个已经完成（`done`）的任务归档；项目在 Git 仓库里时，再把这个任务的改动提交成一次提交。Git 不是必须的：项目不在 Git 仓库里时只归档，不提交。Knit 任何时候都不推送。

本任务先做预览：列出交付会做什么，什么都不改。

做完之后的不同：`knit deliver <任务> --preview` 能看到任务目录要移到哪里、哪些文件会被提交、有哪些要留意的地方。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/task-store.ts`（修改） | 新增 `archiveDirOf(stored)`：返回这个任务归档之后的目录（当月的归档目录加原目录名）；`archiveTask` 改用它，行为不变 |
| `next/src/application/workspace.ts`（修改） | `RUNTIME_PREFIX` 加上 `export`，别的不动 |
| `next/src/application/delivery.ts`（新增） | `insideGit`、`changedAmong`、`previewDelivery`，见下 |
| `next/src/cli/deliver.ts`（新增） | `registerDeliverCommand(program)`：命令 `knit deliver <id>`，选项 `--preview`、`--message-file <文件>`、`--dir <目录>` |
| `next/src/cli/knit.ts`（修改） | 注册这个命令 |
| `next/test/helpers/deliver.mjs`（新增） | `doneTask(dir, paths)`：建一个任务、确认、用 `task close --paths` 记为完成，返回它的 id 和目录 |
| `next/test/deliver-preview.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`delivery.ts`：

- `insideGit(root)`：`git rev-parse --is-inside-work-tree` 退出码是 0 时为真。
- `changedAmong(root, paths)`：这些路径里现在有改动的文件，含新增、删除和没有跟踪的，不含被 Git 忽略的；路径是目录时列出目录里的文件。命令是 `git --literal-pathspecs status --porcelain -z --no-renames -uall -- <路径…>`，每一项去掉开头的两个状态字符和一个空格就是路径。`paths` 是空的时候直接返回空数组，不运行 Git：不带路径时 Git 会列出整个工作区。
- `previewDelivery(root, stored)`：只读，算出预览要显示的内容：
  - 归档之后的目录（`archiveDirOf`）。
  - 项目在不在 Git 仓库里。
  - 记录的路径：`record.json` 里 `changedPaths` 和每一次执行的 `changedPaths` 合在一起，去重、排序。
  - 要提交的文件：`changedAmong(root, 记录的路径)`。其中给出过结论的执行（`verdict` 不是 `null`）改过的，算审查改过。
  - 没有改动的记录路径：记录的路径里，既不是某个要提交的文件、也不是某个要提交的文件所在目录的那些。
  - 别的改动有几处：`changedAmong(root, ["."])` 里去掉要提交的文件、任务目录里的文件和 `.knit/.runtime/` 下的文件之后的个数。
  - 任务目录会不会被提交：`git check-ignore -q -- <任务目录>/task.md` 退出码不是 0（没有被忽略）时会。
  - 没结束的子任务：`parent` 是这个任务、状态不是 `done`、`delivered`、`cancelled` 的任务。
  - 不在 Git 仓库里时，要提交的文件、没有改动的记录路径、别的改动都不算，只算归档目录和子任务。

`knit deliver <id> --preview` 的输出（在 Git 仓库里）：

```
任务: <标题>（<id>）
归档: <任务目录> → <归档之后的目录>
提交的文件:
  src/a.ts
  src/b.ts（审查改过）
  <任务目录>/（整个目录，移到归档的位置）
提示:
  - 记录里有 1 个路径现在没有改动，不会被提交：src/gone.ts
  - 工作区里还有 2 处不属于这个任务的改动，不会被提交
  - 子任务还没有结束：<id>（<状态>）、<id>（<状态>）
结果:
  <「结果」的全文，每一行前面加两个空格，空行保持是空行>
提交文案:
  <文案文件的内容，去掉首尾空白，每一行前面加两个空格，空行保持是空行>
```

- 没有文件、任务目录也被忽略时，`提交的文件:` 一段换成一行 `提交的文件: 没有，不会提交`。
- 三条提示各自有内容才出现；一条都没有时没有 `提示:` 这一段。
- 没有给 `--message-file` 时，最后一段换成一行 `提交文案: 没有给；交付时加 --message-file <文件>`。
- 不在 Git 仓库里时，`提交的文件` 一段换成一行 `提交: 这个项目不在 Git 仓库里，只归档，不提交`，没有 `提交文案` 一段，也不读 `--message-file`。

拒绝（退出码 1，写到标准错误）：

- 任务不存在、任务文件有格式问题：沿用 `loadTask`（`next/src/cli/task.ts`）的报错。
- 状态是 `draft`、`ready`、`active`：`任务 <id> 还没有完成（<状态>）；完成之后再交付：knit task close <id>`。状态用 `currentStatus` 算。
- 状态是 `delivered`、`cancelled`：`任务 <id> 已经结束（<状态>），不能交付`。
- 给了 `--message-file` 而文件读不到：`读不到提交文案：<路径>`。路径相对当前目录，不相对 `--dir`。
- 不带 `--preview`：`knit deliver 现在只能预览：加 --preview`。交付在下一个任务里做。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`，不在本仓库里运行 `git add`、`git commit`、`git reset`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function archiveTask" next/src/application/task-store.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `task-store.ts`、`workspace.ts`，写 `delivery.ts`、`cli/deliver.ts`，在 `cli/knit.ts` 里注册。
4. 写测试。Git 仓库用 `next/test/helpers/git.mjs` 的 `gitProject`，不在 Git 仓库里的项目用 `next/test/helpers/cli.mjs` 的 `project`。建任务并确认可以用 `next/test/helpers/run.mjs` 的 `readyTask`。要一次给出过结论的执行时，照 `next/test/task-runs.test.mjs` 的写法用 `prepareRun`、`finishRun` 准备（这时项目要用 `runProject`）。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): preview what delivering a task will do`。

## 完成条件

### Requirement: 交付预览

#### Scenario: 在 Git 仓库里列出要提交的文件和提示

- GIVEN Git 仓库里一个已经完成的任务，记录的路径有 `src/a.ts`（改了）、`src/b.ts`（一次给出过结论的执行新增的）、`src/gone.ts`（现在没有改动）；工作区里另有一个新文件 `other.txt`；它有一个状态是 `draft` 的子任务
- WHEN 运行 `knit deliver <id> --preview --message-file <文件>`
- THEN 退出码是 0，输出依次是任务、归档、提交的文件（`src/a.ts`、`src/b.ts（审查改过）`、任务目录一行）、三条提示、结果、提交文案，写法和上面的一样
- AND 运行前后 `git status --porcelain` 的输出相同，任务的 `task.md`、`record.json` 没有变

#### Scenario: 不在 Git 仓库里只说明归档

- GIVEN 不在 Git 仓库里的项目里一个已经完成的任务，记录的路径有 `src/a.ts`
- WHEN 运行 `knit deliver <id> --preview`
- THEN 退出码是 0，输出是任务、归档、`提交: 这个项目不在 Git 仓库里，只归档，不提交`、结果；没有 `提交的文件`、`提交文案`，这个任务没有子任务，所以也没有 `提示`
- AND 任务目录还在原处

#### Scenario: 不能交付的任务被拒绝

- GIVEN 一个状态是 `ready` 的任务，和一个已经取消的任务
- WHEN 分别运行 `knit deliver <id> --preview`
- THEN 退出码都是 1，标准输出是空的，标准错误分别是上面两句拒绝的话
- AND 对已经完成的任务运行不带 `--preview` 的 `knit deliver <id>`，退出码是 1，标准错误是 `knit deliver 现在只能预览：加 --preview`

## 待澄清

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付做什么、预览列出什么
- `.knit/standards/development.md` — 开发规范
- `next/src/application/task-store.ts` — `archiveTask`、`scanTasks`、`StoredTask`
- `next/src/application/workspace.ts` — `RUNTIME_PREFIX`
- `next/src/infrastructure/process.ts` — `gitSync`
- `next/src/cli/task.ts` — `loadTask`、`fail`；`task show` 里合并改动文件的写法
- `next/src/cli/knit.ts` — 注册命令的地方
- `next/test/helpers/git.mjs` — `gitProject`、`commitAll`
- `next/test/helpers/run.mjs` — `runProject`、`readyTask`
- `next/test/task-runs.test.mjs` — 用 `prepareRun`、`finishRun` 准备执行的写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-73971fbae23c -->
- 操作: op-73971fbae23c
- 时间: 2026-11-16T11:41:33.999Z
- 分支: refs/heads/main
- 授权来源: user:562bcbd5
- 调用: bridge
- 工作提交: 84422e1eb34fd52082358d9ba772c816ba3b2042
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-f1-deliver-preview

<!-- knit:progress:end -->
