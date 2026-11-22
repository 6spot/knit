---
id: k-ea0e6d690522
title: 改造 knit init 按显式宿主开关注入桥接并生成 AGY 插件模板
status: delivered
stage: null
verification: self
parent: k-a9c3c3ddec63
dependsOn:
  - k-8d2dc8c0ea82
  - k-9c0e2fa7c112
priority: P1
createdAt: 2026-11-22T16:08:53.133Z
---

## 目标与范围

将 `knit init` 改造为按显式宿主开关按需注入客户端桥接（`--pi`、`--agy`，后续 `k-eaa1664e9b5f` 扩展 `--workbuddy`），并新增零 MCP 的 Antigravity 项目内插件模板 `.agents/plugins/knit/`：

1. **`knit init` 显式宿主开关（`src/application/init.ts`、`src/cli/init.ts`）**：
   - 拆分模板列表为「核心模板（`.knit/` 下的 `workflow.yaml`、`config.json`、`.gitignore`、`agents/`、`standards/`）」与「按宿主分组的桥接模板（`pi` → `.pi/extensions/knit.ts`；`agy` → `.agents/plugins/knit/{plugin.json,hooks.json,rules/AGENTS.md}`）」；
   - `knit init` 不带宿主开关时，**只初始化核心 `.knit/`**，不创建 `.pi/` 或 `.agents/` 桥接目录；
   - 支持显式布尔开关 `--pi`、`--agy`（可组合，如 `knit init --pi --agy`；也可在已初始化项目上随时运行 `knit init --agy` 补装）；
   - `knit init --force`：恢复核心可恢复模板以及本次显式指定（或项目中已存在）的宿主桥接副本，覆盖前仍备份到 `.knit/.runtime/backups/<时间>/`，不会凭空创建未启用过的宿主目录。
2. **新增零 MCP 的 AGY 插件模板（`assets/templates/agents/plugins/knit/`）**：
   - `plugin.json`：声明插件名称 `knit`；
   - `hooks.json`：注册 `SessionStart`、`PreInvocation` 和 `PreToolUse`（`matcher: "run_command"`），均直接调用 `PATH` 上的 `knit hook agy <event>`（不写死本机安装路径）；
   - `rules/AGENTS.md`：精简说明 AGY 主会话如何调用 `knit task`、`knit run`、`knit deliver`、`knit context --use/--unuse`，以及在 `knit run start <id>` 后立刻用后台 `run_command` 挂 `knit run wait <id>` 实现批次结束自动唤醒（不重复写入 `.knit/standards/` 里的讨论与交付规范）。
3. **补齐打包检查、文档与测试**：
   - 更新 `scripts/pack-check.mjs` 的 `required`，校验 tarball 包含新增的 3 份 AGY 插件模板文件；
   - 更新 `docs/design/DESIGN.md`（第 2、5、9、10 节：记录 `knit init --pi / --agy`、`.agents/plugins/knit/` 目录与零 MCP 注入机制）；
   - 更新 `test/init.test.mjs`、`test/init-force.test.mjs` 与受影响的桥接测试夹具（显式传 `--pi` 验证 Pi 桥接，新增无开关、单 `--agy`、组合 `--pi --agy` 与 `--force` 回归用例）。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及流程引用的 `.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，模板改动一律写入 `assets/templates/`，不直接往本仓库根目录生成 `.agents/plugins/knit/`（留给 `k-e72b44a67da7` 同步安装版后生成）。
- 不新增任何 `mcp_config.json` 或 MCP Server。

## 完成条件

### Requirement: knit init 默认只初始化 .knit/，显式传 --pi / --agy 按需注入桥接

#### Scenario: 验证无开关、--pi、--agy、组合 --pi --agy 与 --force 的生成及恢复行为

- GIVEN 空的临时项目目录及已有项目目录
- WHEN 分别运行 `knit init`、`knit init --pi`、`knit init --agy`、`knit init --pi --agy`，以及修改副本后运行 `knit init --force`
- THEN 无开关只创建 `.knit/`（不生成 `.pi/` 或 `.agents/`）；`--pi` 只生成 `.pi/extensions/knit.ts`；`--agy` 只生成 `.agents/plugins/knit/{plugin.json,hooks.json,rules/AGENTS.md}`（不生成 `.agents/hooks.json` 或 `mcp_config.json`）；组合开关同时生成两套；`--force` 仅备份并恢复已启用或本次指定的桥接副本

### Requirement: 打包检查、类型检查与全量测试通过

#### Scenario: npm run pack:check 与双终端 npm test 全部通过

- GIVEN 更新后的模板、`init.ts`、`cli/init.ts`、`pack-check.mjs`、`DESIGN.md` 与测试
- WHEN 运行 `npm run typecheck`、`npm run pack:check` 与 `npm test`（macOS 普通终端与 Rex 终端各一次）
- THEN `pack:check` 校验 tarball 包含全部 3 份 AGY 插件模板文件，设计文档与实现一致，全量测试全部通过

## 待澄清

## 相关资料

- `src/application/init.ts` — `TEMPLATES` 与 `initProject` 实现
- `src/cli/init.ts` — `knit init` 命令行参数定义
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接模板参考
- `scripts/pack-check.mjs` — npm tarball 必选文件检查脚本
- `test/init.test.mjs` — `knit init` 回归测试
- `test/init-force.test.mjs` — `knit init --force` 回归测试
- `docs/design/DESIGN.md` — 目录布局、初始化与模板章节

## 结果

已完成 knit init 显式宿主开关改造（默认只初始化 .knit/，按需支持 --pi / --agy 及组合、--force 仅恢复已启用或本次指定的桥接）与零 MCP 的 AGY 插件模板（assets/templates/agents/plugins/knit/），主会话核对并修正 rules/AGENTS.md 的 WaitMsBeforeAsync 最小值为 500；agy plugin validate、npm run typecheck、npm run pack:check、git diff --check、init 定向测试及双终端全量 npm test（含 7/7 跨文件系统补测）全绿。
