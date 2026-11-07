---
id: k-da9973a69c20
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T15:05:13.212Z
title: Worktree 默认开关与收尾配置
---

# Worktree 默认开关与收尾配置

## 目标与边界

Worktree 的创建、交接、准备、路由、修复、清理与合入已实现（8 个测试文件、6 个已完成任务），但默认行为、交付与清理的收尾配置仍靠临场判断。本任务增加项目级默认开关与收尾策略。

已确认（2026-11-06 讨论）：

- **默认 OFF**：不自动建 worktree；用户明确要求某任务走 worktree 时仍执行。任务级指令在两个方向都覆盖项目默认。
- 配置放在 `.knit/config.json`：`worktree.default: "off" | "on"`；`delivery.mode: "local" | "merge"`（复用已有键，当前未使用）；`worktree.cleanup: "manual" | "after-merge"`。
- 配置在明确开启 `merge`／`after-merge` 时作为对应步骤的授权来源（记录 `config` 摘要）；提交仍需交付授权；未配置且无显式授权时只完成本地提交，报告「待合入／待清理」。
- 合入目标沿用 `worktree merge --into` 的既有约束（必须是主检出当前分支），不新增可配置目标。
- **脏工作区守卫（选 A）**：主检出在任务目录之外存在未提交改动时，建 Worktree 前阻塞并列出路径；用户可提交、stash，或显式 `--allow-dirty` 继续。不自动搬运未提交代码。
- **生效范围（选 B）**：开关只覆盖 worker 派发。`run prepare` 在任务派发首个配置阶段前确保 worktree；主会话实施（`task implement`）仍在主检出执行，不强制隔离。任务级用 `run prepare --worktree on|off` 覆盖两个方向；已有 worktree 绑定优先，`off` 不删除绑定。
- 保留既有安全守卫：源 worktree 在任务目录之外有未提交改动时不合入；清理遇到 tracked／untracked／ignored 阻断；目标 index 不清洁不合入；不自动 `--discard-changes`。

待讨论（本任务内继续）：无阻塞项；实现细节见 design.md，实施中出现新取舍再补。

## 外部参考：未提交改动（本轮核对）

- IntelliJ IDEA（Use Git worktrees）：新 worktree 是干净检出，未保存改动留在原窗口；用例写明「run AI agents in separate worktrees to prevent them from overwriting local unsaved changes」；同一分支不能在两个 worktree 同时检出。
- Claude Code（Run parallel sessions with worktrees）：「A worktree is a fresh checkout」；被忽略文件靠 `.worktreeinclude` 显式复制；清理检查 changed／untracked。
- 结论：两家都不带未提交改动，Knit 现有行为（从已提交 HEAD 建、任务资料 handoff、`worktree.copy` 白名单）与之一致；差别在于两家都是用户主动开，Knit 默认 ON 自动开才需要额外守卫。
- 主检出存在未提交改动时的守卫：现有实现只从已提交 HEAD 建（`worktree-manager.ts:355`），不会带上未提交代码，也不报错。参考 IDEA／Claude Code 等做法的结论待讨论后定。
- `delivery.mode: "merge"` 在没有 worktree 的任务上如何处理（保持 local／报配置无效／忽略并提示）。

边界：

- 不改 run／session 协议，不新增宿主或执行模式；不改变既有合入、清理的安全判定。
- 不自动搬用主检出的未提交代码；需要时的处理方式由上面的守卫讨论决定。
- 真实 Worktree 与真实模型的端到端验收仍按用户的延期决定，另行记录。

## 已核对事实

- `worktree create` 从主检出当前已提交 HEAD 建立（`src/application/worktree-manager.ts:355`），不检查主检出是否脏；任务资料按 handoff 交接，公共资料只按 `worktree.copy` 白名单复制（默认空）。
- `worktree merge` 在源 worktree 任务目录之外有改动时 `blocked_dirty`（`worktree-merge.ts:1594` 起），要求目标 index 清洁。
- `worktree cleanup` 遇到 tracked／untracked／ignored 内容默认阻断（`worktree-cleanup.ts:1644` 起）。
- `delivery.mode` 只出现在配置 schema，代码未读取；`deliver` 没有 merge 选项。
- CLI：`worktree create/connect/handoff/prepare/status/repair/cleanup/merge/list`。

## 待澄清

- [assumed] `delivery.mode: "merge"` 只对已绑定 worktree 的任务生效；无 worktree 时按 local 处理并在结果中说明（已写入 design.md，Agent 建议，待确认）。

## 完成条件

- 配置键 `worktree.default`／`worktree.cleanup`／`delivery.mode` 按 design.md 的枚举报错与缺省值生效，旧配置不变。
- 默认 ON 时 `run prepare` 在首个阶段前自动建 worktree 并交接，失败不写 request、不建 run；`off` 与已有绑定行为正确。
- 脏守卫按 A 生效；`worktree create --allow-dirty` 只允许手动覆盖。
- `delivery.mode: "merge"` 与 `worktree.cleanup: "after-merge"` 按授权串联；未授权时完成本地交付并报告待办；失败保留现场、不清理。
- 测试覆盖 design.md 第 7 节；真实环境验收另记。

具体语义、失败原因、顺序与不纳入项见同目录 [design.md](design.md)。

## 输入引用

- 本次会话用户要求（2026-11-06）：workflow 增加 worktree 开关；交付、合入、清理纳入同一配置；默认 OFF。
- `src/application/worktree-manager.ts`、`worktree-handoff.ts`、`worktree-prepare.ts`、`worktree-merge.ts`、`worktree-cleanup.ts`、`worktree-routing.ts`；`src/application/config.ts`；`src/cli/worktree.ts`、`src/cli/deliver.ts`。
- [WORKTREE.md](../../../docs/research/WORKTREE.md) 第 6.1–6.8 节；[DESIGN.md](../../../docs/design/DESIGN.md) 第 6、10 节。

<!-- knit:progress:start -->
## 当前位置

方案定稿（design.md）：默认 OFF、只覆盖 worker 派发、脏守卫 A、交付合入与清理串联；未实施。

## 关键经过

- 2026-11-06：确认 Worktree 已实现但文档仍写「后续」；登记默认开关与收尾配置需求。
- 2026-11-06：核对 create／merge／cleanup 的既有守卫与 `delivery.mode` 现状。
- 2026-11-06：核对 IDEA 与 Claude Code 的 Worktree 行为，确认两者不带未提交改动；用户选定守卫 A（阻塞 + `--allow-dirty`）。

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-b6223a76c899 -->
- 操作: op-b6223a76c899
- 时间: 2026-11-07T02:42:31.036Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: e509ece87533b0071f0d535b003041dc59b32809
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-worktree-default-mode

<!-- knit:progress:end -->
