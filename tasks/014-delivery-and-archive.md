# 014 实现限定提交、归档与确定性收尾

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[013 实现实施、检查、结果接收与恢复续做](013-stage-execution-and-recovery.md)
- 实际依赖：[006](006-domain-rules.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让主Agent判断与确定性工具共同完成真实交付，不让worker报告冒充Git事实。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../DESIGN.md)：第10–11节。
- [OPERATIONS.md](../OPERATIONS.md)：第4.1节：目标与授权。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：确定性操作、seal和回执。
- [validation/pi-cli-1.4.0/README.md](../validation/pi-cli-1.4.0/README.md)：hook与回执限制。

## 实施范围

- 实现deliver/archive核心操作、完整refs/heads目标、authorizationRef版本与来源定位；默认分支候选只观察不授权。
- 使用限定路径／所选树保护普通无关index，保留项目hook，提交后核对真实commit内容和范围。
- 先记录完整收尾资料，再seal固定版本、提交、移动与检查点；已生效但回执丢失先核实，不重做。
- 正常完成使用有效检查；取消／替代仅归档实际资料，不默认提交半成品代码或造空commit。

## 交付物

- 交付／归档与授权接线
- 临时仓库限定工作提交、资料归档和已有脏index证据

## 完成前必须验证

- 工作commit和归档commit各自范围准确，无关staged／unstaged保留；hook越界记录真实事实并needs_attention。
- 封存中record明确未保存；后补按原Task ID写新资料，不伪称已进旧提交、不重开业务。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 绝不在当前工程自动commit/push；不自动stash、reset、amend或改写历史。
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
  - `src/contracts/delivery.ts`（新）：交付／归档操作、步骤、授权来源与默认分支记录 schema。
  - `src/application/delivery.ts`（新）：完整 refs/heads 校验、当前分支与绑定核对、默认分支候选、workflow／user 授权来源定位与摘要、index／工作区快照、Git 范围读取。
  - `src/application/delivery-service.ts`（新）：deliver／archive 操作检查点；检查与规范门禁、限定工作提交、无关 index 保护、hook 越界检测、收尾记录、封存、移动、归档提交、按操作 ID 核实回执、显式 retry、取消／替代归档。
  - `src/cli/deliver.ts`（新）与 `src/cli/knit.ts`：deliver／archive 命令、--branch／--authorization-ref／--caller／--retry、--json 协议输出。
  - `src/application/config.ts`：`delivery.defaultBranch` 可选完整 ref；`src/ports/infrastructure.ts`、`src/infrastructure/sqlite-metadata-store.ts`：operations.list。
  - `src/cli/task.ts`：task new 实际传入 --branch（缺省当前完整分支）。
  - `src/contracts/task-inputs.ts`：inputsDigestOf 排除 id／status／phase／outcome／branch；`src/application/run-acceptance.ts` 冻结输入摘要改按 inputsDigestOf。
  - `src/application/task-service.ts`：task record 追加记录区，不再替换既有记录。
  - `test/delivery.test.mjs`（新 11 项）、`test/stage.test.mjs`（输入摘要一致性断言）。
  - `validation/delivery/`：真实 Pi implement→check→deliver→archive 证据。
- 实际验证命令与结果：`npm test` 149/149；`npm run typecheck` 通过；`npm run pack:check` 通过。
  - 真实 Pi 1.4.0／`magpie / auto/glm-5.3-flash`，临时仓库 `/tmp/knit-014-e2e2`：task new 绑定 refs/heads/main → clarify → ready → implement `run-58955e29b433`（completed，usage 21202/620）→ check `run-8a2675075912`（verdict pass，usage 4957/593）→ `deliver`（op-6ca6e77ca8f5）成功：工作提交 `46e405e`（app.txt + 任务目录），归档提交 `4ad556c`（旧任务路径删除 + `archive/2026-11/11-02-app-new` 新增），归档目录正确，封存标记已移除；归档后 `task record` 补记成功，原交付记录保留。零推送。
  - 另一轮 `/tmp/knit-014-e2e` 先暴露 013 输入摘要含 phase 导致检查刚通过即 stale；修复后重跑检查并交付，保留为缺陷证据。
  - 单元测试覆盖：正常交付两段范围与无关 staged／unstaged 保留；hook 越界／改选中文件 needs_attention；显式 retry 核实原提交；取消归档无工作提交；封存中 record 未保存、归档后补记；Agent 无授权、短分支、分支不一致；检查后正式规范变化 check_stale；archive 不能绕过 deliver；回执丢失不重复提交；CLI --json。
- 任务书必需验证逐项：
  - 工作 commit 与归档 commit 各自范围准确，无关 staged／unstaged 保留：真实 e2e 与单元测试均以 `git diff-tree` 核对；交付前写入的 other.txt 未暂存修改和 staged.txt 暂存内容在提交后保持不变。
  - hook 越界记录真实事实并 needs_attention：pre-commit 写 hook-out.txt 或改 app.txt 时保留真实提交 OID、任务不移动、操作 needs_attention；清理现场后显式 `--retry` 只核验原提交并继续。
  - 封存中 record 明确未保存：`.knit-sealed` 存在时 `saved:false, sealed:true` 且文件不变；归档提交后移除标记，后补按原 Task ID 追加档案新资料，保留原交付记录，不重开业务。
  - 实际命令、环境、结果与证据：见上及 `validation/delivery/report.json`。
- 实施中纠正的事实：① 013 的 `inputsDigestOf` 把 id／status／phase／outcome／branch 纳入摘要，check pass 后 phase 转 deliver 立即被判 stale；已按 DESIGN 第3.6节排除这些字段。② `RunAcceptanceService` 把整篇 task.md 的 SHA-256 当 confirmedInputsDigest；改为 inputsDigestOf。③ `task new --branch` 选项未传给服务，任务常为 null 分支无法交付；已接线并缺省当前完整分支。④ `TaskService.record` 替换整个记录区，归档后补记会覆盖交付记录；改为追加。⑤ 分支错误时先创建操作再失败，遗留操作阻塞后续正确分支；改为创建前校验当前／本地／任务分支。⑥ 取消任务旧路径未跟踪时 `git add` 报 pathspec；只 add 存在或已跟踪路径。⑦ 工作提交后选中路径从脏列表消失被误判 hook 改动；改为只比较提交后仍脏的选中路径。⑧ 归档月份原用 UTC，改为与任务归档一致的本地月份。
- 未解决问题／决定：① deliver 是唯一正常完成入口；已完成但无交付操作的 archive 返回 deliver_required。② needs_attention 不自动重试，须显式 `--retry`；重试先核验原提交与选中范围，工作区脏则停。③ 工作提交包含 scope、任务目录与最近审阅的规范目标；更复杂多任务共享规范归属仍由主 Agent 判断。④ 首版只实现 delivery.mode=local，merge／推送／PR 未实现。⑤ 任务分支为 null 的旧任务需后续 adopt 或重建；新任务已绑定当前分支。⑥ 直接 CLI 无授权来源只记显式调用，核心不验证人类语义。⑦ inputsDigestOf 变更使开发期旧摘要失效，无历史迁移。⑧ mixed 审阅只机械要求至少一个候选来源行，具体哪些候选已采纳仍由主 Agent 判断。
- 对下一项的交接：015 可复用 DeliveryService 的 preflight／操作检查点与 `validation/delivery/` 证据；CLI／桥接需把 Agent 的 authorizationRef 传入 deliver，并保持 stdout 协议。真实 M1 验收仍需在桥接内调用 deliver，覆盖工具参数与协议输出；推送、合并、PR 不在 014。

优先扫描下一编号（阻塞时可继续跳过）：[015 完成CLI与生产薄桥接并验收M1](015-cli-bridge-m1-gate.md)。
