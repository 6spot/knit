---
id: k-6aaf06ce1d4f
title: Knit 体验打磨、缺陷修复与性能优化
status: delivered
stage: null
verification: none
parent: null
dependsOn: []
priority: P1
createdAt: 2026-11-27T07:35:20.219Z
---

## 目标与范围

在严格守住现行设计第 11 节轻核心边界的前提下，分三波推进 Knit 的体验打磨、已核实缺陷修复与运行时性能优化。本任务为主任务，只放总体方向、已定下的取舍与子任务清单，不产出代码，具体改动全部在子任务中逐项登记、实施与交付。

### 核心取舍

1. **逐项推进**：每次只登记并推进当前这一个子任务，交付后再按实际效果调整并登记下一项，不一次性铺开所有子任务。
2. **高风险独立审查分离**：涉及状态推进、改动对比、受保护路径、提交或授权核对（含承担交付授权核对的宿主钩子）的改动单独成子任务，并设置 `verification: independent`。
3. **发版与真机验证分离**：全局重装（`npm run pack:install`）与本仓库桥接刷新在阶段完成后单独成任务并另行授权。

### 子任务清单

#### 第一波：止血与消卡点
- [x] `修复 Pi 与 Antigravity 执行适配器会话采集缺陷（k-1d9ad44e3419）`（验证方式：`self`，已交付 `f8e8693`）
- [x] `修复 WorkBuddy 钩子改写命令丢失 tool_input 字段（k-2bc7f6d855dd）`（验证方式：`independent`，已交付 `f774d65`）
- [x] `支持 knit deliver --message 并优化移动回滚报错（k-80b34debdf66）`（验证方式：`independent`，已交付 `a66afe7`）
- [x] `增强交付预览提示并支持 done 任务补录改动路径（k-ea81fa709d27）`（验证方式：`independent`，已交付 `07a4bf9`）
- [x] `完善冷启动引导与 workflow validate --env 检查（k-4b380aa4d634）`（验证方式：`independent`，已交付 `b68d1e1`）

#### 第二波：日常高频路径提速
- [x] `优化 CLI hook 懒加载与 canSkipHostCommand 快路径（k-5ead32984c04）`（验证方式：`independent`，已交付 `21a4216`）
- [x] `单 PID 判活替换整机 ps 扫描并优化 waitRun 轮询开销（k-85750899cc3a）`（验证方式：`self`，已交付 `9a0311e`）
- [x] `优化 takeSnapshot 归档扫描、previewDelivery 批量哈希与归档查找（k-da512fe91c28）`（验证方式：`independent`，已交付 `4e7c86c`）
- [x] `优化 Antigravity 与 Pi 执行适配器后台 I/O 与事件循环阻塞（k-63d7d10c7b6a）`（验证方式：`self`，已交付 `360d4ef`）
- [x] `优化 atomicWrite 写入路径与 .runtime 清理剪枝及残留回收（k-5d624ec3f0c7）`（验证方式：`self`，已交付 `895b8f4`）

#### 第三波：多宿主闭环与底盘加固
- [x] `统一纯桌面宿主上下文引导与 independent 无记录收尾文案（k-1d417ae1a322）`（验证方式：`self`，已交付 `c4b0bf6`）
- [x] `加固派发结算任务锁、saveTask 冲突捕获与续聊阻断结构化标记（k-b48ffc5cd430）`（验证方式：`independent`，已交付 `07cec26`）
- [x] `修复 task.md 解析（CRLF 与代码围栏）、savePitfall 权限与 archiveTask 跨卷移动（k-9cee30b3431f）`（验证方式：`self`，已交付 `a766ad5`）
- [x] `补齐归档列表筛选、运行排障观测与 Pi 桥接动作（k-94c83d095af3）`（验证方式：`self`，已交付 `7d091e7`）

### 延后 / 独立授权项
- [x] `全局安装新版 Knit、刷新本仓库副本并完成双终端验收（k-87a8f1cc068d）`（验证方式：`none`，已交付 `f0aa4ab`）

## 完成条件

- 清单中确认要做的子任务全部完成交付（不再做的项在清单中标明取消原因）。
- 现行设计文档、模板与测试保持一致。

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#11-不做与延后` — 功能克制边界
- `AGENTS.md` — 本仓库协作、拆分、审查与验证规范

## 结果

三波共 14 项体验打磨、缺陷修复与性能优化子任务以及 1 项全局重装与双终端验收子任务（k-87a8f1cc068d，提交 f0aa4ab）已全部逐项登记、实施、核对并交付进 main。现行设计文档（docs/design/DESIGN.md）、模板、本仓库刷新副本与测试保持一致，Rex 终端与普通终端两次全量 npm test 均 584/591 通过（0 失败，7 项跨卷跳过）。
