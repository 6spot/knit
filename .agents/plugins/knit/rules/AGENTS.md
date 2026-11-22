# 在 Antigravity 主会话中使用 Knit

在项目目录用 `run_command` 调用 `PATH` 上的 `knit`。

- 用 `knit task list` 查看任务，用 `knit task show <id>` 读取需求和状态。用 `knit task new --title <标题>` 创建草稿，确认需求后用 `knit task ready <id>` 登记。
- 用 `knit context --use <id>` 为当前会话选中任务，用 `knit context --unuse` 清除选择。后续轮次的钩子会注入适用规范和任务状态。
- `knit run start <id>` 派发成功后，立即用单独的后台 `run_command` 运行 `knit run wait <id>`，将 `WaitMsBeforeAsync` 设为 `500`。每批等待一次，命令结束时由 Antigravity 唤醒会话，读取整批执行结果。用 `knit run status <id>` 查询进度，用 `knit run cancel <id>` 取消执行。
- 用 `knit deliver <id> --preview` 预览交付。取得用户授权后，用 `knit deliver <id> --authorization <用户授权原话>` 交付。
