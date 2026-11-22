---
id: k-eb039beccd06
title: 实测 Antigravity CLI 的工具边界与原会话补报
status: delivered
stage: null
verification: self
parent: k-b2ac5d4c4c11
dependsOn: []
priority: P2
createdAt: 2026-11-21T10:52:18.334Z
---

## 目标与范围

用本机 Rex、`agy` 1.5.13 和真实模型核实接入所需的工具边界与同会话补报。获得调用真实模型的单独授权后，在临时 Git 仓库及其任务 Worktree 中实验，使用隔离的测试权限配置。结论用来确定正式适配器能承诺的权限与报告处理行为。

交付任务目录内的 `research/agy-feasibility.md`。记录客户端版本、复现所需的配置与步骤、脱敏后的钩子事件或后台回执，以及每项能力的实测结果和证据。观察到的限制或未验证的行为写明原因和对接入范围的影响。

## 完成条件

### Requirement: 确认 Antigravity CLI 能落实任务需要的权限与报告交互

#### Scenario: 交互与后台遵守会话级工具限制

- GIVEN 临时仓库的任务 Worktree、主检出和另一个临时目录，以及可控的用户与项目权限配置
- WHEN 分别以 `tools: []`、`tools: [read]`、`tools: [read, write, exec]` 对应的会话配置运行交互与后台实验
- THEN 记录 `--settings` 与其它权限来源的实际优先级、原生审批的作用，以及未声明能力是否被拒绝。验证允许时能在 Worktree 里读写和执行，原生写入与通过命令写入都受到 Worktree 边界约束
- AND 用受控的测试操作验证 `external`、`network` 缺席时的限制，记录后台拒绝信号，包括可取得的 `denied_actions` 及其退出或结果状态

#### Scenario: 在 Rex 原会话识别报告并补报

- GIVEN `agy` 在真实 Rex 窗格里原生交互，任务要求带固定字段的报告
- WHEN 执行者等待用户输入、遇到权限阻塞、提交不合格报告并收到补报要求
- THEN 记录 `Stop`、`fullyIdle`、`terminationReason` 和 `transcriptPath` 能否区分这些状态、取得报告文本，以及是否可以在原会话补报一次并取得合格报告。用会话标识与事件或转录证明补报属于同一会话

## 待澄清

## 相关资料

- 已有 `agy` 1.5.13 本机实验记录显示，后台使用 `--input-format stream-json --output-format stream-json` 可在一个进程中完成两轮，`conversation_id` 相同。工具审批被拒时，结果可能仍为 `SUCCESS`，并附 `denied_actions`。
- CLI 文档把 `fullyIdle`、`terminationReason` 和 `transcriptPath` 列为 `Stop` 事件的字段。权限文档与沙箱文档用于定位会话设置和命令限制，实际生效结果按本任务的 1.5.13 实测记录。[Stop 钩子](https://antigravity.google/docs/hooks/) · [CLI 权限](https://antigravity.google/docs/permissions?tab=cli) · [CLI 沙箱](https://antigravity.google/docs/sandbox?tab=cli)

## 结果

在本机 macOS、Rex 和 agy 1.5.13 用真实模型完成两项可行性实验，配置、步骤和脱敏回执见 [实测报告](research/agy-feasibility.md)。模型复验退出 0。三组权限和审批均取得工具结果，实测配置无法保证 Worktree 写入边界与全部网络和外部工具限制，具体阻塞已记入父任务。Rex Stop 在同一会话和转录中记录了两次执行，第二份报告经 Knit 校验得到 pass。
