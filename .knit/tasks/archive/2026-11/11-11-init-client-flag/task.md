---
id: k-4255496e31a0
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-7e4dbba9dca7
priority: P3
dependsOn: []
order: null
createdAt: 2026-11-11T14:10:09.518Z
title: 清理材料中已移除的 --client 用法
---

## 目标
修正仓库现行材料中已移除的 `--client` 用法：当前 CLI 客户端开关是 `--pi` 且默认启用，`--client pi` 会报 unknown option。

## 证据
- 真机验收执行 `knit init --client pi` 报错，正确写法为 `knit init`（或 `--pi`）。
- 平台矩阵任务记录与早期文档仍在使用 `--client pi`。

## 范围
- 全仓搜索 `--client`：修现行规范、模板与可执行脚本；历史档案保留事实但标注已失效。

## 完成条件
### Requirement: 现行材料无失效写法
#### Scenario: 搜索确认
- GIVEN 仓库现行文档、模板与脚本
- WHEN 搜索 `--client pi` 及其它 `--client` 用法
- THEN 现行材料不含失效写法；历史档案若保留则标注已失效

## 目标与边界
- 不改写历史执行记录的事实，只补标注。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-8852b9053461 -->
- 操作: op-8852b9053461
- 时间: 2026-11-12T17:24:26.306Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 96ee2599f64b8764716986b101d8b6346691dbc5
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-11-init-client-flag

### 任务资料提交记录

<!-- knit:metadata-commit:op-8852b9053461 -->
- 任务资料提交: b10503856b09cdfc1fd97168a92b5ee17452f3a1
- 归档目标: .knit/tasks/archive/2026-11/11-11-init-client-flag

<!-- knit:progress:end -->
