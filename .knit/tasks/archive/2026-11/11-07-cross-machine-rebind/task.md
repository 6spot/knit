---
id: k-434714cbbb68
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P2
dependsOn:
  - k-836997c84864
order: 20
createdAt: 2026-11-07T11:44:09.525Z
title: 跨机 rebind 与可交付资格权威口径
---

# 跨机 rebind 与可交付资格权威口径

## 目标与边界

### 背景与问题

binding、scope 与凭据都存在被 ignore 的 SQLite 和 `.runtime` 里，task.md 上的 stage 没有任何东西支撑。审计复现：clone 后进行中的任务（`stage: deliver`）：

- `run check` 报"任务缺少绑定"；
- `task close` 报 `inputs_not_confirmed`；
- `task ready` 报 `phase_mismatch`；
- `task adopt` 与 `task implement` 都成功，但之后 `close` 仍然失败；
- 唯一出路是提交一次虚构的 `change` 输入更新，退回 start。

STATES 第 141 行写了"跨机按 verification 重建完成资格"，但没有命令能做。这也和"task.md 是业务状态唯一权威"的说法自相矛盾。

### 交付范围

1. 新命令 `knit task rebind <taskId>`（桥接 `knit_task action=rebind`）：
   - 为没有 binding 的任务按 task.md 建立 binding；
   - 当前输入摘要作为待确认摘要；
   - stage 不是 start 时，降到"最近一个需要证据的阶段"：self 回到首个工作阶段，independent 有实施记录时回到检查阶段；
   - 原 stage 和降级原因写进记录区；
   - 不伪造 run 或凭据。
2. 自动发现：`status`、`task list`、桥接上下文遇到"task.md 非 start 但无 binding"时，标记 `binding_missing`，`nextAction` 指向 `task rebind`。
3. `task implement` 在无 binding 时一并建立 binding，并按主会话实施记录建立资格，使 self 任务在登记实施后可以 close。
4. 文档统一口径：业务意图（目标、验收、stage 名义）以 task.md 为准；可交付资格（scope、凭据、确认摘要）是本机事实，换机后必须重建。改写 AGENTS／DESIGN 第 3 节和 STATES 中"唯一权威"的相关表述。

### 非目标

- 不把凭据或 scope 提交进 Git。
- 不做跨机同步服务。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- rebind 不消耗 `stageVisits` 预算

## 完成条件

- 自动化测试：clone 后 deliver 阶段的 self 任务 → `task rebind` → `task implement --path …` → `close` 成功；independent 任务 rebind 后回到检查阶段，`run check` 可派发。
- `status` 对无 binding 任务给出 `binding_missing` 与 `nextAction`。

## 输入引用

- 审计 S6。
- `src/application/task-service.ts`（adopt、implement、close）、`src/application/context-planner.ts:390`、`docs/design/STATES.md:141`、`docs/design/DESIGN.md` 第 3 节。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

2026-11-07 新机器执行审计计划时实际复现 S6：clone 后 `task ready k-eb2e23ce4f41` 成功把 task.md 推进到 implement，但未写 binding（ready 只在 binding 存在时保存确认摘要），随后 `run implement` 报 `unknown_binding`（任务缺少绑定）。绕过：`git checkout` 恢复该 task.md 到 start，对 15 个 open 任务逐个 `task adopt <id>`（同分支时补建 binding 行），再重新 ready。证据：run-coordinator.ts:185 unknown_binding；task-service.ts ready 分支 `if (binding !== null)`。本任务 rebind 实现时应覆盖“ready 无 binding 时静默推进 stage”的情况。

## 派发须知（2026-11-07 主会话，审计计划执行约定）
- 报告 `changedPaths` 只列本 run 在工作区实际改动的路径（与 git 前后差一致），不列之前轮次或其它任务已存在的改动；否则 `changed_paths_mismatch` 整轮失败。
- 交付前凭据扫描规则 generic_secret_assignment（见 src/contracts/credentials.ts）会把“凭据类关键词作变量名或字段名并被赋值长字符串或表达式”的新增行判为疑似凭据。新增代码与测试请给此类局部变量加前缀（例如 owner 前缀），夹具值保持 8 字符以内；完成前用 dist/contracts/credentials.js 的 scanCredentials 扫描新增行确认零命中。
- 工作区里其它 `.knit/tasks/*/task.md` 的未提交改动来自主会话记录，不属于本任务成果，不要修改或列入报告。
- 单跑测试时请 `env -u REX_SESSION -u REX_BLOCK node --test ...`；全量用 `npm test`。
- 改文件一律用 write／edit 工具，不用 bash／python／sed 写文件。bash 写入会被判 unattributed_paths。
- 已交付的相关能力（实现时复用，不要另起分支）：
  - status nextAction（k-836997c84864，见 src/application/status-service.ts）：binding_missing 时 nextAction 指向 task rebind，本任务接入同一套机制。
  - 凭据 HMAC（k-28296c22647a）：rebind 不伪造 run 或凭据，也不写签名凭据。
  - task close 已不要求 --runs-settled。
- 必须覆盖：上面“运行引用”里记录的 S6 场景，即 `task ready` 在没有 binding 时静默推进 stage，修复后应报错或提示 rebind，不再静默推进。
- 完成前必须：`npm test` 全绿，新增测试单跑通过，并在报告 validation 中写明测试数量。

### 交付记录

<!-- knit:delivery:op-1f4ef0531512 -->
- 操作: op-1f4ef0531512
- 时间: 2026-11-10T07:21:50.567Z
- 分支: refs/heads/main
- 授权来源: session:01a1b5fe-d8c2-75a1-984f-f512fa6dc28f/message:a0a76c7e；.knit/tasks/11-07-audit-fix-plan/plan.md §6 执行授权
- 调用: cli-unverified
- 工作提交: d8b97a49b8df4162160d6b30231be41739e08fa2
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-cross-machine-rebind

### 任务资料提交记录

<!-- knit:metadata-commit:op-1f4ef0531512 -->
- 任务资料提交: 277ca48b2c99408d6c766b643e3f57d82d5dce14
- 归档目标: .knit/tasks/archive/2026-11/11-07-cross-machine-rebind

<!-- knit:progress:end -->
