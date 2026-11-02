---
id: k-af4f5aafa6d7
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T11:30:18.509Z
title: 改进 run 失败诊断：保留 pi 侧 set_model/启动错误细节
---

# 改进 run 失败诊断：保留 pi 侧 set_model/启动错误细节

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

讨论结论（2026-11-02，用户授权完成剩余任务）：

问题：runtime 启动失败时（如 run-9841597d29c2 的 connection_closed、run-2f986619db53 的 set_model_rejected），run 目录的 result.json/state.json 只存 failureReason 代码；pi 侧具体错误（如 "Unknown provider" / "Model not found: magpie/glm-5.3-flash"）只在内存 stderr 尾部（PiRpcConnection.diagnostics），排障必须手工复现 rpc 协议。

方向：
1. runtime 启动失败时把 PiConnection.diagnostics 的尾部（截断、白名单外内容按现有 diagnostics 规则处理——注意不落消息正文/凭据）作为结构化诊断字段写入 run 目录（如 diagnostics.json 或 stage-process.json 扩展字段），供 run status 展示；不改变 failureReason 代码语义。
2. knit run status 对 runtime_start_failed 前缀失败显示该诊断尾部。
3. 遵守 ARCHITECTURE「日志不作权威回执」：诊断只是失败原因的辅助证据，不参与状态机。

验收标准：构造 provider 错误的 run 后，run 目录可直接读到 pi 侧错误文本；status 可见；npm test 全绿；开发者模式关闭时行为不回归。

<!-- knit:progress:end -->
