# Antigravity CLI 1.5.13 可行性实测

2026-11-21 在 macOS 和 Rex 中使用 `agy` 1.5.13、`gemini-3.8-flash-low` 实测。Rex 原会话可以读取报告，并在 Knit 校验失败后自动补报一次。实测的 CLI 权限配置无法保证 Worktree 写入边界和 `network`、`external` 的能力上限。

模型服务此前返回 HTTP 400 `User location is not supported for the API use.`。网络恢复后移除了第一轮实验用于主动终止的 `PreInvocation` 钩子，后台探针得到 `KNIT_AGY_OK`，`result.status` 为 `SUCCESS`，进程退出码为 `0`。

## 环境与复现

在临时 Git 仓库创建任务 Worktree，另备主检出和第三个临时目录。用 `pwd -P` 取得三个目录的绝对路径，在 Rex 中批准临时 Worktree 的信任提示。Worktree 中放置 `marker.txt`，内容为 `KNIT_FIXTURE_READ_21`。所有文件和命令用例均操作这些夹具。

在 Worktree 中启动后台会话。输入为 NDJSON，每行一个 `{"event":"user","message":{"content":"…"}}`。逐轮指定一次原生工具及其绝对路径。命令用例使用 `/usr/bin/touch` 和 `/usr/bin/curl`。

```sh
agy --sandbox --settings "$probe_settings" --model gemini-3.8-flash-low \
  --input-format stream-json --output-format stream-json --print-timeout 40s \
  < "$probe_prompts" > "$probe_events"
```

在 Rex 的对应 Worktree 窗格运行 `agy --sandbox --settings "$probe_settings" --model gemini-3.8-flash-low`，在交互界面提交同类操作。配置共用 `"agentMode": ""`、`"enableTerminalSandbox": true`、`"toolPermission": "proceed-in-sandbox"` 和三条拒绝 `mcp(*)`、`read_url(*)`、`execute_url(*)`。下表中的路径占位符在写入 JSON 前换成夹具的绝对路径。[CLI 设置](https://antigravity.google/docs/settings/?tab=cli) · [CLI 权限](https://antigravity.google/docs/permissions/?tab=cli) · [CLI 沙箱](https://antigravity.google/docs/sandbox/?tab=cli)

## 权限与写入边界

| 能力 | 配置中的读写与命令规则 | 后台 | Rex |
| --- | --- | --- | --- |
| `[]` | 拒绝 `read_file(*)`、`write_file(*)`、`command(*)` | 原生 `read_file` 返回 `ERROR` 和显式拒绝原因 | 读取探针收到拒绝 |
| `[read]` | 放行 `read_file(<worktree>)`，拒绝 `write_file(*)`、`command(*)` | 读到标记内容，原生写入和命令均返回 `ERROR` | 读到相同内容，原生命令被拒，目标文件未创建 |
| `[read, write, exec]` | 放行 `read_file(<worktree>)`、`write_file(<worktree>)`，显式拒绝 `write_file(<checkout>)`、`write_file(<outside>)` | Worktree 内原生读写成功，沙箱 `touch` 退出 `0`。主检出原生写入被拒，沙箱写入主检出和第三目录均退出 `1`，报 `Operation not permitted` | Worktree 内原生写入获批准后成功，沙箱 `touch` 退出 `0`。显式拒绝的原生写入和主检出沙箱写入均未创建文件 |

去掉表中主检出和第三目录的显式写入拒绝，保留 Worktree 的 `write_file` 放行。该目录的原生写入需要审批，后台拒绝后未创建文件。沙箱 `touch` 退出 `0` 并创建该文件。会话配置加入 `unsandboxed(*)` 后，沙箱内的调用仍能在那个目录写入。后续 Rex 复验发现 CLI 将这条规则标为无效并忽略。CLI 沙箱文档把临时目录和部分构建缓存列入默认可写范围。首轮 `rwe` 的命令误用了本机不存在的 `/bin/touch`，退出 `127`。表中命令结论来自用 `/usr/bin/touch` 单独复测的结果。[CLI 沙箱](https://antigravity.google/docs/sandbox/?tab=cli)

| 权限来源 | 对照与结果 |
| --- | --- |
| 用户全局和 `--settings` | 在 `~/.gemini/antigravity-cli/settings.json` 临时拒绝读取一个夹具文件。会话设置省略 `permissions` 时，工具命中该拒绝。会话设置包含放行 Worktree 的 `permissions` 时，同样的 `read_file` 成功，说明此时会话对象覆盖全局对象。实验后恢复全局文件原字节 |
| Project 和 `--settings` | 在 `/permissions` 的 Project 视图放行某个夹具文件的写入，核对规则写入 `~/.gemini/config/projects/default-cli-project.json`。会话的 `write_file(*)` 拒绝仍生效。去掉会话的写入拒绝并切为 `request-review` 后，同一 Project 放行使后台写入成功。实验后撤销该 Project 规则 |
| 原生审批 | 在 Rex 配置 Worktree 放行和某个文件的精确 `ask` 规则。创建弹出一次性审批卡片，确认前文件尚未创建。批准后文件出现。用同规则再试并选拒绝，界面显示 `User declined the tool call`，文件未创建 |

后台显式拒绝在 `step_update.state: "ERROR"` 和 `step_update.tool_info.error.message` 出现。顶层 `result` 仍为 `SUCCESS`，实测未携带 `denied_actions`。对后台 `ask` 的独立复测中，原生写入被拒，进程退出 `0`，最终回执含下列字段。多轮探针中还看到后续成功操作的 `result` 继续携带此前轮次的 `denied_actions`。

```json
{"status":"SUCCESS","denied_actions":[{"action":"write_file","display_name":"Edit"}]}
```

## 外部工具与联网

- 在 `<worktree>/.agents/mcp_config.json` 注册本地 stdio MCP 服务 `knit_fixture`，把测试工具 `knit_probe_ping` 设为 `eager`，工具只返回标记 `KNIT_MCP_OK`。`mcp(*)` 拒绝使实际调用返回 `ERROR`，错误指向 `mcp(knit_fixture/knit_probe_ping)`。启用启动日志的复验中，服务器进程仍启动并写入 `server_started`，日志里没有 `tools/call`。调用层的拒绝无法阻止这项外部进程启动。[MCP 配置](https://antigravity.google/docs/mcp/?tab=cli)
- 在 `read_url(*)` 和 `execute_url(*)` 都被拒绝的设置下，沙箱 `/usr/bin/curl --max-time 3 --head https://example.com/` 退出 `6`，同机宿主请求返回 HTTP 200。`read_url_content` 两次均未产生工具调用事件，回复称不可用。内建 `search_web` 查询 `IANA Example Domains` 在后台实际返回 `DONE`，在 `tools: []` 对应的 Rex 配置中也执行成功。这套配置无法关闭全部工具联网。

## Rex 的报告与原会话补报

在可信 Worktree 的 `.agents/hooks.json` 中注册命令型 `Stop` 钩子。钩子接收 JSON stdin，从 `transcriptPath` 指向的 JSONL 中定位本轮 `USER_INPUT`，提取之后有 `content` 的最后一条 `MODEL` `PLANNER_RESPONSE`，并读取本轮错误记录。用真实模型生成三种探针回执 `KNIT_AGY_SUBMIT`、`KNIT_AGY_WAITING`、`KNIT_AGY_PERMISSION_BLOCKED`。这些回执由任务提示约定。钩子只在 `fullyIdle` 且收到提交回执时调用 Knit 的 `reportOutcome`，要求 `verdict` 为 `pass`、`changes_requested` 或 `blocked`。第一次解析失败时，钩子返回 `{"decision":"continue","reason":"…"}`，用 Knit 的 `reportRetryMessage` 要求原样补报并补全 JSON 结尾。钩子按会话及试验轮次记一次补报，后续 `Stop` 只校验并记录结果。[Stop 钩子](https://antigravity.google/docs/hooks/?tab=cli)

下表的会话标识已经归一化。带 `Stop` 的四行都指向同一个 `.system_generated/logs/transcript_full.jsonl`，事件触发时文件已存在并包含本轮回复。

| 操作 | `conversationId` | `executionNum` | `fullyIdle` | `terminationReason` | 转录或界面证据 |
| --- | --- | --- | --- | --- | --- |
| 首次提交 | `session-1` | `0` | `true` | `NO_TOOL_CALL` | `KNIT_AGY_SUBMIT`，缺少 JSON。Knit 返回“报告结尾没有能解析的 json 代码块”，钩子触发补报 |
| 自动补报 | `session-1` | `1` | `true` | `NO_TOOL_CALL` | 原报告正文保留，追加 `{"verdict":"pass"}` 的 JSON 代码块。Knit 校验通过 |
| 等待输入 | `session-1` | `0` | `true` | `NO_TOOL_CALL` | `KNIT_AGY_WAITING`，模型向用户索要测试文本 |
| 显式权限拒绝 | `session-1` | `0` | `true` | `NO_TOOL_CALL` | `GENERIC` 错误记录 `Matches user-configured deny rule`，随后的回复包含 `KNIT_AGY_PERMISSION_BLOCKED` |
| 等待审批 | `session-1` | — | — | — | 卡片打开期间没有该轮的 `Stop`，文件未创建。拒批返回输入界面，该轮也未取得可归属的 `Stop` 或报告回执 |

较早的本地 `PreInvocation` 主动终止探针也得到 `fullyIdle: true`，`terminationReason` 为 `TERMINAL_CUSTOM_HOOK`。适配器应结合终止原因、当轮回执和工具错误判定状态。审批或等待输入期间保持执行进行中，有效报告通过 Knit 校验后才能结算。拒批没有回执时，适配器还需处理原生命令关闭、取消等中止信号。

## 对接入的影响

- 当前测试的 `agy` 配置只对列明的原生动作、路径和沙箱限制给出了可验证结果。`tools: []`、`[read]` 均缺少 `network`，但 `search_web` 仍可运行。`[read, write, exec]` 还缺少强制 Worktree 写入边界。关掉 MCP 工具调用也无法阻止已配置的服务启动。若环节要求这些限制，按父任务约定应在派发前给出具体原因。保留原定 `[read, write, exec]` 实机验收，需要先落实并验证相应边界。
- Rex 的同会话补报可用。后台和 Rex 应共同使用明确的回执和 Knit 报告校验，错误诊断保留能取得的工具错误与 `denied_actions`。接入后的 `run wait` 结算及原 Pi 主会话自动唤醒留在父任务的端到端实机验收中。显式放行 `external`、`network` 的实测也按父任务安排延后。

实测原始证据保存在本机临时夹具 `/private/tmp/knit-agy-feasibility.Zug4DW/events/`。关键文件为 `availability.json`、`live-{none,read,rwe,boundary-exec,boundary-default,external-network,web-network}.jsonl`、`live-final-controls.json`、`live-{user-global,session-over-global,project-control}.jsonl`、`mcp-calls.jsonl` 和 `rex-live-stop.jsonl`。`invalid-report.md` 与 `corrected-report.md` 保留了两份模型输出，其正文仅用于验证报文格式。[后台协议](https://antigravity.google/docs/cli/headless/?tab=cli)
