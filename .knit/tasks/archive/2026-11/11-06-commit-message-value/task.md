---
id: k-1d796caf7d12
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-06T14:03:18.784Z
title: 交付提交说明缺乏信息价值
---


# 交付提交说明缺乏信息价值

## 目标与边界

用户反馈：Knit 产生的 Git 提交说明「毫无营养、毫无价值」。需求方向已确认（2026-11-06 讨论），方案细节见同目录 [design.md](design.md)。2026-11-06 用户要求按优先级逐个执行任务，本任务进入实施，按 design.md 落代码与测试。

现状（实测证据）：

- 自动提交说明是单行模板 `knit: <artifact|metadata|archive|deliver> <taskId> (<operationId>)`，见 `src/application/delivery-service.ts` 的 `commitSelected`（拼接 message）、`archive`（`:1040`）与旧 `workCommit`（`knit: deliver`）。
- 本仓库历史 214 个提交中 166 个以 `knit: ` 开头；其中 156 个正文为空（94% 无任何补充说明），产物／资料／归档三类合计 150 个。
- 说明只带任务身份与操作 ID，不含「改了什么、为什么、验证了什么」。`git log --oneline` 不可读，追溯只能回任务目录检索，提交本身不承载业务语义。

目标：产物提交由主会话起草可读文案、CLI 校验并附加机器字段；记账提交用确定性模板补上可读事实；恢复与合入判定改读 trailer，并兼容旧格式。

边界：

- 提交说明同时是机器回执：`findOperationCommit` 以 `--grep=<prefix>` + `--grep=<operationId>` 恢复，`worktree-merge` 用 `includes(message)` 判定 archive／metadata 提交，`history-search` 把提交说明作为检索来源。改格式不得破坏按操作 ID 的恢复、幂等核对与历史检索。
- Knit 是确定性 CLI，不引入模型调用；文案由主会话（调用方）提供，核心只做校验、拼装与持久化。
- 旧提交不迁移，恢复路径需同时识别旧格式与新格式。
- 不改变提交拆分（产物／资料／归档仍分开）、不改变 scope 核对、完成资格与授权规则。
- 不扩大到重写历史、amend、squash 或一个任务拆多个提交。

## 已确认决策（2026-11-06 讨论）

- **A**：产物提交文案由主会话起草，经 CLI 输入通道传入，CLI 校验、拼装并持久化。核心不接模型。
- **B**：首行改为人类可读标题；机器锚点移入 trailer（`Knit-Task`／`Knit-Operation`／`Knit-Stage`／`Knit-Verification`）；恢复与合入判定改读 trailer，同时保留旧格式识别。
- **C**：一个任务仍只产生一个产物提交，正文分条说明；多提交不纳入本任务。
- **D**：未提供文案时生成事实型模板正文并记录 `message_source: template`，不允许空正文；交付结果与 `--plan` 都要显示来源。

具体消息格式、校验规则、持久化与恢复细节、文档改动点见同目录 [design.md](design.md)。

## 参考：Trellis 的实际做法（固定基线 0.6.17，与 [RESEARCH.md](../../../docs/research/RESEARCH.md) 第 17.2 节一致）

本地核对位置：全局安装 `@mindfoldhq/trellis@0.6.17` 的 `dist/templates/trellis/workflow.md` 第 3.4 节，以及项目内 `.trellis/scripts`（`add_session.py`、`common/task_store.py`、`common/config.py`）。

- 工作提交（work commits）由主 Agent 在 Phase 3.4 起草：先 `git status --porcelain` 抓脏路径，再用 `git log --oneline -5` 学当前仓库的提交风格（前缀、语言、长度），把本会话编辑的文件按「一个连贯变更单元一个提交」分组，列出无法归因的脏文件，**一次性**向用户展示提交计划并要一次确认；确认后逐批 `git add`＋`git commit`。
- 提交消息本身没有模板规格，内容完全来自 Agent 对本次会话的了解（为什么改、改了什么）；风格靠历史自适应。
- 记账提交保持极简模板：归档自动提交 `chore(task): archive <task-name>`，Session 记录自动提交 `chore: record journal`（可由 `session_commit_message` 配置覆盖）。
- 顺序固定：工作提交先落地，归档与记录提交在后，不交错；不允许 amend；不 push。
- 追溯靠记录而非提交说明：`add_session.py --commit <oid>` 在本地对象库解析出真实 subject 写入 journal／index，无法解析的 OID 直接拒绝；归档只记 hash。

对照 Knit：拆分顺序（产物→资料→归档）已经与 Trellis 同构，缺的是「有意义的那部分由谁写」。Trellis 把工作提交文案交给掌握上下文的 Agent 并要一次确认，记账提交交给脚本；Knit 现在把两者都交给脚本，于是 156 个提交正文为空。

不能直接照搬的部分：

- Knit 的 `deliver` 是确定性 CLI，可能非交互执行（含桥接代调），无法像 Trellis 那样在命令内部询问一次确认；确认必须发生在主会话调用前，`--plan` 承担预览。
- Trellis 允许一段工作拆多个工作提交；Knit 按「任务一个产物提交」核对范围，多提交会让 scope 验证与幂等回执变形，本任务不纳入。
- Trellis 的记账提交只要 hash 可追溯；Knit 的恢复与合入判定直接读提交说明，所以机器锚点必须保留（改为 trailer）。

## 完成条件

实现后按以下结果验收：

- 产物提交的说明含主会话提供的可读首行与正文；未提供时使用模板正文，交付结果与 `--plan` 明确显示 `message_source`。
- 三类提交都带 `Knit-Task`／`Knit-Operation`／`Knit-Stage` trailer；`metadata`／`archive` 提交为确定性模板，含任务标题、结束结果、验证依据与产物／资料提交引用。
- 非法或空文案在创建操作、暂存与提交之前被拒绝，返回可读原因，不留下部分状态。
- 重试复用已持久化的文案，不因文件变化静默改词；已提交的说明不做 amend。
- 恢复与合入：新旧两种格式都能按操作 ID 找到对应提交并完成阶段核对；`worktree-merge` 的 archive／metadata 判定不回归；`history-search` 能在新正文中命中。
- 文档与行为引导同步：DESIGN 第 10.2–10.4 节、OPERATIONS 交付实现说明、ROLE-CONTRACT 收尾锚点、AGENTS 受管块模板与项目桥接注入的交付规则。
- 测试：现有 subject 断言更新并与 `test/delivery.test.mjs`、`test/closeout.test.mjs`、`test/worktree-merge.test.mjs` 通过；新增校验、模板、重试与兼容用例。

## 输入引用

- 本次会话用户反馈与决策：A 接受主会话起草＋CLI 校验；B 接受人可读首行＋trailer；C 不纳入多提交；D 模板兜底并标记来源。
- [design.md](design.md)：格式、校验、持久化、恢复与改动点。
- `src/application/delivery-service.ts`（`commitSelected`、archive 提交、恢复核对）；`src/application/delivery.ts`（`commitMessage`）；`src/application/history-search.ts`；`src/application/worktree-merge.ts`；`src/cli/deliver.ts`。
- 现有断言：`test/delivery.test.mjs`、`test/closeout.test.mjs`、`test/worktree-merge.test.mjs` 中的 subject 匹配。
- [DESIGN](../../../docs/design/DESIGN.md) 第 10.2–10.4 节，[STATES.md](../../../docs/design/STATES.md) 提交步骤，[OPERATIONS.md](../../../docs/design/OPERATIONS.md) 交付实现说明，[ROLE-CONTRACT.md](../../../docs/design/ROLE-CONTRACT.md) 收尾锚点行。

## 输入变更（2026-11-06）

- 2026-11-06 派发首次 worker 时，工作区里未提交的 `.knit/workflow.yaml` 把 implement／check 的 `tools` 改成了空数组（`tools: []`）。按现行规则「写了白名单就只给列出的能力」，空白名单等于不给任何工具：worker 读不到 `task.md`／`design.md`／`src/`，也改不了文件、跑不了验证。run `run-f5bcc3ae062b` 因此报告「未产出」并以空 scope 完成。
- 已把 `.knit/workflow.yaml` 恢复为 `tools: [read, write, exec]`／`tools: [read, exec]`；任务回到 `start` 重新实施。
- 范围变化：原文「本轮只到方案定稿，不实施」改为按 design.md 实施。用户 2026-11-06 明确要求按任务优先级逐个执行，本任务进入实施阶段。

<!-- knit:progress:start -->
## 当前位置

方向与格式已确认，方案细节落在 design.md；未实施，未授权提交。

## 关键经过

- 2026-11-06：登记问题，核对现状（166 个 `knit: ` 提交中 156 个无正文）。
- 2026-11-06：核对 Trellis 0.6.17 的 Phase 3.4 与脚本实现，确认其做法是「工作提交由 Agent 起草并一次确认、记账提交脚本模板、追溯靠 journal」。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-15e1a72a0702 -->
- 操作: op-15e1a72a0702
- 时间: 2026-11-06T16:29:17.833Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；实际效果由主会话接收并自动提交、推送、归档
- 工作提交: ea7a9002d3c77a1f1a64a8a6c542f8669e034008
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-commit-message-value

### 任务资料提交记录

<!-- knit:metadata-commit:op-15e1a72a0702 -->
- 任务资料提交: 17fb582bf6f8ce3458038756220debd702f3feed
- 归档目标: .knit/tasks/archive/2026-11/11-06-commit-message-value

<!-- knit:progress:end -->
