---
id: k-fd956a1c3dc0
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P1
dependsOn: []
order: 10
createdAt: 2026-11-07T11:44:06.642Z
title: macOS 测试全绿与 CLI 参数一致性
---

# macOS 测试全绿与 CLI 参数一致性

## 目标与边界

### 背景与问题

开发机是 macOS，但 `npm test` 在 macOS 上有 7 个失败（585 个中 578 通过）：

- host-selection：`execution.host=auto` 时期望 rex，实得 local；
- pi-runtime：killProcessGroup 抛 `kill EPERM`；
- rex：bridge.sock 路径过长，`listen EINVAL`；
- worker-extension 2 个；
- `task adopt frontmatter 已绑当前分支但绑定行缺失`；
- worktree connect 与 `/private` 路径相关。

CLI 参数也不一致：`locks` 不接受 `--dir`；`resume` 与 `run resume` 两个入口；`cancel` 对已终态 run 返回 `requested: false / already_terminal`，语义含糊。

### 交付范围

1. 逐个定位 7 个失败，分为"测试依赖环境"与"产品缺陷"两类：
   - 前者让测试与环境无关（例如测试中清除 `REX_*`／`TERM_PROGRAM`，socket 改放到短路径的临时目录）；
   - 后者修复产品（如 `/private` 符号链接下的路径规范化、进程组信号的 EPERM 处理）。
2. Rex socket：路径超过平台上限（macOS 104 字节）时改用 `$TMPDIR` 下的短路径并在 rex.json 记录。
3. CLI 一致性：
   - `locks --dir`（若锁任务已处理则跳过）；
   - `run resume` 与顶层 `resume` 共用一个实现；
   - `cancel` 对已终态 run 返回 `requested: false, reason: already_terminal`，人读输出写"run 已结束，无需取消"。
4. 在 TECHNOLOGY／AGENTS 中写清 macOS 的支持级别：开发环境测试必须通过，真机验收仍延期。

### 非目标

- 不做 macOS 安装或发布验收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 无额外取舍；按交付范围执行。

## 完成条件

- macOS 上 `npm test` 全绿（在 Rex 终端和普通终端各跑一次）；Linux CI 测试不回退。

## 输入引用

- 审计中等问题 7、8；`/tmp/knit-test.log` 中的失败用例名（审计时记录）。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
