# 场景化完成条件：收尾恢复复核（2026-11-13）

## 本轮范围与结果

用户指定仅收尾任务 k-185ace3b9556，不处理本机真实 Pi 验收。本轮核对历史成果与本机交付资格，并尝试正式归档；业务成果仍已完成，但本轮归档未成功。

历史功能提交为 `66f2d3f`，验收记录提交为 `58a2dc2`。既有实施 run 为 `run-4725f81f73af`，独立检查 run 为 `run-bc7506733800`。

未修改生产代码、任务需求、任务状态、scope、检查/完成凭据、checkpoint 或旧交付 operation；未提交、推送或归档。本文件是本轮新增调查产物。

## 实际执行与证据

1. 读取任务、计划、此前 stale 检查报告、本机绑定和交付 operation，并核对 Git 历史与工作区。
2. `knit_deliver plan --task k-185ace3b9556 --branch refs/heads/main` 返回 ready；没有暂存产物或资料。该结果仅说明路径/工作区预检，不证明交付资格有效。
3. `knit_deliver archive --task k-185ace3b9556 --branch refs/heads/main --authorization-ref user:c9a5f8e6 --retry` 被拒绝：桥接 reasonCode `needs_review`，错误为「交付策略在操作开始后变化，重核后再继续」。源码守卫是 `policy_changed`（`src/application/delivery-service.ts` 的 prepare）。
4. 原交付 `op-82859126c85c` 是 `delivery.deliver`、mode=deliver、state=planned；所有步骤仍为 planned，workCommit、metadataCommit、archiveCommit 均为 null。旧提交授权已核对原生用户消息并为 verified。
5. 既有独立检查 effective inputs 与当前 `.knit/agents/check.md` 不一致；此前报告还确认了四条成果路径指纹漂移：`.pi/extensions/knit.ts`、`AGENTS.md`、`docs/design/DESIGN.md`、`src/application/task-service.ts`。来源见同目录 `delivery-stale-check-2026-11-12.md`。
6. 主会话本轮没有重新执行功能测试；历史测试不作为本轮新验证结果。

## 独立只读复核

宿主独立上下文 `deepseek-reviewer`，ID `2d13d9b4-e14b-4a0c-b69f-7c0be6a75bf9`，完成了恢复路径代码审阅。它没有执行正式 Knit check，不构成新的检查凭据。

主会话核对的关键事实：

- 当前 binding 已存在时 rebind 不重建资格；不能借此刷新旧凭据。
- 新 clone 的 rebind 不恢复原 scope，检查的 coverage 机械校验只针对 scope；因此不能靠新 clone 的空 scope 声称恢复了原范围的独立验证。
- `task implement --path` 是实际实施事实记录，不应把本轮未改动的既有文件宣称为新实施，也不会给 check 补齐原 scope。
- 在原 scope 上，报告 changedPaths 不能任意声明本 run 未改动且没有 residue 来源的路径；include 也不是刷新任意旧成果指纹的入口。
- `cancel --operation` 可留痕为 abandoned，但 latestOperation 的选择未排除 abandoned；取消旧 operation 不能作为可靠的新交付恢复方案。
- `archive` 新建操作只接受 cancelled/superseded；正常完成必须通过 deliver，不能改 outcome 绕过。

因此本轮没有采用 clone、伪造 changedPaths、补录非本轮实际改动、force、降低验证级别、删除/改写凭据、手动改归档状态等方式。

## 最小后续修复范围（尚未授权实施的方案）

若用户允许扩大到 Knit 的交付/凭据恢复机制，建议补齐同一仓库中的显式恢复流程，保持原功能需求和 independent 验证级别：

1. 交付 operation 在策略变化后可显式按当前策略重新核验并留痕；已有实际 Git 副作用必须逐项复核，旧授权来源及旧操作记录保留。不能仅跳过 policy_changed。
2. 对后续任务已合法更新的旧成果路径，提供有来源的重新取证入口，保留原路径集合与实施来源，区分“重新复核”与“本轮实际写入”，不得依赖假改动。
3. 新独立检查强制覆盖原有完整成果路径与全部场景，在当前输入/提示词和当前成果指纹上生成新资格；旧检查与完成历史保留。
4. 新资格成立后恢复正式 deliver/archive；验证元数据提交、封存、移动和归档提交的实际结果。

需要的验证：在隔离夹具中覆盖旧检查输入变化、后续合法成果漂移、交付策略变化及 abandoned operation 恢复；确认未覆盖路径、来源不明路径或未重核副作用仍被拒绝。按实际代码影响执行相关测试，并由独立上下文复核。

这超出原任务 Requirement/Scenario 功能的既有实施范围，涉及恢复语义，需要用户决定是否扩展本次工作；当前任务保留 completed/deliver、未归档。