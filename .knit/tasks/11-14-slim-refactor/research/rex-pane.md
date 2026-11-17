# Rex 窗格：本机核实过的事实

2026-11-17 在本机核实：macOS 27.2.1、Rex `0.1.0-preview.14`（`rex version`）、Pi 1.5.2。除第 7 节列出的以外，每一条都是用临时脚本实际跑出来的，不调用模型。实现见 `design.md` 第 7.2 节和 `next/src/adapters/rex/pane.ts`、`next/src/adapters/pi/pane-worker.ts`、`next/src/application/run-pane.ts`；测试用假的 `rex`（`next/test/helpers/fake-rex.mjs`）和假的 Pi，不需要本机装有 Rex。旧实现在 `src/adapters/rex/`、`src/application/rex-launcher.ts`（共 2,377 行），只作参考，没有搬。

## 1. 怎么知道在 Rex 里

主会话在 Rex 里跑时，环境变量里有 `REX_SESSION`（`session:…`）和 `REX_BLOCK`（`block:…`，主会话所在的块）。它启动的进程（桥接运行的 `knit`、后台进程）都继承得到。本机 `REX_BIN_DIR` 是空的，`rex` 在 `PATH` 上。

## 2. 调用 Rex

```sh
rex --autostart=false api call <方法> '<JSON 参数>'
```

- 参数里必须有 `session_id`（值是 `REX_SESSION`）。不带时报 `session_id is required`，退出码不是 0。
- 成功时标准输出是一个 JSON 对象，退出码 0。失败时标准错误是 `Error: …`，退出码不是 0（关一个不存在的层是 3）。
- `--autostart=false`：没有 Rex 服务时不去启动它，直接失败。
- 一次调用约 0.07 秒。

用到的四个方法：

| 方法 | 参数 | 结果 |
| --- | --- | --- |
| `session.describe_block` | `{"block_id": REX_BLOCK}` | `{"block": {"window_id": "window:…", …}}` |
| `session.new_layer` | 见下 | `{"layer_id": "layer:…", "block_ids": ["block:…"], "revision": N}` |
| `session.set_layer_state` | `{"layer_id": …, "state": "minimized"}` | `{"revision": N}` |
| `session.close_layer` | `{"layer_id": …}` | `{"revision": N}`；层已经不在时失败（`not found`） |

`session.new_layer` 的参数（开一个浮动窗格，里面跑一条命令）：

```json
{
  "session_id": "<REX_SESSION>",
  "window_id": "<describe_block 得到的 window_id>",
  "bounds": [0.52, 0.48, 0.46, 0.48],
  "focus": false,
  "layout": { "block": {
    "flavor": "com.superlogical.terminal.shell",
    "label": "knit r-0123456789ab",
    "options": {
      "command": ["/usr/bin/env", "KEY=VALUE", "pi", "…"],
      "cwd": "<项目根>",
      "path_prepend": ["<PATH 里的各个目录>"],
      "size": { "columns": 120, "rows": 36 },
      "exit": { "on_completion": true }
    }
  } }
}
```

- `bounds` 是 `[x, y, 宽, 高]`，都是窗口宽高的比例。
- `command` 的各个参数原样交给程序：带空格、引号、`$HOME`、`*`、`;`、反斜杠的参数都没有变，`cwd` 带空格也可以。
- 终端的选项里没有环境变量这一项，要传环境变量就把命令写成 `/usr/bin/env KEY=VALUE … 程序 参数`。
- 不写 `shell` 时命令经用户的登录 shell 启动（读登录配置，不读交互配置），shell 随后被命令替换：窗格里的程序自己是进程组的组长，父进程是 Rex 服务，不是调用 `rex` 的进程。
- 窗格里的程序拿到的环境变量是 Rex 给的（里面有它自己的 `REX_BLOCK`），不是调用方的。`PATH` 要靠 `path_prepend` 传。
- 开窗格加最小化共约 0.25 秒；之后 Pi 的扩展约 1 秒内开始运行。
- 用 `rex send`、`rex send-key` 可以往窗格里的终端输入文字和按键（只看过帮助，没有用过），演练时可以用它代替人按键。

## 3. 窗格什么时候关

`exit.on_completion` 是 `true` 时：

| 情况 | 窗格 |
| --- | --- |
| 程序正常退出（退出码 0） | 自己关掉 |
| 程序被信号结束（SIGTERM） | 自己关掉 |
| 程序启动后 250 毫秒内就以非 0 退出 | 留着，让人看到错误 |
| 调用 `session.close_layer` 时程序还在跑 | 窗格关掉，程序收到 SIGHUP |

Pi 收到 SIGHUP 或 SIGTERM 后约 0.1 秒退出，退出前会触发扩展的 `session_shutdown`。

## 4. 等窗格里的程序结束

```sh
rex --autostart=false wait <块的 id> -s <REX_SESSION>
```

| 情况 | `rex wait` |
| --- | --- |
| 程序过一会儿以 0 退出 | 程序退出时返回，退出码 0 |
| 程序过一会儿以 7 退出 | 程序退出时返回，退出码 7 |
| 等的时候窗格被关掉 | 立即返回，退出码 1（`block … closed`） |
| 程序已经结束、窗格已经关掉之后才开始等 | 立即返回，退出码 3（`not found`） |
| 程序很快失败、窗格留着（第 3 节）之后才开始等 | 立即返回，退出码是程序的退出码 |
| 命令里的程序不存在 | 立即返回，退出码 127，窗格留着 |
| Pi 不认识 `--provider` | 约 0.6 秒后返回，退出码 1，窗格自己关掉 |

所以 `rex wait` 返回就表示窗格里的程序已经结束或者窗格已经没了，不需要看它的退出码。

## 5. 窗格里的 Pi

命令（参数和后台执行的一样，只是没有 `--mode rpc` 和 `--no-themes`）：

```
/usr/bin/env -u PI_SESSION_ID … PI_SKIP_VERSION_CHECK=1 PI_TELEMETRY=0 KNIT_PANE_DIR=<执行目录> \
  pi --no-prompt-templates --no-approve --offline --no-mcp --no-skills --no-extensions \
     --extension <扩展文件的绝对路径> --session-dir <执行目录>/session \
     --tools read,grep,find,ls --provider <provider> --model <模型> \
     --append-system-prompt <执行目录>/system.md --session-id <uuid> --name "Knit worker session"
```

- 不带 `--mode` 而且在终端里时 Pi 是交互界面，扩展里 `ctx.mode` 是 `"tui"`。
- `--append-system-prompt` 的值是一个存在的文件时，Pi 读文件内容；系统提示里是内容，不是路径。
- `--no-themes` 不能带：界面会因为找不到用户设置的主题报错（旧任务 `11-06-rex-worker-theme-loading`）。
- `--extension` 可以是编译好的 `.js` 文件；它能用相对路径导入同一个 `dist` 里的其它模块（试过导入 `domain/report.js` 和 `infrastructure/process.js`）。
- `--provider` 不认识时 Pi 在加载扩展之前就退出；`--model` 不认识而 provider 认识时 Pi 照常启动，第一次请求才失败（见第 6 节的 `error`）。

## 6. Pi 的扩展接口（只列用到的）

扩展文件默认导出一个函数，参数是 `pi`。

```typescript
pi.on("session_start", (event, ctx) => {});       // event.reason："startup" | "reload" | "new" | "resume" | "fork"
pi.on("agent_settled", (event, ctx) => {});       // event.aborted：这一轮是不是被中止的（例如按了 Esc）
pi.on("session_before_switch", () => ({ cancel: true }));   // 不让换会话
pi.on("session_before_fork", () => ({ cancel: true }));     // 不让分叉
pi.sendUserMessage("文本");                        // 空闲时立即作为用户消息发出并开始一轮
ctx.sessionManager.getBranch();                    // 当前分支上的全部记录，从最早到最新
ctx.sessionManager.getSessionFile();               // 会话文件的绝对路径
ctx.ui.notify("文本", "info");                     // 在界面上显示一条提示
ctx.modelRegistry.find("provider", "模型");         // 找不到时不是真值；provider 认识而模型不认识时用它提前发现
ctx.shutdown();                                    // 请求 Pi 退出；交互界面里等到空闲时才退出
```

- `agent_settled` 是“Pi 不会再自己往下做”的信号：重试、压缩后重试、排队的消息都处理完才触发。在它的处理函数里调用 `pi.sendUserMessage`，会在所有处理函数结束之后开始新的一轮（试过：第二轮结束时又触发一次）。
- 在 `session_start` 里直接调用 `ctx.shutdown()` 也可以：Pi 约 0.4 秒内退出，窗格关掉。
- 在 `agent_settled` 里调用 `ctx.shutdown()`：约 0.05 秒后触发 `session_shutdown`（`reason` 是 `"quit"`），Pi 退出，窗格关掉。
- 用户在执行者做事时直接在窗格里输入，Pi 自己会把这句话排进当前这一轮，不需要扩展处理。
- 会话记录里的消息：

```json
{ "type": "message", "id": "9ef13c41", "message": {
    "role": "assistant",
    "content": [{ "type": "thinking", "thinking": "…" }, { "type": "text", "text": "…" }, { "type": "toolCall", "name": "bash" }],
    "stopReason": "stop" } }
```

- 助手消息的 `stopReason`：正常是 `"stop"`；请求失败是 `"error"`，这时 `content` 是空数组，`errorMessage` 里是原因（例如 `404: {"code":null,"message":"magpie knows no model \"no-such-model\" …"}`），`event.aborted` 是 `false`。
- Pi 自己取“最后一条助手消息的文字”的做法（RPC 的 `get_last_assistant_text`）：从后往前找第一条 `role` 是 `assistant` 的消息，跳过 `stopReason` 是 `"aborted"` 而且 `content` 为空的；把其中 `type` 是 `text` 的块的 `text` 接起来，去掉首尾空白。
- 扩展里用 `procStartTicks(process.pid)`（`next/src/infrastructure/process.ts`）读到的启动标识，和别的进程读这个进程号得到的一样。

## 7. 用真的模型核实的，和没有核实的

2026-11-17 用真的模型在窗格里走过一个任务（`validation/slim-rex-2026-11/`）：

- 窗格里的 Pi 能调用模型：实现环节 10 到 19 秒做完。
- 执行者做着的时候往窗格里发 Esc（`rex send-key -b <窗格的标签> -s <会话> escape`）：扩展收到 `agent_settled`，这时会话里最后一条执行者消息的 `stopReason` 是 `aborted`、`content` 是空数组。`event.aborted` 是不是 `true` 没有单独看，扩展两个都认。
- 中止之后往窗格里发一句话再发回车（`rex send`、`rex send-key enter`）：执行者接着做，做完又收到一次 `agent_settled`。
- `rex capture -b <窗格的标签> -s <会话> --trim` 能读到最小化的窗格里的屏幕内容。

没有核实的：

- 只在交互式 shell 配置里导出的密钥，窗格里的 Pi 拿不到（它的环境变量来自 Rex 的登录 shell）；本机的模型配置在文件里，不受影响。
- Linux 上的 Rex。
