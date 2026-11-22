---
id: k-23245e3928c9
title: 实机验收 Pi 实现、Antigravity CLI 审查和主会话唤醒
status: delivered
stage: null
verification: self
parent: k-b2ac5d4c4c11
dependsOn:
  - k-8f2a69252930
priority: P2
createdAt: 2026-11-22T03:44:42.687Z
---

## 目标与范围

在 macOS 的 Rex 中用接入提交 `a1fecbb` 的安装包跑一次两环节工作流。原 Pi 主会话派发 Pi 实现和 Antigravity CLI 审查。审查使用 `agent: antigravity` 与 `tools: [read, write, exec]`。在临时 Git 仓库用求和函数和本地测试作为验收输入。Pi 使用现有的 `magpie/remote/codex/gpt-6.2-sol` 通道。审查环节显式选择 `gemini-3.8-flash-low`（Gemini 3.8 Flash Low），与前期审批和补报的实测型号一致。

前期实测和接入独立审查已覆盖后台回退、主动取消、关窗与未声明联网时的限制。显式声明 `external` 或 `network` 后的放行实测继续延后。

## 完成条件

### Requirement: Rex 中完成 Pi 实现、Antigravity 审查与原 Pi 主会话续跑

#### Scenario: 在同一任务 Worktree 完成实现与审查

- GIVEN Rex 中的 Pi 主会话启动临时仓库的任务，工作流实现环节用 Pi、审查环节用 `agy`
- WHEN Pi 实现完成后，原主会话派发审查并结束当轮，审查者读取实现报告与实现改动
- THEN 审查在同一 Worktree 进行。等待时执行保持进行中，Rex 窗格接受追加的「开始验证」并显示原命令 `node --test total.test.mjs` 的原生审批。批准后本地测试执行，审查者将结果写入 Worktree
- AND 首次报告按夹具要求省略 verdict，Knit 在同一 `agy` 会话发起一次补报。完整报告和实际 verdict 通过校验并入账

#### Scenario: 审查入账后自动唤醒原 Pi 主会话

- GIVEN 原 Pi 主会话已空闲，Rex 审查报告及终态即将入账
- WHEN Knit 结算审查
- THEN 原 Pi 会话收到一条包含实际 Agent 和结果的结束通知，在无人输入的情况下开启新一轮，读取审查报告并按结论继续处理任务
- AND 验收记录包含执行与会话标识、Worktree、审批与补报、报告、`run status`、结束通知以及新一轮的处理证据

## 待澄清

## 准备记录

用户已授权在临时仓库调用已配置的真实 Pi 和 `agy` 模型完成本轮验收。

提交 `a1fecbb` 用 `npm run pack:install -- --prefix` 离线安装，最终复验把下列两项修复叠加到同一源码基线并隔离打包安装。临时 Git 夹具使用工作流基线 `3b02c4c`。该工作流通过 `knit workflow validate`，`agy` 1.5.13 的系统沙箱及 `exec` 所需命令进程跟踪器均通过派发前检查。

## 实机验收记录

夹具 `k-a618bffa669f` 的 Pi 实现 `r-8d4fd37949f8` 和 AGY 审查 `r-feebf05976e6` 在同一 Worktree 运行。AGY 收到「开始验证」后，Rex 原生审批显示 `node --test total.test.mjs` 和 `review-result.md` 的创建请求。两次均为一次性批准，测试通过。

Knit 在同一 AGY 会话补收 `pass` 并清理生成的钩子文件。原 Pi 主会话收到一条标注 `Agent: antigravity` 和 `pass` 的结束通知，自动读取报告并将夹具记为完成。[会话时间线、审批、报告与状态输出](evidence.md)

## 实机发现与修正

1. 首次夹具遗漏 Rex CLI 的 PATH，实际回退到后台。修正专用会话的 PATH 后，Pi 与 AGY 均进入真实 Rex 窗格。
2. `agy` 1.5.13 忽略指向 Worktree 外的钩子链接，接入原版启动日志为 0 个钩子文件。无模型输入的启动对照确认普通钩子文件可以发现。改为在 Worktree 排他创建普通钩子文件，结算时只删除与本次生成内容相同的文件。
3. `agy` 获批后未执行带引号的转发命令。Rex 对照确认无需引号的命令可以正常转发。临时目录中的固定入口由系统沙箱保护，入口在内部处理 Node 和安装路径的引号。原命令继续通过一次性请求进入独立命令进程。

## 回归验证

最终 `npm test` 在 macOS 的普通终端与 Rex 各跑一次，各通过 402 项，0 失败、0 跳过，包含跨文件系统用例。测试夹具按 AGY 的文件发现规则读取钩子，并检查原命令审批和临时入口的权限。[全量测试输出](evidence.md#全量回归输出)

类型检查、打包检查及差异检查通过。隔离夹具确认沙箱阻止修改转发入口，安装路径含空格和单引号时仍能正常转发。

## 相关资料

- 父任务 `k-b2ac5d4c4c11`
- 接入任务 `k-8f2a69252930`，提交 `a1fecbb`
- 接入独立审查 `r-7c996cd5a2f1`，结论 `pass`

## 结果

实机复验通过。Pi 在 Rex 实现并自动派发 Gemini 3.8 Flash (Low) 的 Antigravity 审查。同一 Worktree 的原生命令及写入审批分别获批，测试通过。AGY 在原会话补交 pass，结算后原 Pi 主会话收到一条结束通知并自动读取报告、将夹具记为完成。修复 AGY 忽略外部钩子链接、获批后未执行带引号的转发命令两项问题。普通终端和 Rex 全量回归各 402 项通过，0 失败、0 跳过。类型检查、打包检查和含空格及单引号的转发入口夹具通过。
