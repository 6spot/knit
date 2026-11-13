---
id: k-e7876542ec29
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-13T19:06:01.895Z
title: 收口缺口：主会话实施进入独立检查、目录交付核对与 worktree 关闭路由
---

## 目标与边界

修掉三处让任务无法正常收口的核心缺陷。三处都是“守卫本身正确、但没有留出合法前进路径”，表现为任务卡在某个阶段，只能靠手改资料或强制收口才能继续。

用户于 2026-11-14 确认方向并授权处理（“可以就按照推荐的方向”“梳理好了，就把这个问题给处理掉……你也看着授权给你，给处理掉”）。本任务由 Knit worker 实现并做正式独立检查；主会话负责接收、复验与收尾。授权含本机 Git 提交与归档，不含推送、发布与真实 Pi 验收。

### 缺陷 A：主会话实施的 independent 任务进不了检查阶段

- 现场：任务 k-b9ea41e9eec0（verification=independent）由主会话实施并用 `task implement` 记录后，`knit run check --task` 返回“任务阶段为 implement，不能准备 check”。
- 根因：`task implement`（`src/application/task-service.ts` 的 `implement`）只写实施记录，不推进阶段；阶段只在接收 worker run 时推进（`src/application/run-acceptance.ts` 的 `implementationAccepted`）；`RunCoordinator.prepare`（`src/application/run-coordinator.ts`）在 `frontmatter.stage !== phase` 时只放行从 deliver 发起的复查（`isRecheckOf`）。跨机 `task rebind` 已有“independent 有实施记录时回到检查阶段”的规则（`src/domain/task.ts` 的 `rebindStageOf`），但只在本机绑定缺失时生效。
- 连带问题：实施记录的路径只存在 `.knit/.runtime/implementations/<task-id>.json`，不在任务 scope 里；检查的 coverage 核对、检查凭据的 `scopeDigest` 与 `validateCheckEvidence` 都只看 scope，所以即使进了检查阶段，凭据也不绑定这些路径。

### 缺陷 B：带尾斜杠的目录路径让交付停在 hook_changed_selected

- 现场：交付操作 op-d2b8f5b40d91（任务 k-7e4dbba9dca7）写入产物提交 8209aa1 后停在 `needs_attention / hook_changed_selected`，资料提交与归档没有进行。
- 根因：`src/application/delivery.ts` 的 `selectedPath(path, selected)` 用 `path.startsWith(entry + "/")` 判断归属，选中项写成 `dir/` 时拼成 `dir//`，目录下的文件全部判为未选中；`indexTreeFor` 因此漏记这些文件，而 `treeSnapshot` 走 Git pathspec 能选中它们，`sameTree` 比较不相等，被误报为 hook 改了提交内容。提交实际内容与预期一致，没有 hook 运行（`delivery.hooks` 为 skip）。
- 另外两处使该操作无法重试：重试核对要求产物提交就是 HEAD（`commit_scope_mismatch`），而它之后分支已有 13 个提交，其中 4 个改过同一批文档；重试还要求产物路径在工作区干净（`selected_worktree_dirty`）。任务早已业务完成（completed），只差资料提交与归档，这两条要求对“产物已经提交”的操作没有保护意义。
- 该操作的检查点 `expectedTree` 只有 6 条，实际提交树 16 条，缺的 10 条都在 `validation/macos-acceptance-2026-11/f1-fix/` 与 `f4-fix/` 下；`expectedPaths` 的 16 条与实际提交一致。

### 缺陷 C：在 worktree 内关闭任务时读错证据目录

- 现场：本机验收（任务 k-b9019179b424）的两个 worktree 夹具任务在各自 worktree 内 `task close` 被 `implementation_stale` 拒绝，实施事实实际有效。诊断见 `.knit/tasks/11-12-local-real-pi-acceptance/research/worktree-close-routing-diagnosis.md`。
- 根因：`TaskService.close` 已支持 `executionDir`（任务正文所在检出）与 `evidenceRoot`（运行记录、scope 与凭据所在的主检出）分开，但 CLI `task close`（`src/cli/task.ts`）只传 `dir`，两者都落到 worktree；在主检出执行又找不到 task.md。

### 目标规则

A. 主会话实施后进入检查：

1. verification=independent 的任务处于工作阶段（非 start、非 deliver、非检查阶段）时，`task implement` 成功登记后把任务推进到检查阶段，推进规则与接收 implement run 的 `implementationAccepted` 一致（按生效流程取下一阶段，计入阶段访问）。verification 为 self／none 的任务行为不变。
2. `task implement` 登记的路径并入任务 scope（条目用当前指纹；来源记为主会话实施记录，不写成任何 run 的实际写入，不加入 `runIds`），使检查的 coverage 核对、检查凭据的 `scopeDigest` 与后续完成核对都覆盖这些路径。self／none 任务同样并入。
3. 再次 `task implement`（同一任务重新登记）覆盖记录并更新 scope 中对应条目；任务已在检查阶段或 deliver 时不重复推进阶段。已有的检查凭据因 scope 变化按现有规则失效，不另加规则。
4. 仍不允许跳过实施：independent 任务在工作阶段、没有有效实施记录也没有已接收实施 run 时，`run check --task` 照旧返回 `phase_mismatch`。
5. `task close --force` 对 independent 仍然拒绝；`run check --scope` 仍不构成正式检查。检查者必须是独立的检查 run，不因作者是主会话而放宽。
6. `knit status <taskId>` 的下一步随阶段变化自然给出“派发 check run”；`task implement` 的输出写明已进入检查阶段。
7. 派发分层 W1 的文字改为：independent 的检查必须由独立检查 run 完成；实现可以由 worker 做，也可以在用户明确指定时由主会话做并用 `task implement` 登记后进入检查。删除“不得用 task implement 绕开 W1”的说法，改成“`task implement` 不代替独立检查”。所有出现该文字的位置同步（DESIGN、ROLE-CONTRACT、AGENTS.md 受管块及其模板、两份桥接、相关测试）。

B. 目录路径的交付核对：

8. `selectedPath` 对选中项的尾斜杠不敏感：`dir` 与 `dir/` 都选中 `dir` 本身及其下所有路径；不因此选中 `dir-other/…` 这类只是前缀相同的路径。
9. 已停在 `hook_changed_selected` 的操作可用现有 `deliver --retry` 恢复，不新增命令：重试时按现有顺序核对提交存在、提交文案属于本操作、提交是 HEAD 的祖先、`expectedPaths` 与实际提交路径集合相等；`expectedTree` 中已记录的条目必须与提交树逐条相等；实际提交树多出的条目只有在同时满足“属于 `expectedPaths`”和“位于某个带尾斜杠的选中目录下（即旧检查点因本缺陷漏记）”时才接受，并在步骤证据里记下补认的路径清单。任一条件不满足仍按原因停在 needs_attention。
10. 重试核对产物提交时不再要求该提交就是 HEAD，也不要求之后的提交不触及这些路径：产物提交之后分支继续前进是正常情况。只要求该提交是 HEAD 的祖先、文案属于本操作、提交内容按第 9 条核对通过；产物路径在工作区是否干净只对“尚未提交过产物”的操作要求，已有产物提交的操作不因这些路径后来被别的任务改动而拒绝。不是祖先（被改写或丢弃）照旧拒绝。

C. worktree 内的任务收口：

11. CLI `task close` 与 `task implement` 在关联 worktree 内执行时，任务正文按当前检出定位，运行记录、scope、实施记录与完成凭据按主检出读写；在主检出执行、任务已路由到 worktree 时，按任务绑定的 worktree 路由定位正文，不再报“任务不存在”。桥接经同一 CLI 入口，不另写路由。
12. 非 worktree 项目的行为不变。

### 范围

- 核心：`src/application/task-service.ts`、`src/application/run-coordinator.ts`、`src/application/scope.ts`、`src/application/status-service.ts`、`src/application/delivery.ts`、`src/application/delivery-service.ts`、`src/domain/task.ts`、`src/cli/task.ts`，以及为上述规则必须改动的相邻文件（契约、模板文字）。
- 文字与桥接：`docs/design/DESIGN.md`（§3.8、§4.2、§4.3 及交付核对相关段落）、`docs/design/STATES.md`、`docs/design/OPERATIONS.md`、`docs/design/ROLE-CONTRACT.md`、`docs/design/GLOSSARY.md`、`AGENTS.md` 受管块、`src/application/templates.ts`、`.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts`（两份逐字一致）。
- 测试：新增或扩展覆盖下列场景的自动化测试；受文字改动影响的既有断言同步。

### 非目标

- 不改检查阶段的独立性要求、检查报告字段与场景核对规则。
- 不改 worker 自动接收、run 状态机、阶段访问上限与修复周期规则。
- 不新增配置项、命令或持久状态表；scope 文件允许增加记录来源所需的字段。
- 不处理 worktree 的 merge／cleanup 流程本身；只修任务收口命令的目录路由。
- 不修改任何既有任务的运行资料、凭据或检查点；现场任务的恢复由主会话在本任务完成后用公开命令执行。
- 不做全局安装、发布、部署。

### 实施约束

- 工作区里 `.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`、`docs/design/DESIGN.md`、`docs/design/ARCHITECTURE.md`、`test/bridge-query.test.mjs`、`test/host-selection.test.mjs` 的桥接通知改动属于任务 k-b9ea41e9eec0，已在本任务开始前提交；在其基础上修改，不回退。
- `.knit/config.json` 的未提交改动、`.knit/tasks/` 下其他任务目录、`validation/`、`.pi/agents/` 与本任务无关，保持原样。
- 阶段内不提交 Git，不改 `.knit/` 下受保护资料。
- 两份桥接每次修改后保持逐字一致。

### 延期验收

- 真实 Pi 会话中的端到端观察按 AGENTS.md 延期。
- 现场任务 k-b9ea41e9eec0、k-7e4dbba9dca7 的实际恢复不属于本任务的完成条件，由主会话随后执行并另行记录。

## 完成条件

### Requirement: 主会话实施的 independent 任务可以进入正式检查

#### Scenario: 登记实施后进入检查阶段
- GIVEN verification=independent 的任务已 ready、处于首个工作阶段，没有任何 run
- WHEN 执行 `task implement` 登记至少一个路径与一条验证
- THEN 任务阶段变为检查阶段，`task.md` 的 stage 与绑定的阶段访问计数同步更新
- AND `run check --task` 可以准备检查 run，`knit status` 的下一步指向派发检查

#### Scenario: 登记的路径进入 scope 并被检查覆盖
- GIVEN 上一场景登记了路径 P
- WHEN 读取任务 scope 并准备检查 run
- THEN scope 含 P 的当前指纹，且 `runIds` 不因此增加
- AND 检查报告的 coverage 漏掉 P 时接收以 `check_scope_incomplete` 拒绝

#### Scenario: 检查通过后可以正常完成
- GIVEN 主会话登记实施后，一次检查 run 以 pass 被接收且检查者未改文件
- WHEN 执行 `task close --outcome completed`
- THEN 关闭成功，完成凭据的验证方式为 independent、实施来源为主会话记录、带该检查 run 的 ID

#### Scenario: 登记后成果再变化
- GIVEN 检查已通过
- WHEN 登记过的路径内容再次变化
- THEN `task close --outcome completed` 被拒绝，原因指向检查已过期

#### Scenario: 没有实施事实仍不能跳到检查
- GIVEN verification=independent 的任务处于工作阶段，没有实施记录也没有已接收的实施 run
- WHEN 执行 `run check --task`
- THEN 返回 `phase_mismatch`，任务阶段不变

#### Scenario: self 任务行为不变
- GIVEN verification=self 的任务已 ready
- WHEN 执行 `task implement` 后 `task close --outcome completed`
- THEN 关闭成功，任务没有被推进到检查阶段，凭据实施来源为主会话记录

#### Scenario: independent 仍不能强制收口
- GIVEN verification=independent 的任务已登记实施但没有通过的检查
- WHEN 执行 `task close --outcome completed --force --reason …`
- THEN 被拒绝

### Requirement: 目录路径的交付核对正确

#### Scenario: 带尾斜杠的目录正常交付
- GIVEN 任务成果路径含一个带尾斜杠的目录，目录下有多个文件
- WHEN 在隔离 Git 夹具执行 `deliver`
- THEN 产物提交、资料提交与归档提交依次完成，操作状态为 completed，不出现 `hook_changed_selected`

#### Scenario: 前缀相同的兄弟路径不被误选
- WHEN 用选中项 `dir/` 判断 `dir-other/file`
- THEN 判为未选中

#### Scenario: 旧检查点漏记目录文件的操作可以重试恢复
- GIVEN 一个操作已写入产物提交并停在 `hook_changed_selected`，其检查点 `expectedTree` 漏记了带尾斜杠目录下的文件，`expectedPaths` 与实际提交一致
- WHEN 执行 `deliver --retry`
- THEN 操作继续完成资料提交与归档，不产生第二个产物提交
- AND 步骤证据记下补认的路径

#### Scenario: 真实的内容差异仍被拒绝
- GIVEN 同上的操作，但提交树中某个已在 `expectedTree` 记录的条目与记录不同，或多出的条目不在 `expectedPaths` 内
- WHEN 执行 `deliver --retry`
- THEN 仍停在 needs_attention，原因不变

#### Scenario: 产物提交之后分支有其他提交
- GIVEN 上述可恢复的操作，其产物提交之后分支上又有不触及本操作产物路径的提交
- WHEN 执行 `deliver --retry`
- THEN 恢复成功，资料提交与归档提交接在当前 HEAD 之后
- AND 之后的提交或工作区改动过本操作的产物路径时同样恢复成功，这些后续改动不被纳入本操作的任何提交
- AND 产物提交不是 HEAD 的祖先时拒绝并给出原因

### Requirement: worktree 内可以正常收口任务

#### Scenario: 在 worktree 内关闭已实施的任务
- GIVEN 任务路由到关联 worktree，实施 run 已接收，运行记录在主检出
- WHEN 在该 worktree 内执行 `task close --outcome completed`
- THEN 关闭成功，完成凭据写在主检出的运行目录

#### Scenario: 在主检出关闭路由到 worktree 的任务
- GIVEN 同上
- WHEN 在主检出执行 `task close --outcome completed`
- THEN 关闭成功，不报任务不存在

#### Scenario: 在 worktree 内登记主会话实施
- GIVEN 任务路由到关联 worktree
- WHEN 在该 worktree 内执行 `task implement`
- THEN 实施记录写在主检出的运行目录，路径指纹按 worktree 内的文件计算

### Requirement: 规范文字、桥接与回归一致

#### Scenario: 派发分层文字同步
- WHEN 搜索仓库中的现行规范、模板、桥接与测试
- THEN 不再出现“不得用 task implement 绕开 W1”的说法，各处写明 independent 的检查由独立检查 run 完成、主会话实施经 `task implement` 登记后进入检查
- AND 两份桥接逐字一致，AGENTS.md 受管块与模板生成结果一致

#### Scenario: 状态与操作文档同步
- WHEN 阅读 STATES.md 的任务转移表、DESIGN.md 的命令面与阶段推导、OPERATIONS.md 的 `task implement` 与交付核对说明
- THEN 写明上述三组规则，与代码行为一致

#### Scenario: 回归
- WHEN 运行 `npm test`
- THEN 全部通过

## 验证安排

- verification 为 `independent`：改动涉及任务阶段转移、scope 归属、交付提交核对与 worktree 目录路由，属于状态机与数据保护规则，作者自证不足。
- 实施：Knit worker。完成后主会话在普通终端与 Rex 终端各跑一次 `npm test` 复验。
- 独立检查：Knit 检查 run，模型用 DeepSeek（`magpie` / `group/deepseek`）。

## 输入引用

- 用户决定（2026-11-14）：采用方向一（打通主会话实施进入检查的路径）；授权主会话处理各任务的收口阻塞。
- 现场：任务 k-b9ea41e9eec0 记录区；交付操作 op-d2b8f5b40d91 与 `.knit/tasks/11-11-macos-acceptance-fixes/research/delivery-directory-scope-blocker.md`；`.knit/tasks/11-12-local-real-pi-acceptance/research/worktree-close-routing-diagnosis.md`。
- 历史决定：k-795f3804775e（`.knit/tasks/archive/2026-11/11-06-main-session-implementation-evidence/task.md`，`task implement` 只为 self 设计）；提交 ea64d73（派发分层 W1）；k-434714cbbb68（跨机 rebind，independent 有实施记录回到检查阶段）。
- 代码：`src/application/task-service.ts`（`implement`、`close`、`rebind`、`hasImplementationEvidence`）、`src/application/run-coordinator.ts`（`prepare`、`isRecheckOf`）、`src/domain/task.ts`（`implementationAccepted`、`recheckRequested`、`rebindStageOf`）、`src/application/scope.ts`（`mergeScope`）、`src/application/check-validation.ts`、`src/application/completion-service.ts`、`src/application/delivery.ts`（`selectedPath`、`indexTreeFor`、`sameTree`、`treeSnapshot`）、`src/application/delivery-service.ts`（`commitSelected`、重试核对段）、`src/cli/task.ts`、`src/application/worktree-routing.ts`。
- 规范：`docs/design/DESIGN.md` §3.8、§4.2（派发分层）、§4.3；`docs/design/STATES.md` 第 3、8、11 节；`docs/design/OPERATIONS.md`；`docs/design/ROLE-CONTRACT.md`。
- 测试：`test/main-session-implement.test.mjs`、`test/rebind.test.mjs`、`test/closeout.test.mjs`、`test/init.test.mjs`、`test/bridge-query.test.mjs`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-805b17291d13 -->
- 操作: op-805b17291d13
- 时间: 2026-11-13T20:09:53.185Z
- 分支: refs/heads/main
- 授权来源: user:9698c2d8
- 调用: bridge
- 工作提交: e717f959963d4ebf36d202e089f186af1a2eb932
- 结果: 正常交付；检查 run-f212dcb49f27 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-14-closeout-gaps

### 任务资料提交记录

<!-- knit:metadata-commit:op-805b17291d13 -->
- 任务资料提交: 90c4696f1c5c43799dbd7cb3d1d408d3a7ff6039
- 归档目标: .knit/tasks/archive/2026-11/11-14-closeout-gaps

<!-- knit:progress:end -->
