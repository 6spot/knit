# 子任务清单

主任务 `k-a9c3c3ddec63`。以零 MCP 架构统一支持多宿主主会话接入（`knit init --pi / --agy / --workbuddy`、共用宿主钩子内核、AGY 项目内插件 `.agents/plugins/knit/` 与 WorkBuddy 桌面端适配及 GUI 降级），拆分为 6 个子任务。

| 顺序 | 子任务 | 编号 | 验证 | 前置依赖 | 做完之后有什么不同 |
| --- | --- | --- | --- | --- | --- |
| 1 | [隔离层识别并始终屏蔽项目内 Knit 主会话插件 .agents/plugins/knit](../11-23-agy-isolation-knit-plugin/task.md) | `k-8d2dc8c0ea82` | `independent` | 无 | 含 `.agents/plugins/knit/` 的项目派发 AGY 执行者（含 `tools: all`）不误拒，执行者沙箱始终屏蔽对其读写 |
| 2 | [提供宿主无关的零 MCP 钩子内核与 AGY 协议入口](../11-23-agy-host-hook-handler/task.md) | `k-9c0e2fa7c112` | `independent` | 无 | 新增 `src/application/host-hook.ts` 共用内核（按会话去重注入、任务选择、交付原话授权核对）、`knit hook agy <event>` 入口，以及 `knit run wait --timeout <秒>` |
| 3 | [实测 WorkBuddy 桌面端的项目级 Hook 路径、协议格式、PATH 与后台能力](../11-23-probe-workbuddy-host-hooks/task.md) | `k-fdb8c6110481` | `self` | 无 | 查清本机 `WorkBuddy.app` 真实的项目级 Hook 路径、stdin/stdout 协议、GUI `PATH` 与后台唤醒能力，沉淀研究记录供第 5 项实施 |
| 4 | [改造 knit init 按显式宿主开关注入桥接并生成 AGY 插件模板](../11-23-agy-plugin-template-and-init/task.md) | `k-ea0e6d690522` | `self` | `k-8d2dc8c0ea82`、`k-9c0e2fa7c112` | `knit init` 改为默认只建 `.knit/`，显式传 `--pi` / `--agy` 按需注入桥接；新增 `.agents/plugins/knit/` 模板并补齐 `pack:check` 与 `DESIGN.md` |
| 5 | [实现 WorkBuddy 薄钩子协议入口、--workbuddy 模板与 GUI 降级适配](../11-23-workbuddy-host-bridge/task.md) | `k-eaa1664e9b5f` | `independent` | `k-ea0e6d690522`、`k-fdb8c6110481` | 复用共用钩子内核新增 `knit hook workbuddy <event>`、`knit init --workbuddy` 模板与 GUI 降级适配（`PATH` 引导、不覆盖 `KNIT_SESSION_AGENT`、下轮自动注入与短等策略） |
| 6 | [实机验收 AGY 与 WorkBuddy 主会话免关键词自动注入并同步安装版](../11-23-verify-agy-main-session/task.md) | `k-e72b44a67da7` | `self` | `k-eaa1664e9b5f` | 经单独授权后用真实 `agy 1.5.13` 与 `WorkBuddy.app` 完成实机闭环验收，并升级本机全局安装版与本仓库副本 |

## 依赖与执行约定

- 第 1、2、3 项改动文件互不重叠，可并行推进；第 4 项依赖第 1、2 项；第 5 项依赖第 3（探针结论）与第 4 项；第 6 项在全部代码落地后统一做需单独授权的实机验收与全局安装同步。
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及流程引用的 `.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，模板改动一律写入 `assets/templates/`。
- 每个代码子任务完成后在 macOS 普通终端与 Rex 终端各跑一次 `npm test`，并运行 `npm run typecheck`。
