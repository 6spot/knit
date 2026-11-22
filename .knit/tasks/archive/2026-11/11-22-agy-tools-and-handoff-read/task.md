---
id: k-27f80e26adee
title: Antigravity 放行主检出只读交接资料、补齐内置工具白名单并收敛会话权限
status: delivered
stage: null
verification: independent
parent: k-cdf8de80d14c
dependsOn:
  - k-77935d729cf5
priority: P1
createdAt: 2026-11-22T05:40:36.467Z
---

## 目标与范围

解决 Antigravity 适配器在 `PreToolUse` 工具门控与会话权限配置上的四项缺陷，使交接资料读取和内置工具调用与设计契约一致：

1. **放行主检出中的只读交接资料路径**：
   - 现状：`src/application/handoff.ts` 与 `docs/design/DESIGN.md` 第 5.2 节规定，`.knit/tasks/` 下的任务文档、`plan.md`、跨任务资料以及 `.knit/.runtime/runs/` 下的历史 `report.md` 均保存在主检出（`root`），交接消息给出主检出的绝对路径并告知执行者「只读，不要改；按给出的绝对路径读取」（超出字节上限时只给路径不附正文）。但 `src/adapters/antigravity/broker.ts` 的 `READ_TOOLS` 只允许读取 `inside(this.launch.cwd, real)`（即任务 Worktree），`src/adapters/antigravity/execution.ts` 的 `agy-settings.json` 也仅将 `this.input.cwd` 列入 `trustedWorkspaces` 和 `read_file(...)` 放行，导致 `agy` 用原生读取工具读主检出任务资料或历史报告时被拒绝。
   - 做法：基于前置架构任务 `k-0821df285a6f` 在 `AgentLaunch` 中提供的显式主检出路径 `root`（不再靠 `dir` 反推层级），在具备 `read` 能力时，`AgyBroker.gate()` 允许 `READ_TOOLS` 读取任务 Worktree（`this.launch.cwd`）以及主检出下的只读交接路径（`<root>/.knit/tasks` 与历史运行的 `<root>/.knit/.runtime/runs`，排除当前正在执行的 `this.launch.dir` 以与命令沙箱保护一致）；同时在 `agy-settings.json` 中为上述只读交接目录配置放行，并核实 `allowNonWorkspaceAccess: false`、`trustedWorkspaces` 与 `agy --add-dir` 的交互（避免 `permissions.allow` 添加 `read_file(...)` 后仍被 `allowNonWorkspaceAccess` 拦截）；写入边界（`WRITE_TOOLS` 和外层／命令 `sandbox-exec`）仍严格限制在任务 Worktree 内且排除受保护控制路径。
2. **兼容 `READ_TOOLS` 省略路径参数时的缺省行为**：
   - 现状：`list_dir`、`find_by_name`、`grep_search` 等工具在模型省略路径参数（默认作用于当前工作区根）时，`args` 中对应路径字段为 `undefined`，`gate()` 将 `real` 算为 `null` 并直接拒绝。
   - 做法：当 `READ_TOOLS` 未提供路径参数或为空串时，按 `this.launch.cwd` 解析并通过检查。
3. **在 `WRITE_TOOLS` 中补齐 `edit_file`，在 `exec` 下补齐 `manage_task` 的只读与终止动作**：
   - 现状：`agy` 1.5.13 提供 `edit_file`（参数含 `Path`、`Target`、`Replacement`）用于局部编辑文件，但 `WRITE_TOOLS` 漏了 `edit_file`，导致调用时被拒；此外 `manage_task` 仅放行了 `Action === "status"`，当命令超时转入后台后调用 `list` 或 `kill` 会被拒绝。
   - 做法：将 `edit_file` 加入 `WRITE_TOOLS`（复用现有的 `this.writePath(path)` 检查 Worktree 与受保护路径边界）；在具备 `exec` 能力时允许 `manage_task` 的 `Action` 为 `"status"`、`"list"` 或 `"kill"`（继续拒绝 `send_input` 及持久化终端）。
4. **防止用户全局 `settings.json` 中的 `permissions.ask` 压过 Knit 的内部命令转发入口与后台放行规则**：
   - 现状：`agy` 的权限优先级是 `Deny > Ask > Allow`。`AgySession.launch()` 将用户 `~/.gemini/antigravity-cli/settings.json` 的 `nativePermissions`（包含 `ask`）原样拷入会话设置。若用户全局配置了 `ask: ["command(*)"]` 或 `ask: ["write_file(*)"]`，在 Rex 中批准原命令后会因 `ask` 压过 `allow: ["command(commandPrefix)"]` 而对内部转发脚本弹出二次审批；在后台无交互模式下则会直接导致命令或 Worktree 内读写被拒。
   - 做法：在生成 `agy-settings.json` 时，后台模式（`!this.pane`）不继承会导致无交互拒批的 `nativePermissions.ask`（保留 `deny` 与 `allow`）；Rex 交互模式（`this.pane`）下过滤掉会拦截内部转发入口 `this.broker.commandPrefix` 的 `command(...)` 类 `nativePermissions.ask` 规则，并将 `AgyBroker.gate()` 对 `run_command` 在交互模式下的决定改为 `decision: "ask"`（已与用户确认方案 A：由 `agy` 原生执行 `Deny > Ask > Allow` 优先级——命中用户 `deny` 的原命令直接按规则拒绝、不弹出审批卡；未在全局放行的普通命令通过 `permissionOverrides: ["command(原命令)"]` 弹出一次原命令审批卡，批准后完成转发；用户已在全局 `permissions.allow` 显式放行的命令直接复用其许可，仍受 Knit 命令沙箱约束）。

边界：不修改受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json`、`.knit/agents/`）；绝不允许向主检出任何路径写入。

## 完成条件

### Requirement: 原生读取工具可读取主检出交接资料并支持缺省工作区路径

#### Scenario: 读取主检出任务目录与历史报告放行，读取当前执行目录或外部路径被拒

- GIVEN 环节配置 `agent: antigravity` 与 `tools: [read]`（或 `[read, write, exec]`）
- WHEN `agy` 调用原生读取工具（`read_file`、`view_file`、`list_dir`、`find_by_name`、`grep_search`）读取 Worktree 内文件、省略路径参数搜索当前工作区，或按绝对路径读取主检出 `.knit/tasks/` 下的资料与历史执行的 `report.md`
- THEN `PreToolUse` 钩子与会话权限均放行，且仍拒绝读取当前执行运行目录（`this.launch.dir`）、主检出其它源码目录及仓库外部目录
- AND 原生写入工具和命令尝试写入主检出 `.knit/tasks/` 或历史报告目录时仍被拒绝

### Requirement: 补齐 edit_file 与 manage_task 门控并收敛全局 ask 规则

#### Scenario: 使用 edit_file 编辑 Worktree 文件与使用 manage_task 查询或停止后台命令

- GIVEN 环节配置 `tools: [read, write, exec]`
- WHEN `agy` 调用 `edit_file` 修改 Worktree 内的项目文件、尝试用 `edit_file` 修改受保护文件（如 `.knit/workflow.yaml`），以及调用 `manage_task` 的 `status`、`list`、`kill` 与 `send_input`
- THEN Worktree 内普通文件的 `edit_file` 放行，受保护文件与 Worktree 外路径的 `edit_file` 被拒绝；`manage_task` 的 `status`、`list`、`kill` 放行，`send_input` 被拒绝

#### Scenario: 用户全局 settings.json 含宽泛 ask 规则时不阻塞后台执行与转发入口

- GIVEN 用户 `~/.gemini/antigravity-cli/settings.json` 配置了 `ask: ["command(*)", "write_file(*)"]` 以及针对特定命令或文件的显式 `deny` 规则
- WHEN 在后台模式运行具备 `[read, write, exec]` 的环节，或在 Rex 交互模式请求被 `deny` 的原命令与普通原命令
- THEN 后台模式的 Worktree 读写与命令转发正常执行，不被全局 `ask` 自动拒批；Rex 模式下命中 `deny` 的原命令直接返回规则拒绝、不弹出审批卡，普通命令只审批一次并完成转发；用户的 `deny` 规则在后台和 Rex 下均照常生效

## 待澄清

## 相关资料

- `src/adapters/antigravity/broker.ts` — `READ_TOOLS`、`WRITE_TOOLS`、`manage_task` 与路径核对逻辑
- `src/adapters/antigravity/execution.ts` — `agy-settings.json` 权限合成与 `AgentLaunch` 传递
- `src/application/handoff.ts` — 交接资料与历史报告的主检出绝对路径生成规则
- `docs/design/DESIGN.md#5-交接` — 主检出任务资料与历史报告的交接设计
- `docs/design/DESIGN.md#7-执行` — Antigravity 工具隔离与权限映射说明
- `test/antigravity.test.mjs` — Antigravity 门控与沙箱测试

## 结果

已完成四项修复：1）基于 AgentLaunch.root 放行主检出 .knit/tasks 与历史 runs 目录只读读取（排除当前执行目录且禁止写入），并兼容 READ_TOOLS 省略路径参数；2）WRITE_TOOLS 补齐 edit_file，exec 下放行 manage_task 的 status/list/kill 并继续拒绝 send_input；3）后台模式屏蔽冲突 ask 规则，Rex 模式过滤拦截内部转发入口的 command(...) ask 并改用 decision ask 使 agy 原生执行 Deny > Ask > Allow。完成条件全部满足。独立审查（r-0fca9bf2514f）结论 pass（0 文件修改）：npm run typecheck、npm run pack:check 通过，macOS 普通终端与 Rex 终端 npm test 各 418/418 通过，并用真实 agy 1.5.13 核验主检出读取、edit_file、manage_task kill 与 Rex 拒绝/审批/许可路径。未验证：实测模型未提供 list_dir/find_by_name/grep_search/view_file，其缺省路径由真实 broker 钩子配合夹具验证。
