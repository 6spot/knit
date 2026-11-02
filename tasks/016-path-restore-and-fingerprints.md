# 016 强化快照与逐路径恢复保护

- 里程碑：M2
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[015 完成CLI与生产薄桥接并验收M1](015-cli-bridge-m1-gate.md)
- 实际依赖：[006](006-domain-rules.md)、[007](007-local-infrastructure.md)、[009](009-task-files-and-inputs.md)、[012](012-snapshots-and-workers.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

完成真实项目所需的工作／index双层恢复与冲突保护。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [OPERATIONS.md](../OPERATIONS.md)：第3节。
- [DESIGN.md](../DESIGN.md)：第13节。
- [STATES.md](../STATES.md)：快照／restore及检查失效。

## 实施范围

- 补齐二进制、模式、删除、新增、未跟踪、符号链接／越界及覆盖上限说明。
- 实现snapshot show／restore预览，执行须expect当前指纹；--index与--remove-created分别显式指定。
- 核对仓库、分支、占用、工具终态和指纹，只改选中路径，保留无关index和后来记录。
- Task输入恢复经task update，不整份覆盖frontmatter／记录；runtime／原生记录不由源码restore覆盖。

## 交付物

- 逐路径恢复功能和完整覆盖说明
- 真实Git／文件夹具的恢复及拒绝证据

## 完成前必须验证

- 任意当前版本变化即停，不自动stash apply；同文件分块／后来修改按不变量核对。
- 真实恢复使目标检查失效并回适当环节；中断可核实，不因metadata刷新承诺index字节不变。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 快照不是外部服务回滚，也不是Git提交。
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

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`。
- 开始／结束时间：2026-11-02（本会话）。
- 实际修改：
  - `src/contracts/run.ts`：SnapshotEntry 增加可选 `indexDigest`；快照 manifest 可兼容旧记录。
  - `src/application/snapshot.ts`：通过 `git cat-file blob` 保存独立 index blob（`snapshot/index/`），记录 indexDigest、计入覆盖上限；工作区、index、mode、符号链接、二进制和缺失路径保持原始事实。
  - `src/contracts/restore.ts`（新）：逐路径计划、worktree/index 状态、执行记录 schema。
  - `src/application/restore.ts`（新）：show／preview／restore；显式 `--expect`、项目占用、仓库／分支／当前指纹重核；`--index` 逐路径 `hash-object -w` + `update-index --cacheinfo`；`--remove-created`；父级符号链接与越界拒绝；Task 文档输入经 `task update`；源码恢复清空检查资格、deliver 回 check；`.knit/.runtime/restores/<id>.json` 记录 running／completed／needs_attention 与逐路径结果。
  - `src/cli/snapshot.ts`（新）与 `src/cli/knit.ts`：`snapshot show/restore`、`--path/--expect/--index/--remove-created`、JSON 协议与人类可读预览。
  - `src/contracts/bridge-tools.ts`、`assets/templates/pi/extensions/knit.ts`：新增 `knit_snapshot` 同源工具；桥接只转交 CLI。
  - `src/application/task-service.ts`：直接 update 支持调用方 `expectTaskSha256`，恢复时防止预览后 task.md 变化。
  - `src/cli/output.ts`：branch/repo 变化映射 stale_input，快照／删除保护映射 needs_review。
  - `test/restore.test.mjs`（新 7 项）：show、二进制／模式／删除／未跟踪／符号链接／index、显式删除、Task 输入、检查失效、损坏 index 中断、越界、CLI 协议。
  - `validation/snapshot-restore/`：真实 Git／CLI 恢复与拒绝证据。
  - `OPERATIONS.md`、`DESIGN.md`、`STATES.md`、`ARCHITECTURE.md`：补 016 实现事实与边界。
- 实际验证命令与结果：
  - `npm run -s build`：通过。
  - `npm run -s typecheck`：通过。
  - `npm run -s pack:check`：通过（模板 `knit.ts` 与 bridge schema 在包内）。
  - `npm test`：**165/165**（原 158 + restore 7）。
  - `node --test test/restore.test.mjs`：7/7；覆盖真实 Git index、mode、二进制、symlink、删除、未跟踪、Task 输入、检查失效与损坏快照。
  - 真实 CLI e2e `/tmp/knit-016-e2e`：`snapshot show` 只读；`snapshot restore` 默认预览，带三条 `--expect` 执行 `--index --remove-created` 后 `app.txt` 回到快照字节、`tool.sh` 恢复 0755、`created.txt` 删除；Task 输入经 task update 恢复；切分支后恢复被拒绝。证据见 `validation/snapshot-restore/`。
- 证据位置：`validation/snapshot-restore/README.md`、`report.json`、`show.json`、`restore.json`、`task-input-preview.json`、`task-input-restore.json`、`branch-rejected.json`、`manifest.json`、`restores/`。临时夹具 `/tmp/knit-016-e2e`。
- 任务书必需验证逐项：
  - 任意当前版本变化即停：`--expect` 不匹配、预览后内容／index 变化、mode 变化均拒绝；不自动 stash apply。
  - 同文件分块／后来修改：以整文件指纹为不变量，不提供分块写入；后来修改使当前指纹不符即停。
  - 真实恢复使旧检查失效并回适当环节：清空 binding `lastCheckRunId`，deliver → check，测试覆盖。
  - 中断可核实：损坏 index 快照在 worktree 写后失败，留下 `needs_attention` 记录和逐路径 failed，不承诺回滚；metadata 不冒充 index 字节不变。
  - 二进制、模式、删除、新增、未跟踪、符号链接／越界与覆盖上限：真实测试／e2e 覆盖；快照默认 64 MiB 上限沿用 012，index blob 计入；目录不递归删除，子模块不支持。
  - Task 输入恢复经 task update，保留 frontmatter／记录；runtime／原生记录不由源码 restore 覆盖。
- 未解决问题／决定：
  1. restore 只接受精确文件／符号链接路径；不实现目录子树或分块恢复。
  2. `--index` 同时恢复选中 worktree 与 index，未提供 index-only 开关；保留无关 index。
  3. Task 输入恢复固定使用 `kind=change`，因此任务回到 discuss；只恢复输入区，不恢复旧 frontmatter／记录。
  4. 旧快照没有 `indexDigest` 时 `--index` 拒绝，不迁移旧 snapshot。
  5. 分支必须与快照 base 相同，但不要求当前 HEAD 等于 base（允许后续提交后逐路径恢复）；父级符号链接即使指向项目内也保守拒绝。
  6. 恢复失败不自动回滚已写入的路径，依赖 restore 记录和现场核实。
- 对下一项的交接：017 可复用 `RestoreService` 的显式 expect、项目占用、路径安全与 `.runtime/restores/` 记录；锁／取消测试可直接构造中断 restore 记录，不把恢复记录误当业务完成回执。

优先扫描下一编号（阻塞时可继续跳过）：[017 强化占用、取消和中断后的执行安全](017-cancellation-and-lock-failures.md)。
