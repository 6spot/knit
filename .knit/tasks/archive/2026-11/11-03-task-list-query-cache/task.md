---
id: k-57324c702c9e
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:13.366Z
title: 列表性能：可失效查询缓存
---

需求冻结（讨论结论，主会话测量与决策；用户全权授权批量执行，未决事项按主 Agent 决策记录）：

测量事实（隔离夹具，本机 Node 24）：
- 当前仓库 35 任务：list 单次 15–38ms。
- 合成 500 任务（每 task.md 约 2KB）：list 单次 140–230ms，随任务数线性增长（约 0.3ms/任务）。
- 结论：存在可重现的重复查询成本，主要在逐个 read+parse task.md；同进程内（桥接每轮上下文、status/list 重复调用）缓存收益明确，>10×。

设计决策（记录为实施依据）：
1. 形态：进程内缓存（TaskService 实例持有，每 root 一条），不预设缓存文件、数据库表或常驻服务（任务边界约束）。
2. 失效：目录结构指纹 + 每 task.md 的 inode/size/mtimeNs（bigint stat；atomicWrite 走 rename 会换 inode，覆盖同尺寸同毫秒编辑）。指纹不等价即整体重算，不做部分失效。
3. 范围：仅缓存 list() 的聚合结果（active/archived 分组摘要）。locateTaskDocument、任务操作路径不缓存，仍读权威文件。list 输出不含 binding／run 事实，无需额外失效来源；外部编辑、归档移动、目录增删都改变指纹。
4. 回退：指纹计算失败（目录缺失等）视为失效，重算时如实报 IO 状态；缓存永不授予执行或验收资格，只复用只读展示结果。禁用场景（指纹不匹配）结果与直接读取一致。
5. 验收：缓存命中结果与直接读取一致；外部改 task.md、新增任务目录、归档移动、删除 task.md 后下一次 list 如实反映；重复 list 结果深相等；性能对比记录在任务记录（500 任务规模重算 vs 命中）。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-e4f3df0da36c，已接收 implementation_accepted）：TaskService 增加 list 聚合缓存（每 root 一条），指纹 = 目录结构 + 每 task.md 的 dev/ino/size/mtimeNs（bigint stat）；指纹不一致或不可得即整体重算，不做部分失效；命中返回 structuredClone 副本。验证（self）：npm test 280/280 绿；新增缓存失效用例覆盖同尺寸就地覆盖（mtimeNs）、新增目录、归档移动、删除 task.md、命中不重读、指纹不可得回退六类场景，各场景与新建实例直接读取深相等。性能复测（500 任务隔离夹具）：命中 ~9ms vs 直接重算 ~170–200ms（约 20×）；35 任务仓库单次 15–38ms。缓存不授予执行／验收资格，仅复用只读展示结果。

### 交付记录

<!-- knit:delivery:op-3c5494e80e5b -->
- 操作: op-3c5494e80e5b
- 时间: 2026-11-03T16:42:26.597Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: 7455fe293bfd81b34af2e79242e088158b1e8a10
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-task-list-query-cache

### 任务资料提交记录

<!-- knit:metadata-commit:op-3c5494e80e5b -->
- 任务资料提交: 55b9e517c3540b34492cc21e975cd8aa576609e1
- 归档目标: .knit/tasks/archive/2026-11/11-03-task-list-query-cache

<!-- knit:progress:end -->
