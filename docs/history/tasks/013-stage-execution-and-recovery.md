# 013 实现实施、检查、结果接收与恢复续做

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[012 实现快照准备、local启动与worker认领](012-snapshots-and-workers.md)
- 实际依赖：[003](003-pi-cli-runtime.md)、[006](006-domain-rules.md)、[009](009-task-files-and-inputs.md)、[010](010-session-context.md)、[012](012-snapshots-and-workers.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

贯通独立阶段执行、真实检查资格与恢复，保持Task业务权威。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第5、9.3–9.5、10.1节。
- [STATES.md](../../design/STATES.md)：运行、检查、自动修复与Session。
- [validation/session-fallback/README.md](../../../validation/session-fallback/README.md)：真实续做与模型自报状态边界。

## 实施范围

- 通过003/012派发implement/check及advisory，正确选模型／工具／角色；正式check入口不得越过phase守卫。
- 等待agent_settled与真实工具终态，保存不可变result／原生条目范围／增量用量，核心按固定acceptanceOperationId复核接收。
- 累积scope，使用唯一最新检查候选，处理changes_requested→修复→重查、两轮计数与明确停止原因。
- 实现resume --run：旧执行确认结束后恢复原记录，或同客户端新会话读文件；不重置业务状态，不因有效结果待同步而重跑模型。

## 交付物

- 可执行的阶段／接收／恢复用例
- 正式与advisory、检查失效和修复计数测试

## 完成前必须验证

- 实施与检查Session独立，模型可相同；检查阅读实际内容并保留证据，模型报告不直接改Task。
- 原生引用不可恢复与run证据写失败分别处理；取消终态允许部分事实，旧取消不影响新run。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不让worker提交、递归委派或把主会话对话复制进数据库。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - `src/contracts/run.ts`：RunPhase 增加 advisory；新增 StageReport、RunSessionRecord、不可变 RunResultFile（report／原生条目范围／增量用量／会话／实际改动路径与指纹／固定 acceptanceOperationId）、ScopeFile、CheckFile、RunCancel；RunStatus 增加 result／acceptance。
  - `src/infrastructure/run-store.ts`：result 不可变写入、scope 读写、check 凭据读写、cancel 意图；重试清理对应文件。
  - `src/application/stage.ts`（新）：从 ContextPlan 读取正文、构造 implement／check／advisory 系统与用户提示、解析最后一个 fenced JSON 报告并按 phase 校验字段。
  - `src/application/stage-runner.ts`（新）：选择独立 Session（原记录恢复或同客户端新建）、登记 SessionRecord、装配 PiAgentRuntime（按角色过滤工具）、等待 agent_settled、保存原生条目范围与增量用量、比对实际文件差异、拒绝 check／advisory 副作用、生成不可变 result。
  - `src/application/worktree.ts`（新）：Git 状态路径 + 逐路径内容指纹，检查前后比对；忽略 `.knit/.runtime/`。
  - `src/application/scope.ts`（新）：scope 累积、路径当前指纹、scopeDigest。
  - `src/application/run-acceptance.ts`（新）：按固定 acceptanceOperationId 复核输入／规范／scope／分支／实际文件指纹，机械推进 Task、scope、check 凭据与 binding；修复轮计数、stale 与 needs_attention 分支；接收成功后收敛误置的 failed 状态。
  - `src/application/run-coordinator.ts`：advisory 阶段、check 的 scope 期望、修复周期守卫与显式 `--new-repair-cycle`、status 投影 result／acceptance、cancel 意图、resume --run（待同步只接收、已接收不新建、失败后原会话续做、活跃未确认结束拒绝）。
  - `src/worker/knit-worker.ts`：prepared 后默认继续阶段（`--prepare-only` 保留 012 验收路径），持项目占用执行与接收；结果写失败置 failed，不发布完成。
  - `src/cli/run.ts`：run prepare 支持 advisory／resume-session／new-repair-cycle；新增 run accept／resume／cancel；status 展示结果与接收。
  - `src/contracts/metadata.ts`：binding 增加可选 scope／scopeRunIds。
  - `test/stage.test.mjs`（新 11 项）、`test/fixtures/fake-pi.mjs`（最小 RPC 假实现，仅测试）、`test/run.test.mjs`（012 改用 --prepare-only）。
  - `validation/stage-execution/`：真实 Pi 实测报告、两次 run 结果与 check 凭据副本。
- 实际验证命令与结果：`npm test` 138/138（stage 11 + run 10 + standards 6 + session 7 + task 17 + init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run typecheck` 通过；`npm run pack:check` 通过。
  - 真实 Pi 1.4.0／`magpie / auto/glm-5.3-flash` 临时仓库 `/tmp/knit-013-real2`：init → task ready → implement `run-ab2002d0d74d`（completed，实际改动 app.txt，input 16295／output 713，原生范围 6e864691..1afa6a1a）→ 接收后 phase check、scope app.txt → check `run-c7319a3be882`（独立原生 Session，实际 bash cat／git status／git diff／node 验证，verdict pass，input 7895／output 696）→ 接收后 phase deliver，check.json 绑定 scopeDigest d9994672780b → `run resume run-c7319a3be882` 返回 already_accepted，未新建 run、未重跑模型。零 Git 提交、零推送。
  - 另一轮真实实测 `/tmp/knit-013-e2e`：implement `run-fa2c271dacc4`（input 33810／output 1061，greet.txt＋math.js）→ check `run-574f6128330d`（input 10916／output 528，bash 读取、运行验证命令、git diff）→ 首次因 coverage 写成“路径：说明”被接收判 incomplete，修正路径前缀匹配后接收 pass；说明检查结论确实由核心复核而非模型直接落 Task。
  - 假实现测试覆盖：独立 implement/check 会话与原生范围、check 改动文件失败、报告 changedPaths 与实际不符、两轮修复后 repair_round_limit、输入变化 stale_input、resume 待同步只接收／失败后续做、取消 cancelled 保留会话与用量且旧取消不影响新 run、原生引用缺失仍接收、result 写失败不发布、advisory 不推进 Task。
- 任务书必需验证逐项：
  - 实施与检查 Session 独立、模型可相同；检查阅读实际内容并保留证据，模型报告不直接改 Task：真实 e2e 中 implement 与 check 原生 ID／文件不同，check 原生记录含 cat／git diff／node 工具调用，check.json 保存 coverage 与结论；Task phase 只在 RunAcceptanceService 复核后改变。
  - 原生引用不可恢复与 run 证据写失败分别处理：`KNIT_FAKE_NO_FILE` 测试中结果仍 completed、Session 标 opening、接收完成；result.json 占成目录时 state failed／result_write_failed，Task 不推进、operation needs_attention result_missing。
  - 取消终态允许部分事实，旧取消不影响新 run：取消测试保留 session 与 usage，Task 保持 implement；随后新 run 正常完成，旧 cancel.json 只在其 run 目录。
  - resume --run：待同步结果只接收不重跑；已接收返回 already_accepted；失败 run 用原会话建新 run 续做；活跃且句柄未确认结束时拒绝。
  - 检查失效与修复计数：输入变化 stale_input 不写 check；changes_requested 两轮后写 repair_round_limit，无授权周期写 repair_not_authorized，`--new-repair-cycle` 才开新周期。
- 实施中纠正的事实：① 检查 coverage 常写“路径：说明”或“路径（说明）”，按精确集合比较会误判；改为路径前缀且下一字符不是路径字符。② 接收成功后原 worker 已把 state 置 failed（acceptance_*），补接收时收敛为 completed，否则 status 长期显示 failed。③ result.json 被占成目录时 worker finally 读取 result 抛 EISDIR 导致接收未执行；改为 failed 分支总是尝试接收，status/acceptance 对不可读 result 按缺失处理。④ resume 原先只拦 alive／unknown，句柄缺失会误开新 run；改为只有明确 not_alive 才续做。⑤ 旧 result 没有实际路径指纹，晚接收可能把后来改动当本次成果；result 增加 actualEntries，接收时发现 scope_changed 即停。
- 未解决问题／决定：① CLI 无主会话时阶段 Session 登记为 sub 且 parentSessionId=null（SessionService.attach 会要求父会话；worker 直接登记以支持 DESIGN 5.8 的 CLI 人工入口）。是否允许该例外需在 015/017 确认。② 修复周期必须显式 `run prepare --new-repair-cycle`；首次 changes_requested 不自动授权，写 repair_not_authorized。③ 报告依赖模型输出一个 fenced JSON；无 JSON／字段不符即 failed report_invalid，不猜测。④ 模型选择仍由 prepare 显式 provider/model，未接项目 phases 配置与主会话当前模型（归 015）。⑤ check 副作用以 Git 可见状态为范围，ignored 文件变化不纳入。⑥ result 的 actualEntries 为新增可选字段，旧结果接收时不复核后来文件改动。
- 对下一项的交接：014 从 Task phase=deliver、scope.json、checks/<run>.json 与 binding.lastCheckRunId 出发；收尾前可复用 StandardsService.pending，交付提交必须显式完整 branch 与授权来源；RunAcceptanceService 的固定 operation 模式可复用。真实结果与 check 凭据副本见 `validation/stage-execution/`；`run status/accept/resume/cancel` 已可用，`run prepare --new-repair-cycle` 为显式修复授权入口。

优先扫描下一编号（阻塞时可继续跳过）：[014 实现限定提交、归档与确定性收尾](014-delivery-and-archive.md)。
