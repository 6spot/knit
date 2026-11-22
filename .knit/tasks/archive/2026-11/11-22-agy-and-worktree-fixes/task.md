---
id: k-cdf8de80d14c
title: 修复 Antigravity 适配器边界与 Worktree 任务冲突（主任务）
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-22T05:40:36.186Z
---

## 目标与范围

这是主任务，汇总当前项目在架构契约、Antigravity（`agy`）适配器实现、Worktree 未合并分支安全与本仓库工程同步方面的缺陷修复方案与子任务清单。主任务不直接产出代码，具体实现与验证由子任务分别交付。子任务拆解与顺序见 `.knit/tasks/11-22-agy-and-worktree-fixes/plan.md`。

解决的核心问题：

1. **Antigravity 回执判定与轮次闭合（`k-77935d729cf5`）**：修复 `resultOf()` 将当轮任意一次被拒工具调用（含用户交互拒批或钩子拦截后智能体已改用合规方式完成并输出 `KNIT_AGY_SUBMIT`）一律误判为 `Antigravity 权限阻塞` 的问题；修复后台 stream-json 模式在模型漏写 `KNIT_AGY_SUBMIT` 或误写 `KNIT_AGY_WAITING` 时 `this.turn` 永不闭合的死锁；在 `SessionStart`／`PreToolUse`／`Stop` 阶段即记录 `transcriptPath` 到 `sessionFile`。
2. **Antigravity 交接只读资料放行、工具白名单与会话权限（`k-27f80e26adee`）**：解决交接指令要求读取主检出任务目录及历史报告、而 `AgyBroker.gate()` 与 `agy-settings.json` 只放行 Worktree 导致的契约冲突；在 `WRITE_TOOLS` 中补齐 `edit_file`，在 `READ_TOOLS` 中兼容缺省工作区路径，在 `manage_task` 中放行 `status`、`list`、`kill`；防止用户全局 `settings.json` 的 `ask` 规则覆盖内部 `command(commandPrefix)` 放行和后台模式的 Worktree 读写。
3. **Antigravity 命令临时目录隔离、环境变量保留与进程回收容错（`k-c84dae7772e7`）**：将命令进程的 `TMPDIR` 从 Worktree 根改到沙箱内独立的临时子目录，使 `tools: [read, exec]` 下的命令可正常使用 `$TMPDIR` 且不污染 Worktree 的 `changedPaths`；命令进程继承宿主环境变量（仅剔除主会话私有变量）；忽略 macOS `killpg` 在组长退出后返回的 `EPERM`；加固 `cleanAgyRuntime` 与 `finishRun`，防止清理异常阻断终态入账。
4. **Antigravity `external` 能力的预检与沙箱规则对齐（`k-050013968b09`）**：消除 `agyPreflight` 与 `sandboxProfile` 对 `external`（及默认 `tools: all`）的自相矛盾，明确外部只读定制与不可隔离的自动启动进程（如 MCP）在预检和沙箱读取规则上的边界。
5. **Worktree 未合并任务的目录命名防撞与主检出查找（`k-187f77a762fa`）**：在 `createTask` 生成任务目录名时一并检查已存在的 `refs/heads/knit/*` 分支与任务 Worktree 目录，避免与已交付在任务分支但尚未合并回主检出的任务重名（防止污染未合并 Worktree 或在 `task cancel` 时误删已交付分支）；让主检出的任务查找在任务已归档至自身 Worktree 且尚未合并时仍能定位并读取。
6. **打包检查补齐（`k-70ec54c7daf9`）**：在 `scripts/pack-check.mjs` 中补齐对 `dist/adapters/antigravity/` 运行时入口与 macOS 进程跟踪器的检查。
7. **全局安装版与本仓库模板副本同步（`k-4f3398a3ec99`）**：从 `k-70ec54c7daf9` 拆出的独立授权任务，在全部前置代码子任务交付后清理根目录残留 `.tgz`，经用户授权运行 `npm run pack:install` 与 `knit init --force` 同步全局安装版与本仓库模板副本。

前置架构衔接：本主任务的第一个子任务 `k-77935d729cf5` 依赖架构加固主任务 `k-d123fec5fa11` 的末项 `k-053fe369b3ec`，先收口 Agent 规格表、CLI→应用层用例边界、依赖反转与按需查找，再实施本清单中的 Antigravity 边界修复与 Worktree 扩展，避免二次搬迁和合并冲突。

不在本主任务范围内：为 Antigravity CLI 构建类似 `.pi/extensions/knit.ts` 的主会话主动桥接入口（当前 `agy` 仅作为工作流环节的执行者接入）。

## 完成条件

### Requirement: 全部子任务完成交付且全量验证通过

#### Scenario: 子任务按序交付并同步安装版

- GIVEN `.knit/tasks/11-22-agy-and-worktree-fixes/plan.md` 列出的 7 个子任务
- WHEN 各子任务按依赖顺序完成实现、审查与交付，且主任务汇总各子任务的交付提交与验证证据
- THEN 7 个子任务全部处于 `delivered`（或经用户决定 `cancelled`），待澄清项清零，主任务自身无代码改动
- AND 在 macOS 普通终端与 Rex 终端运行 `npm test` 全部通过，`npm run typecheck` 与 `npm run pack:check` 均通过

## 待澄清

## 相关资料

- `.knit/tasks/11-22-agy-and-worktree-fixes/plan.md` — 子任务拆解、依赖顺序与验证约定
- `docs/design/DESIGN.md` — 现行设计文档（交接、执行、Antigravity 工具隔离、完成与交付）
- `src/adapters/antigravity/execution.ts` — Antigravity 会话生命周期、设置生成、后台与窗格回执处理
- `src/adapters/antigravity/broker.ts` — Antigravity `PreToolUse` 工具门控与独立命令进程执行
- `src/adapters/antigravity/isolation.ts` — Antigravity 派发前隔离预检与 macOS `sandbox-exec` 规则
- `src/adapters/antigravity/protocol.ts` — Antigravity 回执标记解析与转录读取
- `src/application/task-store.ts` — 任务目录创建、扫描与归档
- `src/application/worktree.ts` — 任务 Worktree 路径与分支计算、合并及清理

## 结果

7 个子任务全部交付并合并至 main：k-77935d729cf5（d7509a7）、k-27f80e26adee（a5e8ff0）、k-c84dae7772e7（3faeea6）、k-050013968b09（791de88）、k-187f77a762fa（13c9597）、k-70ec54c7daf9（6c496f0）、k-4f3398a3ec99（见上一提交）。主任务无代码改动。验证：npm run typecheck、npm run pack:check 均通过，macOS Rex 与普通环境 npm test 各 467/474 通过（0 失败，7 跨文件系统用例按环境跳过；临时 APFS 卷验证 474/474 全过）。
