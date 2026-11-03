# 固定来源与核对位置（054）

## Trellis 基线

- 仓库：`mindfold-ai/Trellis`
- 固定提交：`f089cb3286071199e84118dee86b6d76aab032f1`（2026-11-03 核对）
- CLI 版本：`@mindfoldhq/trellis` **0.6.17**（`packages/cli/package.json`）
- 提交树：<https://github.com/mindfold-ai/Trellis/tree/f089cb3286071199e84118dee86b6d76aab032f1>
- 本机便利副本：`/tmp/trellis-054`，仅用于逐行阅读；不是 Knit 仓库内容，也不是交付依赖。任务说明提到的旧副本 `/tmp/agent-framework-research-20261031/Trellis/` 本机不存在，未使用。
- 版本范围：本报告只使用上述固定提交。没有读取更新版本的 Trellis，也没有把不同提交的行为合并描述。
- 固定文件链接可按 `https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/<仓库内路径>` 组成；下表路径均相对仓库根。

核对方式：`git clone` 后检出固定提交，读取工作流、命令／技能、Pi 角色与扩展源码。没有启动 Trellis CLI，也没有让 Trellis 运行模型；因此下文把它区分为“源码与注入路径核对”，不是运行行为实验。

## Trellis 实际来源

| 用途 | 固定提交内的位置 | 核对到的行为 |
| --- | --- | --- |
| 请求分流与无任务状态 | `packages/cli/src/templates/trellis/workflow.md` L155-159、L179-183 | 简单对话／小任务先问是否创建任务；复杂任务问是否进入规划；用户拒绝则本次跳过 Trellis。 |
| 每轮状态面包屑 | 同文件 L195-208、L228-241、L270-272；`packages/cli/src/templates/pi/extensions/trellis/index.ts.txt` L1124-1151、L2066-2085 | 从 `workflow.md` 的 `[workflow-state:*]` 块解析 `no_task`／`planning`／`in_progress` 等正文，经 Pi `before_agent_start` 注入。 |
| 创建任务与规划门 | `workflow.md` L325-339、L341-365、L455-468 | 只有在任务创建同意后 `task create`；`start` 是后续规划审阅门，不把创建同意当作实施同意。 |
| 研究子 Agent 派发 | `workflow.md` L367-390 | 明确要求 `trellis-research` 把每个主题写入 `{TASK_DIR}/research/`；产物按文件保留，聊天不作为持久载体。 |
| Pi research 角色 | `packages/cli/src/templates/pi/agents/trellis-research.md` L1-25 | 工具为 read/write/bash/find/grep；先 `task.py current` 解析活动任务，只允许写当前任务 `research/`，回复只给路径和摘要。 |
| Claude research 变体 | `packages/cli/src/templates/claude/agents/trellis-research.md` L30-32 | 同样先解析活动任务；没有活动任务时要求用户指定输出位置，不自行猜测。这说明 research 仍依附任务，不是免任务入口。 |
| Pi implement 角色 | `packages/cli/src/templates/pi/agents/trellis-implement.md` L1-35 | 读任务产物、spec、research；运行 lint／typecheck／聚焦测试；禁止 commit／push／merge；有递归委派守卫。 |
| Pi check 角色 | `packages/cli/src/templates/pi/agents/trellis-check.md` L1-37 | 读 diff、任务产物与 `check.jsonl`；**直接修复发现**；运行 lint／typecheck；有递归委派守卫。 |
| 检查工作流 | `workflow.md` L543-553、L559-562 | 明确写“Auto-fix issues it finds”；检查完成后仍要 lint／typecheck。 |
| 规划技能与同意门 | `packages/cli/src/templates/common/skills/brainstorm.md` L3-17、L25-37、L39-70 | 先取证再问用户；任务创建同意与实施批准分开；复杂任务先写 `prd.md`／`design.md`／`implement.md`并停下等待批准。 |
| 上下文清单 | `workflow.md` L392-414 | `implement.jsonl`／`check.jsonl` 由主 Agent 手工整理 spec 与 research 路径，供子 Agent 使用；代码文件不放进清单。 |
| 子 Agent 上下文注入 | `packages/cli/src/templates/shared-hooks/inject-subagent-context.py` L60-72、L762-835、L940-958、L1124-1177 | implement／check 需要任务目录；research 在部分 hook 路径允许缺少任务目录，但角色仍只做“查找并解释”，不是评审或完成规则。 |
| 子 Agent 递归守卫 | `trellis-implement.md` L11-17、`trellis-check.md` L11-17；`workflow.md` L234-240 | 派发只由主会话发起；子 Agent 不得再派发 implement／check。 |
| 强制步骤与收尾 | `workflow.md` L147-152、L273-279、L600-640；`packages/cli/src/templates/common/commands/finish-work.md` L1-20 | Phase 2 检查、Phase 3 spec 更新与 commit 属于 required steps；`finish-work` 归档并记录会话，不在命令内替代工作提交。 |
| Pi 启动与首轮上下文 | `pi/extensions/trellis/index.ts.txt` L1824-1837、L2028-2033、L2066-2118 | `session_start` 提示 `/trellis-start`／`/trellis-continue`；`before_agent_start` 注入缓存的 session overview／workflow 启动上下文，随后追加任务状态。 |

## Knit 当前对应位置

| 用途 | 仓库位置 | 核对到的行为 |
| --- | --- | --- |
| 主会话分流模板 | `assets/templates/.knit/workflow.md` L5-13 | 五类路径：普通问答、小修改、新正式需求、继续、补充／范围变化；没有只读调查／外部评估的独立路径。 |
| 实施角色 | `assets/templates/.knit/agents/implement.md` L1-9 | “按目标与完成条件实施”；结尾固定“完成自检后交独立检查”。 |
| 检查角色 | `assets/templates/.knit/agents/check.md` L1-9 | 独立核对，不修改实施内容；没有说明报告／文档类成果如何核对。 |
| 每轮注入 | `assets/templates/pi/extensions/knit.ts` L291-320 | 有任务时给身份、阶段、资料、活动运行与“按当前阶段推进”；无任务时只给普通问答、小修改、新正式需求、继续／补充。 |
| 自动入口 | 同文件 L342-352 | `session_start` 自动登记／恢复选择并启动观察，不要求先运行 `knit start`。 |
| 阶段系统提示 | `src/application/stage.ts` L125-150 | 明确“独立阶段执行器、不是主 Agent、不要委派”；禁止修改 `.knit/` 下任何文件；plan／design 全文注入，research 只作背景摘要。 |
| 角色文件装配 | `src/application/context-planner.ts` L198-219 | `.knit/agents/<role>.md`；implement／check 必需，advisory 可选；缺失时记 `optional_role_file_missing`。 |
| 规划资料装配 | 同文件 L274-298 | `plan/design` 全文、`research/` 入口摘要；`research` 为背景、不计入输入摘要。 |
| 实施接收 | `src/application/run-acceptance.ts` L261-270 | implement 报告与实际 changedPaths 集合一致即接收；没有“必须非空”或“必须为代码”的判断。 |
| 阶段转移 | `src/domain/task.ts` L151-160 | `onImplementationAccepted` 无条件 `implement → check`。 |
| 检查结论 | 同文件 L162-178；`src/application/run-acceptance.ts` L320-360 | pass → deliver；changes_requested → implement；blocked 保留 check；检查报告与实际范围由核心核对。 |
| 正常完成领域规则 | `src/domain/task.ts` L209-216 | `onComplete` 只处理业务状态，不核对检查资格；调用方注释称守卫由调用方核对。 |
| task close 实现 | `src/application/task-service.ts` L1052-1093 | 核对 `runsSettled` 与领域状态后写闭；没有核对 `lastCheckRunId`／检查通过。 |
| 非正式独立检查 | `src/application/informal-check.ts` L123-142；`src/cli/run.ts` L210-260 | 显式 `--scope`，只读，不建 Task／binding；prompt 是“检查者”，不是研究角色。 |
| 模板与受管内容 | `src/application/templates.ts` L20-29、L63-82 | workflow／角色为 project 所有（已存在即 keep）；桥接为 managed；AGENTS 受管块按基线核对。 |
| 主流程验收 | `validation/main-workflow-gate/README.md` S1-S14 | 已验证无任务注入、创建授权、继续、规划注入与真实宿主 3 轮；未覆盖“只读调查不建任务”的模型行为。 |

## 未取得或未验证

- 本机没有 `knit-demo` 的工作副本；真实案例 `k-748f2087202d`（`11-03-eval-pi-rexagents`）只引用任务 054 已登记的可移植事实，没有另行读取其任务文件或截图。
- 没有运行 Trellis CLI／模型，也没有把 Trellis 的行为当作 Knit 的运行保证；Trellis 结论均为固定提交源码与注入路径结论。
- 没有验证 macOS、NPM 发布、外部部署或真实项目迁移；这些仍在既有边界之外。
