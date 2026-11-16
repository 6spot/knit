---
id: k-24749f3aa449
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-3f89354bec0b
order: null
createdAt: 2026-11-16T09:01:03.810Z
title: F2 交付：归档
---

# F2 交付：归档

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。交付是把一个已经完成（`done`）的任务归档；项目在 Git 仓库里时，再把这个任务的改动提交成一次提交。Git 不是必须的：项目不在 Git 仓库里时只归档，不提交。Knit 任何时候都不推送。

`knit deliver <任务> --preview` 已经有了（`next/src/cli/deliver.ts`）。本任务做交付里和 Git 无关的那一半：核对能不能交付、记下授权、把状态改成 `delivered`、把任务目录移到归档目录。提交那一半在下一个任务里做。

做完之后的不同：不在 Git 仓库里的项目，`knit deliver <任务> --authorization <引用>` 能把一个完成的任务交付掉。在 Git 仓库里，本任务做完时它也只归档、不提交，输出里没有 `提交` 一行；下一个任务补上提交。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/cli/deliver.ts`（修改） | 加选项 `--authorization <引用>`；不带 `--preview` 时做交付 |
| `next/test/deliver.test.mjs`（新增） | 见「完成条件」的两个场景，各一个测试 |

不带 `--preview` 的 `knit deliver <id>`，依次：

1. 任务不存在、文件有格式问题、状态不是 `done`：和预览一样拒绝，报错的话不变。
2. 没有给 `--authorization`，或者去掉首尾空白之后是空的：拒绝，`交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的`。项目不在 Git 仓库里时也要：归档和提交各自都要授权。
3. 用 `saveTask` 把状态改成 `delivered`，把 `record.json` 的 `authorization` 写成去掉首尾空白的引用。`saveTask` 返回问题时照原样报出来，退出码 1，不往下做。
4. 用 `archiveTask` 把任务目录移到归档目录。
5. 输出：

   ```
   已交付 <id>
   归档: <归档之后的目录>
   提交: 这个项目不在 Git 仓库里，没有提交
   ```

   第三行只在项目不在 Git 仓库里时有（`insideGit`，`next/src/application/delivery.ts`）。

命令行只要求有授权引用，不核对它是不是真的：核对由桥接在调用之前做，不在本任务里。

原来“不带 `--preview` 时报只能预览”的那一句和它的测试断言去掉。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- `next/` 里没有列在「产出」里的文件和测试。发现问题写进报告，不在本任务里改。
- 测试只在临时目录里做，不读写本仓库的 `.knit/`，不在本仓库里运行 `git add`、`git commit`、`git reset`。
- 不加依赖，不提交、不推送。

前置条件：运行 `npm run test:next` 能通过，并且 `grep -n "export function previewDelivery" next/src/application/delivery.ts` 有输出。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `cli/deliver.ts`。
4. 写测试，用 `next/test/helpers/deliver.mjs` 的 `doneTask`。`next/test/deliver-preview.test.mjs` 里核对“只能预览”的那一处断言删掉，别的不动。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出「产出」里的文件。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 「产出」之外允许改的只有 `next/test/deliver-preview.test.mjs` 里那一处断言。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): archive a task on delivery`。

## 完成条件

### Requirement: 交付时归档

#### Scenario: 不在 Git 仓库里交付一个完成的任务

- GIVEN 不在 Git 仓库里的项目里一个已经完成的任务
- WHEN 运行 `knit deliver <id> --authorization " user:1a2b3c4d "`
- THEN 退出码是 0，输出是上面的三行
- AND 任务目录移到了 `.knit/tasks/archive/<YYYY-MM>/<原目录名>`，原处没有了；`task.md` 的状态是 `delivered`，需求部分和「结果」没有变；`record.json` 的 `authorization` 是 `user:1a2b3c4d`，别的字段没有变
- AND `knit task list` 里没有它，`knit task list --archive` 里有

#### Scenario: 不能交付时什么都不变

- GIVEN 一个状态是 `ready` 的任务，和一个已经完成的任务
- WHEN 对前一个运行 `knit deliver <id> --authorization user:1a2b3c4d`；对后一个运行不带 `--authorization` 的 `knit deliver <id>`，再运行 `--authorization "  "`
- THEN 退出码都是 1，标准输出是空的；标准错误分别是“还没有完成”那一句和“交付要有用户的授权”那一句
- AND 两个任务的目录都在原处，`task.md`、`record.json` 逐字没有变

## 待澄清


## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md#82-交付` — 交付做什么
- `.knit/tasks/11-14-slim-refactor/design.md#33-recordjson` — `authorization` 字段
- `.knit/standards/development.md` — 开发规范
- `next/src/cli/deliver.ts` — 要改的文件
- `next/src/application/delivery.ts` — `insideGit`
- `next/src/application/task-store.ts` — `saveTask`、`archiveTask`
- `next/src/cli/task.ts` — `task cancel` 里改状态再归档的写法
- `next/test/helpers/deliver.mjs` — `doneTask`
- `next/test/deliver-preview.test.mjs` — 要删一处断言

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-edd30d25fb72 -->
- 操作: op-edd30d25fb72
- 时间: 2026-11-16T11:41:45.914Z
- 分支: refs/heads/main
- 授权来源: user:562bcbd5
- 调用: bridge
- 工作提交: 4115c1398b8531b4f1e1fff372cbdd41fb90cb36
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-16-f2-deliver-archive

<!-- knit:progress:end -->
