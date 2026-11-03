---
id: k-ef9e7b1653c3
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T14:45:51.990Z
title: 修复 deliver 归档遗漏任务同目录材料的旧路径删除
---

实施前核实（主会话代码审阅，与用户定位一致）：src/application/delivery-service.ts 中三处以 op.taskPath（单文件）构造归档提交范围 selected——run() 的 archive_commit 恢复核对（约 732 行）、archiveCommit() 的恢复路径 selectedForRecovery（约 952 行）与新增路径 selected（约 999 行）。归档范围应为原任务目录整体（op.taskPath 的父目录，保持 .knit/ 前缀规范化），使被移动的同目录材料（plan.md/design.md/research/ 等）旧路径删除进入归档提交；归档目录不变。selectedPath/dirtyPaths/addable/stageable/treeSnapshot 均支持目录前缀，recovery 的 outside 核对（actual ⊆ selected）与既有操作恢复兼容。classifyPaths 的 metadata 范围本就以任务目录为单位，此修复使归档提交与其一致。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-3bc2a742e89b，已接收 implementation_accepted）：archiveScope(taskPath) 以原任务目录整体作为归档提交范围，替换 run() 恢复核对、archiveCommit() 恢复路径与新增路径三处的单文件 selected；新增隔离夹具测试「归档提交包含任务同目录材料移动后的旧路径删除」，覆盖 task.md/plan.md/design.md/research/notes.md 的旧路径删除与新路径新增、归档后无未暂存删除。另按自修复条款在主会话直接修复阻塞项：task adopt 对 frontmatter 已绑当前分支但绑定行缺失的任务补建绑定行（提交 46914bc，含测试；此前 backlog 任务无法派发 run 的根因），修复后 npm test 278/278 绿。验证方式 self：全量回归通过。

### 交付记录

<!-- knit:delivery:op-8b601528d310 -->
- 操作: op-8b601528d310
- 时间: 2026-11-03T16:26:31.390Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: c09a5a59a9c08213fd90b1b62feefe5080b7b685
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-fix-deliver-archive-material-staging

<!-- knit:progress:end -->
