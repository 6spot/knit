---
id: k-e8f223bea531
title: 全局安装新版 Knit、刷新本仓库副本并完成双终端验收
status: delivered
stage: null
verification: none
parent: k-8d244665f694
dependsOn:
  - k-223a8907d4e5
  - k-f331f86e46a8
priority: P2
createdAt: 2026-11-27T13:37:26.823Z
---

## 目标与范围

在前置 11 个子任务全部交付并合并进 `main` 之后，将新版 Knit 打包安装到全局位置，刷新本仓库受管模板与桥接副本，恢复本仓库定制的模型配置，并在 Rex 终端与普通终端完成双终端全量验收。

### 前置条件与授权约束

- 须等待依赖任务 `k-223a8907d4e5` 与 `k-f331f86e46a8`（及其全部上游子任务）完成交付并合并进主检出 `main`。
- 全局安装（`npm run pack:install`）与刷新本仓库副本属于独立授权操作，**动手执行前须先取得用户明确授权**。

### 执行步骤

1. 在主检出运行 `npm run pack:check` 核对打包清单、执行位与禁用文件检查。
2. 取得用户授权后运行 `npm run pack:install`，校验全局 `knit --version` 与安装入口。
3. 运行 `knit init --force` 刷新本仓库的流程、角色文件与各宿主桥接副本，核对 `.knit/.runtime/backups/<时间>/` 中的备份并将本仓库定制的 `.knit/workflow.yaml` 模型与思考等级配置恢复到位。
4. 运行 `knit workflow validate --env` 与 `knit task list --archive --limit 5`，确认环境就绪且归档列表零报错。
5. 分别在 **Rex 终端** 与 **普通终端** 各运行一次全量 `npm test`，核实全部用例通过（记录实际通过数、跳过数与耗时），再按交付规范请用户授权收尾交付。

## 完成条件

- `npm run pack:check` 通过。
- 全局 `npm run pack:install` 成功，全局 `knit --version` 与 `package.json` 一致。
- 本仓库受管桥接与模板副本已刷新，`.knit/workflow.yaml` 本仓库定制模型配置已恢复且 `knit workflow validate --env` 通过。
- `knit task list --archive --limit 5` 零报错。
- Rex 终端与普通终端两次全量 `npm test` 均 0 失败（按实际输出如实记录通过数与跳过数）。

## 待澄清

## 相关资料

- `AGENTS.md` — 本仓库全局安装、`knit init --force` 备份恢复与双终端验收规范
- `docs/design/DESIGN.md` — 第 10 节「用 Knit 开发 Knit」
- `scripts/pack-check.mjs` — 打包校验脚本
- `scripts/pack-install.mjs` — 打包与全局安装脚本
- `.knit/workflow.yaml` — 本仓库定制工作流与模型配置

## 结果

主检出通过 npm run pack:check 与 npm run pack:install。全局 Knit 0.1.0 安装入口指向 Node 26.3.0 的全局包，清单中全部 77 个文件和本地构建逐字节相符。用户单独授权后执行 knit init --force，刷新两份角色、Pi 桥接及 Antigravity 规则，从 .knit/.runtime/backups/20261128-080217-454/ 恢复项目定制工作流，恢复前后 SHA-256 均为 a5b9a7741ef8293c0693b5c863e2888aec9290c26cabdf8c5ea0459048934ee7。PATH 中 agy 1.5.16 被隔离版本检查拒绝，指定审查使用的 KNIT_AGY_BIN（Antigravity 1.5.13）后 knit workflow validate --env 通过。knit task list --archive --limit 5 与完整归档列表均退出 0，stderr 为空。普通终端首轮的 1 项超时触发原子写入 Rex 中止测试的 PID 文件（k-226088480237），独立审查通过后交付为 bf2108e，仅修测试夹具。该提交上两种终端均使用独立的第二卷。Rex 671/671（36.84 秒），普通终端 671/671（36.64 秒），均为 0 失败、0 取消、0 跳过。全量日志和预检结果见 .knit/.runtime/install-accept-j3nq2p1i/。
