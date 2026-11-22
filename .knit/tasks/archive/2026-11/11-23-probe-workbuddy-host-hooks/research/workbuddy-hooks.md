# WorkBuddy 桌面端主会话 Hook、路径、PATH 与后台能力调研报告

- 调研对象：本机已安装的 `WorkBuddy.app`（`5.9.3`，`/Applications/WorkBuddy.app`）
- 调研方式：只读分析 `WorkBuddy.app` 打包运行时（`Contents/Resources/app.asar` 主进程启动环境、`Contents/Resources/app.asar.unpacked/cli/dist/codebuddy-lite-wb.mjs` Hook/Session/Bash 引擎、`Contents/Resources/app.asar.unpacked/cli/bin/no-orphans.cjs`、`@genie/agent-harness/lib/settings/setting-sources.js`、`product.json`）+ 模拟 WorkBuddy GUI 环境的 `PATH` 与 `detached` 子进程实测。
- 边界声明：**未修改**用户 `~/.workbuddy/` 真实配置、未读取任何登录凭据或用户私有会话记录；本报告区分「运行时代码与受控命令已核实」与「未实机在 WorkBuddy GUI 窗口点击复核」。

---

## 1. 项目级配置与 Hook 发现路径

### 1.1 已核实事实

1. **项目配置目录是 `<project>/.workbuddy/`，而非 `.codebuddy/`**：
   - `codebuddy-lite-wb.mjs` 中 `PathUtils.getProjectHomeDir()` 定义如下：
     ```js
     static getProjectHomeDir(t = B()) {
       let i = process.env.CODEBUDDY_PROJECT_CONFIG_DIR?.trim();
       if (i) return t.isAbsolute(i) ? i : t.join(this.getWorkDir(), i);
       let n = (0, Y.f)();
       return n?.dataLayout?.configDir?.projectDirName
         ? t.join(this.getWorkDir(), n.dataLayout.configDir.projectDirName)
         : t.join(this.getWorkDir(), ".codebuddy");
     }
     ```
   - `app.asar` 中 `buildAgentCliRuntimeEnv` 启动 CLI 后端时**显式注入**：
     - `CODEBUDDY_HOST="workbuddy-desktop"`
     - `CODEBUDDY_CONFIG_DIR="~/.workbuddy"`、`WORKBUDDY_CONFIG_DIR="~/.workbuddy"`
     - `WORKBUDDY_DATA_FOLDER_NAME=".workbuddy"`
     - **`CODEBUDDY_PROJECT_CONFIG_DIR=".workbuddy"`**
   - `PathUtils.getSettingsFilePath(SettingsScope.PROJECT)` 返回 `join(PathUtils.getProjectHomeDir(), "settings.json")`，因此在 WorkBuddy Desktop 中项目级配置精确落在：
     - **`<project>/.workbuddy/settings.json`**（提交到仓库的项目级配置）
     - **`<project>/.workbuddy/settings.local.json`**（本地私有覆盖）
   - `HookManager.getHooks(event)` 从 `settingsManager.get("hooks")` 加载配置，并按 `settingSources` 合并 `user`、`project`、`local` 三个作用域（`setting-sources.js` 默认 `["user", "project", "local"]`）。

2. **关键发现：WorkBuddy Desktop 禁用了 `AGENTS.md` / `CODEBUDDY.md` 自动注入**：
   - `app.asar` 中 `buildWorkbuddyAgentPolicyEnv()` 显式设置了 **`CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD: "1"`**。
   - `codebuddy-lite-wb.mjs` 中 `shouldInjectSystemReminder()` 检测到该环境变量为 `"1"` 时直接返回 `false`，跳过项目 `CODEBUDDY.md` / `AGENTS.md` 的 `<system-reminder>` 注入。
   - 与之相对，**`injectHookContexts()` 不受该变量影响**：`SessionStart` 与 `UserPromptSubmit` hook 返回的 `hookSpecificOutput.additionalContext` 会直接包装为 `<system-reminder data-role="hook">...</system-reminder>` 注入模型输入。
   - **实施结论**：WorkBuddy 的桥接不得依赖 `AGENTS.md` 或 `CODEBUDDY.md` 自动生效，而应：
     1. 将 Hook 配置写入 **`<project>/.workbuddy/settings.json`**；
     2. 通过 `SessionStart` 与 `UserPromptSubmit` hook 的 `additionalContext` 在注入 `knit context` 时附带简短 WorkBuddy 主会话运行提示（含角色边界与 GUI 派发降级说明），确保每次生效且支持去重。

3. **项目信任（Workspace Trust）门禁**：
   - `app.asar` 中 `resolveWorkspaceTrustConfiguration` 显示：当项目目录尚未被用户信任（`restricted === true`）时，`runtimeSettingSources` 会被收缩为 `["user"]`（忽略 `.workbuddy/settings.json`），且 `Bash` 会被加入 `runtimeDeniedTools`。
   - 用户在 WorkBuddy GUI 中确认信任该项目目录后，`settingSources` 恢复为 `["user", "project", "local"]`，`.workbuddy/settings.json` 中的项目级 Hook 与 `Bash` 工具自动生效。

### 1.2 未核实项

- 在真实 `WorkBuddy.app` GUI 窗口打开新目录并点击「信任工作区」后的完整端到端弹窗交互，未实机点击复核。

---

## 2. Hook 生命周期事件与真实输入输出协议

### 2.1 真实 stdin JSON 样本（源自 `codebuddy-lite-wb.mjs`）

`HookExecutor.execute` 将事件输入对象剔除 `session` 后 `JSON.stringify` 写入子进程 `stdin`，各事件构造如下：

1. **`SessionStart`**（`executeSessionStartHooks`）：
   ```json
   {
     "session_id": "<session-id>",
     "transcript_path": "/Users/<user>/.workbuddy/projects/<compressed-cwd>/<session-id>.jsonl",
     "hook_event_name": "SessionStart",
     "source": "startup"
   }
   ```
   - **关键陷阱**：`SessionStart` 的 stdin JSON **不包含 `cwd` 字段**！但 `executeCommandHook` 会传入 `CODEBUDDY_PROJECT_DIR` / `CLAUDE_PROJECT_DIR` 环境变量，且 Hook 进程默认工作目录在项目目录。因此 `knit hook workbuddy` 解析工作目录必须依次回退：
     `payload.cwd || process.env.CODEBUDDY_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()`。

2. **`UserPromptSubmit`**（`executeUserPromptSubmitHooks`）：
   ```json
   {
     "session_id": "<session-id>",
     "transcript_path": "/Users/<user>/.workbuddy/projects/<compressed-cwd>/<session-id>.jsonl",
     "cwd": "/path/to/project",
     "hook_event_name": "UserPromptSubmit",
     "prompt": "用户本轮输入文本",
     "is_internal_continuation": false
   }
   ```
   - 当 `is_internal_continuation === true` 时为引擎内部续跑（如后台任务完成通知唤醒），仍可走哈希去重逻辑——内容变化时自动刷新上下文，未变时零输出跳过。

3. **`PreToolUse`**（`executePreToolUseHooks`）：
   ```json
   {
     "session_id": "<session-id>",
     "transcript_path": "/Users/<user>/.workbuddy/projects/<compressed-cwd>/<session-id>.jsonl",
     "cwd": "/path/to/project",
     "hook_event_name": "PreToolUse",
     "tool_name": "Bash",
     "tool_input": {
       "command": "knit deliver k-xxxx --authorization \"...\"",
       "timeout": 120000,
       "description": "Deliver task",
       "run_in_background": false
     },
     "call_id": "<call-id>",
     "tool_use_id": "<call-id>"
   }
   ```

4. **Bash 工具真实 `matcher` 名称**：
   - 工具常量 `L3.BASH = "Bash"`（首字母大写；`aliases` 含 `"bash"`，但 `executePreToolUseHooks` 传入的 `tool_name` 为 `t.name === "Bash"`）。
   - `HookManager.findMatchingHooks` 使用 `new RegExp(entry.matcher).test(toolName)` 匹配，配置 `"matcher": "^Bash$"` 精确拦截 Bash 调用。

### 2.2 `transcript_path` 会话记录格式与用户消息提取规则

`SessionStore.getSessionFilePath(sessionId)` 指向 JSONL 文件（每行一个 JSON 对象）。结合 `InputItemUtils.createUserMessage` 与 `AcpUtils.convertHistoryItemContentToAcp` 的实现：

- **真实用户消息条目的形状**：
  ```json
  {
    "id": "msg-...",
    "type": "message",
    "role": "user",
    "content": [
      { "type": "input_text", "text": "用户原文……" }
    ],
    "providerData": { "skipRun": false }
  }
  ```
  或 `content` 直接为字符串 `"用户原文……"`。
- **必须过滤的伪用户条目**（防止系统消息、压缩边界、Hook 注入内容混入授权匹配）：
  1. 仅接受 `entry.type === "message" && entry.role === "user"`；
  2. 跳过满足任一条件的系统合成条目：
     - `entry.providerData?.isMeta === true`
     - `entry.providerData?.isCompactInternal === true`
     - `entry.providerData?.agent === "compact"`
     - `entry.providerData?.goalStatus != null`
     - `entry.providerData?.scheduledTaskTrigger != null`
     - `entry.providerData?.contentFilterNotice === true`
     - `entry.providerData?.hookStatus != null`
  3. 对 `content` 数组仅提取 `part.type === "input_text" && typeof part.text === "string"` 的文本；
  4. **剥离引擎附加的 `<system-reminder ...>...</system-reminder>` 标签块**（因为 `MessageUtils.addSystemReminder` 会把 `<system-reminder data-role="hook">...</system-reminder>` 拼接进用户消息文本块中！），仅保留真实用户输入正文后再交给 `src/application/host-hook.ts` 做原话授权校验。
- 助手消息为 `role: "assistant"`、`content: [{ type: "output_text", text }]`，自然排除。

### 2.3 真实有效的输出协议（源自 `HookExecutor.parseHookOutput` 与各事件调用点）

1. **上下文注入（`SessionStart` / `UserPromptSubmit`）**：
   - 推荐输出 `exit 0` + 结构化 JSON：
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "SessionStart",
         "additionalContext": "<待注入的 Knit 上下文与简短宿主提示>"
       }
     }
     ```
     （`UserPromptSubmit` 对应 `"hookEventName": "UserPromptSubmit"`）。
   - 若当前目录无 `.knit/` 或上下文 SHA-256 未变化：直接 `exit 0` 且**不输出任何 stdout**，不向会话注入冗余 `<system-reminder>`。

2. **`PreToolUse` 拒绝执行**：
   - 推荐输出 `exit 0` + 结构化 JSON（`parseHookOutput` 明确警告顶层 `decision: "block"` 已废弃，要求使用 `hookSpecificOutput.permissionDecision`）：
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "permissionDecision": "deny",
         "permissionDecisionReason": "<明确拒绝原因与下一步做法>"
       }
     }
     ```
   - `parseHookOutput` 将其设为 `allowed: false, blockSource: "json", blocking: true`，`executeToolWithHooks` 阻断本次 Bash 工具执行并把原因回传模型。

3. **`PreToolUse` 透传环境变量（`knit context --use` / `--unuse`）**：
   - `executePreToolUseHooks` 读取 `hookSpecificOutput.updatedInput` 作为 `modifiedInput`，由 `executeToolWithHooks` 合并回工具入参 `tool_input`：
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "updatedInput": {
           "command": "KNIT_HOST=workbuddy KNIT_HOST_SESSION=<id> knit context --use k-xxxx"
         }
       }
     }
     ```
   - **角色红线**：`PreToolUse` 绝不为 `knit run start` 注入 `KNIT_SESSION_AGENT=workbuddy`（WorkBuddy 仅作为主会话调度者，绝不作为 Worker）。

### 2.4 `.workbuddy/settings.json` 的 Hook 声明结构

与内置插件 `hooks.json` 及 `HookManager.getHooks` 一致，项目级 `.workbuddy/settings.json` 使用按事件分组的数组格式：

```json
{
  "hooks": {
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<PATH 引导命令> knit hook workbuddy session-start"
          }
        ]
      }
    ],
    "UserPromptSubmit": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "<PATH 引导命令> knit hook workbuddy user-prompt-submit"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "^Bash$",
        "hooks": [
          {
            "type": "command",
            "command": "<PATH 引导命令> knit hook workbuddy pre-tool-use"
          }
        ]
      }
    ]
  }
}
```

---

## 3. 桌面 GUI 环境下的 `PATH` 与 Node／CLI 可达性

### 3.1 重大实测发现：WorkBuddy 会把内置 Node v22.22.2 前置到 `PATH` 最前

- `app.asar` 中 `resolveWorkbuddyManagedRuntimeEnv` 会把 WorkBuddy 托管的 Node 目录（本机实测为 `~/.workbuddy/binaries/node/versions/22.22.2-6/bin`，版本 **`v22.22.2`**）**前置（prepend）到 `PATH` 最前面**，并写入 `CODEBUDDY_SHELL_PREPEND_PATH`。
- 而 Knit 要求 **Node >= 24**，且桌面 App 启动时 `PATH` 默认只有 `/usr/bin:/bin:/usr/sbin:/sbin`（不含 Homebrew、mise、volta、`~/.local/bin`）。

### 3.2 模拟 WorkBuddy GUI 最小环境的对照实测结果

在 `env -i HOME="$HOME" USER="$USER" SHELL="/bin/zsh" PATH="$HOME/.workbuddy/binaries/node/versions/22.22.2-6/bin:/usr/bin:/bin:/usr/sbin:/sbin"` 下实测：

| 引导方式 | `node` 解析结果 | `knit` | `pi` | `agy` | 结论 |
| --- | --- | --- | --- | --- | --- |
| 直接 `sh -c`（Hook 默认 POSIX shell） | `~/.workbuddy/.../22.22.2-6/bin/node` (**v22.22.2**) | 未找到 | 未找到 | 未找到 | **不可用**（缺 `knit` 且 Node 版本过低） |
| `/bin/zsh -lc`（仅 login） | `/opt/homebrew/bin/node` (v26.13.1) | 未找到 | 未找到 | `/opt/homebrew/bin/agy` | **不完整**（不读 `~/.zshrc`，丢 `mise`/`~/.local/bin`） |
| `/bin/zsh -ic`（仅 interactive） | `~/.workbuddy/.../22.22.2-6/bin/node` (**v22.22.2**) | 未找到 | `~/.local/bin/pi` | 未找到 | **不完整**（不读 `~/.zprofile`） |
| `/bin/zsh -lic` | `~/.local/share/mise/.../node` (**v26.3.0**) | 找到 | `~/.local/bin/pi` | `/opt/homebrew/bin/agy` | 可用，但每次 Hook 启动加载交互 shell 较慢且可能受用户 prompt 插件污染 stdout |
| **通用标准路径前置 + fallback（推荐）** | `~/.local/share/mise/shims/node` (**v26.3.0**) | `~/.local/share/mise/shims/knit` | `~/.local/bin/pi` | `/opt/homebrew/bin/agy` | **快速（~100ms）、零个人路径硬编码、无交互 shell stdout 污染** |

### 3.3 推荐的可移植最小引导命令

在 `.workbuddy/settings.json` 的 Hook command 中使用如下纯 POSIX `sh` 引导（按优先级从低到高依次前置常见用户级工具目录，确保 `$HOME/.local/share/mise/shims` 等排在 WorkBuddy 自带 Node 22.22.2 之前；仅在仍找不到 `knit` 时才回退用户的 login+interactive shell）：

```sh
for d in /usr/local/bin /opt/homebrew/bin "$HOME/.local/bin" "$HOME/.volta/bin" "$HOME/.asdf/shims" "$HOME/.local/share/mise/shims"; do [ -d "$d" ] && PATH="$d:$PATH"; done; export PATH; if command -v knit >/dev/null 2>&1; then exec knit hook workbuddy <event>; else exec "${SHELL:-/bin/zsh}" -lc 'exec knit hook workbuddy <event>'; fi
```

- 在本机模拟 WorkBuddy GUI 最小环境下实测：`node` 解析为 `v26.3.0`（或 `/opt/homebrew/bin/node v26.13.1`），`knit --version` 正常输出 `0.1.0`，`pi` 与 `agy` 均可达，且不硬编码任何个人用户名或版本号。
- 若用户环境使用 `nvm`/`fnm` 等纯 `~/.zshrc` 初始化工具链，且 `knit` 不在常见 shims 目录中，说明文档应提示可通过 `~/.zprofile` 或 mise/volta shims 暴露 `node >= 24` 与 `knit`。

---

## 4. 后台执行与唤醒能力（桌面 GUI 降级档位结论）

### 4.1 已核实事实

1. **Bash 工具原生参数与超时**：
   - `codebuddy-lite-wb.mjs` 中 `BashTool` 支持 `run_in_background: boolean` 与 `timeout: number`；
   - 前台默认超时 `BASH_DEFAULT_TIMEOUT_MS = 120000`（120 秒），上限 `BASH_MAX_TIMEOUT_MS = 600000`（600 秒）；
   - `executeInBackground` 将 `timeout` 设为 `0`（无超时），任务结束后引擎构建 `<task-notification>` 投入会话消息队列并调度唤醒（可配合 `TaskOutput` 读取输出）；
   - `app.asar` 未设置 `CODEBUDDY_CODE_DISABLE_BACKGROUND_TASKS`。

2. **孤儿进程回收与 `detached` worker 存活**：
   - `cli/bin/no-orphans.cjs` 显式写明仅在 Windows（`platform === 'win32'`）安装 Job Object；**macOS 上直接返回 `false`**。
   - 在 macOS 上通过同步 `/bin/zsh -c` 启动 `spawn(..., { detached: true, stdio: "ignore" })` + `unref()` 的后台进程，实测父 shell 退出后子进程继续存活并正常落盘（`after 700ms survived? true ok`）。

3. **桌面沙箱约束（关键降级前提）**：
   - `codebuddy-lite-wb.mjs` 中当 `host === "workbuddy-desktop"` 时，沙箱策略强制 `allowUnsandboxedCommands = false`（除非模型传 `dangerouslyDisableSandbox: true` 且用户审批），且若沙箱返回 `capabilities.background === false`，`BashTool` 会直接拒绝 `run_in_background: true` 并返回 `ExecuteCommandBackgroundUnsupportedError`。
   - **未核实项**：在真实 `WorkBuddy.app` GUI 窗口的 macOS Seatbelt 沙箱（`SandboxHelper`）中：
     - `knit run start <id>` 访问 `~/.knit/worktrees/` 及外部模型 API / `pi` / `agy` 是否需要用户批准 `dangerouslyDisableSandbox`；
     - `Bash({ run_in_background: true })` 触发的 `<task-notification>` 在 WorkBuddy Desktop 5.9.3 GUI 中是否自动续跑下一轮。
     这两项需在后续实机 GUI 窗口中复核。

### 4.2 面向 `k-eaa1664e9b5f` 的降级档位设计结论

WorkBuddy 主会话桥接采用**无 Rex 窗格 + 两档自适应等待**策略（写入 WorkBuddy 注入规则文案）：

1. **派发**：直接执行 `knit run start <id>`（前台秒返，在后台 `detached` 拉起 `.knit/workflow.yaml` 指定的 `pi` 或 `agy` worker；无 Rex 窗格时自动退化为无头后台模式；绝不传 `KNIT_SESSION_AGENT=workbuddy`）。
2. **等待**：
   - **首选**：尝试 `Bash({ command: "knit run wait <id>", run_in_background: true })` 后台挂等并等待 `<task-notification>` 唤醒；
   - **自动降级**：若当前 WorkBuddy 沙箱不支持 `run_in_background` 或返回后台模式不可用错误，绝不把无上限 `knit run wait <id>` 挂在 120s 前台超时里卡死，而是按需短等 `knit run wait <id> --timeout 60`（超时退出码 0 返回当前状态）或直接向用户汇报已派发并结束当前轮次，等用户下次发消息时由 `UserPromptSubmit` hook 自动注入最新完成状态。
3. **沙箱提示**：若执行 `knit run start` 时命中 WorkBuddy 沙箱路径/网络拦截，明确告知用户批准本次命令的沙箱豁免（`dangerouslyDisableSandbox`）或在终端继续。
