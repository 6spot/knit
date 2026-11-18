### 7.3 执行目录里的文件坏了

执行目录 `.knit/.runtime/runs/<执行 id>/` 里有三个 JSON 文件是命令要读的。它们只有在写到一半时进程崩溃或磁盘写满才会坏。坏了之后读它的命令报 `SyntaxError` 退出，不会自己修，要手工恢复。

| 文件 | 什么时候写 | 坏了之后 |
| --- | --- | --- |
| `worker.json` | 派发时，记后台进程的进程号和启动标识 | `knit run status`、`knit run wait`、`knit run cancel`、`knit context` 都报错退出；执行者还在跑，什么都没有停 |
| `before.json` | 派发时，记当时的工作区 | 执行者做完时记不了结果，错误在 `worker.log` 里，这次执行一直算正在跑；`knit run cancel` 先停掉进程，然后报错退出，这次执行还没有记为结束 |
| `after.json` | 审查以 `pass` 结束时，记当时的工作区 | `knit deliver --preview` 报错退出；`knit deliver` 不读它，照常交付 |

恢复 `worker.json`：

1. 停掉这次执行的进程：`pkill -f <执行 id>`。后台进程和它启动的 Pi，命令行里都带着执行 id。执行者在 Rex 的窗格里跑时，另外关掉那个窗格。
2. 删掉 `worker.json`。
3. 运行 `knit run cancel <任务>`。这次执行记为失败「执行进程意外退出」，改动文件照常记下，之后可以重新派发。

只删文件、不停进程的话，`knit run cancel` 照样把这次执行记为失败，但进程还在跑，还会接着改工作区。

恢复 `before.json`：

1. 删掉 `before.json`。
2. 运行 `knit run cancel <任务>`。这次执行记为失败「执行进程意外退出」，之后可以重新派发。

没有派发时的记录可比，这次执行改了哪些文件记不下来（改动文件是 0 个），这些文件不会进交付的提交。要留下的改动，在 `knit task close` 时用 `--paths` 登记。

恢复 `after.json`：删掉它。预览不再标出审查通过之后又改过的文件，别的不受影响。
