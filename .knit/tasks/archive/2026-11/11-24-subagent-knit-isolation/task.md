---
id: k-7124ad6183cf
title: 防止子 Agent 重复加载 Knit 桥接与重复拼接上下文
status: delivered
stage: null
verification: independent
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-24T13:50:00.037Z
---

## 目标与范围

防止 Knit 派发的 Pi 执行者重复加载主会话 Knit 桥接，避免执行者在收到完整交接后再次触发 `knit` 并把主会话上下文重复拼进系统提示，也避免向执行者暴露主会话工具。

- **修复范围（仅 Pi 执行者）**：
  - 当 Pi 环节的 `tools` 含 `external`、写 `all` 或省略（`capabilities === null`）时，Pi 启动参数不传 `--no-extensions`，会自动发现并加载 Worktree 中的 `.pi/extensions/knit.ts`，从而注册 `knit_task`/`knit_run`/`knit_deliver` 并在每轮 `before_agent_start` 调用 `knit context` 注入主会话 `discuss` 规范、避坑清单和无任务指引，与 `system.md` 叠加冲突。
  - 在 Pi 执行者的后台 RPC 环境（`isolatedEnv`）和 Rex 窗格启动命令（`interactivePiCommand`）中注入显式的执行者标识环境变量，并在桥接模板 `assets/templates/pi/extensions/knit.ts` 入口检测该标识，命中时直接退出（不注册三个 Knit 工具，不挂载 `before_agent_start`、`tool_call`、`session_shutdown`）。
  - 注意嵌套环境：本任务的执行者本身就运行在 Pi 执行者环境中，运行 `npm test` 时进程环境里可能已经带着该执行者标识；既有桥接测试（如 `test/bridge.test.mjs` 等）需确保“普通主会话”用例显式隔离该环境变量，避免在 Pi 执行者内跑全量测试时误跳过桥接初始化。
  - 归属模块与既有测试：`src/adapters/pi/runtime.ts`、`assets/templates/pi/extensions/knit.ts`，同步更新设计文档 `docs/design/DESIGN.md` 第 5/7 节对应说明；测试优先追加到既有 `test/pi-runtime.test.mjs` 和 `test/bridge.test.mjs`，不另起碎片测试文件。
- **不包含与延后**：
  - Antigravity 执行者（`agent: antigravity`）已通过两层 `sandbox-exec` 在所有 `tools` 组合下无条件屏蔽 `.agents/plugins/knit` 读写，本次不改动其隔离逻辑。
  - Antigravity（`invoke_subagent`）与 WorkBuddy 原生子 Agent 的主会话钩子行为调研与过滤延后，不在本次范围内。
  - 全局安装升级（`npm run pack:install`）与本仓库 `.pi/extensions/knit.ts` 副本同步（`knit init --force`）留待交付后按用户授权单独操作，本次只改模板源文件与源码。

## 完成条件

### Requirement: Pi 执行者在开放扩展能力时不加载主会话 Knit 桥接

#### Scenario: 后台 RPC 与 Rex 窗格启动 Pi 执行者时携带执行者标识

- GIVEN Pi 环节配置为 `tools: [read, write, exec, external]`、`tools: all` 或省略 `tools`
- WHEN 构造 Pi 后台执行环境（`isolatedEnv`）与 Rex 窗格命令（`interactivePiCommand`）
- THEN 两条启动路径均注入统一的 Knit 执行者标识环境变量；同时保持既有 `--no-extensions` 等能力开关与主会话私有变量清理行为不变

#### Scenario: Knit Pi 桥接在执行者环境下跳过初始化

- GIVEN `assets/templates/pi/extensions/knit.ts` 在带有该执行者标识的环境中被 Pi 加载
- WHEN 执行桥接入口函数 `knitBridge(pi)`
- THEN 不注册 `knit_task`、`knit_run`、`knit_deliver` 工具，不注册 `before_agent_start`、`tool_call`、`session_shutdown` 钩子，不调用 `knit context`，也不向 `systemPromptOptions.sections.knit` 注入任何内容

#### Scenario: 普通主会话加载 Pi 桥接不受影响

- GIVEN 未设置该执行者标识的正常 Pi 主会话环境（即使外层运行测试的进程自身带有该标识）
- WHEN 加载并运行 `assets/templates/pi/extensions/knit.ts`
- THEN 三个 Knit 工具与每轮上下文注入、交付授权核对均保持原有行为；`npm run typecheck`、`npm run pack:check` 与 `npm test`（Rex 与普通终端各一次）全部通过

## 待澄清

无。

## 相关资料

- `src/adapters/pi/runtime.ts` — Pi 后台与窗格的环境变量隔离及参数构造（`isolatedEnv`、`interactivePiCommand`、`buildPiArgs`）
- `assets/templates/pi/extensions/knit.ts` — Pi 主会话桥接模板源文件
- `src/adapters/antigravity/isolation.ts` — Antigravity 执行者屏蔽 `.agents/plugins/knit` 的现行隔离参考
- `test/pi-runtime.test.mjs` — 既有 Pi 运行时与启动参数测试，优先在此追加用例
- `test/bridge.test.mjs` — 既有 Pi 桥接测试，优先在此追加执行者标识跳过用例
- `docs/design/DESIGN.md#7-执行` — 执行与工具隔离设计说明

## 结果

在 Pi 执行者的后台 RPC（isolatedEnv / PiAgentRuntime）与 Rex 窗格（interactivePiCommand）启动环境中统一注入 KNIT_PI_EXECUTOR=1，并在桥接模板 assets/templates/pi/extensions/knit.ts 入口检测该标识直接返回，避免开放 external/all 或省略 tools 时重复加载主会话 Knit 桥接、注入 discuss 上下文或暴露主会话工具；同步更新 docs/design/DESIGN.md 第 5、7 节及既有测试（test/pi-runtime.test.mjs、test/bridge.test.mjs、test/helpers/bridge.mjs）。三个完成场景均通过独立审查 r-5b5f03877c35（pass）。验证：npm run typecheck、npm run pack:check、git diff --check 均通过；Rex 窗格（带 KNIT_PI_EXECUTOR=1）与清除 Rex 变量的独立终端各运行一次 npm test，均为 508/508 通过、0 失败、0 跳过。未验证/留待后续：全局安装升级（npm run pack:install）与本仓库 .pi/extensions/knit.ts 副本同步（knit init --force）留待交付后按用户授权单独处理；真实 Pi 在 external 模式下端到端启动未另跑真实模型，Antigravity/WorkBuddy 原生子 Agent 钩子调研延后。
