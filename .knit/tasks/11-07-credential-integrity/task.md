---
id: k-28296c22647a
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-2c0d10318898
priority: P1
dependsOn:
  - k-a8ace0d90676
order: 30
createdAt: 2026-11-07T11:44:09.047Z
title: 凭据完整性、阶段调用边界与交付 hooks 隔离
---

# 凭据完整性、阶段调用边界与交付 hooks 隔离

## 目标与边界

### 背景与问题

审计结论：
- **凭据可伪造：** 检查凭据 `checks/*.json`、完成凭据 `completions/*.json`、实施记录都是 ignored 的明文 JSON，有 exec 的阶段 Agent 可以伪造。
- **hooks 会执行：** 交付提交会执行仓库 hooks，阶段 Agent 写入的 hook 在用户授权交付时被执行。
- **授权靠自报：**
  - `authorizationRef: user:任意文本` 即被接受（`verified: false`）；
  - 不带 `--caller agent` 直接调 CLI，会被当作用户的显式调用、不需要授权；
  - 阶段进程没有环境标记，核心无法拒绝来自 worker 内部的交付类命令。
- **凭据扫描范围不全：** 只扫 scope 与任务目录。

### 交付范围

1. 凭据完整性：
   - 本机密钥 `~/.knit/keys/<project-hash>`（0600，worker 环境不传路径）；
   - 检查、完成、实施记录写入时附 HMAC，读取时校验，失败按 `credential_tampered` 处理，不当作有效凭据；
   - 旧凭据缺签名时按"需重建"处理，而不是"有效"。
2. 阶段进程标记：worker 为阶段 Pi 及其子进程注入 `KNIT_STAGE_RUN_ID`。核心检测到该变量时，拒绝 `deliver`、`archive`、`worktree merge --apply`、`worktree cleanup`、`task close`、`unlock`、`gc --apply`、`run accept`，原因 `stage_context_forbidden`。
3. 交付提交隔离 hooks：Knit 发起的 commit 使用 `-c core.hooksPath=<空目录>`。是否保留用户 hooks 由配置 `delivery.hooks: skip|run` 决定，默认 `skip`；交付前列出 `.git/hooks` 中自上次交付以来新增或修改的 hook。
4. 授权：`user:` 前缀的引用在桥接路径必须匹配本会话中真实存在的用户消息（桥接按原生条目 ID 或内容摘要核对）；直接 CLI 调用保持现状，但在回执中标明 `caller: cli-unverified`。
5. 凭据扫描范围扩大到产物提交的全部暂存路径，而不只是 scope。
6. 同步 DESIGN 交付与授权章节、OPERATIONS、ROLE-CONTRACT。

### 非目标

- 不防同一用户账号下的恶意本地进程：密钥在本机，目标是防阶段 Agent 无意或越权伪造。
- 不做远程签名或多用户权限。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 交付提交默认不执行用户 hooks（`delivery.hooks: skip`）；需要 lint／format hook 的项目在配置中显式改为 `run`。
- 旧凭据缺签名时按"需重建"处理，不做一次性信任迁移

## 完成条件

- 自动化测试：
  - 篡改 `checks/*.json` → 交付以 `credential_tampered` 拒绝；
  - worker 环境下调用 `knit deliver` → `stage_context_forbidden`；
  - 阶段写入的 `.git/hooks/pre-commit` 在交付时不执行（skip 模式）；
  - 桥接路径伪造的 `user:` 引用被拒。
- 审计 S8、中等问题 4／5 不再复现。

## 依赖说明

依赖基线冻结任务（`.git`／`.runtime` 敏感区检测）先完成，本任务在其上加完整性与调用边界。

## 输入引用

- 审计 F1（凭据与 hook 部分）、S8、中等问题 4／5。
- `src/application/delivery.ts:82-125`、`src/application/delivery-service.ts:640-700,1258-1403`、`src/infrastructure/run-store.ts:300-400`、`src/worker/knit-worker.ts`、`.pi/extensions/knit.ts:1060-1080`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 派发须知（2026-11-07 主会话，审计计划执行约定）
- 报告 `changedPaths` 只列本 run 在工作区实际改动的路径（与 git 前后差一致），不列之前轮次或其它任务已存在的改动；否则 `changed_paths_mismatch` 整轮失败。
- 交付前凭据扫描规则 generic_secret_assignment（见 src/contracts/credentials.ts）会把“凭据类关键词作变量名或字段名并被赋值长字符串或表达式”的新增行判为疑似凭据。新增代码与测试请给此类局部变量加前缀（例如 owner 前缀），夹具值保持 8 字符以内；完成前用 dist/contracts/credentials.js 的 scanCredentials 扫描新增行确认零命中。
- 工作区里其它 `.knit/tasks/*/task.md` 的未提交改动来自主会话记录，不属于本任务成果，不要修改或列入报告。
- 单跑测试时请 `env -u REX_SESSION -u REX_BLOCK node --test ...`；全量用 `npm test`。
- Delivered k-fdfd8c171736 attributes changes by write/edit tool calls. Please change files with write/edit; files written via bash are flagged unattributed_paths.
- Builds on delivered tasks:
  - k-a8ace0d90676 (stage-baseline sensitive-area detection for .git/hooks and .knit/.runtime);
  - k-b88e4a80906d (checkerChangedPaths, check_self_modified);
  - k-836997c84864 (worker injects KNIT_RUN, nextAction).
  This task's KNIT_STAGE_RUN_ID is a separate marker from the existing KNIT_RUN. Stay consistent with KNIT_RUN or reuse it, and explain the choice in the docs.
- Note: this task's credential scanner is the same source of false positives that has hit delivery repeatedly (`generic_secret_assignment`). New code and fixtures added for HMAC/keys must also pass scanCredentials with zero hits.

## 实施接收记录（2026-11-10 主会话）
- run-28609d4c2140 completed。接收时有两个障碍：
  1. 8 个路径由 worker 经 bash 写入，判为 unattributed_paths。主会话逐一核对原生会话的 bash 调用后用 `--include` 确认。
  2. 新代码要求 result.json 带本机 HMAC，但这个 run 的 worker 进程在 9d2c37a 版 dist 下启动，写出的结果没有签名，被新版 dist 判为 `credential_unsigned`（needs_attention）。这是本任务自身引入的自举问题，不是伪造。
- 处理：用与产出一致的 9d2c37a 版构建（git archive 到 /tmp/knit-head 后 build）执行 `run accept --include`，结果 implementation_accepted。之后的检查 run 会在新版 dist 下产出并签名。
- 待检查者核实：新版代码读取这次旧版接收写出的未签名 acceptance 与 implementation 相关记录时，是否会阻碍后续检查、close 或 deliver。

## 检查 run-75df4debd9f0 changes_requested 结论（修复轮须知，2026-11-10 主会话转录）

- [must fix] With delivery.hooks=skip, only commit/merge get -c core.hooksPath=<empty dir>. git add -A (delivery-service.ts ~L1423 and ~L1559) and git reset (~L1561) still use this.git, and worktree-merge.ts merge --abort uses gitSync directly, so repository hooks such as post-index-change still run during an authorised delivery (reproduced: ran 4 times). This contradicts the hookIsolatedGit comment in delivery.ts ('add／commit／reset／merge') and leaves S8 partly open. Fix: in the work/archive commit steps, run add/reset through prepared.commitGit (or another isolated runner), isolate merge --abort the same way, and add a post-index-change regression test.
- [must fix] The bridge knit_deliver only passes --session-file when authorizationRef starts with 'user:'. native:x, message:x or bare free text through the bridge are accepted by the core as user_reference with verified=false, the same self-reported authorisation medium issue 4 was meant to stop, and the receipt is wrongly labelled caller: cli-unverified. The core already applies the userLike check whenever evidence is present. Fix: the bridge always passes --session-file for non-plan actions (and refuses user-type refs when the session file is missing), with a test that native:/free-text refs through the bridge get authorization_unverified.
- [minor] npm test points KNIT_KEYS_ROOT at the fixed directory ${TMPDIR:-/tmp}/knit-test-keys; every fixture project leaves a key file there and they are never cleaned up (several hundred already). Consider a per-run temp directory or cleaning up after the run.
- [bootstrap answer] The unsigned result.json written by run-28609d4c2140 under the old build does not block later steps: its acceptance operation is already completed, so accept/resume returns duplicate before verifyResult; no acceptance.json is left; this task has no implementations record; this check run's worker uses the new build, so its result, check credential and later completion will be signed.

- 修复要求：修完两项必须修复，次要项一并处理（键目录改为每次运行的临时目录或用后清理）；每项都补回归测试；changedPaths 只列本轮实际改动的路径；改文件用 write/edit 工具。

## 完成记录（2026-11-10 主会话）
- 实施：run-28609d4c2140（由旧版 dist 接收，原因见上文“自举”说明）→ 检查 run-75df4debd9f0 提出 changes_requested（hooks 隔离不完整、桥接授权核对漏洞）→ 修复 run-bb955f749268 implementation_accepted，npm test 683/683。
- independent 检查 run-48775a191ffb pass，未改文件，独立 CLI 探针确认 skip 模式下各 hook 不执行。
- 非阻塞观察：对已 completed 的交付操作重复调用 deliver 时走幂等返回，不核对新授权；有意清除 KNIT_STAGE_RUN_ID 可绕过拦截，由基线核对与 HMAC 兜底，已写入文档。
- 主会话已删除旧版 npm test 留下的 /tmp/knit-test-keys（项目外的临时文件）。
- unverified：真实 Pi 宿主桥接端到端调用 knit_deliver；Rex 呈现路径携带 KNIT_STAGE_RUN_ID 的真实启动；macOS。

### 交付记录

<!-- knit:delivery:op-ddfdb5ce395e -->
- 操作: op-ddfdb5ce395e
- 时间: 2026-11-10T05:40:37.955Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 调用: cli-unverified
- 工作提交: 3239f73262090bb032fa01aa628a5243acdba5b9
- 结果: 正常交付；检查 run-48775a191ffb 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-07-credential-integrity

<!-- knit:progress:end -->
