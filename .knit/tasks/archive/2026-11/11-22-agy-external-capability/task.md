---
id: k-050013968b09
title: 对齐 Antigravity 的 external 预检与沙箱读取规则
status: delivered
stage: null
verification: independent
parent: k-cdf8de80d14c
dependsOn:
  - k-c84dae7772e7
priority: P2
createdAt: 2026-11-22T05:40:36.741Z
---

## 目标与范围

消除 Antigravity 适配器在 `external` 能力（包括 `tools: all` 或省略 `tools`）上预检与沙箱配置之间的矛盾：

- **现状**：
  1. `src/adapters/antigravity/isolation.ts` 的 `agyPreflight()` 在 `permits(tools, "external")` 为真时，把工作区和主目录下的所有定制项（`mcp_config.json`、`plugins`、`skills`、`workflows`、`agents`、`rules`、`hooks.json`，包括 `~/.gemini/antigravity-cli/skills`）全部视为不可隔离的外部工具来源；只要本机存在任一非空目录（例如安装了默认技能 `~/.gemini/antigravity-cli/skills/ego-browser`），`tools: all` 或含 `external` 的环节在真实开发机上就一律拒绝派发。
  2. 与此同时，即便在空 `HOME` 夹具下通过了 `agyPreflight()`，`sandboxProfile()`（第 173–191 行）在启动 `agy` 时仍**无条件**对 `WORKSPACE_EXTERNAL` 和 `HOME_EXTERNAL` 的全部路径生成 `(deny file-read-data ...)`，且 `AgyBroker.gate()` 也未放行 `skills`／`workflows`／`subagent` 相关工具，导致即便声明了 `external`，沙箱也屏蔽了全部外部定制读取。
- **做法**：
  - 将「会在 CLI 启动时自动派生不受控外部进程或修改 CLI 状态的来源」（如已配置 `mcpServers` 的 `mcp_config.json`、`.mcp.json`、已启用插件 `plugins`／`plugins.json`、外部 `hooks.json`）与「纯只读文本定制」（如 `skills`、`rules`、`workflows`、`agents`）区分开：
    1. 未声明 `external` 时（如默认的 `tools: [read, write, exec]`）：保持现有严格隔离，外层沙箱通过 `(deny file-read-data ...)` 屏蔽工作区和主目录的全部 `WORKSPACE_EXTERNAL` 与 `HOME_EXTERNAL`（含技能、规则、插件和 MCP 配置），`agyPreflight` 不受主目录已有配置影响。
    2. 声明了 `external`（或 `tools: all`）时：若缺少 `network` 仍拒绝派发；若存在无法隔离运行时写入的自动启动来源（如非空的 `mcp_config.json`、`.mcp.json`、`plugins`、`plugins.json` 或外部 `hooks.json`）仍按具体路径拒绝派发；但对只读的 `skills`、`rules`、`workflows`、`agents` 不再拒绝派发，并在 `sandboxProfile` 中当 `permits(capabilities, "external")` 为真时放开这些只读定制路径的 `file-read-data`。
  - 同步更新 `docs/design/DESIGN.md` 第 7.4 节的表述，使设计与实现完全一致。

边界：不修改受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）；不放开未声明 `external` 时的任何外部定制读取。

## 完成条件

### Requirement: 区分只读外部定制与不可隔离的外部进程来源，并与沙箱规则一致

#### Scenario: 未声明 external 时屏蔽全部外部定制，声明 external 时放行只读技能与规则

- GIVEN 用户主目录下存在只读技能目录（如 `~/.gemini/antigravity-cli/skills/demo/SKILL.md`）或工作区存在 `.agents/skills/`、`.agents/rules/`，且未配置 MCP 服务或插件
- WHEN 分别派发 `tools: [read, write, exec]` 与 `tools: all`（或 `tools: [read, write, exec, external, network]`）的 Antigravity 环节
- THEN 未声明 `external` 时派发成功且外层沙箱拒绝读取上述技能与规则文件（返回 `EPERM`）；声明 `external` 且含 `network` 时派发同样成功，且外层沙箱允许 `agy` 读取这些只读技能与规则文件
- AND 当工作区或主目录存在已配置的 MCP（`mcp_config.json`／`.mcp.json`）、插件（`plugins`／`plugins.json`）或外部 `hooks.json` 时，声明 `external` 仍在派发前拒绝并指出该具体路径

## 待澄清

- [assumed] 声明 `external`（含 `tools: all`）时放行只读的 `skills`、`rules`、`workflows`、`agents` 定制目录与清单读取，继续在派发前拒绝会启动不受控进程或覆盖钩子的 `mcp_config.json`、`.mcp.json`、`plugins`、`plugins.json`、`hooks.json` 及 `.gemini/config.json`。

## 相关资料

- `src/adapters/antigravity/isolation.ts` — `WORKSPACE_EXTERNAL`、`HOME_EXTERNAL`、`agyPreflight` 与 `sandboxProfile`
- `src/adapters/antigravity/execution.ts` — `AgySession.launch` 调用 `sandboxProfile` 的参数传递
- `test/antigravity.test.mjs` — `external` 预检与外层沙箱读取测试
- `docs/design/DESIGN.md#7-执行` — 第 7.4 节 Antigravity 工具隔离设计

## 结果

已对齐 Antigravity 的 external 预检与外层沙箱规则：区分只读文本定制（skills、rules、workflows、agents）与不可隔离的自动启动来源（MCP、插件、外部 hooks、工作区 .gemini/config.json）；未声明 external 时屏蔽全部外部定制读取，声明 external 且含 network（含 tools: all 与省略 tools）时允许只读定制读取并保持写入保护，存在已配置自动启动来源时派发前按具体路径拒绝，同步更新 DESIGN.md 第 7.4 节。完成条件全部满足。独立审查（r-7a322c13cb41）结论 pass（审查补修新 Worktree 预检空清单处理与主目录技能写入保护）：npm run typecheck 通过，Rex 与普通环境 npm test 各 430/437 通过（0 失败，7 跨文件系统按环境跳过），真实 sandbox-exec 逐路径核对 37 个定制位置与 22 个启动配置位置并通过本机 agy 1.5.13 本地代理发现核验。未验证：在线模型调用。
