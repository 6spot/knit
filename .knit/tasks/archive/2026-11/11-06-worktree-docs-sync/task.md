---
id: k-a6a220185827
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T15:05:13.694Z
title: Worktree 实现口径回写文档
---

# Worktree 实现口径回写文档

## 目标与边界

Worktree 已实现（CLI、8 个测试文件、6 个已完成任务、合入与清理），但当前规范仍统一写「首版不实现／属于后续」，与代码和实际能力冲突。本任务把已实现的事实写回规范，消除漂移。

已核对的漂移点：

- `AGENTS.md:34`：「首版不实现任何 Worktree 功能」。
- `docs/design/DESIGN.md:6`：「Worktree 和其他客户端具体实现后续增加」。
- `docs/design/DESIGN.md:507`：第 6 节标题「Worktree（后续设计）」。
- `docs/design/DESIGN.md:751`：把 Worktree 执行环境、`worktree.copy`、`worktree.postCreate`、`delivery.mode: "merge"` 列为后续。
- `docs/design/DESIGN.md:810`：§15.2 把「Worktree 的全部实现」列为后续。
- `docs/design/DESIGN.md:635`：写「后续增加项目可配置的 merge 交付，使用 `delivery.target`」，与实际 `knit worktree merge --into` 不一致。
- `docs/design/OPERATIONS.md:3`：「Worktree 等属于后续」。
- `docs/README.md:24`：「Worktree 后续设计，首版不实现」。
- `docs/research/WORKTREE.md` 开头：「首版不实现本章……」。
- `DESIGN.md` §4.1 命令面未列 `worktree` 子命令；§6 与 WORKTREE.md 的内容定位需重新说明（现状是已实现行为，不再是"后续设计"）。

范围：

- 将上述位置改为「已实现」的现行规则；DESIGN §6 更名为现行 Worktree 规则并保留与 WORKTREE.md 的分工（DESIGN 概览、WORKTREE 细则）。
- §4.1 命令表补 `worktree create/connect/handoff/prepare/status/repair/cleanup/merge/list` 与 `deliver` 和它们的边界。
- §10.1 的 merge 描述改为实际的 `worktree merge` 语义（目标为主检出当前分支、缺省只读预览、`--apply` 需授权）。
- WORKTREE.md 开头改为「现行规则与细则」，保留研究历史与 §6.8 实验记录。
- AGENTS.md 的开发约定改为「Worktree 已实现，修改时核对创建、交接、路由、合入、清理与绑定链路」。
- 只写**现状**；`k-da9973a69c20` 的开关与收尾配置定稿后再补对应键（本任务不预写未确定的默认值）。

边界：

- 不改代码、不改行为、不改测试；纯规范回写。
- 不删除研究依据与实验记录；历史与现状分开表述。
- 不扩大范围到其他文档漂移（发现即记录，另行处理）。

## 完成条件

- 上述漂移点在全文检索中不再出现（`首版不实现.*Worktree`、`Worktree.*后续`、`delivery.target` 等旧口径按实际语境清除或改写）。
- DESIGN §4.1、§6、§10.1、§15、OPERATIONS、README、AGENTS、WORKTREE 的口径与 `knit worktree --help` 及实际行为一致。
- 交叉引用、章节编号与 Markdown 结构正确；WORKTREE.md 的研究与实验内容保留。
- 与 `k-da9973a69c20` 的配置键不冲突；该任务定稿后只补它新增的键。

## 输入引用

- 本次会话核对（2026-11-06）：`git log` 中 6 个 Worktree 任务已完成归档；CLI 与 8 个测试文件存在。
- `npx --no-install knit worktree --help`、各子命令 `--help`。
- `docs/history/TASKS.md` 中的 Worktree 任务记录（作为实现来源，不复制为规范正文）。

<!-- knit:progress:start -->
## 当前位置

漂移点已定位，待实施（纯文档回写）；开关任务定稿后补新增配置键。

## 关键经过

- 2026-11-06：用户要求在 worktree 开关任务之外同步处理文档缺口；核对了 AGENTS、DESIGN、OPERATIONS、README、WORKTREE.md 的旧口径。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-1f975a8e5658 -->
- 操作: op-1f975a8e5658
- 时间: 2026-11-07T03:05:19.089Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: 5067620804de0a44d35bcf6d11419184eefde7ce
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-worktree-docs-sync

### 任务资料提交记录

<!-- knit:metadata-commit:op-1f975a8e5658 -->
- 任务资料提交: 9eb1ce004236971e546ffd69ecedae8d4ce47d1b
- 归档目标: .knit/tasks/archive/2026-11/11-06-worktree-docs-sync

<!-- knit:progress:end -->
