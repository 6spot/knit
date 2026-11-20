# Pi 扩展接口摘录

摘自本机 Pi 1.5.2 的文档（`docs/extensions.md`、`docs/session-format.md`），只留桥接用得到的部分。G 批的任务按这份摘录写桥接，不需要另外读 Pi 的文档。摘录于 2026-11-16；真的 Pi 加载桥接的验证留给 H1。

## 文件位置与入口

- 项目里的扩展放在 `.pi/extensions/*.ts`，项目被信任之后 Pi 自动加载。
- 文件默认导出一个函数，参数是 `pi`；可以是异步函数。
- 这个函数可能在没有会话的调用里运行：不要在里面启动进程、定时器这类后台资源。要等到 `session_start`，或者等到用得着它的工具、事件里再启动，并在 `session_shutdown` 里关掉。
- 可以用 Node 自带的模块（`node:fs`、`node:path`、`node:child_process` 等）。

## 工具

```typescript
pi.registerTool({
  name: "my_tool",
  label: "My Tool",
  description: "给模型看的说明",
  parameters: { type: "object", properties: { action: { type: "string", enum: ["list", "add"] } }, required: ["action"] },
  async execute(toolCallId, params, signal, onUpdate, ctx) {
    return { content: [{ type: "text", text: "Done" }], details: undefined };
  },
});
```

- `parameters` 是 JSON Schema，Pi 按它校验参数。
- 结果里 `content` 给模型看，`details` 必须有（没有内容时写 `undefined`）。
- 表示失败：返回的结果带 `isError: true`，或者在 `execute` 里抛错。
- `ctx` 是下面说的上下文。

## 事件

```typescript
pi.on("before_agent_start", async (event, ctx) => {
  // event.messageType："user"（用户的输入）或 "custom"（pi.sendMessage 触发的）
  // event.systemPromptOptions.sections：按名字存的几段系统提示，可以直接改
  event.systemPromptOptions.sections.knit = "一段文本";
});
pi.on("session_start", async (event, ctx) => {});     // event.reason："startup" | "reload" | "new" | "resume" | "fork"
pi.on("session_shutdown", async (event, ctx) => {});  // event.reason："quit" | "reload" | "new" | "resume" | "fork"
```

- `before_agent_start` 在每一轮开始之前触发。改 `sections` 之后，Pi 拿它和模型已经有的各段比较，只补发变了的那几段；内容没变就不补发。
- `sections` 里的每一段在系统提示里用它的名字做标签包起来。

## 会话记录

```typescript
pi.appendEntry("my-state", { count: 42 });   // 写一条扩展自己的记录，不进模型的上下文
ctx.sessionManager.getBranch();              // 当前分支上的全部记录，从最早到最新；压缩之前的也在
```

记录的样子：

```json
{"type":"custom","id":"h8i9j0k1","parentId":"g7h8i9j0","timestamp":"…","customType":"my-state","data":{"count":42}}
{"type":"message","id":"a1b2c3d4","parentId":"prev1234","timestamp":"…","message":{"role":"user","content":"Hello","timestamp":1733234401000}}
{"type":"message","id":"b2c3d4e5","parentId":"a1b2c3d4","timestamp":"…","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"}]}}
{"type":"custom_message","id":"i9j0k1l2","parentId":"h8i9j0k1","timestamp":"…","customType":"my-extension","content":"Injected context...","display":true}
```

- 用户消息的 `content` 是字符串，或者内容块的数组（文本块是 `{"type":"text","text":"…"}`，还可能有图片块）。
- `custom_message` 是扩展用 `pi.sendMessage` 发的，不是用户消息。

## 给主会话发消息

```typescript
pi.sendMessage(
  { customType: "my-extension", content: "消息的文本", display: true },
  { deliverAs: "followUp", triggerTurn: true },
);
```

- 这条消息进模型的上下文。
- `deliverAs: "followUp"`：智能体正在做事时，等它这一轮做完再送到。
- `triggerTurn: true`：智能体空闲时，立即触发一轮。
