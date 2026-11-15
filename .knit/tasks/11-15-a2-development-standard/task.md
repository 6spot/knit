---
id: k-d868ba595dd7
status: open
stage: start
outcome: null
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
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在合并请求说明里。开头的声明之后直接写正文，不加重复的标题。
- 整个文件不超过 4096 字节：切换到小核心之前，它会被全文交给每一个执行者。

步骤：

1. 从最新的 `main` 开分支 `a2-development-standard`。
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
- 风格类规则（少用 `try`／`catch`、不用 `else`、优先 `const` 等）如果采纳，写明只约束新写的代码，不要求回头改现有代码。

供判断的现状（2026-11-15，`src/` 共 128 个文件）：`try {` 527 处，`} else ` 207 处，`let` 声明 405 处，`any` 17 处，别名导入 5 处，星号导入 0 处。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不整理现有代码去符合新规范。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/` 和 `.knit/tasks/` 下的所有文件：这些是流程和任务资料，由登记任务的主会话维护。
- 不运行 `knit task …`、`knit run …`、`knit deliver`：任务状态存在主会话所在的机器上，在别处运行会得到错误的状态。

验证：

- 运行 `wc -c .knit/standards/development.md`，结果不超过 4096。
- 运行 `git status --short`，除新增的文件外没有别的改动。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在合并请求说明里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在合并请求说明或回复里写出失败的命令和输出，不再重试。

提交与交回（用户把这个任务交给你执行，即同意你在这个分支上提交、推送并开合并请求；合并不在其内）：

- 提交一次，只含 `.knit/standards/development.md` 这一个文件。
- 提交文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-d868ba595dd7`。
- 推送分支 `a2-development-standard`，开一个指向 `main` 的合并请求，说明里写上「完成条件」要求的内容。不合并，不直接改 `main`。

做完之后：合并请求由用户审阅、合并。合并后由主会话在登记任务的机器上把本任务标记完成。

## 完成条件

- 文件存在，开头有 `title` 和 `stages`，不超过 4096 字节。
- 合并请求说明里有一张对照表：两个来源的每一条，写明采纳（对应规范里的哪一条）或不采纳（理由）。
- 提交里只有这一个文件。

## 待澄清

- [assumed] 风格类规则只约束新写的代码（Agent 建议，待确认）。

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

<!-- knit:progress:end -->
