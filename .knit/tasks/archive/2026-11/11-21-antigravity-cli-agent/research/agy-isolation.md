# Antigravity CLI 的运行隔离

2026-11-21 至 22 日在 macOS arm64、Rex 和 `agy` 1.5.13 中使用 `gemini-3.8-flash-low` 复验。工作区、外部目录和 MCP 服务都是临时夹具。官方 CLI 提供终端沙箱、权限审批、工具调用钩子和自定义 Agent。实测的 `PreToolUse` 能拦住内建网页搜索。外层沙箱允许会话保存转录，并能阻止工作区 MCP 夹具启动。把固定命令转给独立进程后，后台和 Rex 都实现了 Worktree 内写入和套接字访问限制。[CLI 参考](https://antigravity.google/docs/cli/reference/)

## 文件与命令

- 官方说明 `--sandbox` 隔离 Agent 启动的终端命令。文档列出的可写位置包括工作区、临时目录和常用构建缓存。沙箱命令默认无网络，`read_url` 的放行域名可进入出站白名单。`allowNonWorkspaceAccess` 默认为 `false`，用于控制原生文件读写。在 `--sandbox` 和 `allowNonWorkspaceAccess: false` 下，未获批的原生外部写入没有创建文件，沙箱 `touch` 仍在 Worktree 内和另一个临时目录各创建了一个文件并退出 `0`。[CLI 沙箱](https://antigravity.google/docs/sandbox/?tab=cli) · [设置 schema](https://antigravity.google/schemas/v1/settings.json)
- 本机 CLI 把会话设置中的 `unsandboxed(*)` 标为无效并忽略。此前加入这条规则后的 `touch` 结果仍可作为沙箱可写范围的证据。该结果无法用于证明这条拒绝规则生效。[CLI 权限](https://antigravity.google/docs/permissions/?tab=cli)
- 另用 macOS `sandbox-exec` 建立外层写入限制。裸 `touch` 在允许目录内退出 `0`，直接写外部目录和通过符号链接写同一目录均退出 `1`，错误为 `Operation not permitted`。同一限制下，`agy` 可以请求模型并读取夹具。原生外部写入在会话配置明确放行后仍被系统拒绝。`run_command` 在开启和关闭 CLI 内层沙箱时都因无法写入 `~/.gemini/antigravity-cli/bin/agentapi` 而在启动命令前失败。CLI 日志也记录了会话数据库和转录目录的写入错误。这个外层配置还不能同时提供命令执行和持久化会话。

## 工具和联网

- 在工作区 `.agents/hooks.json` 配置匹配 `.*` 的 `PreToolUse`。测试钩子只放行已知的读取工具。后台的 `read_file` 返回 `DONE`，`search_web` 返回 `ERROR`，带有钩子的 `KNIT_PROBE_TOOL_DENIED`。Rex 同样记录了 `search_web` 的拒绝。把钩子换成退出 `1` 的程序后，后台原生读取中止并返回工具错误。后台两种拒绝中的会话结果仍可为 `SUCCESS`。这次只验证了已加载钩子拦截这些调用的行为，联网边界还涉及 shell、浏览器、子 Agent 和 MCP。[CLI 钩子](https://antigravity.google/docs/hooks/?tab=cli)
- 用 `--agent knit-isolation-audit` 加载 `tools: [view_file, grep_search]` 的自定义 Agent。后台和 Rex 都读到夹具内容并返回自定义系统提示中的标记。要求搜索时，两处均回复工具不可用，后台未出现搜索工具事件。默认 Agent 的对照触发 `search_web` 并返回 `DONE`。自定义 Agent 会话的 `init.tools` 仍列出 `search_web`，此项可作为工具筛选线索。执行层拒绝仍以钩子记录为证。[自定义 Agent](https://antigravity.google/docs/subagents/?tab=cli) · [CLI 参考](https://antigravity.google/docs/cli/reference/)

## MCP 启动

- 官方说明 CLI 发现工作区、全局及插件的 MCP 配置，通用配置表列出逐服务的 `disabled` 和逐工具的 `disabledTools`。在相同 `mcp(*)` 拒绝下，分别给工作区 stdio 夹具设置 `disabled: false` 和 `disabled: true`，两次都记录到 `server_started`、`initialize` 和 `tools/list`，均未调用 MCP 工具。对照说明该版本的工作区配置不能依靠 `disabled: true` 防止进程启动。CLI 的官方启动参数和会话设置里也未找到一项关闭全部 MCP 来源的开关。[CLI MCP](https://antigravity.google/docs/mcp/?tab=cli) · [插件](https://antigravity.google/docs/plugins/?tab=cli) · [CLI 参考](https://antigravity.google/docs/cli/reference/)

## 2026-11-22 离线启动复验

在新建的临时 Git 仓库及 Worktree 中，把 stdio MCP 夹具写入 `<worktree>/.agents/mcp_config.json`。用 `sandbox-exec` 比较允许和拒绝读取该文件的两组行为。直接读取的退出码分别是 `0` 和 `1`，限制组报 `Operation not permitted`。`agy mcp list` 两组都退出 `0`，并输出没有配置 MCP 服务的提示。可读对照也没有检出工作区服务，实际的启动行为需用会话进程复验。

后台会话使用 `--sandbox`、临时会话设置和会在模型调用前终止的 `PreInvocation` 钩子。外层沙箱限制写入到临时夹具，拒绝读取全局 MCP 配置、钩子和插件。禁用全部网络时，`agy` 在绑定 `127.0.0.1` 时退出 `1`。允许回环后，套接字对照验证了可以绑定本机端口，非回环连接仍被拒绝。两组 `agy` 均记录全局 MCP 配置读取被拒，随后在 OAuth 初始化阶段超时。两组都未到达钩子和夹具服务启动。运行会话的对照改用下节的外层配置，允许 `agy` 访问模型服务。

试验摘要保存在 `/private/var/folders/25/wn233x_93rv9z2jjm9xzfm_00000gn/T/knit-agy-offline-64prjjng` 的 `offline-summary.json`、`loopback-summary.json` 和对应的 CLI 日志中。

## 2026-11-22 真实会话复验

在临时 Git 仓库的独立 Worktree 中配置工作区钩子和标记文件。后台用 `--print --output-format stream-json` 收集结果，Rex 用 `--prompt-interactive` 保持交互。两条路径都用外层 `sandbox-exec` 限制写入，允许 Worktree、夹具回执目录和 `~/.gemini/antigravity-cli/`，保护 Worktree 的 `.git` 文件、`.agents/` 和 CLI 的 `settings.json`。PTY 和终端初始化另外需要设备及少量运行文件写权限。沙箱允许 `agy` 访问模型服务，拒绝读取全局 MCP、钩子与全局和工作区的插件目录。用 `PreToolUse` 只放行试验指定的原生文件工具和固定命令。

| 检查 | 对照与结果 |
| --- | --- |
| MCP 随会话启动 | 保留 `disabled: true` 和 `mcp(*)` 拒绝。工作区配置可读时，后台夹具记录 `server_started`、`initialize` 和 `tools/list`。增加对 `.agents/mcp_config.json` 的读取拒绝后，后台和 Rex 都完成模型请求，CLI 日志记录配置读取被拒，夹具无启动记录。全局来源只核对了配置路径读取被拒。 |
| 原生文件写入 | 后台 `write_file` 在 Worktree 内返回 `DONE`，标记文件实际存在。外部写入返回 `ERROR` 和 `denied_actions`，外部目录无文件。会话结果仍为 `SUCCESS`。 |
| 会话与转录 | 在两个独立试验中设置 `ANTIGRAVITY_APP_DATA_DIR` 或 `ANTIGRAVITY_GEMINI_DIR`，同时禁止写默认状态目录。模型请求成功，但数据库仍尝试写 `~/.gemini/antigravity-cli/` 并被拒。允许写该目录后，后台退出后可用 `--conversation` 恢复同一会话并复述文件标记。Rex 连续两轮的 `Stop` 属于同一会话。两条路径都核对了实际数据库和钩子指向的转录。 |
| `agy` 自带终端沙箱 | 外层配置允许 PTY、终端初始化文件和 `~/.gemini/sandbox/profiles/` 后，内层 `sandbox-exec` 仍因 `sandbox_apply: Operation not permitted` 退出 `71`。命令没有运行。 |
| 仅外层沙箱 | 固定命令退出 `0`，Worktree 内写入成功，直接写外部目录、经符号链接写出和写同一仓库的主检出均返回 `EPERM`。命令成功连接回环 TCP 夹具，监听端实际收到字节。 |
| 独立命令进程 | 停用 `agy` 内层终端沙箱。`PreToolUse` 仅将一个固定命令的 `CommandLine` 改为调用本地套接字客户端。独立进程收到固定请求后，从 `agy` 进程树之外在新的 `sandbox-exec` 中运行预设命令，只允许写 Worktree 和 `/dev/null`，继续保护 `.agents/` 和 `.git`，并拒绝套接字网络。后台和 Rex 的命令均退出 `0`，只创建 Worktree 内文件。直接、符号链接和主检出写入、回环绑定和测试用非回环连接均返回 `EPERM`。后台还尝试连接回环 TCP 夹具，返回 `EPERM`，监听端未收到数据。Rex 第二轮请求另一个命令，钩子拒绝，文件未创建。两轮 `Stop` 在同一会话且均能取得转录。 |
| Rex 原生审批 | 固定命令的钩子一并返回 `overwrite.CommandLine`、`decision: force_ask` 和指向原命令的 `permissionOverrides`。审批卡片显示的是原命令。选一次性批准前，执行进程没有回执，目标文件未创建。批准后独立进程记录退出 `0`，只写入 Worktree，`Stop` 能取得转录。另启一轮选择拒绝，界面显示 `User declined the tool call`，独立进程没有执行记录，目标文件未创建。 |

独立进程试验复用了同一个固定写入和套接字探针，监听端只接受固定请求。通用命令转发、权限审批规则的组合、独立进程随取消退出、CLI 会话状态按任务隔离，以及浏览器、子 Agent 和插件等其余入口仍待核对。此轮只测了 macOS。下列本机临时回执位于 `/private/tmp/knit-agy-live-33dwqn1n/events/`。`visible-read.mcp.jsonl` 记录可读对照，`closed-resume.summary.json`、`masked-rex.hooks.jsonl` 记录续跑，`network-control.summary.json` 记录回环对照，`split-{headless,rex}.worker.json` 和 `split-{headless,rex}.hooks.jsonl` 记录独立命令进程及钩子行为，`approve-rex.worker.json` 和 `{approve,decline}-rex.hooks.jsonl` 对应原生审批试验。

## 对 Knit 接入的影响

外层沙箱加独立命令进程可用于设计 macOS 上的隔离，`agy` 会话保持模型连接与转录，命令进程单独限制文件和网络。若沿用首版 `tools: [read, write, exec]` 验收，要让通用命令经过同一边界，把固定夹具的原生审批扩展到适配器的权限映射，并核对缺少 `external`、`network` 时的其他入口。CLI 仍需要会话状态写权限，需确定如何保护和归属这些写入。适配器无法落实环节声明的限制时，在派发前报出缺失项。

本机证据在 `/private/tmp/knit-agy-feasibility.Zug4DW/isolation-u20wyxr4/events/`。`live-summary.jsonl` 和 `follow-summary.jsonl` 记录后台结果，`gate.hook.jsonl` 记录钩子决策，`rex-gate.capture.txt` 和 `rex-agent.capture.txt` 记录 Rex 行为，`mcp-{on,off}.mcp-started.jsonl` 记录进程启动和协议握手，`outer-summary.jsonl` 及 `outer-agy-*.jsonl` 记录外层沙箱。已断言工具状态、MCP 握手和文件是否实际存在。
