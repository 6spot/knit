---
id: k-3d730c8907b3
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T13:30:19.585Z
title: task list 读取成本不随归档规模线性增长
---

# task list 读取成本不随归档规模线性增长

## 目标与边界

现状：`TaskService.list` 的缓存指纹（`taskListFingerprint`）会对 `tasks/` 与 `tasks/archive/**` 下每个 `task.md` 做 stat，命中缓存也先付这笔开销；`task next`、依赖与父子判定都走同一路径。归档涨到数百上千后，每次列出活跃任务都要为归档支付成本。

目标是让默认视图与启动判定只依赖活跃任务，归档扫描只在显式查看归档、或确实需要归档事实（父任务子任务结束进度、`dependency_archived` 诊断）时才付成本。

这是讨论中确认单独立项的方向，具体方案未确认。

边界与待确认：

- 派生结果保持权威一致：同一时刻的活跃集合、父子进度与依赖阻塞判定，不能因为分成两次扫描而与现状不同。
- 缓存语义要重新定义（按分区指纹、还是显式失效），不能把旧结果配给新指纹。
- 是否顺带调整 `knit status` 项目概览与交付前置的扫描范围，需另行判断，不在本任务默认范围。
- 只优化读取路径，不改输出格式（输出已由 `k-c06c5a41092f` 收敛）、不改目录结构、不建索引。
- 需要基线与目标：在数百条归档的夹具上测量默认列表与 `task next` 的耗时／stat 次数，作为验收依据。

## 完成条件

方案确认后补：覆盖缓存失效与并发写入、归档数量增长时的耗时不随归档线性放大、活跃语义与现状等价的验证。

## 输入引用

- 本次会话讨论：`k-c06c5a41092f` 只改输出范围，读取成本另行处理。
- [DESIGN](../../../docs/design/DESIGN.md) 第 2、3 节；`src/application/task-service.ts` 的 `list`／`computeList`／`taskListFingerprint`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
