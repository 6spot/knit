---
id: k-2af2e1208325
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-13T20:45:38.120Z
title: 策略恢复：needs_attention 的提交步骤可随重试重核
---

## 目标与边界

修掉交付策略恢复的一处死锁：操作停在 needs_attention 之后策略版本又变化时，`deliver --retry` 被 `policy_changed` 拒绝，`deliver --retry --recover-policy` 又被 `policy_recovery_effects` 拒绝，两条公开路径互相要求对方先完成，操作永远无法继续。

用户于 2026-11-14 授权主会话处理收口受阻的问题（“剩下几个收口的问题，导致任务无法进行下去、没法完成的。你也看着授权给你，给处理掉”）。本任务由 Knit worker 实现并做正式独立检查；主会话负责接收、复验与收尾。授权含本机 Git 提交与归档，不含推送、发布与真实 Pi 验收。

### 现场

- 交付操作 op-d2b8f5b40d91（任务 k-7e4dbba9dca7）：产物提交 8209aa1 已在 main，步骤 `1-artifact_commit` 为 `needs_attention`（原因 `hook_changed_selected`，检查点因旧尾斜杠缺陷漏记 10 个文件），其余 5 步 `planned`，未封存。
- 提交 e717f95 已让 `deliver --retry` 能补认这类检查点，但同一提交改了 `AGENTS.md`，策略版本（`policyVersion`，AGENTS.md 正文摘要）随之变化。
- 2026-11-14 实测：
  - `knit deliver k-7e4dbba9dca7 --branch refs/heads/main --retry` → `交付策略在操作开始后变化，重核后再继续`（`policy_changed`）。
  - 同一命令加 `--recover-policy`、原授权引用与原会话文件 → `副作用尚不能核验: 1-artifact_commit`（`policy_recovery_effects`）。
  - 两次都没有产生提交，操作记录未变。

### 根因

- `src/application/delivery-service.ts` 的 `recoverPolicy` 逐步核验旧副作用时，只接受两种步骤：完全没有痕迹的 `planned`，或带提交且 `completed`。`needs_attention` 的提交步骤一律抛 `policy_recovery_effects`。
- `prepare` 在策略版本不同时抛 `policy_changed`，重试必须先过 `prepare`，所以带 `needs_attention` 步骤的操作不能先重试再恢复策略。
- `docs/design/OPERATIONS.md` 交付恢复段已写“needs_attention 同时给 `--retry`”，代码没有实现这一条。

### 目标规则

1. `deliver --retry --recover-policy` 同时给出时，策略恢复对 `needs_attention` 的提交类步骤（产物、资料、归档提交）按下列方式核验，不再一律拒绝：
   - 步骤已记录提交：按 `--retry` 对该步骤使用的同一套核对规则核验（提交存在、文案属于本操作与该阶段、是 HEAD 的祖先、记录了父提交时父提交相符、`expectedPaths` 与实际提交路径集合相等、`expectedTree` 逐条相等，产物提交允许按现有尾斜杠补认规则补认漏记条目）。核对逻辑与重试共用一份实现，不另写一套宽松版本。通过后该提交记入本次 `policyRecoveries` 的 `verifiedCommits`。
   - 步骤没有记录提交，且分支历史中找不到属于本操作该阶段的提交：视为没有副作用，允许恢复。
   - 步骤没有记录提交，但历史中找得到属于本操作的提交：照旧拒绝。
2. 核验全部通过后才更新策略版本并追加 `policyRecoveries`；任一条不通过，策略版本、`policyRecoveries`、步骤状态与提交都保持原样，返回 `policy_recovery_effects`。恢复通过后同一次调用继续按普通重试执行，不要求再调用一次。
3. 不带 `--retry` 时行为不变：`needs_attention` 操作直接返回已有结果，不恢复策略。
4. 不带 `--recover-policy` 时行为不变：仍以 `policy_changed` 拒绝，普通重试不跳过策略检查。
5. 下列既有限制不放宽：
   - 必须显式提供与原操作相同的授权引用；用户消息授权须可核验且消息未变。
   - 分支须与原操作及当前检出一致。
   - `completed` 步骤的提交继续按现有规则核验；操作记录了提交却没有对应步骤来源、历史中有未核验的本操作提交，仍拒绝。
   - 已封存的操作仍拒绝；非提交类步骤（`final_record`、`seal`、`move`）只要不是无痕迹的 `planned` 仍拒绝。
6. 拒绝时给出下一步：
   - `policy_changed` 的说明在原句后写明可用 `--recover-policy` 加原授权引用重核，操作为 needs_attention 时同时加 `--retry`。原句“交付策略在操作开始后变化”保留。
   - `policy_recovery_effects` 因 `needs_attention` 步骤而拒绝且调用未带 `--retry` 的情形按第 3 条不会出现；其余拒绝说明保留步骤或提交标识。
7. 文档同步：`docs/design/OPERATIONS.md` 交付恢复段与 `docs/design/STATES.md` 对应段写明上述核验范围（needs_attention 提交步骤按重试规则核验、无提交且无历史提交视为无副作用、非提交步骤与已封存仍拒绝）。

### 范围

- 核心：`src/application/delivery-service.ts`，以及为共用核对逻辑必须改动的 `src/application/delivery.ts`。
- 文档：`docs/design/OPERATIONS.md`、`docs/design/STATES.md`；其他设计文档只在出现相同表述时同步。
- 测试：`test/delivery.test.mjs` 新增或扩展覆盖下列场景；受说明文字改动影响的既有断言同步。

### 非目标

- 不改策略版本的计算方式，不改授权解析与核验规则。
- 不新增命令、选项、配置项或持久字段；`policyRecoveries` 结构不变。
- 不改桥接工具参数，不改 `AGENTS.md`。
- 不放宽 `final_record`、`seal`、`move` 步骤与已封存操作的恢复限制。
- 不修改任何既有任务的运行资料、凭据或检查点；现场操作 op-d2b8f5b40d91 的实际恢复由主会话在本任务完成后用公开命令执行。
- 不做全局安装、发布、部署。

### 实施约束

- `.knit/config.json` 的未提交改动、`.knit/tasks/` 下其他任务目录、`validation/`、`.pi/agents/` 与本任务无关，保持原样。
- 阶段内不提交 Git，不改 `.knit/` 下受保护资料，不对真实仓库执行 `deliver`。
- Git 与交付测试都在隔离夹具内完成。
- 不改 `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts`。

### 延期验收

- 现场操作 op-d2b8f5b40d91 的实际恢复不属于本任务的完成条件，由主会话随后执行并另行记录。
- 真实 Pi 会话中的端到端观察按 AGENTS.md 延期。

## 完成条件

### Requirement: needs_attention 的提交步骤可以随重试恢复策略

#### Scenario: 已有产物提交的操作恢复策略并完成
- GIVEN 隔离夹具中一个交付操作已写入产物提交并停在 `needs_attention`，其检查点与提交相符（或只漏记带尾斜杠目录下的文件），之后 `AGENTS.md` 内容变化
- WHEN 用原授权引用执行 `deliver --retry --recover-policy`
- THEN 操作完成资料提交与归档，状态为 completed，没有产生第二个产物提交
- AND 操作的 `policyRecoveries` 追加一条，含旧策略、当前策略与已核验授权，`verifiedCommits` 含该产物提交

#### Scenario: 提交前停下的操作恢复策略
- GIVEN 一个交付操作的产物步骤在写入提交前停在 `needs_attention`，分支历史中没有属于该操作的提交，之后 `AGENTS.md` 内容变化
- WHEN 用原授权引用执行 `deliver --retry --recover-policy`
- THEN 策略恢复通过，`policyRecoveries` 追加一条且 `verifiedCommits` 为空
- AND 调用继续按普通重试执行，不再返回 `policy_changed` 或 `policy_recovery_effects`

#### Scenario: 提交内容与检查点不符时拒绝
- GIVEN 第一个场景的操作，但检查点 `expectedTree` 中已记录的某个条目与提交树不同
- WHEN 执行 `deliver --retry --recover-policy`
- THEN 返回 `policy_recovery_effects`
- AND 操作的策略版本、`policyRecoveries`、步骤状态不变，分支上没有新提交

#### Scenario: 产物提交不在当前分支历史时拒绝
- GIVEN 第一个场景的操作，但记录的产物提交不是 HEAD 的祖先
- WHEN 执行 `deliver --retry --recover-policy`
- THEN 返回 `policy_recovery_effects`，操作记录不变

#### Scenario: 历史中有未记录的本操作提交时拒绝
- GIVEN 一个 `needs_attention` 操作的产物步骤没有记录提交，但分支历史中存在属于该操作的提交
- WHEN 执行 `deliver --retry --recover-policy`
- THEN 返回 `policy_recovery_effects`，操作记录不变

### Requirement: 既有限制与默认行为不变

#### Scenario: 只重试不恢复策略
- GIVEN 第一个场景的操作
- WHEN 执行 `deliver --retry`，不带 `--recover-policy`
- THEN 返回 `policy_changed`，说明含“交付策略在操作开始后变化”并指出 `--recover-policy` 与 `--retry` 的用法
- AND 操作记录不变

#### Scenario: 只恢复策略不重试
- GIVEN 第一个场景的操作
- WHEN 执行 `deliver --recover-policy`，不带 `--retry`
- THEN 返回已有的 needs_attention 结果，策略版本与 `policyRecoveries` 不变，没有新提交

#### Scenario: 授权引用不符
- GIVEN 第一个场景的操作
- WHEN 用与原操作不同的授权引用执行 `deliver --retry --recover-policy`
- THEN 返回 `authorization_required`，操作记录不变

#### Scenario: 非提交步骤已有痕迹时仍拒绝
- GIVEN 一个操作的 `final_record`、`seal` 或 `move` 步骤不是无痕迹的 `planned`，或操作已封存，之后策略变化
- WHEN 执行 `deliver --retry --recover-policy`
- THEN 返回 `policy_recovery_effects`，操作记录不变

#### Scenario: 既有策略恢复用例保持通过
- WHEN 运行 `test/delivery.test.mjs` 中既有的「策略显式恢复」用例与全量 `npm test`
- THEN 全部通过，planned 操作的恢复、缺少步骤来源的旧提交拒绝、不可核验授权拒绝等既有断言不变

### Requirement: 文档与实现一致

#### Scenario: 设计文档写明核验范围
- WHEN 阅读 `docs/design/OPERATIONS.md` 交付恢复段与 `docs/design/STATES.md` 对应段
- THEN 两处写明 needs_attention 提交步骤须同时给 `--retry` 并按重试规则核验、无提交且无历史提交视为无副作用、非提交步骤与已封存操作仍拒绝
- AND 没有与实现矛盾的表述

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-93b4378473bf -->
- 操作: op-93b4378473bf
- 时间: 2026-11-13T21:28:06.761Z
- 分支: refs/heads/main
- 授权来源: user:9698c2d8
- 调用: bridge
- 工作提交: 46bd914b40783d1d4df56bb6f7a92c95ff900323
- 结果: 正常交付；检查 run-0ac98d57462e 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-14-policy-recovery-retry

### 任务资料提交记录

<!-- knit:metadata-commit:op-93b4378473bf -->
- 任务资料提交: 62ea8d392071e193add9b3692c3242c49ff366ca
- 归档目标: .knit/tasks/archive/2026-11/11-14-policy-recovery-retry

<!-- knit:progress:end -->
