---
id: k-3d730c8907b3
status: closed
stage: deliver
outcome: completed
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

这是讨论中确认单独立项的方向；2026-11-06 用户确认按下述方案 A 实施。

## 已确认方案（2026-11-06，用户确认：保输出 + 归档按月目录指纹）

- 指纹拆成两个分区：`active`（`tasks/` 下除 `archive` 外的 `task.md` 逐文件 stat，现状口径）与 `archive`。
- `archive` 分区指纹取 `tasks/archive` 与各 `tasks/archive/<YYYY-MM>` 目录的 stat（dev／ino／size／mtimeNs），成本 O(月份数)，不逐文件 stat 归档 `task.md`。
- 缓存按分区记账：活跃分区指纹配其派生结果，归档分区指纹配归档索引（条目、problems、父子关系、依赖归档状态）。命中即复用，指纹变化只重算该分区。
- 输出、派生结果、既有用例一律不变：`archivedCount`、归档 problems、父任务 children 中的归档子任务、`dependency_archived` 阻塞、`task next` 的可执行判定都按现有口径产出。
- Knit 自身的归档／还原／改档操作写显式失效标记（与分区指纹一起参与比较），不依赖目录 mtime 也能让缓存在下一次读取失效。
- 已知限制并写入文档：绕过 Knit 原地改写已归档 `task.md`（不改目录结构）不会自动失效；正常流程中归档后不再改内容。
- `knit status` 项目概览沿用同一分区缓存，保持现状输出。

边界（不变）：

- 派生结果保持权威一致：同一时刻的活跃集合、父子进度与依赖阻塞判定，不能因为分成两次扫描而与现状不同；差异只在「何时付归档扫描成本」。
- 写入路径沿用现有锁：任务写入／归档／改档后对应分区失效重算，不引入跨进程广播。

## 完成条件

- 分区指纹实现：活跃与归档各自记账；缓存命中时归档侧只做 O(月份) 目录 stat，不 stat 任何归档 `task.md`（夹具断言采集 stat 次数）。
- 语义等价：无归档、有归档、归档子任务参与父进度、`dependency_archived` 诊断四类夹具下，`task list`（含 footer 与 problems）、`task list --json`、`task next` 结果与改造前逐字一致。
- 显式失效：`archive`、跨目录改档、还原后立即读取得到新结果；活跃任务新增／修改后列表即时反映。
- 规模验证：在数百条归档的夹具上测量默认 `task list` 与 `task next` 的耗时与归档侧 stat 次数，证明不随归档条数放大（只随月份数变化），测量数据写入任务记录。
- 文档：DESIGN／OPERATIONS 记录分区指纹口径、失效方式与「原地改写已归档任务不自动失效」的限制。
- `npm test` 相关用例与既有任务列表用例不回归；新增用例覆盖分区复用、指纹变化与显式失效。

## 输入引用

- 本次会话讨论：`k-c06c5a41092f` 只改输出范围，读取成本另行处理。
- [DESIGN](../../../docs/design/DESIGN.md) 第 2、3 节；`src/application/task-service.ts` 的 `list`／`computeList`／`taskListFingerprint`。

## 输入变更（2026-11-06）

- 用户确认按方案 A（分区指纹）实施；补齐完成条件与边界，需求未决项已清空。

## 输入变更（2026-11-06）

- 用户确认在「输出不变」前提下实施：归档分区改用月目录 stat 指纹（O(月份)）+ Knit 自身操作显式失效，替代原先「默认路径完全不碰归档」的写法。
- 原因：默认视图的 archivedCount、归档 problems、归档 children 与 dependency_archived 本就依赖归档事实，改输出会破坏既定边界。
- 完成条件按该方案重写；`task ready` 已在交付锚点后重置回 start 重新实施。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-be7e269e81e2 -->
- 操作: op-be7e269e81e2
- 时间: 2026-11-07T01:29:46.255Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-06 用户要求按任务优先级逐个执行；主会话接收结果后自动提交、推送、归档
- 工作提交: f9a176e00bcd9f657c62c3757c2b2752cdcc6217
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-task-list-read-cost

<!-- knit:progress:end -->
