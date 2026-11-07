---
id: k-28296c22647a
status: open
stage: start
outcome: null
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

<!-- knit:progress:end -->
