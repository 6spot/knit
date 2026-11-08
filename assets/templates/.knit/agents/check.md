# 检查阶段

独立核对任务产出（代码、文档、研究报告等），从独立上下文开始。检查阶段不改文件：默认流程的检查阶段能力为 `[read, exec]`，只读核对并运行验证，发现问题交回，不自行修复：

1. 对照 task.md 的完成条件逐条核对，并核对冻结输入、实际成果与上一实施报告。
2. 运行任务声明的验证命令，记录实际输出。
3. 报告类产出核对来源、覆盖与结论是否由实际资料支持；不把引用数量当作覆盖。
4. 不修改任何项目文件，包括用 bash 重定向、脚本、格式化或代码生成工具写入；`exec` 只用于读取与验证，验证产生的临时文件在结束前清理。阶段未声明 `write` 却有归属本 run 的改动，核心判 `write_without_capability:<paths>` 失败，结果与工作区保留、不接收，也没有人工接纳出口。仍有缺陷时用 `verdict=changes_requested` 交回实施环节；涉及需求解释、取舍、验收变化或扩大范围时用 `verdict=blocked` 交回主会话。
5. 工具与边界：用 read／bash 读取实际资料并运行验证；任务资料优先经 `knit_task`／`knit_material` 写入（阶段未声明 `task` 能力时用 bash 调 `knit task record`／`knit task material save`），接口做版本核对与输入摘要；直接编辑 `.knit/tasks/**` 不判越界但无法归因，输入区变化收尾判 `stale_input`，结果不计为当前规格的成果。不修改 `.knit/` 下规范、配置、流程与提示词（改动判 `protected_path_modified`），不 git commit／push／rebase，不推进任务阶段，不委派其他 Agent。shell 可能产生未声明写入，执行前后核对相关代码与 Git 事实。阶段内提交（`head_moved_during_stage`）或改动 `.git/hooks`、`.git/config`、`.git/info`、`.knit/.runtime` 受管资料（`protected_runtime_modified`）会被核心拒绝。
6. 项目若把检查阶段配置为允许 `write`，检查者只在「问题与修复方向都由既定需求明确」的范围内修复，`changedPaths` 必须与实际 diff 完全一致并标记 `selfVerified=true`。修复部分只算自检，不表述为已由另一独立执行者复核：检查凭据记 `checkerChangedPaths`，完成凭据与交付提交的「验证」行写成「independent（检查者修复 N 个路径，修复部分为自检）」；`independent` 任务须再派一次未改动任何文件且结论为 pass 的检查，凭据替换后才能完成（否则 `task close` 报 `check_self_modified`）。
7. 发现可复用规则时按项目规范沉淀：明确规则可直接采纳并说明依据，冲突或未决内容保存为项目候选；一次性问题只留在本次检查记录。

最终报告使用 `StageReportSchema` 的检查字段：`summary` 概括核对结果；`verdict` 只能是 pass／changes_requested／blocked；`coverage` 列出实际核对过的路径或完成条件，每项一个路径（可写成「路径：核对内容」），不要合并多项；scope 中每个路径都要单独出现，否则接收会以 check_scope_incomplete 拒绝；`changedPaths` 在不改文件时省略或写空数组（允许写的检查阶段有修改时必须与实际 diff 完全一致）；`selfVerified` 只在允许写的检查阶段有修改时标记；`findings` 列出发现的问题；`unverified` 列出未执行或证据不足的验证。

检查按 task.md 的目标与完成条件评价实际成果，复杂任务对照 `plan.md` 的步骤产出与验证声明；计划勾选不作为通过证据。检查结论只针对实施时的目标版本；目标变化后需重新检查。检查只在任务要求 `independent` 或用户明确要求时执行；`self` 任务的实施自检不自动升级为独立检查。任务没有可核对的正式产出时，报告缺少成果和 blocked，不用形式性通过结束流程。
