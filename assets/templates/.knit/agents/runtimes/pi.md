# Pi runtime 补充

本项目的阶段会话使用本机 Pi CLI（stdin-stdout RPC）：

- 阶段执行不加载项目扩展（`--no-extensions`），只使用受控资源。
- 模型选择按项目配置 `phases.<phase>.model`；未配置时用启动时主 Agent 当前模型。
- 原生会话记录由 Pi CLI 保存在 `.knit/.runtime/native-sessions/pi/`，跨 run 复用；恢复优先加载旧记录。
- 取消经受控 CLI 的 clear_queue/abort，按稳定终态核实。

无正式任务时不启动 Knit worker；需要委派时使用 Pi 宿主提供的通用子 Agent／只读工具。宿主不提供或不可用时由主会话直接执行，不暗建 Knit 任务。
