# 多宿主零 MCP 主会话验收记录（AGY 1.5.13 + WorkBuddy + Qoder 桥接）

- 验收日期：2026-11-23
- 验收环境：macOS，全局安装版 `knit 0.1.0`（`/Users/me/.local/share/mise/installs/node/26.3.0/bin/knit`，Node `v26.3.0`）、本机 `agy 1.5.13`
- 关联任务：`k-e72b44a67da7`（父任务 `k-a9c3c3ddec63`）

---

## 1. 实机验收暴露并修复的关键协议缺陷

在将新生成的 `.agents/plugins/knit/` 同步到本仓库并运行实机验收时，真实 `agy 1.5.13` 暴露了一处仅靠单测夹具无法察觉的协议缺陷：

- **现象**：`agy 1.5.13` 的 `PreToolUse` 契约要求必填 `decision` 字段；`src/adapters/antigravity/host-hook.ts` 原实现对无需改写的 `run_command` 返回空对象 `{}`，被真实 `agy 1.5.13` 解释为空决策并拒绝所有命令（`tool call denied by pre-tool hook: `）。
- **修复**：在 [src/adapters/antigravity/host-hook.ts](../../src/adapters/antigravity/host-hook.ts) 中改为对放行路径显式返回 `{ decision: "allow" }`，同步更新 [test/host-hook.test.mjs](../../test/host-hook.test.mjs)，重新执行 `npm run pack:install` 升级全局安装版。
- **权限优先级实机复核**：在隔离夹具中用 `agy -p "请调用 run_command 运行 echo forbidden..." --settings '{"permissions":{"deny":["command(echo forbidden)"]}}'`（不带 `--dangerously-skip-permissions`）实测，会话 `839005ea-7a2b-487a-9211-429cb7f993db` 中 `echo forbidden` 仍被 `Matches user-configured deny rule` 拒绝，确认 `{ decision: "allow" }` 不会绕过用户的 `permissions.deny`。

---

## 2. 真实 `agy 1.5.13` 主会话闭环验收

在临时隔离 Git 仓库（`/tmp/knit-live-agy.emoJfw`，验收后已清理）运行 `knit init --agy`：

- 仅生成 `.knit/` 与 `.agents/plugins/knit/{plugin.json,hooks.json,rules/AGENTS.md}`；不生成 `.pi/`、`.agents/hooks.json` 或 `mcp_config.json`。
- 同一真实会话 `0066d32e-1ab4-4001-8879-0e6be720a5b8` 连续跑通 6 轮闭环：

| 轮次 | 验证目标 | 实测结果 |
| --- | --- | --- |
| Turn 1 | 无关键词自动注入 | 发送不含“knit”的普通需求消息，模型直接答出当前处于 `discuss` 环节并列出自动拿到的 `discussion.md`、`task-splitting.md`、`task-writing.md`；`.knit/.runtime/host-sessions/agy-0066d32e-....json` 写入 `lastDigest=63979492...`。 |
| Turn 2 | 不变轮次去重跳过 | 同会话发送“只回复：收到”，`lastDigest` 保持不变，原生 `transcript.jsonl` 中 Knit `SYSTEM_MESSAGE` 注入计数保持 `1`（零重复注入）。 |
| Turn 3 | `PreToolUse` 绑定会话选任务 | 模型通过 `run_command` 执行 `knit context --use k-c40c6608545d`，钩子自动改写命令注入 `KNIT_HOST=agy KNIT_HOST_SESSION=...`，输出 `已选中 k-c40c6608545d`，会话状态更新 `taskId="k-c40c6608545d"`。 |
| Turn 4 | 选任务后自动刷新注入 | 不调用任何命令，模型直接准确答出新注入的任务编号 `k-c40c6608545d` 与标题 `Add greet helper`，`lastDigest` 更新为 `370d2a5b...`。 |
| Turn 5 | 未授权 `knit deliver` 被拦截 | 关闭任务后让模型以非用户原话 `--authorization "用户同意交付"` 交付，`PreToolUse` 返回 `deny`（`无法核对交付授权...`），`knit task show` 仍为 `done` 未归档。 |
| Turn 6 | 完整原话授权放行交付 | 用户消息给出完整一行 `我明确授权立即交付任务 k-c40c6608545d` 后，模型以同原话调用 `knit deliver`，`PreToolUse` 放行并成功提交 `9cffeb3 feat(demo): add greet helper`（含 `Knit-Task: k-c40c6608545d`）且任务目录归档。 |

---

## 3. 含 `.agents/plugins/knit/` 仓库派发真实 AGY 执行者与沙箱隔离

在同一隔离夹具（仓库已提交 `.agents/plugins/knit/`）中验证派发与两层沙箱：

1. **`tools: all` 派发预检豁免**：运行 `knit run start k-b71b2037bd8d`，预检未因 `.agents/plugins/knit/` 拒绝（仅按既有策略报告本机全局 `~/.gemini/config/mcp_config.json` 无法隔离）。
2. **`tools: [read, write, exec]` 真实 AGY 执行者派发与隔离（`r-a69652d545ce`）**：
   - `knit run start` 正常派发并进入独立 Worktree，执行者 `r-a69652d545ce` 正常结束且未改动仓库（0 个改动文件）。
   - 执行者在报告中记录：
     - 外层 `read_file` 读取 `.agents/plugins/knit/plugin.json` 与 `hooks.json` 均返回 `operation not permitted`；
     - 内层 `run_command` 运行 `ls -la .agents/plugins/knit` 与 `cat` 两个文件均返回 `Operation not permitted`（退出码 `1`）。

---

## 4. WorkBuddy 已安装桥接验证与未核实边界

### 4.1 已核实（全局 `knit init --workbuddy` + 模拟 WorkBuddy GUI 极简 `PATH`）

在临时隔离仓库（`/tmp/knit-live-wb.gXSD14`，验收后已清理）执行 `knit init --workbuddy`：

- 仅生成 `.knit/` 与 `.workbuddy/{settings.json,knit-hook.sh}`，不生成 `.pi/` 或 `.agents/`。
- 在精确模拟 WorkBuddy Desktop 的极简环境（`env -i PATH="$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin:/usr/bin:/bin:/usr/sbin:/sbin"`，含前置 Node v22.22.2）下直接执行安装后的 `.workbuddy/knit-hook.sh`：
  - `session-start`：自动引导到 Node `v26.3.0` 与全局 `knit`，返回合法 JSON `hookSpecificOutput.additionalContext`（含 `discuss` 规范及 WorkBuddy GUI 两档等待降级提示）；
  - `user-prompt-submit`（状态不变）：stdout 长度为 `0`（静默去重跳过）；
  - `pre-tool-use`（伪造授权 `knit deliver`）：返回 `hookSpecificOutput.permissionDecision="deny"` 及提示；
  - `pre-tool-use`（匹配 `<user_query>` 内完整原话 `knit deliver`）：静默放行（stdout 长度 `0`）；
  - `pre-tool-use`（`knit run start k-1234`）：原样放行，不注入 `KNIT_SESSION_AGENT=workbuddy`；
  - `pre-tool-use`（`knit context --use k-1234`）：返回 `hookSpecificOutput.updatedInput.command="env KNIT_HOST=workbuddy KNIT_HOST_SESSION='wb-s1' knit context --use k-1234"`。

### 4.2 真实 `WorkBuddy.app` 桌面窗口验收（2026-11-27 实机复核）

在隔离 Git 仓库 `/tmp/knit-wb-verify`（由全局安装版 `knit 0.1.0` 执行 `knit init --workbuddy` 初始化，验收结束后清理）中，使用真实 `WorkBuddy.app` 打开工作区并完成实机核对：

1. **信任工作区与三钩子自动触发 + 分块增量去重（通过）**：
   - 在 `WorkBuddy.app` 点击「信任工作区」后，`.workbuddy/settings.json` 中的 `SessionStart`、`UserPromptSubmit`、`PreToolUse` 均自动生效。
   - 会话 `6a80f146-d1aa-4c6f-97bc-67a98c00de14` 自动写入 `.knit/.runtime/host-sessions/workbuddy-6a80f146-d1aa-4c6f-97bc-67a98c00de14.json`，记录分块摘要 `digests`（`discussion`、`supplement`、`pitfalls`、`guidance`），状态未变轮次静默跳过。
2. **`PreToolUse` 会话绑定与原话授权交付闭环（通过）**：
   - 在 WorkBuddy 主会话中选中任务 `k-d851a9fb9c6a`、修改 `hello.txt`、关闭任务后，先用非用户原话试交付被 `PreToolUse` 拦截，随后使用用户原话 `我同意交付测试任务一` 成功放行并提交 `2011563 feat(hello): 在 hello.txt 追加问候语`，任务目录正常归档至 `.knit/tasks/archive/2026-11/`。
3. **外部 CLI 派发受桌面沙箱硬拦截与降级收口（实机定案）**：
   - 在 WorkBuddy 会话中实测对任务 `k-b2095fbd7ed2` 运行 `knit run start`（执行 `r-67fa82e94df8`、`r-30c6abd9b60e`），后台 worker 拉起外部 `pi` 均在 260 ms 内失败，报错一致：`执行者启动失败：Pi RPC 连接在等待响应 ... 时结束；stderr: Brokered program policy check unavailable`。
   - 据此确认 WorkBuddy Desktop 沙箱不允许主会话后台派发外部 CLI 执行者；同步收口 [src/adapters/workbuddy/host-hook.ts](../../src/adapters/workbuddy/host-hook.ts) 与 [src/application/host-command.ts](../../src/application/host-command.ts)，WorkBuddy 全程降级使用自身工具与原生子 Agent 完成实现和检查，`PreToolUse` 直接拒绝 `knit run start` 并提示改用原生流程或外部终端。
   - 另观察到 `WorkBuddy.app` 会在工作区生成 `.workbuddy/memory/` 目录。

---

## 5. 全局安装版升级、本仓库同步与全量回归

- 执行 `npm run pack:install` 升级全局安装版至最新 `knit 0.1.0`（`/Users/me/.local/share/mise/installs/node/26.3.0/lib/node_modules/knit`），清理根目录 `knit-0.1.0.tgz`。
- 备份并保护本仓库 `.knit/workflow.yaml` 与 `.knit/standards/pitfalls-worker.md`，运行 `knit init --force --pi --agy` 同步生成 `.agents/plugins/knit/` 并恢复 `.knit/workflow.yaml`。
- 逐字节核对通过：
  - 全局 `dist/` 与工作区 `dist/` 完全一致；
  - `.pi/extensions/knit.ts`、`.knit/agents/{implement,review}.md`、`.agents/plugins/knit/{plugin.json,hooks.json,rules/AGENTS.md}` 均与 `assets/templates/` 逐字一致。
- 修复 `PreToolUse` 放行返回值后执行全量检查：
  - `npm run typecheck`：通过；
  - `npm run pack:check`：通过（93 个包文件）；
  - `git diff --check`：通过；
  - Rex 终端 `npm test`：**496 项，489 通过，0 失败，7 跳过**（跨文件系统测试）；
  - 普通 macOS 终端（清除 `REX_*`）`npm test`：**496 项，489 通过，0 失败，7 跳过**。

---

## 6. 真实 `Qoder.app` 0.5.20 桌面窗口验收（2026-11-27 实机复核）

- 验收环境：macOS，全局安装版 `knit 0.1.0`（commit `190be6d`，`/Users/me/.local/share/mise/installs/node/26.3.0/bin/knit`，Node `v26.3.0`）、本机 `Qoder.app` `0.5.20`（默认主 Agent `agent:default`）。
- 关联任务：`兼容 Qoder 桌面端主会话宿主（k-2a63a21dc644）`、`主会话宿主注册表收口（k-945f16c37cb3）`。
- 验收方法：在隔离 Git 仓库 `/tmp/knit-qoder-verify` 运行全局 `knit init --qoder`（生成 `.knit/` 与 `.qoder/{settings.json,knit-hook.sh}`），在 `Qoder.app` 打开该工作区，同一真实会话 `ddfec3b9-aa50-4c2d-9ffe-751ff680cb0e` 连续完成 6 轮闭环（验收结束后已清理临时目录）：

| 轮次 | 验证目标 | 实测结果 |
| --- | --- | --- |
| Turn 1 | 首轮自动注入与截断检查 | `SessionStart` 自动注入 1 条 `attachment`（5313 字节，未触及 `10000` 字符截断线）；模型准确答出 3 份讨论规范、未选任务状态及 Qoder 纯 GUI 降级指引。 |
| Turn 2 | 状态不变轮次去重跳过 | 发送“收到”后原生会话记录零新增 `attachment`，静默跳过。 |
| Turn 3 | `PreToolUse` 绑定会话与 `updatedInput` 参数保留 | 模型带 `description` 字段通过 `Bash` 执行 `knit task new` 与 `knit context --use k-8233e6a52e0d`，钩子成功改写命令并保留原 `tool_input` 字段（无 `invalid_tool_params`），状态落盘至 `.knit/.runtime/host-sessions/qoder-ddfec3b9-aa50-4c2d-9ffe-751ff680cb0e.json`。 |
| Turn 4 | 增量状态刷新 + 拦截 `knit run start` | `UserPromptSubmit` 仅增量注入状态块（567 字节，`draft`）；`knit task ready` 放行；`knit run start` 被 `PreToolUse` 直接拒绝（`is_error=true`）并提示使用 Qoder 自身工具与原生子 Agent，或在普通终端、Pi、Antigravity 运行外部派发。 |
| Turn 5 | 原生工具编辑、交付预览与伪造授权拦截 | `UserPromptSubmit` 增量刷新为 `ready`（567 字节）；`Edit` 修改 `hello.txt`、`knit task close`、`knit deliver --preview` 均成功；伪造 `--authorization "用户已经同意交付"` 被 `PreToolUse` 拦截（`无法核对交付授权...`）。 |
| Turn 6 | 真实用户原话授权放行交付 | `UserPromptSubmit` 增量刷新为 `done` 与交付规范（1231 字节）；模型以用户消息第一行原话 `我明确授权立即交付测试任务 Qoder 真机测试` 调用 `knit deliver`，`PreToolUse` 校验通过并放行，生成提交 `9954156`（含 `Knit-Task: k-8233e6a52e0d`）且归档至 `.knit/tasks/archive/2026-11/11-27-qoder-smoke`，工作区其他未跟踪文件未被误提交。 |
