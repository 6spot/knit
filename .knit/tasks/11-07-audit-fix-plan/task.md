---
id: k-2c0d10318898
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P0
dependsOn: []
order: 10
createdAt: 2026-11-07T11:44:04.726Z
title: 审计修复总计划：成果认定、归属、出口与信任边界
---

# 审计修复总计划：成果认定、归属、出口与信任边界

## 目标与边界

### 背景与问题

2026-11-07 主会话只读审计（隔离仓库 `/tmp/kx` + fake-pi 实测）发现：run 成果的认定、改动归属与卡住后的出口三处基础不可靠，导致完成凭据、"independent" 标记与交付提交可能与事实不符。完整问题清单与复现证据见本任务 `plan.md`。

### 交付范围

- 统筹以下子任务的范围、优先级与依赖；子任务各自承担实现、文档与测试。
- 已有任务 `k-f0d9a8952aff`（锁收窄与状态写归属）覆盖审计 S4／S5，纳入本计划，不重复建任务。
- 每个子任务把对应审计复现场景写成自动化测试，作为回归集。

### 非目标

- 不建设操作系统级沙箱；有 exec 的阶段进程仍可能产生未声明副作用，目标是"检测并如实标注"，而非"绝对阻止"。
- 不在本计划内做真实模型、真机或 NPM 发布验收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 子任务的取舍已按审计推荐项确认（2026-11-07 用户「按推荐」）；各子任务「关键决定」为准。

## 完成条件

- 全部子任务 closed（completed／superseded 需写明原因）。
- 在隔离夹具中按 `plan.md`「回归场景」逐条复跑：F1–F4、S1–S8 均不再复现，或按子任务决定以 needs_attention／明确标注呈现。
- 设计文档（DESIGN／STATES／OPERATIONS／ROLE-CONTRACT）与实现一致，无残留旧语义。

## 输入引用

- 本任务 `plan.md`：问题清单、根因、修复原则、任务分解与回归场景。
- [AGENTS.md](../../../AGENTS.md) 开发约定与交付检查。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 模型分配决定（2026-11-09 用户指示）
- 用户指示：验证内容对模型能力要求不高的后续子任务改用 magpie group/deepseek，主会话须严格核验产出代码与结果。
- 分配：
  - k-434714cbbb68（跨机 rebind，self）、k-b9df107db53a（报告补报，self）、k-0524fc52e81b（桥接异步，self）：实施用 deepseek。主会话逐个读 diff、复跑全量测试与新增测试，并抽查完成条件。
  - k-28296c22647a（凭据 HMAC、调用边界、授权核对，independent）：涉及信任边界与安全，实施和独立检查仍用 group/claude。
  - k-836997c84864 已用 claude 派发，不中途更换模型。

## Verification approach adjustment (2026-11-09, user decision)
- The user chose "reduce per-task checks; do one full verification at the end":
  - k-836997c84864: changed from independent to self. Its current run is still in progress, so the change waits until the run ends, to avoid stale_input. After it ends: `task update --kind change` back to start, then `task verification self`, with the reason recorded.
  - k-28296c22647a (credential integrity, trust boundary): keeps an independent check.
  - k-434714cbbb68, k-b9df107db53a, k-0524fc52e81b: already self, implemented with deepseek; the main session reviews the diff and reruns the tests.
  - Final full verification: once all subtasks are delivered, the parent task replays F1–F4 and S1–S8 in an isolated fixture, runs the full npm test, and checks DESIGN, STATES, OPERATIONS and ROLE-CONTRACT for consistency. This covers the downgraded tasks together.

## 当前位置

全部子任务已交付并推送；总任务的回归复跑、完整测试与设计文档核对已完成，待交付。

## 关键经过

- 13 个子任务与 `k-3cdf35cd9d45` 按 `knit task next` 的顺序逐个推进，每个都经 `knit deliver` 交付并推送到 `origin main`。没有任务被置为 blocked，没有使用 `--force`，没有改写已推送的历史。
- 2026-11-09 用户两项指示（原文见下方两节）：后三个 self 子任务实施改用 deepseek，主会话核验；`k-836997c84864` 由 independent 改为 self，最后由总任务统一做一次完整验证。`k-28296c22647a` 保留独立检查。
- 总任务没有派 worker，由主会话直接实施：写 CLI 级探针复跑 `plan.md` 第 5 节的 12 条场景，跑完整 `npm test`，核对设计文档。
- 设计文档核对发现两处并已修正：
  - `DESIGN.md` 第 14.1 节仍写“保留现有 Git hooks”，与第 10.2 节 `delivery.hooks` 缺省 `skip` 矛盾。
  - 原因码 `path_not_unattributed` 在设计文档中没有出现，已在 `OPERATIONS.md` 的接收步骤补一句。
- 探针脚本、输出与报告放在 `validation/audit-fix-plan-regression/`，格式参照 `validation/audit-fix-verification/report.md`（Agent 自行决定，执行授权内）。

## 结果与验证

子任务结果（全部 closed／completed，提交为 产物／资料／归档）：

| 序 | 任务 | 验证 | 提交 |
|---|---|---|---|
| 1 | k-eb2e23ce4f41 tools 语义 | self | 9325bff／7999941／218f49f |
| 2 | k-6f0616f3779d 崩溃锁回收 | independent | f23a22d／ecec2de／7c34910 |
| 3 | k-a8ace0d90676 阶段基线冻结 | independent | 5a15988／5617019／38125c3 |
| 4 | k-fd956a1c3dc0 macOS 测试与 CLI 一致性 | self | 2e79e30／17ece5e／358ece8 |
| 5 | k-f0d9a8952aff 锁收窄与状态写归属 | independent | 03529be／7569111／44222be |
| 6 | k-fdfd8c171736 改动来源归属 | independent | bd7d5d4／2c33fbe／e99c3ed |
| 7 | k-b88e4a80906d 检查阶段写入约束 | independent | 0eceab9／56614d7／bc9bf0a |
| 8 | k-86d01bf85274 空成果完成守卫 | self | 59b2ef0／485c3a4／d009337 |
| 9 | k-836997c84864 resume、Rex 回退与出口 | self（原 independent，用户决定） | e7ec73e／af42164／9d2c37a |
| 10 | k-28296c22647a 凭据、调用边界与 hooks | independent | 3239f73／2a5ece0／dd80dd0 |
| 11 | k-434714cbbb68 跨机 rebind | self | d8b97a4／277ca48／8c953d9 |
| 12 | k-b9df107db53a 报告补报 | self | 1123a0e／4277669／8f2f875 |
| 13 | k-0524fc52e81b 桥接异步化 | self | 1d27ec7／c5607ca／de6b4c7 |
| — | k-3cdf35cd9d45 准备期 change 不耗预算 | self | 4c9b73e／195adfc／235dc96 |

总任务实际跑过的验证（2026-11-10，主会话，基线 `de6b4c7`，去掉阶段环境变量）：

- `node validation/audit-fix-plan-regression/probe.mjs`：12 条场景 61 条断言全部通过，退出码 0；复跑一次逐行输出相同。F1–F4、S1–S8 均不再复现，或按子任务决定以 needs_attention／明确标注呈现。逐场景结果见 `validation/audit-fix-plan-regression/report.md`。
- `npm test`：711 项全部通过，退出码 0（含 `DESIGN.md` 与 `OPERATIONS.md` 两处修正）。
- `git diff --check`：通过。
- 设计文档：本计划引入的 15 个原因码逐个与 `src/` 对照，旧说法（tools 缺省、手工 unlock、resume 只准备、hooks 处理）搜索无残留。

未验证：

- 真实模型、真机、Rex 实机与 macOS 上的运行；探针只用假 Pi 与假 Rex。
- `npm test` 的真实模型冒烟用例（`受控工具取消`）在子任务 13 阶段出现过一次 180 秒超时，单独重跑与之后的全量运行都通过，仍可能偶发。

## 运行引用

- 总任务无 worker run；实施事实由 `task implement` 记录。
- 回归证据：`validation/audit-fix-plan-regression/`（`probe.mjs`、`probe-output.txt`、`probe-output.json`、`report.md`）。

### 交付记录

<!-- knit:delivery:op-ca5b8da4973d -->
- 操作: op-ca5b8da4973d
- 时间: 2026-11-10T23:37:42.675Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 调用: bridge
- 工作提交: d33d28c7b8b9a1b7d483f3ccbf994d610b8b9617
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-audit-fix-plan

<!-- knit:progress:end -->
