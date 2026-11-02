# 004 实证比较并确定唯一元数据仓储

- 里程碑：M0
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[003 实现本机Pi CLI协议适配](003-pi-cli-runtime.md)
- 实际依赖：[001](001-engineering-baseline.md)、[002](002-contracts-and-ports.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

用同一真实写入契约选定文件或SQLite，并只保留一个生产权威。

## 先读

先遵守根 [AGENTS.md](../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [TECHNOLOGY.md](../TECHNOLOGY.md)：第4、8节：原子写与存储比较。
- [ARCHITECTURE.md](../ARCHITECTURE.md)：第4、6–7节：MetadataStore及单写入方。
- [RESEARCH.md](../RESEARCH.md)：第17.13节：比较计划（已执行，见任务记录）。

## 实施范围

- 按002最小结构比较Session/binding/operation真实关联写入、版本检查、重复执行与恢复。
- 覆盖两进程竞争、取消／完成竞争、Git成功回执丢失后的元数据收敛；Git／Markdown事实仍单独核实。
- 核实Node24 node:sqlite的真实API／事务／busy与打包行为；若需外部驱动先比较安装维护成本，不引ORM。
- 选择一个生产实现并接入MetadataStore；另一实现最多留隔离比较夹具，不在产品双写或长期维护两套后端。
- 依据实证同步九份文档中的存储选择、布局、命令和验收；不能只在本任务记一句决定。

## 交付物

- 可复核对比报告和明确选型理由
- 选定的生产仓储、必要原子文件／事务实现和更新后的设计

## 完成前必须验证

- 在Node24实际执行相同写入脚本与故障点，验证不丢关联、不重复接收、只读不写。
- 对比复杂度和故障处理，不只比较吞吐；未达到条件就blocked，不把SQLite当默认已选。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 开发任务用Markdown不决定产品后端；不把外部副作用放进长事务。
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
- 开始／结束时间：2026-11-01。
- 实际修改：新增 src/infrastructure/sqlite-metadata-store.ts（生产 SqliteMetadataStore，实现 002 的 MetadataStore 端口：sessions/bindings/operations 三表 JSON 正文、BEGIN IMMEDIATE 短事务 await 语义、WAL、busy timeout 可配、TEXT 列严格读取）；test/metadata.test.mjs（6 项产品级测试）；validation/metadata-storage/（比较夹具 fixture/{file-store,sqlite-store,store-factory,scenarios,run-comparison}.mjs 与 README 报告）；同步更新 DESIGN/ARCHITECTURE/TECHNOLOGY/OPERATIONS/STATES/RESEARCH/WORKTREE 中全部存储决策表述（运行目录布局改为 metadata.db，移除“M0 决定文件或 SQLite”类措辞，验收表标注已选定）。
- 实际验证命令与结果：
  - node:sqlite 能力核实：v24.21.0 加载无 ExperimentalWarning；WAL/BEGIN IMMEDIATE/ROLLBACK/busy timeout（等待后报 database is locked）/readOnly 拒写/进程崩溃后库可重开且回滚，全部实测通过。
  - 同路径比较：`node validation/metadata-storage/fixture/run-comparison.mjs both` 两实现各 8 场景全部 PASS（file 3058ms / sqlite 986ms）。
  - 产品级：`node --test test/metadata.test.mjs` 6/6 通过（关联事务原子回滚、幂等不重复计、两进程 20+20 并发无丢失、SIGKILL 回滚、busy 如实报错、只读字节不变）。
  - 全仓回归：`npm test` 35/35；`npm run pack:check` 通过，dist 含编译产物、零新增依赖。
- 证据位置：validation/metadata-storage/README.md（结论表与夹具说明）、fixture/ 同目录、test/metadata.test.mjs、src/infrastructure/sqlite-metadata-store.ts。
- 实施中纠正的事实：SQLite 版初版 withTransaction 未 await 回调导致写入落在事务外（同步 API 与 async 工作流错配），已改为 await 语义并在测试覆盖；文件版事务包装曾用开始时旧快照覆写 mutate 结果，已改为 mutate 后重读叠加版本；`-e` 子进程 argv 下标与 import 路径错误各一处，已修。
- 未解决问题／决定：binding/version 乐观检查列仅存在于比较夹具，产品投影按 DESIGN 6/7 节实现任务再定稿；RunPort/NativeEntryRangePort 的生产实现（runs 目录文件产物）不在本任务范围。
- 对下一项的交接：005 宿主桥接可与本任务产物并行；元数据读写一律经 MetadataStore 端口（src/infrastructure/sqlite-metadata-store.ts），.runtime/metadata.db 为产品约定路径；.knit/.runtime/ 目录仍不预建。

优先扫描下一编号（阻塞时可继续跳过）：[005 验证宿主桥接准入并收敛M0](005-pi-host-admission.md)。
