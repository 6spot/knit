---
id: k-795f3804775e
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-06T13:59:05.886Z
title: 主会话实施的完成凭据与强制收口
---

# 主会话实施的完成凭据与强制收口

## 目标与边界

让主会话直接实施的任务能凭证据正常完成并交付，同时保留显式强制收口通道，取代只能手改 frontmatter 的做法。

问题：`self` 完成只承认「已接收 implement run」（`src/domain/completion.ts`、`src/application/run-acceptance.ts` 的 `lastImplement`），主会话直接改代码没有 run，`task close` 恒被拒绝；`deliver` 又要求 `stage=deliver`。唯一出路是降 `verification=none`（语义错误）或绕开工具手改。任务 k-c06c5a41092f 已按后者强制归档，可作为实例。

范围（方案 C，用户确认）：

- 主会话／用户实施记录：`knit task implement <id> --path <p> --validation <text>`，在项目＋任务锁内写 `.knit/.runtime/implementations/<task-id>.json`，含执行者、输入摘要、成果路径指纹、实际验证、未验证项。
- 完成判定：`self` 接受「已接收 run」或「实施记录」；记录路径不要求阶段先行到 `deliver`；成果或输入变化使记录失效。
- 强制收口：`task close --force --reason`，跳过完成证据核对，凭据写 `forced`／`forcedReason`／未验证项；`independent` 拒绝 force。
- 交付：forced 凭据照常交付，提交信息在操作 ID 后加 `, forced`。
- 诊断：`doctor` 报告未归档已完成任务缺完成凭据；不追溯历史归档（54 份档案中 51 份无凭据属旧规则，避免误报）。
- 文档：DESIGN §3.8／§4.3、STATES §11、OPERATIONS、GLOSSARY、AGENTS 开发约定、桥接顶部提示同步。

边界：

- 不放宽 `independent`：正式检查仍是唯一依据，force 不能替代。
- 不改 worker／run 协议，不新增模型调用；实施记录只由 CLI 在锁内写。
- 不追溯修复已归档档案；历史缺凭据保持只读。
- 交付提交顺序、封存、归档与授权边界不变。

## 设计决定（Agent 建议，已按讨论采纳）

1. 记录必须含至少一条验证，否则退回 `--force`；避免「声明完成」冒充证据。
2. `--force` 只允许 `--outcome completed`，必须有 `--reason`，且 `independent` 拒绝。
3. 记录复用 scope 条目结构（路径＋指纹＋类型／模式），成品交付前复验记录内路径未再变化。
4. 历史归档不做缺凭据诊断，避免把旧规则档案全量误报。

## 完成条件

- `task implement` 写记录；`ready` 后无 run 也能 `task close --outcome completed`，凭据 `implementedBy=record`。
- 记录后改动实施路径或任务输入，close 分别返回 `implementation_stale`／`inputs_not_confirmed`；`ready`、输入更新、非等价改名、分支接管清理旧记录。
- `task close --force --reason` 可用且凭据带 `forced`；缺 reason、`independent`、非 completed 均拒绝。
- `deliver` 接受 forced 凭据，artifact／metadata／archive 提交信息带 `, forced`。
- `doctor` 检出未归档已完成任务缺完成凭据（只告警）。
- 测试覆盖上述正反例；`tsc`／`build` 通过；DESIGN／STATES／OPERATIONS／GLOSSARY／AGENTS／桥接同步。

## 输入引用

- 代码：`src/domain/completion.ts`、`src/application/completion-service.ts`、`src/application/task-service.ts`（implement／close）、`src/application/delivery-service.ts`、`src/cli/task.ts`、`src/contracts/completion.ts`、`src/contracts/implementation.ts`、`src/contracts/run.ts`、`src/infrastructure/run-store.ts`、`src/application/diagnostics.ts`。
- 桥接：`assets/templates/pi/extensions/knit.ts`、`src/contracts/bridge-tools.ts`。
- 测试：`test/main-session-implement.test.mjs`（新增）、`test/closeout.test.mjs`、`test/domain.test.mjs`。
- 实例：任务 k-c06c5a41092f 的强制归档记录（提交 422c114／79fae41／61a06f4）。

<!-- knit:progress:start -->
## 当前位置

已实现并验证；待记录实施事实后收尾。

## 关键经过

- 用户确认方案 C：实施记录 + 强制通道 + 一致性诊断。
- 实现中修正：`ScopeEntrySchema` 从 `ScopeFileSchema` 提取复用；`close` 只在非 completed 时清理实施记录；deliver 两条提交路径都要带 forced 标记。

## 结果与验证

- `npx tsc --noEmit`、`npm run build` 通过。
- `node --test test/*.test.mjs`：533 项、526 通过、7 失败；失败均为既有环境问题（TMPDIR realpath、Unix socket 路径超长、Rex 自动探测）。
- 新增 6 个实施记录／强制收口用例与 1 个 forced 交付用例，覆盖正反例。

## 运行引用

### 交付记录

<!-- knit:delivery:op-f3ac8ea88818 -->
- 操作: op-f3ac8ea88818
- 时间: 2026-11-06T14:12:17.554Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 会话确认方案 C 并要求提交归档推送
- 工作提交: 04268dc0ab1c144e6752918310701a0cd9986069
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-main-session-implementation-evidence

<!-- knit:progress:end -->
