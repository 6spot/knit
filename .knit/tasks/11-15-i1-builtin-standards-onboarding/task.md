---
id: k-966b2bf6ef60
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P3
dependsOn: []
order: 10
createdAt: 2026-11-15T03:05:44.637Z
title: I1 通用规范进模板，初始化后生成引导任务
---

# I1 通用规范进模板，初始化后生成引导任务

## 目标与范围

需求未全部确认，仅登记方向。重构切换完成（`plan.md` 的 H 批全部交付）之后再讨论细节和开始做；届时按 `.knit/standards/task-writing.md` 把本文件补写到可以直接执行，并按 `.knit/standards/task-splitting.md` 拆成两个任务（模板里的通用规范、引导任务）。

背景：本仓库的 `.knit/standards/` 里有三份规范写的是“怎么用 Knit 管任务”，不只对本仓库成立：

- `task-writing.md`（任务编写）
- `task-splitting.md`（任务拆分）
- `delivery.md`（交付）

现在 `knit init` 只生成一个空的规范目录，新项目要自己从头写这三份。用户决定（2026-11-15）：通用的规范由 Knit 自带，初始化时直接生成；初始化之后再用一个引导任务带用户把项目自己的规范补齐。

要做的两件事：

1. 通用规范进模板。把上面三份里通用的内容放进 `assets/templates/.knit/standards/`，`knit init` 在项目里没有同名文件时生成；已有的文件不覆盖，`--force` 也不覆盖。
2. 引导任务。`knit init` 第一次在一个项目里运行时，在 `.knit/tasks/` 下生成一个任务，由主会话带用户完成：过一遍自带的三份规范并按项目情况修改；从项目已有的约定文件（`AGENTS.md`、`CONTRIBUTING.md` 等）和代码里总结出开发规范；说明避坑清单是什么、什么时候往里加。

不在范围内：

- 开发规范（`development.md`）和避坑清单（`pitfalls-*.md`）的内容不进模板，它们写的是具体项目的情况。
- 不改规范的注入方式和文件格式（见主任务 `design.md` 第 4、5 节）。

参考：Trellis 的 `trellis init` 在第一次初始化或任务目录为空时生成 `00-bootstrap-guidelines` 任务，目录已存在就不再生成；任务正文要求先读项目已有的约定文件，再看真实代码，写“代码现在怎么做”而不是“应该怎么做”（`packages/cli/src/commands/init.ts`，提交 f089cb3）。

## 完成条件

- 在一个空项目里运行 `knit init`：`.knit/standards/` 下有三份通用规范，`knit standards list` 能列出，各自声明了适用环节。
- 项目里已有同名规范时再运行 `knit init` 或 `knit init --force`：文件内容不变。
- 第一次 `knit init` 之后 `knit task list` 里有引导任务；再次运行不会生成第二个。
- 引导任务的 `task.md` 符合任务编写规范：主会话只凭它就能带用户做完。

## 待澄清

- [assumed] 交付规范里的提交文案语言和类型列表是本仓库的选择，模板里只留通用部分（完成与汇报、授权、提交范围、同一原因失败两次就停），文案格式留给引导任务让用户定（Agent 建议，待确认）。
- [assumed] 本仓库的这三份和模板里的三份内容会有重合。模板是来源，本仓库的是初始化生成后按自己情况改过的副本，两边不要求一致，也不加逐字比对的测试（Agent 建议，待确认）。
- [assumed] 模板里的通用规范更新后，已初始化的项目不自动跟进；`knit init --check` 只提示“自带规范有新版本”，由用户决定是否合并（Agent 建议，待确认）。
- [assumed] 引导任务只在第一次初始化时生成；用户取消或完成后不再生成（Agent 建议，待确认）。

## 相关资料

- `.knit/standards/task-writing.md`、`.knit/standards/task-splitting.md`、`.knit/standards/delivery.md` — 现有的三份，通用内容的来源
- `.knit/tasks/11-14-slim-refactor/design.md` 第 4 节、第 10 节 — 规范的格式；`knit init` 不覆盖哪些内容
- `.knit/tasks/11-14-slim-refactor/plan.md` — 子任务清单，本任务排在 H 批之后

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
