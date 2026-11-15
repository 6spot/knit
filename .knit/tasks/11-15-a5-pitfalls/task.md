---
id: k-7e8d766d2a81
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T16:23:29.962Z
title: A5 避坑清单：写入 .knit/standards/
---

# A5 避坑清单：写入 .knit/standards/

## 目标与范围

背景：本仓库正在把 Knit 重构成一个小核心（见 `.knit/tasks/11-14-slim-refactor/design.md`）。项目规范放在 `.knit/standards/`，一份一个文件，开头声明适用的环节，由 Knit 交给对应环节的智能体。

产出：新增两个文件，把已经发生过、会重复发生的错误写成清单，按读者分开。

- `.knit/standards/pitfalls-worker.md`，给实现和审查环节的执行者，开头：

  ```markdown
  ---
  title: 避坑清单（执行者）
  stages: [implement, review]
  ---
  ```

- `.knit/standards/pitfalls-main.md`，给主会话，开头：

  ```markdown
  ---
  title: 避坑清单（主会话）
  stages: [discuss, deliver]
  ---
  ```

- 正文用中文。每个文件不超过 6144 字节：切换到小核心之前，它们会被全文交给每一个执行者。
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在本任务目录的 `research/notes.md` 里。开头的声明之后直接写正文，不加重复的标题。

素材只有一份：本任务目录里的 `research/incidents.md`。原始记录（运行记录、会话记录）只存在于一台机器上，克隆里没有，所以以这份摘录为准。

- 摘录里的 W1–W9 写进执行者那份，M1–M11 写进主会话那份。
- 每条写三项：现象、原因、正确做法。摘录里的编号和来源（执行编号、任务编号、提交号、日期）不写进清单。
- 现象和原因照摘录写，不添加摘录里没有的事实；摘录写了“未核实”的照写。
- 正确做法由你根据原因写出，要具体到能照着做。例如 W6 的做法是“先写到同目录的临时文件，写完再改名”，不是“注意并发”。
- 摘录里标了「仅旧 Knit」的条目照样收，集中放在文件末尾的一个小节里，小节标题写“切换到小核心后删除”。
- 原因相同的条目可以合并成一条。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」里的文件。
3. 写两个文件。
4. 逐条核对：摘录里的每个编号都能在两个文件里找到去处。
5. 按「验证」核对，然后提交并交回。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不修这些错误背后的代码。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，以及 `.knit/tasks/` 下其它任务的文件：这些是流程配置和别的任务的资料。
- 不运行 `knit run …`、`knit deliver`，不提交、不推送：提交要等用户审阅并授权。

验证：

- 运行 `wc -c .knit/standards/pitfalls-worker.md`，结果不超过 6144。
- 运行 `wc -c .knit/standards/pitfalls-main.md`，结果不超过 6144。
- 运行 `git status --short`，和开始前相比只多出本任务的文件。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在汇报里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在汇报里写出失败的命令和输出，不再重试。

交回：

- 改动留在工作区。把「完成条件」要求的说明写进本任务目录的 `research/notes.md`，然后汇报。
- 提交时的文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-7e8d766d2a81`。

做完之后：用户审阅工作区里的文件，同意后由主会话收尾（`knit task ready`，`knit task implement` 登记改动文件和做过的验证，`knit task close`），提交另行授权。

说明：给主会话的那份，现在的 Knit 不会交给主会话，它从切换到小核心起自动生效。

## 完成条件

- 两个文件存在，开头有 `title` 和 `stages`，各不超过 6144 字节。
- 摘录里的每一条都有去处，`research/notes.md` 里列出对应关系（摘录编号对应清单里的哪一条）。
- 「仅旧 Knit」的条目集中在文件末尾的小节里。
- 本任务新增的只有这两个文件和 `research/notes.md`。

## 相关资料

- `.knit/tasks/11-15-a5-pitfalls/research/incidents.md` — 故障记录摘录，唯一的素材
- `.knit/standards/candidates.md` — M1 的完整经过和当时提出的规则
- `.knit/tasks/archive/2026-11/11-14-policy-recovery-retry/task.md` — M2 的经过

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-e0258d5f07ff -->
- 操作: op-e0258d5f07ff
- 时间: 2026-11-15T02:57:48.001Z
- 分支: refs/heads/main
- 授权来源: user:28c6d6cf
- 调用: bridge
- 工作提交: 18b1385c059b4ad72fa5d756657dc967a060c524
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-a5-pitfalls

<!-- knit:progress:end -->
