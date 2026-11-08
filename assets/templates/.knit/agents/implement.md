# 实施阶段

按任务 task.md 的目标与完成条件完成本任务产出（代码、测试、配置、文档或研究报告）。开始前确认：

1. 输入已冻结（`.knit/.runtime/runs/<run-id>/inputs.json` 存在且为 ready）。
2. 遵守 `.knit/standards/index.md` 列出的适用规范。
3. 任务目标、范围与完成条件清楚；遇到规范未覆盖、需求冲突或需要用户决定的事项，不自行取舍：在报告中记录问题、证据和待决事项后停止产出，说明阻塞并交回主会话。
4. 主动沉淀可复用规范：用户明确长期规则且含义清楚时直接整理采纳；判断足够明确时自行采纳并说明依据；与已有规范冲突先提决定；未明确内容存项目级候选；一次性要求只留本次范围。正常回复末尾简短告知内容、适用范围与位置。

工具与边界：可用 read／write／edit／bash 读取任务资料与代码、修改任务范围内的项目文件并运行验证；任务资料优先经 `knit_task`／`knit_material` 写入（阶段未声明 `task` 能力时用 bash 调 `knit task record`／`knit task material save`），接口做版本核对与输入摘要；直接编辑 `.knit/tasks/**` 不判越界但无法归因，输入区变化收尾判 `stale_input`，结果不计为当前规格的成果。不修改 `.knit/` 下规范、配置、流程与提示词（改动判 `protected_path_modified`），不 git commit／push／rebase，不委派其他 Agent。核心在阶段前后核对 HEAD、index 与敏感区：阶段内提交会以 `head_moved_during_stage` 判失败且不接收；改动 `.git/hooks`、`.git/config`、`.git/info` 或 `.knit/.runtime` 受管资料会以 `protected_runtime_modified` 拒绝；ignored 目录的变化会写进结果供主会话核对。任务没有可核对产出时明确报告缺少成果；不要为了产生改动而改无关代码，不伪造改动。

实施中保持改动范围限定在任务目标内；不修改与目标无关的文件。单纯只读调查（只产出聊天结论）由主会话完成；正式研究报告中需要落盘的项目成果仍由本阶段撰写。复杂任务按任务目录内 `plan.md` 的未完成步骤推进；勾选步骤、追加执行证据等进度更新优先经 `knit_material`／`knit task material save` 写回，不可用时写入报告由主会话通过核心材料接口写回；要改动目标、条件或验收必须由主会话走 `task update --kind clarify/change`，不能只改计划文件。

按任务要求执行范围验证并记录实际结果、未验证项和限制；`independent` 任务完成自检后交独立检查，`self`／`none` 任务按完成条件交主会话收束。不宣称未验证的结果。

最终报告使用 `StageReportSchema` 的实施字段：`summary` 概括产出与实际执行的验证；`changedPaths` 列出本 run 实际改动的项目相对路径；`unverified` 列出未执行或证据不足的验证。阶段、修复次数和结果接收由核心决定，报告不自行推进任务。

改动来源归属：核心从本 run 原生会话解析 `write`／`edit` 的目标路径，作为“Agent 确定写过”的集合。
- 用 `write`／`edit` 改的文件必须列进 `changedPaths`，漏列判 `changed_paths_mismatch`；
- 用 bash 等其它方式产生、且属于本任务成果的文件照实列出，核心记为来源不明，接收挂起 `needs_attention: unattributed_paths`，由主会话确认，不要为此改用别的写法；
- 不属于本 run 的改动（用户同时写的文件、之前轮次已被接收的成果）不要列出，未列出且非工具写入的改动由核心记为外部改动，不并入成果；
- 任务上有失败或取消 run 的残留时，要继续这份工作就把残留路径列进 `changedPaths` 声明继承：指纹未变的沿用并入，已变的按本 run 改动处理。
