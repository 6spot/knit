---
id: k-636bdd45fc92
title: 清理旧 Knit 历史文档与过期验证记录
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-24T09:22:44.832Z
---

## 目标与范围

从当前工作树移除重构前（2026-11 小核心重写之前）遗留的旧 Knit 历史文档、旧研究与旧验证记录，避免过时的 SQLite、锁子系统、快照和旧桥接内容在搜索与协作者阅读时污染上下文。被删内容仍保存在 Git 历史中。

### 范围内

1. **删除旧 Knit 文档与研究**：
   - 删除整个 `docs/history/` 目录（旧设计、旧任务索引、001–060 执行记录与旧阻塞记录）。
   - 删除 `docs/research/RESEARCH.md` 与 `docs/research/WORKTREE.md`。
2. **删除重构前的旧验证记录**：
   - 在 `validation/` 下，删除重构前（2026-11-14 及以前）的旧验证目录，仅保留小核心重构后的 7 个现行验证目录：
     - `validation/slim-h1-2026-11/`
     - `validation/slim-h5-2026-11/`
     - `validation/slim-rex-2026-11/`
     - `validation/slim-linux-2026-11/`
     - `validation/worktree-drill-2026-11/`
     - `validation/adversarial-review-resume/`
     - `validation/multi-host-main-session/`
3. **同步清理文档索引与交叉引用**：
   - 更新 `README.md` 和 `docs/README.md`，移除指向 `docs/history/`、`RESEARCH.md`、`WORKTREE.md` 和已删历史验证记录的链接、目录项与过时说明。
   - 检查 `docs/` 其余现行文档（如 `docs/design/DESIGN.md`、`docs/AGENT-INTEGRATION.md`、`docs/research/REX-PANE.md`），确认没有指向已删路径的失效链接；如有则同步修复。

### 范围外（不能动）

- 保留现行研究文件：`docs/research/REX-PANE.md`、`docs/research/file-granularity-and-test-review.md`。
- 保留上述 7 个现行 `validation/` 目录与 `.knit/tasks/archive/`（新 Knit 管理的已归档任务）。
- 不修改根目录 `AGENTS.md`（由独立任务 `k-82ba6435637f` 处理）。
- 不修改 `src/`、`test/` 与 `.knit/standards/`；不执行全局安装或手动提交。

## 完成条件

### Requirement: 旧 Knit 历史文档与过期验证目录已清理且现行资料完整

#### Scenario: 核对删除与保留清单

- WHEN 检查工作树中的 `docs/history/`、`docs/research/`、`validation/` 与 `.knit/tasks/archive/`
- THEN `docs/history/`、`docs/research/RESEARCH.md`、`docs/research/WORKTREE.md` 及重构前的旧 `validation/` 目录均已移除
- AND `docs/research/REX-PANE.md`、`docs/research/file-granularity-and-test-review.md`、上述 7 个现行 `validation/` 目录及 `.knit/tasks/archive/` 完整保留，且 `AGENTS.md` 未改动

#### Scenario: 现行文档无失效引用

- WHEN 检查 `README.md`、`docs/README.md` 及 `docs/` 下所有现行 Markdown 文件中的相对链接与对 `docs/history`、`RESEARCH.md`、`WORKTREE.md` 的引用
- THEN 不再存在指向已删除历史路径的失效链接或目录项，现行验收记录链接均可定位

#### Scenario: 构建、打包检查与测试不受影响

- WHEN 运行 `npm run pack:check`、`npm test` 与 `git diff --check`
- THEN 全部通过，且报告如实记录运行结果

## 待澄清

无。

## 相关资料

- `README.md`、`docs/README.md` — 需同步移除旧历史文档和旧研究条目的入口文档
- `docs/AGENT-INTEGRATION.md`、`docs/research/REX-PANE.md` — 引用现行 `validation/` 目录的文档，核对链接不断裂
- `scripts/pack-check.mjs` — 核对打包检查仍正常通过

## 结果

移除 docs/history/、两份旧研究和 36 个旧验证目录，共 628 个已跟踪文件。首页和文档索引已更新，可直接找到两份现行研究和全部 7 个保留的验证目录；这些目录及任务归档内容均与基线一致。主会话核对了 6 份现行文档的 55 处项目链接，13 处验收记录均可定位，新增断链 0；docs/AGENT-INTEGRATION.md 中另有 5 个早于本次清理的源码或测试断链。打包 26 项检查通过（69 个文件），git diff --check 通过。macOS Rex 与 Terminal.app 实际各跑 npm test 506 项，499 通过、7 项跨文件系统跳过、0 失败。执行者另一次独立伪终端首轮有 2 项 Rex 窗格测试失败，带控制终端复跑通过，首次失败根因未核实。
