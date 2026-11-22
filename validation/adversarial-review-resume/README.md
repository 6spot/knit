# Pi 与 Antigravity 并行审查、续聊和回退实机验收

2026-11-22，macOS 27.2.1，Node v26.13.1，Pi 1.6.0，Antigravity CLI 1.5.13。验收使用当前 Worktree 构建的 CLI 和 `knit init` 生成的桥接、角色模板。在两个临时 Git 仓库内派发，`KNIT_HOME` 指向临时目录。实现和 Pi 审查使用 `magpie/remote/codex/gpt-6.2-astra`，另一名审查者使用 `gemini-3.8-flash-low`。模型名分别从 Pi 原生记录和 `agy` stream 的 `init` 事件核对。

主会话由本地脚本模拟。脚本调用生成的 `knit_run` 工具并记录它实际发送的 `knit.run-ended` 消息，每次派发只允许写入一份通知。执行者通过真实 Pi RPC 和 `agy` stream 运行。下表时间均为 UTC。两份流程配置、八份执行报告、六条通知、执行起止时间、会话标识和快照摘要均保存在[实机记录](evidence.json)。

## 双模型闭环

夹具任务为 `independent`。需求约定首轮只写 `hello\n`，两名审查者均按最终格式 `hello\nworld\n` 独立验证。`implement` 配置 `resume: true`，`review` 配置 `tools: [read, exec]`。两个夹具运行 `knit workflow validate` 均返回 `配置有效`。

| 派发 | 结果 |
| --- | --- |
| 首轮 `start` | Pi 创建 `hello.txt`，`od -An -tx1 hello.txt` 得到 `68 65 6c 6c 6f 0a`。 |
| 第一次审查 `start` | 批次 `b-24ad8a74b263` 的两位成员于 15:39:14.051 派发。Pi 于 15:39:31.291 入账，Antigravity 于 15:39:33.082 入账。两份报告都指出缺少第二行及 LF，都给出 `changes_requested`。15:39:33.664 收到一条通知，含两份报告路径、各自结论及裁决入口。 |
| 汇总后的 `start` | `instruction` 要求保留 `hello` 行、追加 `world` 和 LF，并核对全部 12 字节。实现者 r-9522d27476d5 的 `worker.log` 记录 `续聊原会话`。 |
| 复审 `start` | 批次 `b-2986f615c0f1` 的两位成员分别于 15:41:59.804 和 15:41:58.296 入账，均为 `pass`。15:42:00.412 收到一条通知，列出两份报告，下一步为主会话核对并 `task close`。 |

实现者的原生 Pi 会话 ID 为 `bf40fbb1-f842-4cc3-ba06-f5a4bf0d3d82`。返工前保存了首轮 JSONL，返工后逐字节核对它仍是同一文件的完整前缀。记录从 16 条增至 27 条，用户消息从 1 条增至 2 条。新增用户消息等于本轮 `resume-message.md`，包含主会话的裁决、两份报告路径与结论。

首审两份 `before.json` 与下一次实现的 `before.json` 内容相同。复审两份 `before.json` 和两份 `after.json` 内容相同，四次审查的 `changedPaths` 均为空。Pi 首审曾观察到 `.agents/`，这是同批 Antigravity 在运行时使用的钩子目录。批次结束后的 `git status --short` 仅显示 `?? hello.txt`。Worktree 的 HEAD 仍为 `fd866b3`，最终字节为 `68 65 6c 6c 6f 0a 77 6f 72 6c 64 0a`。记录中的快照摘要对按键排序的完整快照 JSON 取 SHA-256。

## 会话失效回退

第二个夹具配置可重入的 Pi 环节 `probe`，开启 `resume: true`。首轮按约定写入 `one`，提交 `changes_requested`。将该夹具中 `resumeId` 指向的 JSONL 改名保留，随后用 `instruction` 指示写入 `two`。本轮 `resume-id.txt` 仍指向原文件，`worker.log` 记录 `已自动回退新会话（Pi 原生会话文件不存在）`。新会话原生 ID 为 `157689d4-4772-45ae-b393-fb0a2ccce50d`，唯一用户消息逐字等于完整 `message.md`。文件读回为 `two`，结果为 `pass`。

## 工程验证

`npm run typecheck` 退出码为 0。`npm run pack:check` 输出 `pack 检查通过`，包内 83 个文件。第 6.1 节的 YAML 示例单独交给 `knit workflow validate`，输出 `配置有效`。

两个终端均执行 `npm test`。通过 `KNIT_TEST_CROSS_DEVICE_DIR` 提供独立临时 APFS 卷，使 7 个跨文件系统场景也参与测试。

| 终端 | TTY | 通过 / 总数 | 失败 / 跳过 | 退出码 |
| --- | --- | --- | --- | --- |
| macOS Terminal.app | `/dev/ttys013` | 474 / 474 | 0 / 0 | 0 |
| Rex，`block:01a203ec-e88b-78f4-950f-a2152cd1804c` | `/dev/ttys014` | 474 / 474 | 0 / 0 | 0 |
