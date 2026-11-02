---
id: k-446712287b43
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:58.986Z
title: 快照策略落地或改规范
---

# 快照策略落地或改规范

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

架构审查确认的快照问题（src/application/snapshot.ts、restore.ts）：

1.【中】文档声明 HEAD 策略未实现：DESIGN 声明快照按 HEAD 策略裁剪（与 HEAD 相同的内容引用基线，仅存差异；refs/knit/bases），实际 snapshot.ts 逐文件 copyFileSync 全量拷贝（129-130 行只取 HEAD 用于记录，201/215/248/263/276 行全拷贝），且所有 tracked 文件计入 64MiB 上限（DEFAULT_MAX_SNAPSHOT_BYTES，27 行）。大仓库会直接 snapshot_too_large 无法开工。
2.【中】snapshot.tmp-* 残留不清理：构建 tmp 目录后若进程中断，tmp 残留无回收路径，随重试持续占盘。
3.【低】restore 先记录再取锁、cancel 不持锁 → 并发下可能 version_conflict 重试（restore.ts 记录写入与锁获取顺序）。

二选一（讨论定夺）：落地 HEAD 策略＋tmp 清理；或把 §文档改为「全量拷贝＋上限」，明确大仓库限制并补 tmp 残留清理。

验收标准：
- 快照行为与规范一致（含 64MiB 语义：是单文件还是总量）。
- 中断后重试不留 tmp 残留；隔离夹具测试覆盖中断恢复。

讨论结论（2026-11-02，架构师决策，用户已授权按序推进）：

方向选择：B（实现为基准收敛规范）＋补全缺失的恢复能力，理由：
1. HEAD 策略去重是性能优化，不是首版正确性必需；全量拷贝＋上限语义简单可验证，符合「首版只持久化必要业务事实」的取向。
2. DESIGN 中 HEAD 策略／refs/knit/bases 相应描述改为后续能力（明确标注未实现），消除文档-实现矛盾。
3. 本任务必须落地：a) 快照 tmp 残留清理（中断后重试不留 snapshot.tmp-*）；b) 64MiB 上限语义在文档与代码中统一（按总量计，明确是 tracked 文件总量）；c) restore 顺序问题（记录先于取锁、cancel 不持锁）按代码现状在文档中如实描述或修正实现，取更小改动。

验收标准：
- 快照行为与更新后的规范一致；64MiB 语义全文统一。
- 中断后重试不留 tmp 残留，有隔离夹具测试。
- 搜索 HEAD 策略／bases 旧措辞，每处命中归属正确。

<!-- knit:progress:end -->
