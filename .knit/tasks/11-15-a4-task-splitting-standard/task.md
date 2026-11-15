---
id: k-1a847b67af63
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T16:23:29.071Z
title: A4 任务拆分规范：写入 .knit/standards/task-splitting.md
---

# A4 任务拆分规范：写入 .knit/standards/task-splitting.md

## 目标与范围

背景：本仓库正在把 Knit 重构成一个小核心（见 `.knit/tasks/11-14-slim-refactor/design.md`）。项目规范放在 `.knit/standards/`，一份一个文件，开头声明适用的环节，由 Knit 交给对应环节的智能体。

产出：新增一个文件 `.knit/standards/task-splitting.md`，写一件事该怎么拆成任务。供主会话在讨论需求、登记任务时遵守。

- 文件开头：

  ```markdown
  ---
  title: 任务拆分规范
  stages: [discuss]
  ---
  ```

- 正文用中文，一条规则一到两句。整个文件不超过 4096 字节。
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在合并请求说明里。开头的声明之后直接写正文，不加重复的标题。
- 每条规则要能用来判断“这个任务是否符合”，不写笼统的原则。
- 只写怎么拆。一个任务的正文怎么写已经有规范（`.knit/standards/task-writing.md`），不重复它的内容。

起点是下面五条草案。逐条给出结论：保留、改写或删除，并写理由。可以补充草案里没有、但「相关资料」里有记录支持的规则。

1. 一个任务只做一个行为变化，能单独完成、单独验证，完成后测试全绿。
2. 一个任务的验收不超过 3 个场景，超过就拆。
3. 会改同一批文件的任务用 `dependsOn` 排成先后，不并行。
4. 主任务不直接产出代码。
5. 同一操作因同一原因失败两次就停下报告，不再重试。

步骤：

1. 从最新的 `main` 开分支 `a4-task-splitting-standard`。
2. 读「相关资料」里的文件。`plan.md` 是按这五条草案拆出来的 38 个子任务，可以用它检验每条规则是否好用。
3. 写出规则，写入文件。
4. 按「验证」核对，然后提交并交回。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不调整已经登记的任务。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/` 和 `.knit/tasks/` 下的所有文件：这些是流程和任务资料，由登记任务的主会话维护。
- 不运行 `knit task …`、`knit run …`、`knit deliver`：任务状态存在主会话所在的机器上，在别处运行会得到错误的状态。

验证：

- 运行 `wc -c .knit/standards/task-splitting.md`，结果不超过 4096。
- 运行 `git status --short`，除新增的文件外没有别的改动。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在合并请求说明里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在合并请求说明或回复里写出失败的命令和输出，不再重试。

提交与交回（用户把这个任务交给你执行，即同意你在这个分支上提交、推送并开合并请求；合并不在其内）：

- 提交一次，只含 `.knit/standards/task-splitting.md` 这一个文件。
- 提交文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-1a847b67af63`。
- 推送分支 `a4-task-splitting-standard`，开一个指向 `main` 的合并请求，说明里写上「完成条件」要求的内容。不合并，不直接改 `main`。

做完之后：合并请求由用户审阅、合并。合并后由主会话在登记任务的机器上把本任务标记完成，并把 `.knit/tasks/11-14-slim-refactor/task.md` 里的五条草案换成指向这份文件。

说明：这份规范是给主会话的。现在的 Knit 不会把规范交给主会话，它从切换到小核心起自动生效。

## 完成条件

- 文件存在，开头有 `title` 和 `stages`，不超过 4096 字节。
- 合并请求说明里写明五条草案每条的结论和理由。
- 提交里只有这一个文件。

## 相关资料

- `.knit/standards/task-writing.md` — 任务编写规范，不要重复它
- `.knit/tasks/11-14-slim-refactor/plan.md` — 按草案拆出的 38 个子任务
- `.knit/tasks/11-14-slim-refactor/research/findings.md` 第 1、6 节 — 交付积压的记录；93 个历史任务的用量
- `.knit/tasks/11-14-slim-refactor/design.md` 第 3 节 — 任务资料的结构

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
