---
id: k-e72b44a67da7
title: 实机验收 AGY 与 WorkBuddy 主会话免关键词自动注入并同步安装版
status: delivered
stage: null
verification: self
parent: k-a9c3c3ddec63
dependsOn:
  - k-eaa1664e9b5f
priority: P2
createdAt: 2026-11-22T16:08:53.243Z
---

## 目标与范围

在前置 5 个子任务全部交付合并后，经用户明确授权，用本机真实 `agy 1.5.13` 与 `WorkBuddy.app` 完成零 MCP 多宿主主会话免关键词自动注入、交付授权拦截与后台派发执行者闭环的实机验收，并升级全局安装版及本仓库副本：

1. **真实 `agy 1.5.13` 主会话实机闭环验收（需用户单独授权调用真实模型）**：
   - 在临时隔离 Git 夹具运行 `knit init --agy` 生成 `.agents/plugins/knit/`；
   - 启动真实 `agy 1.5.13` 主会话发送**不含任何 “knit” 关键词**的需求消息，验证自动注入 `discuss` 规范、不变轮次去重跳过、选中任务自动更新注入、无原话授权 `knit deliver` 被拒、有原话授权放行，以及在该项目中照常派发 AGY 执行者（含 `tools: all`）且执行者沙箱看不到主会话插件；证据记入 `validation/multi-host-main-session/`。
2. **真实 `WorkBuddy.app` 桌面端实机闭环验收（需用户单独授权调用真实模型）**：
   - 在临时隔离 Git 夹具运行 `knit init --workbuddy` 生成 WorkBuddy 桥接；
   - 在本机 `WorkBuddy.app` 打开该夹具验证：免关键词自动注入、不变去重、交付原话授权拦截、通过 Bash 派发 `knit run start` 后台执行者（Pi／AGY 无 Rex 窗格自动降级后台执行）及完成后下轮自动获取状态；证据记入 `validation/multi-host-main-session/`。
3. **升级全局安装版与同步本仓库副本（需用户单独授权全局安装）**：
   - 运行 `npm run pack:install` 升级全局 `knit` 并清理根目录 `.tgz`；
   - 按需运行 `knit init --force --pi --agy`（或用户指定的宿主组合）同步本仓库桥接副本并从备份恢复 `.knit/workflow.yaml`；
   - 核对全局 `dist/` 与工作区 `dist/` 及各模板副本一致，并运行双终端 `npm test`。

边界：
- 调用真实模型与运行 `npm run pack:install`／`knit init --force` 均须在用户明确授权后执行。
- 实机验收在临时隔离夹具完成，不污染本仓库工作区与历史；本仓库既有的未提交配置（如 `.knit/workflow.yaml`、`.knit/standards/pitfalls-worker.md`）按用户意愿保留，不擅自丢弃。

## 完成条件

### Requirement: 真实 AGY 与 WorkBuddy 主会话免关键词自动注入、授权门禁与后台派发闭环通过

#### Scenario: 两个真实宿主在隔离夹具中跑通自动注入、去重、授权拦截与后台派发

- GIVEN 用户已明确授权调用真实模型，且临时夹具分别经 `knit init --agy` 与 `knit init --workbuddy` 初始化
- WHEN 分别在真实 `agy 1.5.13` 与 `WorkBuddy.app` 中发送无关键词消息、切换任务、核验无/有原话交付授权，并后台派发执行者
- THEN 两个宿主均免关键词收到 `discuss` 规范且不变轮次不重复注入，无原话授权的 `knit deliver` 被拒绝、有原话时放行，AGY 执行者沙箱隔离看不到 `.agents/plugins/knit/`，WorkBuddy 桌面端能正常后台派发并在完成后获知状态，完整证据保存在 `validation/multi-host-main-session/`

### Requirement: 全局安装版与本仓库宿主桥接副本同步完成

#### Scenario: 升级全局安装版并同步本仓库指定宿主副本后双终端测试全绿

- GIVEN 用户已明确授权升级全局安装版与同步本仓库副本
- WHEN 执行 `npm run pack:install`、清理 `.tgz`、按用户确认的宿主开关运行 `knit init --force`（并恢复 `.knit/workflow.yaml`）
- THEN 全局 `dist/` 与工作区 `dist/` 一致，本仓库生成的桥接副本与 `assets/templates/` 逐字一致，macOS 普通终端与 Rex 终端 `npm test` 均通过

## 待澄清

- [resolved] 用户已在会话中明确全权授权执行本任务含真实 `agy` 模型实机验收、全局打包安装（`npm run pack:install`）与按 `--pi --agy` 同步本仓库桥接副本（「我全权授权给你派发去执行，我要睡了，等明天起来我看你最终的结果成品」）。WorkBuddy 桌面端 GUI 窗口人工点击部分若无头环境无法真实点击，按事实在报告与提交信息中标明「未核实」，不伪造实机点击结果。

## 相关资料

- `assets/templates/` — Pi、AGY、WorkBuddy 桥接模板来源
- `scripts/pack-install.mjs` — 全局打包安装脚本
- `validation/` — 实机验收记录目录
- `docs/design/DESIGN.md#10-用-knit-开发-knit` — 安装版升级与模板重新生成规范

## 结果

已完成全局安装版升级（knit 0.1.0）、本仓库 --pi --agy 桥接同步（保留未提交的 .knit/workflow.yaml 与 .knit/standards/pitfalls-worker.md）及实机验收：真实 agy 1.5.13 验收中发现并修复 PreToolUse 放行缺少必填 decision 导致误拒的问题（改为 { decision: "allow" }，已实机核实不绕过 permissions.deny 并重装全局版），完整跑通 6 轮无关键词自动注入、不变去重、选任务刷新、未授权交付拦截、原话授权放行交付与真实 AGY 执行者沙箱隔离（read_file 与 run_command 均 EPERM）；在模拟 WorkBuddy GUI 极简 PATH + Node 22.22.2 环境下核通已安装 .workbuddy/knit-hook.sh 全事件链路，并将未实机点击 WorkBuddy GUI 窗口的 3 项如实记入 validation/multi-host-main-session/README.md；修复后 typecheck、pack:check 与双终端 npm test（489 通过、0 失败、7 跨文件系统跳过）全绿。
