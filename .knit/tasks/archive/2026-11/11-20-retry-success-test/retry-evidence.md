# 重试之后成功：真实的例子和 Pi 的事件

## 真实的例子

摘自本机的会话记录，仓库里没有。执行 `r-5f861db2a268`，2026-11-19，窗格执行，Pi 1.5.2。

- 助手消息里有 5 条 `stopReason: "error"`、`errorMessage: "Claude: Service Unavailable (error)"`、`content: []`。
- 分三段出现：1 条、连着 2 条、连着 2 条。每段之后模型接着正常调用工具。
- 最后一条助手消息是 `stopReason: "stop"`，带文字。
- 这次执行没有因为模型出错记失败。

## Pi 1.5.2 的重试事件

`docs/json.md`「Retry events」一节的原文：

```json
{"type":"auto_retry_start","attempt":1,"maxAttempts":3,"delayMs":2000,"errorMessage":"529 overloaded"}
{"type":"auto_retry_end","success":true,"attempt":2}
```

「On final failure, `auto_retry_end` has `success: false` and a `finalError` string.」

同版本的 `docs/rpc.md`：`agent_end` 之后还可能有重试，要知道 Pi 不会再自己继续时等 `agent_settled`。
