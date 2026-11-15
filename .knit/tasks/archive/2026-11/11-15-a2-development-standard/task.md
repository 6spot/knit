---
id: k-d868ba595dd7
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T16:23:27.291Z
title: A2 开发规范：写入 .knit/standards/development.md
---

# A2 开发规范：写入 .knit/standards/development.md

## 目标与范围

背景：本仓库正在把 Knit 重构成一个小核心（见 `.knit/tasks/11-14-slim-refactor/design.md`）。项目规范放在 `.knit/standards/`，一份一个文件，开头声明适用的环节，由 Knit 交给对应环节的智能体。

产出：新增一个文件 `.knit/standards/development.md`，写本项目写代码、写测试时要遵守的规则。Knit 会把它全文交给实现和审查环节的执行者。

- 文件开头：

  ```markdown
  ---
  title: 开发规范
  stages: [implement, review]
  ---
  ```

- 正文用中文，一条规则一到两句，不写背景；确有必要的例子不超过三行。
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在本任务目录的 `research/notes.md` 里。开头的声明之后直接写正文，不加重复的标题。
- 整个文件不超过 4096 字节：切换到小核心之前，它会被全文交给每一个执行者。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」里的文件。
3. 把两个来源的条目逐条过一遍，按下面的标准决定是否采纳：
   - 来源一：`AGENTS.md`「开发约定」的 14 条和「交付检查」的 4 条。
   - 来源二：`.knit/tasks/11-14-slim-refactor/research/opencode-agents-excerpt.md`。
4. 把采纳的条目用自己的话写成规则，意思相同的合并成一条，写入文件。
5. 按「验证」核对，然后提交并交回。

采纳标准：

- 是写代码、写测试、改文档时要遵守的规则。
- 在重构后的小核心里仍然成立。只和 `design.md` 第 11 节「不做」的功能有关的条目不收，例如锁、快照、续用旧会话、Worktree 调度、开发者模式。
- 不依赖 opencode 的技术栈（Bun、Effect、Drizzle、它的包结构和技能目录）。
- 给主会话的规则（提交、授权、汇报）不收，它们属于另一个任务（A3 交付规范）。
- 风格类规则（少用 `try`／`catch`、不用 `else`、优先 `const` 等）采纳时写明只约束新写的代码，不要求回头改现有代码（用户审阅规范后确认）。

供判断的现状（2026-11-15，`src/` 共 128 个文件）：`try {` 527 处，`} else ` 207 处，`let` 声明 405 处，`any` 17 处，别名导入 5 处，星号导入 0 处。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不整理现有代码去符合新规范。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，以及 `.knit/tasks/` 下其它任务的文件：这些是流程配置和别的任务的资料。
- 不运行 `knit run …`、`knit deliver`，不提交、不推送：提交要等用户审阅并授权。

验证：

- 运行 `wc -c .knit/standards/development.md`，结果不超过 4096。
- 运行 `git status --short`，和开始前相比只多出本任务的文件。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在汇报里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在汇报里写出失败的命令和输出，不再重试。

交回：

- 改动留在工作区。把「完成条件」要求的说明写进本任务目录的 `research/notes.md`，然后汇报。
- 提交时的文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-d868ba595dd7`。

做完之后：用户审阅工作区里的文件，同意后由主会话收尾（`knit task ready`，`knit task implement` 登记改动文件和做过的验证，`knit task close`），提交另行授权。

## 完成条件

- 文件存在，开头有 `title` 和 `stages`，不超过 4096 字节。
- `research/notes.md` 里有一张对照表：两个来源的每一条，写明采纳（对应规范里的哪一条）或不采纳（理由）。
- 本任务新增的只有这个文件和 `research/notes.md`。

## 相关资料

- `AGENTS.md`「开发约定」「交付检查」 — 来源一
- `.knit/tasks/11-14-slim-refactor/research/opencode-agents-excerpt.md` — 来源二：opencode 的 AGENTS.md 摘录，固定在一个提交上
- `.knit/tasks/11-14-slim-refactor/design.md` 第 4 节、第 11 节 — 规范文件的格式；重构后不做的功能

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-20a20b554f8f -->
- 操作: op-20a20b554f8f
- 时间: 2026-11-15T02:57:44.657Z
- 分支: refs/heads/main
- 授权来源: user:28c6d6cf
- 调用: bridge
- 工作提交: e0e46ff418bba1fc98fdedaad3631f67106e87a4
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-a2-development-standard

### 任务资料提交记录

<!-- knit:metadata-commit:op-20a20b554f8f -->
- 任务资料提交: 13e061a4b5971ab5a07ab414a54c9df7a995a3ee
- 归档目标: .knit/tasks/archive/2026-11/11-15-a2-development-standard

<!-- knit:progress:end -->
