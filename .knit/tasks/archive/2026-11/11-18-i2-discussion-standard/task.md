---
id: k-89295386576c
title: I2 讨论规范
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn: []
priority: P1
createdAt: 2026-11-18T08:05:55.216Z
---

## 目标与范围

旧 Knit 在 `AGENTS.md` 里维护一个受管块，里面有几条只有主会话才用的规则：提问之前先查、一轮最多问几个、什么时候派给执行者、长期规则怎么写进规范。受管块已经删掉（提交 `68ee679`），这几条现在哪里都没有写。用户 2026-11-18 决定把它们写成一份适用讨论环节的规范。

只新增一个文件：`.knit/standards/discussion.md`，开头声明 `title: 讨论规范`、`stages: [discuss]`。内容分五节，来源是受管块原文（`git show 69d8ff8:AGENTS.md` 里 `knit:managed-begin` 到 `knit:managed-end` 之间），只取新 Knit 里还成立的：

1. 先查再问：提问前先查仓库和以前的任务；查到的只说明现状，要做成什么由用户决定；按哪几项看缺口。
2. 怎么问：一轮最多 3 个问题，一问一事；每问写要定什么、为什么、推荐项、另一项的代价；按推荐往下做时记 `[assumed]`；和已有决定冲突时先说冲突；挡着往下做的记 `[blocking]`。
3. 确认：建任务不等于确认需求或同意动手；确认之前给摘要；验证不了的延后项不写成完成条件。
4. 谁来做：什么样的任务派给执行者，什么样的主会话直接做；要求独立审查的任务，审查必须由执行者做。
5. 长期规则：用户明确的直接写进规范并告知；拿不准的当场问；只对这一次有效的不写。

不写进去的：

- 「是否建任务由用户决定」：没有选中任务时收不到讨论规范，这一条留在 `AGENTS.md`（已经有）。
- 场景的写法：`knit task ready` 会检查并给出示例。
- 旧 Knit 才有的：`task implement`、`task search`、`task update --kind`、规范候选文件、`run check --scope`。

不能动的：

- 别的规范文件、`AGENTS.md`、代码和模板。把这份规范放进模板是 I1 的事。

## 完成条件

- `knit standards list` 列出七份规范，其中一行是 `.knit/standards/discussion.md  讨论规范  discuss`，没有告警。
- `knit context k-966b2bf6ef60`（一个 `draft` 任务）的输出里有 `<standard path=".knit/standards/discussion.md"`。
- `grep -cE "task implement|task search|task update|candidates|run check" .knit/standards/discussion.md` 输出 `0`。

## 待澄清

无。

## 相关资料

- `.knit/standards/task-writing.md`、`.knit/standards/task-splitting.md`、`.knit/standards/pitfalls-main.md` — 同样适用讨论环节，新规范不重复它们的内容
- `.knit/tasks/11-14-slim-refactor/design.md#4. 规范` — 规范文件怎么写

## 结果

新增 `.knit/standards/discussion.md`（讨论规范，适用 discuss，2,783 字节），五节：先查再问、怎么问、确认、谁来做、长期规则。内容取自旧受管块里新 Knit 还成立的部分。三条完成条件都运行过：`knit standards list` 列出七份规范、没有告警；`draft` 任务的 `knit context` 输出里有这份规范；旧命令的 grep 输出 0。讨论环节每轮给主会话的内容从 5,101 字节增加到 7,919 字节。没有放进模板，那是 I1 的事。
