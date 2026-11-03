---
id: k-f99e069ab0c5
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:12.158Z
title: 跨机历史：Git 已归档任务的只读展示
---

需求冻结（主会话核查 task-service list/computeList、task-document parse 抛错行为、CLI task list 后决策）：

现状：list 已从磁盘读 archive/YYYY-MM 全部 task.md，但不区分"已入库 Git 历史"与"未入库移动"，且单个归档 task.md 结构损坏会让整个 list 抛 io_error；跨机克隆场景缺本机 metadata 回执时无法标注历史属性。

交付设计：
1. TaskListResult 归档条目新增 history 分类：kind ∈ git-history | local-only | invalid，附 problems[]。判定：身份有效（id 合 k- 模式、title/createdAt/branch 非空）且结束有效（status=closed、phase=deliver、outcome∈completed|cancelled）且 task.md 被 Git 跟踪（`git ls-files -- <路径>` 批量一次查询）→ git-history（显示"Git 历史已归档（只读）"）；字段有效但未跟踪 → local-only（显示"未入库"）；身份/结束字段无效 → invalid+问题明细；git 查询失败 → 按未验证处理并附"Git 跟踪状态不可判定"问题，不冒充已入库。
2. 健壮性：归档 task.md 解析失败不再中断 list——写入新增 result.problems（path+message）；活动区解析失败维持抛错（业务权威必须严格）。重复来源：同一 taskId 同时出现在活动区与归档或多个归档位置 → problems 记"重复来源"诊断；操作定位仍活动区优先，list 不改任何业务状态。
3. 只读保证：仅文件读取与只读 git ls-files，无写入；git-history 归档不创建绑定、不产生检查资格、不能作为新执行/交付的检查证明（completion 资格链路不变，归档任务本就不可 adopt/close）。
4. 展示：CLI 文本归档条目追加标注；JSON 输出含 history/problems。list 缓存沿用既有文件指纹：knit 自身流程提交归档必伴随目录结构变化（失效指纹），纯外部 git add 不改文件的情形不做建模，作为已知限制写入文档。
5. 文档：DESIGN §12 跨机历史段由"首版未实现的后续能力"改为现行行为描述（判定条件、只读属性、不能作为检查证明、已知限制）。
6. 测试：a) 模拟他机克隆（清空 runtime/metadata）后 list 对已入库有效档案显示 git-history；b) 未跟踪的有效归档 → local-only；c) status=open 的归档 → invalid+问题；d) 损坏归档 task.md → problems 记录且 list 成功返回其余条目；e) 活动+归档同 id → 重复来源诊断；f) list 前后文件系统与 Git 状态零变化；g) git-history 归档不改变 completion/绑定资格。全量 npm test 绿。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-04920bb21ff7，已接收 implementation_accepted）：新增 src/application/task-history.ts——归档条目按身份（k- 模式 id、title/createdAt/branch 非空）+结束（closed/deliver/completed|cancelled）+Git 跟踪（git ls-files 批量只读查询，失败记"不可判定"不冒充）分类为 git-history／local-only／invalid 附 problems；list 解析损坏归档不再中断（写入 result.problems），活动区维持严格；同 id 多处出现记重复来源诊断；CLI 归档行加只读/未入库/档案异常标注，JSON 含 history/problems；不创建绑定与检查资格，list 零写入。DESIGN §12 改为现行行为描述。验证（self）：npm test 309/309 绿（新增他机克隆模拟、未跟踪归档、status=open 归档、损坏归档隔离、重复 id、零写入、资格不变等用例）。

### 交付记录

<!-- knit:delivery:op-8da27165065a -->
- 操作: op-8da27165065a
- 时间: 2026-11-03T17:46:43.874Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: e006d19de3a35bef5539aca66a3ecf1596b28bd8
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-cross-machine-git-archived-history-view

### 任务资料提交记录

<!-- knit:metadata-commit:op-8da27165065a -->
- 任务资料提交: 0d41b8018f8f8f149dc01f65b11b1a2de4208f0d
- 归档目标: .knit/tasks/archive/2026-11/11-03-cross-machine-git-archived-history-view

<!-- knit:progress:end -->
