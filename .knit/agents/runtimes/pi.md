# Pi runtime 补充

本项目的阶段会话使用本机 Pi CLI（stdin-stdout RPC）：

- 阶段执行不加载项目扩展（`--no-extensions`），只使用受控资源；工具范围由该阶段 `tools` 能力白名单决定：不写或 `all` = 全部放开，`[]` = 全部禁用（`--no-tools`），非空列表 = 白名单；`read` 只读，`write` 改文件，`exec` 可间接改文件，`task` 任务工具，`external`／`network` 为显式放开。
- 用 read／write／edit／bash 读取实际任务资料、代码和验证入口；不得只凭描述猜测文件内容或测试结果。
- 任务资料（`.knit/tasks/**`）不计入成果也不判越界，优先经接口写入：阶段声明 `task` 能力时用 `knit_task`／`knit_material`，默认能力下用 bash 调 `knit task record`／`knit task material save`；直接编辑无法归因。输入区变化收尾判 `stale_input`；`.knit/` 下规范、配置、流程与提示词是硬保护路径，需要变更时记录问题并交回主会话。
- 阶段内禁止 Git 提交：核心冻结阶段前 HEAD，收尾时 HEAD 移动即 `head_moved_during_stage` 失败；`.git/hooks`、`.git/config`、`.git/info` 与 `.knit/.runtime` 受管资料有变化即 `protected_runtime_modified` 失败；ignored 目录变化只写进结果 `ignoredChanges`。
- 模型选择按项目配置 `phases.<stage>.model`（配置键名沿用 phases，值为阶段 id）；未配置时用启动时主 Agent 当前模型。
- 原生会话记录由 Pi CLI 保存在 `.knit/.runtime/native-sessions/pi/`，跨 run 复用；恢复优先加载旧记录。
- 取消经受控 CLI 的 clear_queue/abort，按稳定终态核实。
- 停止条件：需求不明、规范冲突、需要用户取舍、发现保护路径或未授权副作用时停止写入并如实报告；检查阶段用 blocked／changes_requested 交回，其他阶段在报告中说明阻塞；blocked 由核心接收，不自行推进阶段。
- 报告按阶段字段输出（implement：summary／changedPaths／unverified；check：summary／verdict／coverage／changedPaths／selfVerified／findings／unverified）；`changedPaths` 列出本 run 实际改动（`write`／`edit` 写过的必须列出，bash 产出照实列出、由主会话确认来源，声明继承的失败残留一并列出），不列外部改动与之前轮次的成果；未执行的验证写入 `unverified`。

无正式任务时不启动 Knit worker；需要委派时使用 Pi 宿主提供的通用子 Agent／只读工具。宿主不提供或不可用时由主会话直接执行，不暗建 Knit 任务。
