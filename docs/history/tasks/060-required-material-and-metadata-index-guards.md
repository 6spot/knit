# 060 补齐阻塞复核发现的资料加载与暂存保护

- 来源：用户授权本轮处理除真机验收外的可执行阻塞；058／059完成后的独立安全复核。
- 状态以TASKS.md为准；不提交／推送或操作真实项目，真机／真实模型验收暂缓。

## 已确认问题

1. B005旧记录声称必需规划资料不再静默跳过，但loadSectionContents读取失败仍catch后continue；必需资料在规划后消失时实际提示缺内容。
2. 057的plan只检查artifacts暂存冲突，metadata的部分暂存未受保护；commitSelected的git add -A会覆盖用户在任务资料中预先暂存的版本。独立reviewer给出任务plan.md暂存A／工作区B、hook拒绝后index变B的具体路径。

## 实施与验收

- 必需资料不可读取时明确拒绝提示装配，保留sourceId／path／缺口；可选资料仍按既有语义省略。不伪装已加载，不启动额外模型轮次。
- 资料与业务路径一致保护已有index：预检报告冲突，正式执行在产生Git副作用前再次检查；安全停止而不覆盖部分暂存。兼容旧操作与已完成步骤的重试。
- 增加可复现的独立夹具，验证失败前后index、HEAD、任务状态与操作记录；修改文档／协议字段须同步引用。
- 执行相关隔离回归、默认并行全量与打包检查，并独立复核修复结果；保留失败与成功证据。

## 执行记录

- 执行者：主Agent；独立复核：blocker-reviewer三次只读审查，首次发现metadata漏保护，第二次发现删除检查点后重建遗漏，最终确认两处闭合、必需资料失败在runtime创建之前，无本次新增可复现问题。
- 必需资料：loadSectionContents读取required分节失败抛io_error并记录sourceId／path及原因；可选背景保持省略。更新OPERATIONS与B005，区分051当时修复和060追加修复。
- 任务资料index：plan新增stagedMetadata；服务锁内在操作创建／Task修改前拒绝未知用户暂存，提交步骤重核。仅接受HEAD、预期路径和blob一致的本操作未完成检查点；工作区部分暂存始终停止，lstat覆盖删除后重建普通文件与悬空链接。
- 修复前初始四项回归三失败，删除重建两项均失败，原始日志保留；修复后相关48/48，默认并行npm test273/273（0跳过，含typecheck／build），最终pack:check通过。未降低默认并行或扩大等待截止。
- 完整证据与独立结论：[validation/blocker-cleanup](../../../validation/blocker-cleanup/README.md)。B008已修复，B005残留缺口闭合。
- Task资料部分暂存拒绝时验证index、HEAD、Task与操作记录均不变；hook拒绝后本操作检查点可正常重试，新部分编辑与删除后重建均保持用户暂存选择。旧操作缺少充分检查点时安全拒绝，不声称自动拆分任意同路径内容。
- 已同步TASKS／BLOCKERS／OPERATIONS及057证据。无本仓库Git提交／推送或真实项目操作，真机／真实模型验收依用户要求暂缓。
