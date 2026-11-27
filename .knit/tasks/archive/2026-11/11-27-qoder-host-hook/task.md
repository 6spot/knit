---
id: k-2a63a21dc644
title: 兼容 Qoder 桌面端主会话宿主
status: delivered
stage: null
verification: independent
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-27T03:41:21.484Z
---

## 目标与范围

### 目标与背景

为 Qoder 桌面端 GUI（`Qoder.app`）新增主会话宿主兼容，使项目可以通过 `knit init --qoder` 安装 Qoder 项目钩子，在 Qoder 聊天窗口中完成需求讨论、自动规范与任务状态增量注入、会话级任务选择绑定，以及带真实用户原话校验的交付闭环。

已与用户确认采用与 WorkBuddy 桌面端对齐的**纯 GUI 降级策略**：Qoder 仅作为主会话宿主，不接入为工作流执行者，也不在 Qoder 主会话内通过 `knit run start` 派发外部 CLI 执行者；实现与检查在 Qoder 内通过其自身工具与原生子 Agent 完成（确需外部执行者时提示用户改在普通终端、Pi 或 Antigravity 运行）。

### 实现思路与已定决策

依据本机 `Qoder.app` `0.5.20` 静态探针结果（完整摘录见 `.knit/tasks/11-27-qoder-host-hook/research/qoder-hooks.md`）：

1. **项目桥接模板（`assets/templates/qoder/`）**：
   - 新增 `assets/templates/qoder/settings.json` 与 `assets/templates/qoder/knit-hook.sh`。
   - `settings.json` 注册 `SessionStart`、`UserPromptSubmit` 与 `PreToolUse`（`matcher: "^Bash$"`），命令通过 `${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}/.qoder/knit-hook.sh` 调用 `knit hook qoder <event>`。
   - `knit-hook.sh` 复用 WorkBuddy 的通用 `PATH` 前置引导并核对 `node >= 24`，找不到时回退登录 shell。
2. **初始化与 `--force` 桥接识别（`src/application/init.ts`、`src/cli/project.ts`）**：
   - `knit init` 新增 `--qoder` 选项，生成 `.qoder/knit-hook.sh` 与 `.qoder/settings.json`。
   - 与 WorkBuddy 同理：`.qoder/settings.json` 可能被项目自行使用，`--force` 识别已启用桥接时，仅当存在 `.qoder/knit-hook.sh` 或三个事件钩子中任一 `command` 引用 `.qoder/knit-hook.sh` 才视为已启用，避免误覆盖项目自定义 `.qoder/settings.json`。
3. **Qoder 宿主钩子适配器（`src/adapters/qoder/host-hook.ts`、`src/cli/knit.ts`）**：
   - CLI 注册隐藏命令 `knit hook qoder <event>`，按动态导入延迟加载适配器，返回 `null` 时不输出 stdout。
   - `session-start` / `user-prompt-submit`：按 `payload.cwd || process.env.QODER_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()` 定位目录，复用 `hostContext(..., { host: "qoder", sessionId }, guidance)` 做分块增量去重注入，返回 `{ hookSpecificOutput: { hookEventName, additionalContext } }`；`guidance` 简明说明 Qoder 纯 GUI 降级流程。
   - `pre-tool-use`：仅处理 `tool_name === "Bash"` 且 `tool_input.command` 为字符串的调用；复用 `checkHostCommand` 完成三件事：
     1. 传入 `rejectStartReason` 直接拒绝 `knit run start`，提示改用 Qoder 自身工具与原生子 Agent 完成实现和检查，或在普通终端 / Pi / Antigravity 运行外部派发；
     2. 为 `knit context --use` / `--unuse` 与 `knit task new` 注入 `KNIT_HOST=qoder KNIT_HOST_SESSION=<quoted>`；**注意 Qoder worker 对 `updatedInput` 执行整对象替换而非合并，改写时必须保留 `tool_input` 其余原始字段（`{ ...toolInput, command: checked.command }`）**；
     3. 校验 `knit deliver` 的 `--authorization` 原话，按 Qoder 的 JSONL transcript 结构提取真实用户消息，严格过滤 `isMeta`、`isCompactSummary`、`isVisibleInTranscriptOnly`、`toolUseResult`、非 `human` 来源、非 `user` 角色、`tool_result` 块，并剥离 `<system-reminder>` / `<hook_context>` / `<loaded_context>` 等标签（残缺标签视为不可信并忽略）。
4. **Antigravity 工作树写保护（`src/adapters/antigravity/isolation.ts`）**：
   - 将 `.qoder` 加入 `WORKSPACE_CONTROL`，使 Antigravity 执行者读取 `.qoder/` 不受阻但无法在工作树中篡改项目 Qoder 钩子配置，与 `.workbuddy` 保持一致。
5. **文档更新**：
   - 更新 `docs/AGENT-INTEGRATION.md`、`docs/design/DESIGN.md` 与 `README.md`，补充 Qoder 桌面端的主会话入口、纯 GUI 降级策略、`updatedInput` 整对象替换及仅默认主 Agent 加载项目级 `.qoder/settings.json` 的边界说明。

### 范围内外与延后项

- **范围内**：上述模板、Qoder 适配器、CLI 与初始化接入、Antigravity 隔离写保护、单元测试与回归覆盖、设计/接入/首页文档更新。
- **范围外**：不接入 Qoder 作为工作流执行者（不修改 `AgentNameSchema`、`AGENT_SPECS` 或 `builtinAgents`）。
- **延后项（不作为本任务完成条件）**：
  - `npm run pack:install` 升级本机全局 `knit`；
  - 在真实 `Qoder.app` GUI 窗口打开隔离临时项目完成三钩子触发、会话绑定、原话授权交付与拒绝 `knit run start` 的端到端真机复核，并补录 `validation/multi-host-main-session/README.md`。上述事项待本任务审查并交付后另行授权执行。

## 完成条件

### Requirement: Qoder 项目桥接初始化与 --force 保护
`knit init --qoder` 安装 Qoder 桌面端钩子模板，且不误覆盖项目自有配置。

#### Scenario: 首次安装与多宿主组合安装
- GIVEN 一个已初始化 Git 的项目目录
- WHEN 执行 `knit init --qoder` 或与 `--pi`、`--agy`、`--workbuddy` 组合执行
- THEN 生成 `.qoder/settings.json` 与 `.qoder/knit-hook.sh`
- AND 重复执行不带 `--force` 的 `knit init --qoder` 保留已有文件不做覆盖

#### Scenario: 自定义 .qoder/settings.json 的 --force 保护与恢复
- GIVEN 项目目录已有未引用 `.qoder/knit-hook.sh` 的自定义 `.qoder/settings.json` 且无 `.qoder/knit-hook.sh`
- WHEN 执行 `knit init --force`（未显式指定 `--qoder`）
- THEN 不将该目录识别为已启用 Knit Qoder 桥接，保留原有 `.qoder/settings.json`
- AND 当显式执行 `knit init --force --qoder` 或已启用桥接后执行 `knit init --force` 时，将有差异的文件备份到 `.knit/.runtime/backups/<时间>/` 并恢复为最新模板

### Requirement: Qoder 主会话钩子协议、纯 GUI 降级与交付原话校验
`knit hook qoder <event>` 按 Qoder 协议处理上下文增量注入、会话绑定、外部派发拦截和真实用户原话交付授权校验。

#### Scenario: 首轮与后续轮次的分块增量上下文注入
- GIVEN 已初始化的 Knit 项目，工作目录通过 `cwd` 或 `QODER_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` 提供
- WHEN 依次触发 `session-start` 与状态未变的 `user-prompt-submit`
- THEN 首轮返回合法 JSON `hookSpecificOutput`（含匹配的 `hookEventName` 与 `additionalContext`，内含讨论规范、任务状态及 Qoder 纯 GUI 降级指引）
- AND 状态未变的后续轮次静默跳过（无 stdout 输出）

#### Scenario: PreToolUse 绑定会话并保留 tool_input 原始字段
- GIVEN Qoder `PreToolUse` 事件调用 `Bash` 工具，且 `tool_input` 包含 `command` 与其它字段（如 `timeout`、`description`、`run_in_background`）
- WHEN `command` 为 `knit context --use <id>`、`knit context --unuse` 或 `knit task new`
- THEN 返回 `hookSpecificOutput.updatedInput`，其 `command` 已注入 `KNIT_HOST=qoder KNIT_HOST_SESSION=<id>`
- AND `updatedInput` 完整保留原 `tool_input` 的其它字段，不丢失参数

#### Scenario: PreToolUse 拒绝外部派发（纯 GUI 降级）
- GIVEN Qoder `PreToolUse` 事件调用 `Bash` 工具
- WHEN `command` 包含 `knit run start`
- THEN 返回 `hookSpecificOutput` 含 `hookEventName: "PreToolUse"`、`permissionDecision: "deny"` 与 `permissionDecisionReason`
- AND 拒绝原因明确提示改用 Qoder 自身工具与原生子 Agent 完成实现和检查，或在普通终端、Pi、Antigravity 运行外部派发

#### Scenario: PreToolUse 校验 Qoder transcript 真实用户交付授权
- GIVEN Qoder `PreToolUse` 事件调用 `Bash` 工具执行 `knit deliver`
- WHEN 执行 `knit deliver --preview` 或实际交付且 `--authorization` 匹配 `transcript_path` 中真实用户消息的整条或完整一行
- THEN 放行该命令（静默输出 `null`/空 stdout）
- AND 当 `--authorization` 为伪造原话，或仅出现在 `isMeta`、`isCompactSummary`、`isVisibleInTranscriptOnly`、`toolUseResult`、非 `human` 来源、`tool_result` 块、`<system-reminder>` / `<hook_context>` / `<loaded_context>` 标签或未闭合标签块中时，返回 `permissionDecision: "deny"` 拒绝交付

#### Scenario: 桌面极简 PATH 下的钩子脚本可达性
- GIVEN 模拟桌面 GUI 极简 `PATH`（前置低版本 `node` 如 v22，不含用户默认工具链）
- WHEN 执行安装后的 `.qoder/knit-hook.sh session-start`
- THEN 脚本能定位 `node >= 24` 与 `knit` 并返回合法 JSON 响应

### Requirement: Antigravity 工作树写保护覆盖 .qoder
Antigravity 执行者在工作树中运行受限环节时不得篡改 `.qoder/` 桥接配置。

#### Scenario: WORKSPACE_CONTROL 包含 .qoder
- GIVEN 项目存在 `.qoder/settings.json` 与 `.qoder/knit-hook.sh`
- WHEN Antigravity 隔离模块生成工作树保护规则并运行隔离回归测试
- THEN `.qoder` 被纳入 `WORKSPACE_CONTROL`，执行者可读但不可写 `.qoder/` 下文件

### Requirement: 文档同步与全量回归验证
文档与安装包构建、自动化测试完整覆盖本次改动。

#### Scenario: 文档更新与构建测试通过
- GIVEN 完成上述代码、模板与测试改动
- WHEN 同步更新 `docs/AGENT-INTEGRATION.md`、`docs/design/DESIGN.md`、`README.md`，并运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 与全量 `npm test`
- THEN 文档准确记录 Qoder 主会话入口、纯 GUI 降级策略、`updatedInput` 整对象替换要点与仅默认主 Agent 加载项目级 `.qoder/settings.json` 的边界
- AND `npm run typecheck`、`npm run build`、`npm run pack:check`（包含 `assets/templates/qoder/`）与全量 `npm test` 全部通过
- AND 改动仅保留在任务工作树/分支中等待独立审查与交付，不执行 `npm run pack:install` 或手工提交主分支

## 待澄清

## 相关资料

- [.knit/tasks/11-27-qoder-host-hook/research/qoder-hooks.md](.knit/tasks/11-27-qoder-host-hook/research/qoder-hooks.md)（本机 Qoder.app 0.5.20 静态探针摘录）
- [docs/AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md)
- [docs/design/DESIGN.md](docs/design/DESIGN.md)
- [src/adapters/workbuddy/host-hook.ts](src/adapters/workbuddy/host-hook.ts)
- [src/application/host-hook.ts](src/application/host-hook.ts)
- [src/application/host-command.ts](src/application/host-command.ts)
- [src/application/init.ts](src/application/init.ts)
- [src/adapters/antigravity/isolation.ts](src/adapters/antigravity/isolation.ts)
- [assets/templates/workbuddy/settings.json](assets/templates/workbuddy/settings.json)
- [assets/templates/workbuddy/knit-hook.sh](assets/templates/workbuddy/knit-hook.sh)
- [test/host-hook.test.mjs](test/host-hook.test.mjs)
- [test/init.test.mjs](test/init.test.mjs)
- [test/antigravity.test.mjs](test/antigravity.test.mjs)

## 结果

新增 Qoder 桌面端 GUI 主会话宿主兼容（knit init --qoder、knit hook qoder、纯 GUI 降级拦截 knit run start、updatedInput 保留原 tool_input、Qoder transcript 真实用户原话校验、Antigravity WORKSPACE_CONTROL 写保护与文档同步）；独立审查（r-0c128559a3c5）一次通过，typecheck/build/pack:check 与全量 npm test（547/547）全部通过。
