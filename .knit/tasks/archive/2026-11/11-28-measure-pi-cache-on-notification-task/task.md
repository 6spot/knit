---
id: k-4599ed083e4a
title: 用剩余通知任务实测 Pi 提示词缓存读取
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-28T06:09:12.339Z
---

## 目标与范围

按用户授权，用装有新桥接的 Pi 会话，在阅读和分析待办的通知修复需求时观测真实模型缓存。采用原问题所用的模型，在同一个会话中先建立历史，再选择通知任务，然后继续处理一项具体的只读调查。

## 完成条件

- 核对会话实际加载的桥接、使用的模型和与通知任务有关的工具调用，保留更新前、更新后首个及其后请求的可用 `usage`。
- 记录模型实际返回的 `cacheRead` 及未命中的 `input`，说明样本规模、首个变化的时间点和可判断的范围。缺少指标或外部服务失败时按实际情况记录。
- 把通知任务的实测观察和对后续实施有用的定位交给用户。

## 待澄清

## 相关资料

- `.knit/tasks/11-28-pi-dynamic-context-prompt-cache/task.md`
- `.knit/tasks/11-28-shared-host-completion-notification/task.md`
- `.knit/tasks/11-28-install-pi-context-cache-fix/task.md`

## 结果

在本仓库刷新后的 Pi 1.7.0 中，以 magpie/remote/group/astra 完成阅读通知修复需求、实际调用 knit_task use 选中草稿、读取已安装桥接这三轮操作。7 次模型请求中首请求冷启动，其余 6 次均读到缓存。逐条核对模型 usage 与会话记录：切换前调用工具的请求 cacheRead/input 为 11,136/2,359，切换后首请求为 13,440/385（缓存占该次输入的 97.2%），随后两次分别为 13,824/165、13,952/892。工具结果后只追加了一条含 status 的隐藏 knit.context，系统 Knit 段仅在会话开始时写入；本次采样没有在线压缩。当前 notifyWhenEnded 在 knit run wait 返回后以 followUp、triggerTurn: true 送出通知，解释了忙时排队的现象。完整 7 次用量见 .knit/.runtime/cache-install-8h8n6ahg/live-usage.json，会话 ID 01a220cb-e0e7-77cf-bf7f-6fcf83532a37；观察范围为单会话一次真实任务切换，线上压缩和长期命中率未采样。
