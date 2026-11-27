# Qoder 桌面端主会话 Hook 协议静态探针摘录

- 探针对象：本机 `/Applications/Qoder.app`（`0.5.20`，`productId: "qoder"`，内嵌 `@qoder-ai/qoder-agent-sdk 1.0.62-alpha.9` 与 `qoder-worker-runtime 1.1.96-hotfix.8`）
- 探针方式：只读分析 `Contents/Resources/app.asar`（`out/main/electronMain.js`、`node_modules/@qoder-ai/qoder-agent-sdk/dist/index.js`）与 `Contents/Resources/app.asar.unpacked/node_modules/@qoder-ai/qoder-agent-sdk/dist/_worker/{qoder-worker-runtime.obf.mjs,qoder/hook-config/SKILL.md}`。
- 边界声明：未修改 `~/.qoder/` 配置，未读取用户凭据或私有会话记录。真实 `Qoder.app` GUI 窗口端到端点击运行留待代码合入与全局重装后补验。

---

## 1. 项目配置路径与生效条件

1. **配置目录与文件**：
   - 项目级配置目录为 `<project>/.qoder/`，项目共享 Hook 配置文件为 `<project>/.qoder/settings.json`（本地覆盖为 `<project>/.qoder/settings.local.json`）。
   - `Qoder` 运行时会加载项目根目录的 `AGENTS.md`。
2. **默认 Agent 与自定义 Agent 边界**：
   - `electronMain.js` 中 `UGe(agentId)` 判断 `agentId === "agent:default"`。
   - 默认主 Agent（`agent:default`）下 `synchronizedDeviceCapabilities = true`，传给 worker 的 `settingSources` 为 `undefined`，worker 默认加载 `["user", "project", "local"]`，因此 `<project>/.qoder/settings.json` 自动生效。
   - 若用户切换为自定义 Agent，`esr()` 将 `settingSources` 收窄为 `["user"]` 或 `[]`，项目级 `.qoder/settings.json` 不会加载（需在文档中注明）。

---

## 2. Hook 配置格式与环境变量

1. **`<project>/.qoder/settings.json` 结构**：
   ```json
   {
     "hooks": {
       "SessionStart": [{ "hooks": [{ "type": "command", "command": "sh \"${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}/.qoder/knit-hook.sh\" session-start" }] }],
       "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "sh \"${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}/.qoder/knit-hook.sh\" user-prompt-submit" }] }],
       "PreToolUse": [{ "matcher": "^Bash$", "hooks": [{ "type": "command", "command": "sh \"${QODER_PROJECT_DIR:-${CLAUDE_PROJECT_DIR:-.}}/.qoder/knit-hook.sh\" pre-tool-use" }] }]
     }
   }
   ```
2. **注入给 Hook 子进程的环境变量**：
   - `qoder-worker-runtime.obf.mjs` 的 `prepareEnv` 同时注入 `QODER_PROJECT_DIR`（由 `MC("PROJECT_DIR")` 生成）和 `CLAUDE_PROJECT_DIR`，均指向项目根路径。
   - 桌面 GUI 启动下 `PATH` 仍可能缺少用户工具链（Homebrew、mise、volta、`~/.local/bin` 等），`.qoder/knit-hook.sh` 应沿用 WorkBuddy 的通用 `PATH` 前置引导并校验 `node >= 24`，找不到时回退 `${SHELL:-/bin/zsh} -lc`。

---

## 3. 事件 Stdin JSON 与工具名

`createBaseInput(eventName)` 构造所有事件的公共字段：

```json
{
  "session_id": "<session-id>",
  "transcript_path": "/Users/<user>/.qoder/projects/.../<session-id>.jsonl",
  "cwd": "/path/to/project",
  "hook_event_name": "SessionStart | UserPromptSubmit | PreToolUse"
}
```

- 解析项目目录时仍应按 `payload.cwd || process.env.QODER_PROJECT_DIR || process.env.CLAUDE_PROJECT_DIR || process.cwd()` 回退，兼容缺少 `cwd` 的边界情况。
- `PreToolUse` 额外携带 `tool_name`（Bash 工具名常量为 `"Bash"`）与 `tool_input`（对象，命令字段为 `tool_input.command`，可能同时包含 `timeout`、`description`、`run_in_background` 等其它字段）。

---

## 4. Hook Stdout JSON 协议（含关键差异）

`hook-config/SKILL.md` 与 `qoder-worker-runtime.obf.mjs`（类 `ZT`、`D9`、`Wue`）核实结果：

1. **必须带 `hookEventName`**：任何返回 `hookSpecificOutput` 的输出都必须包含匹配当前事件的 `hookEventName`，否则被 runtime 拒绝。无需注入或直接放行时可静默返回空输出（`exit 0`）。
2. **上下文注入（`SessionStart` / `UserPromptSubmit`）**：
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "SessionStart",
       "additionalContext": "..."
     }
   }
   ```
   - 注意：`qoder-worker-runtime.obf.mjs` 中 `cD()` 对部分钩子输出的截断阈值常量 `ufA = 10000` 字符（超长时落盘并提示路径）；Knit 现有的 `hostContext` 分块去重有助于降低后续轮次长度，指引文案应保持精炼。
3. **`PreToolUse` 拒绝**：
   ```json
   {
     "hookSpecificOutput": {
       "hookEventName": "PreToolUse",
       "permissionDecision": "deny",
       "permissionDecisionReason": "..."
     }
   }
   ```
4. **`PreToolUse` 改写输入（与 WorkBuddy 的关键差异！）**：
   - Qoder worker 在处理 `PreToolUse` 的 `hookSpecificOutput.updatedInput` 时执行**整对象替换**（`E = t; u = e.build(E, o)`），而非与原 `tool_input` 浅合并！
   - 因此改写 `command` 时必须返回保留其它原始字段的完整对象：
     ```json
     {
       "hookSpecificOutput": {
         "hookEventName": "PreToolUse",
         "updatedInput": {
           "...原 tool_input 其余字段": "...",
           "command": "env KNIT_HOST=qoder KNIT_HOST_SESSION='...' knit context --use k-xxxx"
         }
       }
     }
     ```

---

## 5. `transcript_path` JSONL 格式与真实用户消息提取（与 WorkBuddy 不同）

`qoder-worker-runtime.obf.mjs` 中判定真实用户消息的内部辅助函数（`c4e`、`MM`、`YLi`、`RO`、`rge`、`Pw`）显示，Qoder 的 JSONL 行结构为 Claude Code 风格：

- **真实用户消息条目**：
  ```json
  {
    "type": "user",
    "origin": { "kind": "human" },
    "humanInput": { "mode": "prompt" },
    "isMeta": false,
    "message": {
      "role": "user",
      "content": "用户输入正文"
    }
  }
  ```
  其中 `message.content` 也可以是数组：`[{ "type": "text", "text": "用户输入正文" }]`。
- **必须过滤的非真实用户条目**：
  1. `entry.type !== "user"`；
  2. `entry.isMeta === true`、`entry.isCompactSummary === true`、`entry.isVisibleInTranscriptOnly === true`、`entry.toolUseResult !== undefined`；
  3. 存在 `entry.origin` 且 `entry.origin.kind !== "human"`（例如内部任务/子 Agent/系统来源）；
  4. 存在 `entry.humanInput?.mode` 且不是 `"prompt"`（若字段缺省则不强拒）；
  5. `entry.message?.role` 存在且不为 `"user"`；
  6. `entry.message?.content` 为数组且包含 `tool_result` 块（如 `content[0]?.type === "tool_result"`）；
  7. 文本块中引擎自动包裹的宿主标签块：`<system-reminder>...</system-reminder>`、`<hook_context>...</hook_context>`、`<loaded_context>...</loaded_context>` 必须剥离，且含残缺未闭合标签的块应拒绝，防止注入内容绕过原话授权校验。
