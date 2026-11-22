---
id: k-a9c3c3ddec63
title: 支持多宿主零 MCP 主会话接入：按需 init、AGY 插件与 WorkBuddy 适配（主任务）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-22T16:08:52.808Z
---

## 目标与范围

这是主任务，用于在**零 MCP、无常驻进程**的前提下，让 Knit 统一支持 **Pi、Antigravity（`agy`）与 WorkBuddy** 三个主会话宿主，解决「免关键词自动注入 Knit 上下文、按需初始化不污染仓库、交付原话授权核对、以及 WorkBuddy 桌面 GUI 环境派发 Pi/AGY 执行者的平滑降级」。

已与用户确认的核心架构决策：

1. **零 MCP、共用宿主钩子内核 + 薄协议翻译层**：
   - 将会话状态（`.knit/.runtime/host-sessions/`）、内容 SHA-256 去重注入、轻量任务选择、交付原话授权核对集中在宿主无关的 `src/application/host-hook.ts` 中；
   - 各宿主只保留薄协议入口（`knit hook agy <event>`、`knit hook workbuddy <event>`），避免多宿主逻辑复制，后续扩展 Claude Code / CodeBuddy 也可直接复用。
2. **`knit init` 显式按宿主开关注入桥接**：
   - `knit init` 不带宿主开关时只初始化项目核心 `.knit/`，不再默认生成特定客户端目录；
   - 显式传布尔开关（`--pi`、`--agy`、`--workbuddy`，支持任意组合如 `knit init --pi --agy`）才生成对应宿主桥接；`knit init --force` 仅恢复核心模板及本次指定或项目内已存在的桥接副本。
3. **AGY 项目内插件 `.agents/plugins/knit/` 与执行者零冲突**：
   - 主会话插件放 `.agents/plugins/knit/`（不占根目录 `.agents/hooks.json`），隔离层始终屏蔽执行者对其读写（含 `tools: all`）。
4. **WorkBuddy 仅作主会话宿主 + 桌面 GUI 降级策略**：
   - WorkBuddy 桌面端通过内置 Bash 调用 `knit run start` 后台派发独立 `detached` worker 运行 Pi（RPC）和 AGY（stream-json），天然降级为无 Rex 窗格的后台执行；
   - 先做前置实测探针（`k-fdb8c6110481`）查清项目级 Hook 发现路径、stdin/stdout 协议、`PATH` 继承和后台任务唤醒能力，再针对极简 GUI `PATH`、不设 `KNIT_SESSION_AGENT=workbuddy`、以及不支持后台唤醒时降级为「`run start` 立即返回 + 下轮 `UserPromptSubmit` 钩子自动注入最新状态 + `run wait --timeout`」完成落地。

子任务拆解与顺序见 `.knit/tasks/11-23-agy-main-session-plugin/plan.md`（共 6 个子任务）。

不在本主任务范围内：构建 MCP Server、常驻后台守护进程、或把 WorkBuddy 接入为工作流执行者（Worker）。

## 完成条件

### Requirement: 多宿主零 MCP 主会话接入全部子任务交付且验证通过

#### Scenario: 6 个子任务按依赖顺序完成交付与实机验收

- GIVEN `.knit/tasks/11-23-agy-main-session-plugin/plan.md` 列出的 6 个子任务
- WHEN 各子任务按依赖顺序完成调研、实现、审查与交付，且主任务汇总各子任务的提交与验收证据
- THEN 6 个子任务全部处于 `delivered`（或经用户决定 `cancelled`），主任务自身无代码改动
- AND 在 macOS 普通终端与 Rex 终端运行 `npm test` 全部通过，`npm run typecheck` 与 `npm run pack:check` 均通过

## 待澄清

## 相关资料

- `.knit/tasks/11-23-agy-main-session-plugin/plan.md` — 6 个子任务的拆解、并行关系与验证约定
- `src/adapters/antigravity/isolation.ts` — AGY 执行者预检与 `sandbox-exec` 隔离规则
- `src/application/init.ts` — `knit init` 模板生成与覆盖备份逻辑
- `assets/templates/pi/extensions/knit.ts` — Pi 主会话桥接实现（授权原话匹配与上下文注入参考）
- `docs/design/DESIGN.md` — 现行设计文档（第 2、5、7.4、9 节）

## 结果

全部 6 个子任务均按依赖顺序完成调研、实现、独立审查与交付合并到 main（1ee2457、f94ce49/3756512、d7184e2/3c235a9、a6fde05、9e18f68、10e64f5），主任务无代码改动。已升级本机全局 knit 0.1.0 并同步本仓库 --pi --agy 桥接，真实 agy 1.5.13 6 轮主会话闭环与执行者沙箱隔离实测通过，WorkBuddy 桥接在模拟 GUI 极简 PATH + Node 22.22.2 下验证通过（真实 WorkBuddy.app 窗口交互项已如实标注未核实）。全量 typecheck、pack:check 与 Rex/普通 macOS 双终端 npm test 全绿。
