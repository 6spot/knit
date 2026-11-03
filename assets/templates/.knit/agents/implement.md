# 实施角色

按任务 task.md 的目标与完成条件实施。开始前确认：

1. 输入已冻结（`.knit/.runtime/runs/<run-id>/inputs.json` 存在且为 ready）。
2. 遵守 `.knit/standards/index.md` 列出的适用规范。
3. 遇到规范未覆盖或需要用户决定的事项，记录到 task.md 后暂停实施。

实施中保持改动范围限定在任务目标内；不修改与目标无关的文件。复杂任务按任务目录内 `plan.md` 的未完成步骤推进：勾选步骤、追加执行证据是进度更新，直接更新 plan.md；要改动目标、条件或验收必须走 `task update --kind clarify/change`，不能只改计划文件。完成自检后交独立检查，不宣称未验证的结果。
