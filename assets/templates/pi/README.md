# Pi 项目资源

放置生成到用户项目的薄桥接、流程配置和阶段提示词／runtime 指令模板。此目录本身不是生效的 .pi/ 扩展；不将开发Knit的根AGENTS.md当作产品模板。

模板使用宿主公开API并调用Knit CLI，无本机绝对路径、凭据或业务状态机；本机安装映射由init单独保存。

## 恢复与下一步

- `knit_run action=resume runId=<run-id>`：与 CLI `knit run resume` 同一实现。旧 run 收敛后生成新 run 并立即启动（与阶段动作同一 start 流程），返回的 `launch.state` 为启动后的状态（confirmed 表示 worker 已认领并准备）；`wait: true` 时等新 run 到终态。只准备不启动用 CLI `knit run resume <run-id> --no-start`。
- 下一步：每轮上下文、`knit_status`（按任务）与 `knit_context` 显示核心推导的 `nextAction`（`下一步（<kind>）: …` 加可执行命令），覆盖输入已变（`task update --kind clarify/change`）、run 待接收（`run accept`）、needs_attention（原因与可用命令）、worker 已退出（`run resume`）、锁残留（`unlock`）与无绑定（跨机重建）；规则见 OPERATIONS §3.1。
- Rex：`execution.host=auto` 选中 Rex 后 worker 未报到且无副作用时，核心自动以 local 重启同一 run（回退原因 `rex_worker_not_started`）；显式 `--rex` 不回退。根因见 `knit status --run <run-id>` 的 Rex 启动诊断。
- `knit_task action=close` 的 `runsSettled` 是兼容参数：收敛由核心直接核对，不必传。
