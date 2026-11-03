---
id: k-cbe6ad49560d
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:12.964Z
title: 存储清理：引用核验与可恢复资料回收
---

需求冻结（主会话核查 diagnostics.ts storage 统计、run-store claim/snapshot 原子语义、DESIGN §7/§12/§15.2 后决策）：

原则：引用核验判定候选，不用目录年龄或日志静默判无用；未选策略时全部现有命令行为不变；doctor 保持不动。

1. 新增只读预览 `knit gc`（默认无 --apply 即只读）：扫描并按类列出候选，每项含 kind、路径、大小、判定理由与被引用证据。只读不改任何文件；storage 保持现有字段并新增 gcCandidates 计数摘要（不改变既有输出结构）。
2. 候选类与核验规则：
   a) snapshot 临时目录：run 目录下 `snapshot.tmp-*`（中断遗留）；仅当该 run 无进行中快照（manifest 非 preparing 且项目快照锁未持有）才为候选。
   b) 孤儿原生会话目录：`.knit/.runtime/pi-sessions/` 下未被 session 索引（SQLite sessions 表）任何行引用的目录；有行引用即保留，索引不可读视为未知不收集。
   c) 孤儿 run 目录：runs/ 下无任何任务资料引用（扫描活动区+归档任务 task.md 记录区、metadata operations/bindings 表引用）且运行状态为终态的 run；状态非终态或不可判定一律跳过并报告"未知/活跃，不收集"。
   d) 其余一律不碰：活动任务、被引用 run（含归档任务恢复引用，终态但被引用不收集）、快照 manifest、diagnostics、locks、metadata.db、claim 目录。
3. 执行 `knit gc --apply`：全程持有项目写锁；执行时逐项重新核验（预览后状态可能变化），仅收集仍满足条件的项；逐项记录 removed/skipped+原因，中断时已完成项保留、未处理项原样；结果写入 `.knit/.runtime/gc/last.json`（含时间、策略、逐项结果）供诊断。--json 输出与其他命令一致。
4. 不自动启用：无 --apply 永不删除；不含年龄策略与 diagnostics 清理（范围外）。
5. 测试（test/gc.test.mjs）：a) 中断快照 tmp 目录被识别且 --apply 后清除、run 主数据完整；b) 被索引引用的会话目录保留，孤儿会话清除；c) 被活动/归档任务引用的终态 run 保留，无引用终态 run 清除，非终态孤儿 run 跳过并报告；d) 预览与 storage gcCandidates 计数一致且只读（前后字节/条目不变）；e) --apply 中途注入失败→部分完成、last.json 可诊断、其余候选原样；f) 默认 storage 输出既有字段不变。全量 npm test 绿。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-f6543aa6a2ea，已接收 implementation_accepted）：新增 src/application/gc.ts + src/cli/gc.ts——`knit gc` 只读预览（snapshot.tmp-* 需 manifest 非 preparing 且快照锁未持有；pi-sessions 孤儿目录需未被 SQLite sessions 表引用、索引不可读视为未知；孤儿 run 需无任务资料/operations/bindings 引用且终态；其余一律跳过并报告理由），每项含 kind/路径/大小/理由/证据；`knit gc --apply` 持项目写锁逐项复验后收集，逐项 removed/skipped 记入 .knit/.runtime/gc/last.json，中断保留已完成项；storage 输出新增 gcCandidates 只读摘要（既有字段不变）。验证（self）：npm test 300/300 绿（新增 6 项：tmp 清理且主数据完整、被引用会话保留/孤儿清除、被引用终态 run 保留/孤儿终态清除/非终态跳过、预览只读且计数一致、apply 中断部分完成可诊断、storage 默认输出不变）。

### 交付记录

<!-- knit:delivery:op-88ec41576633 -->
- 操作: op-88ec41576633
- 时间: 2026-11-03T17:31:48.372Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: c6bdfecec2379344c79ffae344d4b8c996b75789
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-storage-reference-aware-garbage-collection

<!-- knit:progress:end -->
