---
id: k-19da925fecc2
title: 提取 Knit 共用执行流程并保持 Pi 现有行为
status: delivered
stage: null
verification: independent
parent: k-b2ac5d4c4c11
dependsOn: []
priority: P2
createdAt: 2026-11-21T10:52:15.037Z
---

## 目标与范围

让现有 Pi 执行使用 Knit 的共用流程，为后续 Agent 接入提供同一个入口。派发准备、Worktree 与任务交接、窗格管理与后台回退、进程跟踪与取消、报告校验和一次补报、执行结算与等待结果由 Knit 共用。Pi 适配器处理客户端启动、参数与权限映射、原生会话和报告采集，通过适配接口提供启动状态、结果、会话记录和失败原因，并在原会话中补报或停止执行。

沿用 Pi 当前的模型与思考等级优先级、角色提示、工具能力、工作流配置和执行记录格式。工作流环节选择 Agent 与新增执行记录字段由后续接入任务交付。验证结果与实现一同交回，独立审查核对窗格和后台执行确实共用上述流程。

## 完成条件

### Requirement: Pi 通过共用流程执行并保留现有交互

#### Scenario: 现有 Pi 派发在 Rex 和后台完成

- GIVEN 原有工作流使用 Pi，主会话位于 Rex 或普通终端
- WHEN 主会话派发环节并结束当前轮次
- THEN Pi 按原有优先级取得模型与思考等级，在任务 Worktree 里执行。Rex 窗格可用时在窗格里运行，窗格启动失败或普通终端派发时由 Pi 在后台执行
- AND 报告与执行终态入账后，`run status`、`run wait` 取得结果。Pi 桥接向发起派发的会话发送一条 `knit.run-ended`，空闲时触发新一轮，正在执行时排到当前轮结束后投递

#### Scenario: 窗格交互与报告补报沿用原会话

- GIVEN Pi 正在 Rex 窗格执行
- WHEN 用户暂停后继续输入，或报告校验失败需要补报
- THEN 执行在原会话继续，补报一次且校验通过后才记成功，补报仍不合格时记录失败原因。Pi 的后台报告复用同一套校验与补报规则

#### Scenario: 取消执行并结束等待

- GIVEN Pi 执行者在 Rex 窗格或后台运行
- WHEN 主会话主动取消
- THEN 执行者及其子进程停止，执行记录和状态反映取消。取消结果随工具返回，桥接结束对此次执行的等待

在 macOS 的 Rex 与普通终端各跑一次 `npm test`。用现有模拟客户端检查窗格、取消、报告补报、执行等待与通知。通知回归断言终态入账后桥接以 `followUp` 和 `triggerTurn: true` 发送结果。

## 待澄清

## 相关资料

- 现行派发、Worktree 和结束通知设计见 `docs/design/DESIGN.md`。
- 现有回归见 `test/run-pane.test.mjs`、`test/run-cancel.test.mjs`、`test/run-wait.test.mjs`、`test/bridge-notice.test.mjs`。

## 结果

已提取 Knit 共用执行流程。后台和 Pi 窗格复用报告保存、校验、原会话补报一次和结算。派发、Worktree、窗格回退、进程跟踪与取消、等待执行结果由 Knit 管理。Pi 适配器处理启动、能力映射和原生会话。通知回归确认执行终态入账后向原 Pi 会话发送一次带 `followUp` 和 `triggerTurn: true` 的消息。

实现 `r-07285b6e5c0d` 正常结束，独立审查 `r-c3f33c72e80c` 对三个场景验证通过，结论为 `pass`。最终版本在 macOS Rex 环境和非 Rex 独立 PTY 中分别通过全量 `npm test`，每次 383 项中 376 通过、0 失败、7 项跨文件系统测试因缺少夹具跳过。`npm run typecheck` 与 `git diff --check` 通过。窗格补报和主会话唤醒使用模拟客户端回归。
