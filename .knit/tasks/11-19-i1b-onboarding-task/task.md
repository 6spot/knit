---
id: k-759b948a5d61
title: I1b 初始化后生成一个完善开发规范的任务
status: draft
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn:
  - k-966b2bf6ef60
  - k-d8b5009c9981
priority: P3
createdAt: 2026-11-18T17:22:55.111Z
---

## 目标与范围

新项目运行 `knit init` 之后，项目自己的开发规范还没有。用户决定（2026-11-15 提出，2026-11-19 定下做法，`user:4eb94f6e`）：初始化之后默认生成一个任务，让用户把项目的开发规范写出来。这个任务只做这一件事，不带别的。

前置条件：I1a 已经做完（它也改 `src/application/init.ts` 和初始化的测试，两个任务不同时进行）。

要做的：

1. 新增模板 `assets/templates/tasks/bootstrap-standards.md`：这个任务的正文（从「## 目标与范围」到「## 相关资料」，不含开头的元数据）。它要符合任务编写规范：主会话只拿到项目和这份正文，就能带用户做完。内容只有一件事——写出项目的开发规范 `.knit/standards/development.md`（声明 `stages: [implement, review]`）：
   - 先读项目已有的约定文件（`AGENTS.md`、`CONTRIBUTING.md`、`README.md` 里讲开发的部分），再看真实的代码和测试。
   - 写“代码现在怎么做”，不写“应该怎么做”；每一条都要能指出它在代码里的依据。
   - 写完给用户看，用户同意后保存。
   - 完成条件用自由列表：`development.md` 存在并声明了环节；`knit standards list` 没有告警；用户看过并同意。
2. `knit init` 在项目里一个任务都没有（归档的也算）时，初始化之后建这个任务：标题「完善项目的开发规范」，目录名里的名称 `bootstrap-standards`，验证方式 `self`，优先级 `P1`，状态 `draft`，正文是上面的模板。用现有的 `createTask`（`src/application/task-store.ts`）建，再把正文写进去；有没有任务用现有的 `scanTasks` 看。
3. 建了任务时，输出在最后多一行：`初始化任务: <id>（<task.md 的路径>）；在 Pi 里用 knit_task 的 use 选中它`。没有建时没有这一行。
4. 设计跟着改：`docs/design/DESIGN.md` 第 11 节「延后」表里删掉「自带通用规范与引导任务」一行，第 4 节加一条说明这个任务什么时候生成。

会受影响的地方（都要处理，处理办法写进报告）：

- 测试：`test/init.test.mjs`「在空目录里初始化」断言任务目录是空的、输出逐字相同。`test/helpers/bridge.mjs` 的 `loadBridge` 在空的临时目录里运行 `knit init`，之后每个桥接测试的项目里都会多一个任务：跑一遍 `npm test` 找出因此失败的断言，按新行为改，不删测试。
- 演练脚本 `validation/slim-h1-2026-11/setup.sh` 在新项目里运行 `knit init`，`cancel.sh` 用 `.knit/tasks/*/task.md` 找唯一的任务。让 `setup.sh` 在 `knit init` 之后把这个任务的目录删掉（演练不需要它），并用 `KNIT_H1_LOGS="$(mktemp -d)" ./refusals.sh` 验证脚本还能跑（这个脚本不调用模型）。

不在范围内：

- 不判断是不是“第一次初始化”，不加关掉它的选项。重复运行 `knit init` 时不能每次多建一个，所以只在项目里一个任务都没有（归档的也算）时才建；已经在用 Knit 的项目因此不会收到这个任务（用户 2026-11-19 确认，`user:26e7f619`）。
- 这个任务不自动选中，不自动确认，不派给执行者：它由主会话和用户一起做。
- 任务的正文不带用户过一遍自带的规范，不讲避坑清单。
- 不加依赖，不提交、不推送。

先改测试再改代码。

## 完成条件

- 在空目录里运行 `knit init`：`knit task list` 里正好有一个任务，标题是「完善项目的开发规范」，状态 `draft`；它的 `task.md` 正文和模板逐字相同；输出的最后一行以 `初始化任务: ` 开头。
- 再运行一次 `knit init` 或 `knit init --force`：不再建任务，输出里没有 `初始化任务` 这一行。把这个任务取消（它会进归档）之后再运行，也不建。
- 这个任务的正文通得过格式检查：在测试里对它运行 `knit task ready`，退出码 0。
- 上面三条各有测试。`npm test` 全部通过，测试个数不比改之前少（改之前先运行一次记下个数；改之前就有失败时停下来报告）；`npm run typecheck` 退出码 0；`npm run pack:check` 通过。
- `KNIT_H1_LOGS="$(mktemp -d)" validation/slim-h1-2026-11/refusals.sh` 以退出码 0 结束；`git status --short validation/slim-h1-2026-11/logs` 没有输出。

## 待澄清

无。

## 相关资料

- `src/application/init.ts`、`src/cli/init.ts` — 初始化的逻辑和输出
- `src/application/task-store.ts` — `createTask` 和 `scanTasks`
- `.knit/standards/task-writing.md` — 任务的正文要符合的规范
- `docs/design/DESIGN.md#4. 规范` — 两类规范的分工

参考：Trellis 的 `trellis init` 在第一次初始化或任务目录为空时生成 `00-bootstrap-guidelines` 任务；任务正文要求先读项目已有的约定文件，再看真实代码，写“代码现在怎么做”而不是“应该怎么做”（`packages/cli/src/commands/init.ts`，提交 f089cb3）。

交付：提交文案首行建议 `feat: create a task for the project standards on knit init`。
