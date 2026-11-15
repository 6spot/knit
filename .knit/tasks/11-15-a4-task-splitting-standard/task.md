---
id: k-1a847b67af63
status: closed
stage: deliver
outcome: completed
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
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在本任务目录的 `research/notes.md` 里。开头的声明之后直接写正文，不加重复的标题。
- 每条规则要能用来判断“这个任务是否符合”，不写笼统的原则。
- 只写怎么拆。一个任务的正文怎么写已经有规范（`.knit/standards/task-writing.md`），不重复它的内容。

起点是下面五条草案。逐条给出结论：保留、改写或删除，并写理由。可以补充草案里没有、但「相关资料」里有记录支持的规则。

1. 一个任务只做一个行为变化，能单独完成、单独验证，完成后测试全绿。
2. 一个任务的验收不超过 3 个场景，超过就拆。
3. 会改同一批文件的任务用 `dependsOn` 排成先后，不并行。
4. 主任务不直接产出代码。
5. 同一操作因同一原因失败两次就停下报告，不再重试。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」里的文件。`plan.md` 是按这五条草案拆出来的 38 个子任务，可以用它检验每条规则是否好用。
3. 写出规则，写入文件。
4. 按「验证」核对，然后提交并交回。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不调整已经登记的任务。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，以及 `.knit/tasks/` 下其它任务的文件：这些是流程配置和别的任务的资料。
- 不运行 `knit run …`、`knit deliver`，不提交、不推送：提交要等用户审阅并授权。

验证：

- 运行 `wc -c .knit/standards/task-splitting.md`，结果不超过 4096。
- 运行 `git status --short`，和开始前相比只多出本任务的文件。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在汇报里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在汇报里写出失败的命令和输出，不再重试。

交回：

- 改动留在工作区。把「完成条件」要求的说明写进本任务目录的 `research/notes.md`，然后汇报。
- 提交时的文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-1a847b67af63`。

做完之后：用户审阅工作区里的文件，同意后由主会话收尾（`knit task ready`，`knit task implement` 登记改动文件和做过的验证，`knit task close`），提交另行授权，并把 `.knit/tasks/11-14-slim-refactor/task.md` 里的五条草案换成指向这份文件。

说明：这份规范是给主会话的。现在的 Knit 不会把规范交给主会话，它从切换到小核心起自动生效。

## 完成条件

- 文件存在，开头有 `title` 和 `stages`，不超过 4096 字节。
- `research/notes.md` 里写明五条草案每条的结论和理由。
- 本任务新增的只有这个文件和 `research/notes.md`。

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

### 交付记录

<!-- knit:delivery:op-3441d37e5c05 -->
- 操作: op-3441d37e5c05
- 时间: 2026-11-15T02:57:46.893Z
- 分支: refs/heads/main
- 授权来源: user:28c6d6cf
- 调用: bridge
- 工作提交: a476bc4aaf874d90d3a854e777681ea033ecc20d
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-a4-task-splitting-standard

<!-- knit:progress:end -->
