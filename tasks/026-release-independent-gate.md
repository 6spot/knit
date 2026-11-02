# 026 独立完成首版发布就绪审查

- 里程碑：M3B
- 执行角色：独立检查 Agent
- 顺序参考（非硬依赖）：[025 完成平台、打包和使用文档](025-packaging-and-platform-ci.md)
- 实际依赖：[任务表](../TASKS.md)中001–025的可用成果／证据；缺项先审并记录，全部必需项通过才可发布就绪。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 当前复核补记

2026-11-02 后续[一致性审计](../validation/design-implementation-audit/README.md)发现16项偏差，已登记027–042修复及043独立复验。本项completed及下方执行记录保留为当时的历史事实；其中“无未处理缺口／队列结束”不再代表当前实现。当前唯一状态以TASKS.md为准，下一修复入口027，修复后重新给出就绪结论。

## 目标

核对首版需求、实现、平台与证据的最终一致性，给出可审阅交付。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [TASKS.md](../TASKS.md)：全队列状态和前置记录。
- [DESIGN.md](../DESIGN.md)：第15.1、16节完整首版验收。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：写入权威与进程边界。
- [TECHNOLOGY.md](../TECHNOLOGY.md)：选型与最终实际验证。

## 实施范围

- 独立读当前代码、包、任务记录和真实测试证据，建立需求→实现→验收映射。
- 核对所有M0/M1/M2/M3A/M3B项；确认文档已随实际仓储与版本同步，不残留SDK／旧恢复假设。
- 检查受管文件保护、规范闭环、检查资格、授权、限定提交、取消／恢复及故障边界。
- 整理已验证、未支持、已知限制和候选材料；缺口关联阻塞与受影响任务，完成可审部分后汇总待决定事项。全部必需项未解决时保持blocked，不假称发布就绪，也不无限反复退回同一未决问题。

## 交付物

- 独立首版就绪结论、需求覆盖和证据索引
- 面向用户的安装／验证／限制／后续动作交接

## 完成前必须验证

- 所有前置成果可复现且不是模型自述／TODO空壳；无未处理数据保护或授权阻塞。
- Worktree/REX/其它客户端未混入首版，任务全部完成只代表开发验收，不等于已发布或已提交。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 本任务停止在可审阅的本地成果；发布、提交、推送或外部写入另按明确授权执行。
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

- 执行者／Session：独立检查 Agent（独立上下文／Session，最终复核）；主 Agent 依据其 PASS 报告整理证据并提交。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - 补齐 026 发现的实现缺口：`src/application/task-service.ts` `assertFormalTaskEnvironment`（task new/ready 核对 Git 工作区、HEAD、本地分支、未完成 merge/rebase/cherry-pick/revert/bisect、index 冲突、runtime tracked、项目根远程 FS）；`src/application/diagnostics.ts` doctor 增 `filesystem`／`cloud-sync`；`package.json` `prepack`；`scripts/build-bridge-schema.mjs` 不再向 stdout 打诊断；`src/application/templates.ts` 生成 `task list` 指令；README 自包含安装说明。
  - 新增 `validation/release-independent-gate/`；更新 README 状态与任务记录；B001 记录用户 Linux-only 决定和 macOS 后续补测。
- 实际验证命令与结果：
  - `/tmp` 全新 clone + `npm ci` + `npm pack`：**162 文件**，含 dist/bin、worker、bridge schema、桥接模板；无 src/test/tasks/validation/研究/私有资料。
  - 本地安装：`knit --version` 0.1.0；`knit init` ready；`knit start -- --version` Pi 1.4.0。
  - `typecheck`、`build`、`pack:check` 通过；`npm test` 两轮 **201/201**。
  - Git 前置真实 CLI：非 Git `git_required`；detached HEAD `detached_head`；`MERGE_HEAD` `git_operation_in_progress`；index 冲突 `git_conflict`；runtime tracked `runtime_tracked`。
  - doctor：`filesystem`、`cloud-sync` 检查存在；远程 FS 魔数静态核对一致。
- 任务书必需验证逐项：
  - 前置成果可复现且非自述/TODO：独立 Agent 实际执行 clean clone、pack、install、tests 和 Git guard 用例。
  - 无未处理数据保护/授权阻塞：M2/M3A 审计与发布复核通过。
  - Worktree/REX/其它客户端未混入首版：独立审查确认；`application/worktree.ts` 是运行前后工作区签名，不是 Worktree 功能。
  - 任务全部完成不等于已发布/已提交：候选通过，未 npm publish/部署。
- 证据位置：`validation/release-independent-gate/README.md`、`report.json`；`validation/release-candidate-linux/`；`validation/m2-independent-gate/`；`validation/m3a-developer/`。
- 未解决问题／决定：macOS 后续验证（B001）；未来 npm 发布需改名/scope、LICENSE、版本策略；远程 FS/SQLite 断电/外部并发未覆盖。
- 对下一项的交接：队列结束。当前可审阅交付为 Linux + Node24 + Pi1.4.0 候选；不自动发布，不扩展平台声明。
优先扫描下一编号（阻塞时可继续跳过）：队列结束；交付本地就绪结论，不自动发布或提交。
