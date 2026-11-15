---
id: k-6ee0f30669c2
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn:
  - k-0e1db9419488
order: null
createdAt: 2026-11-15T07:48:52.609Z
title: C5 next 的 knit task ready：确认需求
---

# C5 next 的 knit task ready：确认需求

## 目标与范围

背景：本仓库正在把 Knit 重写成一个小核心，新代码在 `next/`，旧代码不动。任务创建时是 `draft`，用户确认需求之后才能开始做。`task ready` 是这道门：需求里还有没定的事、或完成条件写得不能验证时拒绝，并说明怎么改；通过后记下当时需求部分的摘要，之后需求被改动就能看出来（`.knit/tasks/11-14-slim-refactor/design.md` 第 3.2 节、第 3.3 节）。

做完之后的不同：`node next/dist/cli/knit.js task ready <id>` 可以确认一个任务的需求。

产出：

| 文件 | 做成什么样 |
| --- | --- |
| `next/src/application/task-store.ts`（修改） | 扫描出的任务带上两个文件读入时的版本（SHA-256）；新增 `saveTask`，把改过的 `task.md` 和 `record.json` 写回 |
| `next/src/cli/task.ts`（修改） | 注册 `task ready` |
| `next/test/task-ready.test.mjs`（新增） | 见「完成条件」的三个场景，各一个测试 |

`saveTask`：

- 用 `atomicWrite` 写，`mode` 传 `0o644`，`expectedSha256` 传读入时的版本：读入之后文件被别人改过就不覆盖，报告出来。`record.json` 原来不存在时 `expectedSha256` 传 `null`。
- 先写 `record.json`，再写 `task.md`。两次写之间中断时，文件里的状态和记录的摘要对不上，`currentStatus` 会把它算作 `draft`，重新确认一次即可。

`task ready <id>` 的行为（`--dir <目录>` 默认当前目录）：

1. 找不到任务：标准错误 `没有任务 <id>；用 knit task list 查看现有任务`，退出码 1。`task.md` 有格式问题：逐条打印问题，退出码 1。
2. 用 `currentStatus` 算任务现在的状态，按状态分：
   - `draft`：继续第 3 步。文件里是 `ready` 或 `active`、但确认后改过需求的任务也算 `draft`。
   - `ready`：打印 `已确认，需求没有变化`，不写文件，退出码 0。
   - `active`：标准错误 `任务正在 <环节 id> 环节，需求没有变化，不需要重新确认`，退出码 1。
   - `done`、`delivered`、`cancelled`：标准错误说明任务已经结束（带上状态），要继续做就新建一个任务，退出码 1。
3. 检查需求部分，下面三条有任何一条不满足就拒绝：把不满足的都打印到标准错误，每条后面跟着怎么改，退出码 1，不写文件。
   - 「待澄清」里有 `[blocking]`：列出前 3 条的正文；写明“和用户定下来之后，把结论写进正文并删掉这一行”。
   - 「完成条件」的场景有写法问题：逐条列出问题，后面附上 `SCENARIO_FORMAT_EXAMPLE`。
   - `verification` 是 `independent` 而一个场景都没有：写明“独立审查的任务必须把完成条件写成场景”，附上 `SCENARIO_FORMAT_EXAMPLE`，并写明另一条路是把 `task.md` 开头的 `verification` 改成 `self`。
4. 通过：`record.json` 的 `confirmedDigest` 写成现在的需求摘要；`task.md` 的 `status` 改成 `ready`，`stage` 改成 `null`。确认后改过需求的任务原来在某个环节里的，重新确认后回到 `ready`，从第一个环节重新开始。
5. 打印 `已确认 <id>：N 个场景`；「待澄清」里有 `[assumed]` 时再打印一行 `还有 M 项 [assumed] 没有得到用户确认`。退出码 0。

- `verification` 是 `self` 或 `none` 的任务可以不写场景，完成条件用普通的列表也行。
- 不检查依赖的任务有没有完成：那是开始做的时候看的事，不在本任务里。
- 只做人读的输出，不做 `--json`。

新写的代码遵守 `.knit/standards/development.md`。

不能动的：

- `next/` 以外的所有文件：旧代码在切换前保持原样，所以本任务不需要运行旧的 `npm test`。
- C1、C2 的文件：格式和解析由它们定，本任务只调用。发现问题写进报告，不在本任务里改。
- `task new`、`task list`、`task show` 的行为不变，它们的测试继续通过。
- 所有验证都在临时目录里做，不对本仓库运行 `task ready`：本仓库的任务还是旧格式。
- 不加依赖，不提交、不推送。

前置条件：C4 已完成。运行 `npm run test:next` 能通过，并且 `ls next/src/application/task-store.ts next/src/domain/task-requirements.ts next/test/helpers/cli.mjs` 都存在。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」。
3. 改 `task-store.ts`，在 `cli/task.ts` 里加 `task ready`。
4. 写测试：用 `next/test/helpers/cli.mjs` 建临时项目，用 `task new` 建任务，再直接改写临时项目里的 `task.md` 填入需求。
5. 按「验证」核对。

验证：

- `npm run test:next`：通过，输出里 `fail 0`。
- `git status --short`：和开始前相比，只多出 1 个新文件和上表两个文件的修改。
- `git diff --stat -- src test assets scripts package.json`：没有输出。
- 同一条命令因同一原因失败两次就停下，在报告里写出命令和输出，不再重试。

交回：改动留在工作区。报告里写：改动的文件、运行过的命令和最后一次完整运行的测试数、没有验证的内容。

做完之后：主会话核对后收尾；提交由用户另行授权，文案首行建议 `feat(next): add task ready`。

## 完成条件

### Requirement: 确认需求

#### Scenario: 确认通过

- GIVEN 一个 `draft` 任务，「完成条件」里有两个写法正确的场景，「待澄清」里没有 `[blocking]`
- WHEN 运行 `task ready <id>`
- THEN `task.md` 的状态变成 `ready`，`record.json` 的 `confirmedDigest` 等于现在的需求摘要
- AND 标准输出里有 `2 个场景`，退出码为 0

#### Scenario: 不满足时拒绝并说明怎么改

- WHEN 对「待澄清」里有 `[blocking]` 的任务、场景缺 `THEN` 的任务、或 `independent` 而没有场景的任务运行 `task ready <id>`
- THEN 标准错误里说明是哪一条不满足以及怎么改，退出码为 1
- AND `task.md` 逐字不变，`record.json` 没有被创建或改动

#### Scenario: 确认后改了需求要重新确认

- GIVEN 一个已经确认的任务
- WHEN 改动它的需求部分后再运行 `task ready <id>`
- THEN 状态是 `ready`，`confirmedDigest` 更新成改动后的需求摘要
- AND 不改动直接再运行一次时，打印 `已确认，需求没有变化`，文件不变

## 相关资料

- `.knit/tasks/11-14-slim-refactor/design.md` 第 3 节 — 任务资料：状态、确认摘要、待澄清和完成条件的写法
- `.knit/standards/development.md` — 开发规范
- `next/src/application/task-store.ts` — 要改的文件：扫描、查找、创建任务
- `next/src/domain/task-document.ts`、`next/src/domain/task-record.ts` — `currentStatus`、`requirementDigest`、渲染
- `next/src/domain/task-requirements.ts` — `scenarioStateOf`、`clarifyStateOf`、`SCENARIO_FORMAT_EXAMPLE`
- `next/src/infrastructure/atomic.ts` — `atomicWrite`、`readWithVersion`
- `next/src/cli/task.ts`、`next/test/task-view.test.mjs`、`next/test/helpers/cli.mjs` — 命令和命令测试的现有写法

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
