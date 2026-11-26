---
id: k-893085015d47
title: 精简执行者交接内容并优化审查默认配置
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn:
  - k-9a36f357607f
priority: P1
createdAt: 2026-11-26T13:43:44.833Z
---

## 目标与范围

**要解决的问题**：实测本仓库 109 次执行的 `message.md` 中位达 32.2 KB、P90 达 56.4 KB，其中 80% 以上是 `<material>` 全文内联的源码文件；但在 99 份真实 Pi 会话里，预塞的 288 份资料有 169 份（58.7%）又被执行者调用 `read` 重读，白白放大每轮对话的 `cacheRead` 成本。同时 `review` 环节既没有收到 `git diff` 摘要、默认也未开 `resume: true`，导致审查均价（$3.65）比实现（$2.18）贵 67%、耗时中位数高 45%。

**改动目标**：
1. **交接资料按需内联（`src/application/handoff.ts` 与 `src/application/run-prepare.ts`）**：
   - 当环节具备 `read` 能力（即 `stage.tools === null` 或包含 `"read"`）时，对「相关资料」中的普通文件做瘦身：只全文内联**短文档或章节**（Markdown 文件 `.md` 或带 `#标题` 的章节，且内容字节数不超过默认 4 KB，受 `config.handoff.fileBytes` 与 `totalBytes` 上限约束）；其余源码/非短文档文件不再全文内联，只输出路径说明（提示执行者按路径自读），避免把十几 KB 的代码预塞进 Turn 1。
   - `plan.md` 和上轮报告继续按现有预算规则内联（若单文件或合计超限则只给路径说明）。
   - 当环节**不具备 `read` 能力**时，保持原有按 `fileBytes` / `totalBytes` 全文内联所有点名资料的规则不变（确保无读工具的执行者仍能拿到内容）。
   - 同输入逐字相同、点名文件不存在/未提交入 Worktree 的报错检查均保持不变。
2. **审查环节附带 Worktree 改动摘要（`git diff --stat` / 精简 diff）**：
   - 对审查环节（`stage.report` 声明了 `verdict` 的环节），在首次交接消息（以及 `resume-message.md`）中附上当前 Worktree 相对 `HEAD` 的改动概览（`git diff --stat HEAD` + 未跟踪文件列表；若总 diff 文本较小且在交接字节预算内，例如 ≤8 KB，可一并附上精简 `git diff HEAD` 文本，超出则只给 `--stat` 与提示执行者按需 `git diff`）。
   - 无改动时不输出多余噪音或明确标示工作区无相对 `HEAD` 的差异。
3. **优化默认角色模板与流程模板**：
   - 更新 `assets/templates/agents/review.md`：引导审查者优先结合改动摘要与实现报告的验证证据定向核验，优先运行与改动相关的定向测试，仅在涉及跨模块/高风险改动时再跑全量测试，减少与实现环节的重复耗时。
   - 更新 `assets/templates/workflow.yaml`：默认在 `implement` 和 `review` 环节取消注释开启 `resume: true`（或在模板默认配置中为 `implement`/`review` 开启 `resume: true`），注释示例中的 `review` 思考等级说明普通任务建议 `high`、高风险再用 `max`。
4. **同步更新文档**：更新 `docs/design/DESIGN.md` 第 5.1、5.2 节与第 6.1 节对应的交接内联、审查改动摘要和默认模板说明。

**明确不做 / 边界**：
- **严禁修改 Worktree 中的受保护路径**：不要修改 `.knit/workflow.yaml`、`.knit/agents/review.md`、`.knit/config.json` 或 `.knit/standards/`（本仓库自身副本由后续发版/主会话刷新；修改受保护文件会导致执行结算失败）。只修改 `assets/templates/` 中的模板源文件。
- 不修改 `config.json` 的 schema 字段（`handoff.fileBytes` 和 `handoff.totalBytes` 仍有效，且当项目把 `fileBytes` 配得比 4 KB 更小时，取 `Math.min(4096, limits.fileBytes)`）。
- 不改动 `progress.ts` 状态推进逻辑和 `workspace.ts` 快照对比逻辑。

## 完成条件

### Requirement: 具备 read 能力时的交接资料瘦身
#### Scenario: 源码文件不全文内联，短文档和章节仍内联
- WHEN 为具备 `read` 能力的环节组装交接，任务「相关资料」同时点名了源码文件（如 `.ts`）和不超过 4 KB 的 Markdown 文件或 `#标题` 章节
- THEN `message.md` 中短文档/章节全文内联，源码文件只给出路径与按需自读说明，不塞入源码正文；点名不存在或未提交的文件仍照常报错拒绝派发

#### Scenario: 无 read 能力时保持原有全量内联规则
- WHEN 为未授予 `read` 能力的环节（如 `tools: []`）组装交接，点名不超过 `fileBytes` 的源码文件
- THEN `message.md` 仍按 `fileBytes`/`totalBytes` 规则内联该文件内容

### Requirement: 审查环节附带 Worktree 改动摘要
#### Scenario: 审查交接包含相对 HEAD 的 diff 摘要
- WHEN 派发声明了 `verdict` 的审查环节且 Worktree 相对 `HEAD` 存在修改或新增未跟踪文件
- THEN 审查者的交接消息（首次交接 `message.md` 与续聊 `resume-message.md`）包含改动摘要块（`git diff --stat` 及未跟踪文件）；总 diff 在预算内时附带 diff 内容，超限时只给摘要与按需查看提示

### Requirement: 模板与设计文档同步
#### Scenario: 模板更新且通过发布包检查与全量测试
- WHEN 检查 `assets/templates/agents/review.md`、`assets/templates/workflow.yaml` 和 `docs/design/DESIGN.md`
- THEN 审查角色模板包含先看 diff 与优先定向验证的指引，流程模板默认开启 `resume: true` 且 `knit workflow validate` 对其校验通过，设计文档与新行为一致

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#5-交接` — 现行交接字节预算与拼装规则
- `docs/design/DESIGN.md#6-流程与角色文件` — 现行工作流与角色模板设计
- `src/application/handoff.ts` — 交接拼装与续聊消息生成
- `src/application/run-prepare.ts` — 派发准备与调用交接处
- `assets/templates/agents/review.md` — 审查角色模板源文件
- `assets/templates/workflow.yaml` — 默认流程模板源文件
- `test/handoff.test.mjs` — 交接拼装单元测试
- `test/handoff-worktree.test.mjs` — Worktree 交接测试
- `test/run-prepare.test.mjs` — 派发准备集成测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/handoff.test.mjs test/handoff-worktree.test.mjs test/run-prepare.test.mjs test/init.test.mjs test/workflow.test.mjs`，并补跑全量 `npm test` 和 `npm run pack:check`（因改动公共模板与交接核心）。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已完成执行者交接瘦身与审查默认配置优化：具备 read 能力时源码文件仅传路径、短文档/章节（<=4KB）与 plan.md 仍内联，无 read 能力保持原内联上限；审查环节（声明 verdict）在首次与续聊消息中附带 Worktree 相对 HEAD 的改动摘要与预算内精简 diff；同步更新 review.md、workflow.yaml 模板（默认开启 implement/review 的 resume: true，审查推荐 thinking: high）及 docs/design/DESIGN.md 第 5、6 节。验证：npm run typecheck、npm run build、npm run pack:check、git diff --check 通过；定向测试 123/123 通过；全量 npm test 505 通过、0 失败、7 项跨文件系统跳过。未验证：未用真实模型测量实际 cacheRead 与审查耗时降幅。
