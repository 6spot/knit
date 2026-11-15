---
id: k-e7f590d7d30b
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-19c962be9fb8
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T16:23:28.125Z
title: A3 交付规范：写入 .knit/standards/delivery.md
---

# A3 交付规范：写入 .knit/standards/delivery.md

## 目标与范围

背景：本仓库正在把 Knit 重构成一个小核心（见 `.knit/tasks/11-14-slim-refactor/design.md`）。项目规范放在 `.knit/standards/`，一份一个文件，开头声明适用的环节，由 Knit 交给对应环节的智能体。

产出：新增一个文件 `.knit/standards/delivery.md`，写主会话在收尾（完成任务、提交）时要遵守的规则。

- 文件开头：

  ```markdown
  ---
  title: 交付规范
  stages: [deliver]
  ---
  ```

- 正文用中文，一条规则一到两句。整个文件不超过 4096 字节。
- 文件会原样进入智能体的上下文，只写智能体做事时要用到的内容。来源、日期、编号、制定经过不写进文件，写在本任务目录的 `research/notes.md` 里。开头的声明之后直接写正文，不加重复的标题。

要覆盖的内容：

- 提交文案怎么写：首行的格式与长度、正文写什么、末尾的任务标注。
- 提交前要有用户授权；授权不包含推送和发布。
- 只提交本任务的文件，工作区里别的改动不动。
- 汇报只写实际做过的验证，没验证的照实写。
- 同一操作因同一原因失败两次就停下报告，不再重试。

两条限制：

- 只写重构前后都成立的规则。由工具保证的行为不写成规则，例如一个任务提交几次（现在是三次，重构后是一次）。
- 提交文案的格式要能通过现在的检查（`src/application/delivery.ts` 第 349–380 行）：首行不超过 72 个字符；首行后空一行；正文不能为空；首行不以 `knit: ` 开头；首行不能只有任务编号。

步骤：

1. 运行 `git status --short`，记下开始前的状态。
2. 读「相关资料」里的文件；运行 `git log -15 --format=%B --grep='^fix\|^test\|^docs\|^feat' ` 看现在的文案写法（正文之后有 `Task`、`Source`、`Validation`、`Not verified` 几行）。
3. 写出规则，写入文件。每条规则记下它的来源，交回时要用。
4. 按「验证」核对，然后提交并交回。

不能动的：

- `AGENTS.md`、`src/`、`test/`、`assets/`、`docs/`：本任务只写规范，不改代码和文档。也不改交付代码。
- `.knit/standards/` 下已有的文件：其它任务也在往这个目录加文件，改已有文件会互相冲突。
- `.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`，以及 `.knit/tasks/` 下其它任务的文件：这些是流程配置和别的任务的资料。
- 不运行 `knit run …`、`knit deliver`，不提交、不推送：提交要等用户审阅并授权。

验证：

- 运行 `wc -c .knit/standards/delivery.md`，结果不超过 4096。
- 运行 `git status --short`，和开始前相比只多出本任务的文件。
- 环境里有 Node 24 以上并且能联网时，运行 `npm ci && npm run build && node dist/cli/knit.js standards list`。输出的“正式规范”里应有新文件，后面带“（索引未引用）”是预期的。`dist/` 和 `node_modules/` 已被 Git 忽略，不会进入提交。
- 不具备上一条的环境时跳过它，并在汇报里写明没有运行。
- 同一条命令因同一原因失败两次就停下，在汇报里写出失败的命令和输出，不再重试。

交回：

- 改动留在工作区。把「完成条件」要求的说明写进本任务目录的 `research/notes.md`，然后汇报。
- 提交时的文案：首行 `docs: <英文摘要>`，不超过 72 个字符；空一行后用英文写正文，说明做了什么；末尾单独一行 `Task: k-e7f590d7d30b`。

做完之后：用户审阅工作区里的文件，同意后由主会话收尾（`knit task ready`，`knit task implement` 登记改动文件和做过的验证，`knit task close`），提交另行授权。

说明：这份规范是给主会话的。现在的 Knit 不会把规范交给主会话，它从切换到小核心起自动生效。

## 完成条件

- 文件存在，开头有 `title` 和 `stages`，不超过 4096 字节。
- 其中没有只在重构前或只在重构后成立的规则。
- `research/notes.md` 里列出每条规则的来源。
- 本任务新增的只有这个文件和 `research/notes.md`。

## 相关资料

- `AGENTS.md`「交付检查」一节，以及受管块里以“交付：”开头的一条 — 现有规则
- `src/application/delivery.ts` 第 349–380 行 — 现在对提交文案的检查
- `.knit/tasks/11-14-slim-refactor/design.md` 第 8 节 — 重构后的完成与交付
- `.knit/tasks/11-14-slim-refactor/research/findings.md` 第 1 节 — 交付失败的记录
- `.knit/tasks/11-14-slim-refactor/research/opencode-agents-excerpt.md`「Commits and PR Titles」 — 参考

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-2e9980fb6183 -->
- 操作: op-2e9980fb6183
- 时间: 2026-11-15T02:57:45.795Z
- 分支: refs/heads/main
- 授权来源: user:28c6d6cf
- 调用: bridge
- 工作提交: 36c197f430da04a583d72dff1e0f5e33e19101f2
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-15-a3-delivery-standard

<!-- knit:progress:end -->
