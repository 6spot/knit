# 023 完善用量、历史和只读诊断查询

- 里程碑：M3A
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[022 完善初始化升级与指令生效核对](022-upgrades-and-instructions.md)
- 实际依赖：[003](003-pi-cli-runtime.md)、[004](004-metadata-storage-decision.md)、[007](007-local-infrastructure.md)、[010](010-session-context.md)、[013](013-stage-execution-and-recovery.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

提供日常可追溯查询，同时保持原生历史与内部状态不被查询修改。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第9.5、12节。
- [OPERATIONS.md](../../design/OPERATIONS.md)：第4节。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：传输／原生历史边界。
- [validation/pi-cli-1.4.0/USAGE.json](../../../validation/pi-cli-1.4.0/USAGE.json)：原生entry去重口径。

## 实施范围

- 完善session list/history、status --run、doctor/storage，公开身份／关系／耗时／最近活动／心跳和真实待处理项。
- 按本次原生条目／调用范围计增量，input含缓存、缓存为子集；未知价格／量不填零或作账单。
- 活跃历史经宿主只读API，离线仅已文档化格式，未知只返引用；不set_model／prompt修改原文件。
- 统计runtime/快照/原生资料/诊断与Knit Git基线引用，避免共享Git对象重复相加；不自动gc。

## 交付物

- 完整查询与用量归一
- 只读前后指纹及已知／未知格式和统计口径测试

## 完成前必须验证

- 恢复累计量不重复相加，主会话用量与worker范围区分，模型切换本身不使业务检查失效。
- status/doctor/storage不建目录、接收结果、跑模型或自动修复；私密正文／凭据不输出。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不建第二聊天库、全分支索引或云锁。
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

- 执行者／Session：ZCode / Pi session `01a1981c-6f75-749d-b9c2-7e5c897950a6`（用户已授权本仓库提交／推送）。
- 开始／结束时间：2026-11-02。
- 实际修改：
  - `src/adapters/pi/native-entries.ts`：历史扫描新增 `NativeUsageSummary`，按唯一助手条目 `id` 去重汇总 input（含 cacheRead／cacheWrite）、output、缓存、费用；未知用量／费用为 null。
  - `src/application/session-service.ts`、`src/cli/session.ts`：history 返回并显示用量；仍只读原生文件、不复制正文。
  - `src/cli/status.ts`：`status --run` 人类输出用量，未知值显示“未知”，不填零。
  - `src/application/diagnostics.ts`：storage 单列原生会话与诊断字节，并统计 `refs/knit/bases/*` 数量；run 字节含快照，Git 共享对象不重复相加。
  - `test/session.test.mjs`、`test/m1-cli.test.mjs`：真实原生 JSONL 用量断言、只读与数据库大小不变、原生资料统计。
  - `validation/m3a-usage-history/`：真实原生 history／storage 输出。
  - `DESIGN.md`、`OPERATIONS.md`：回写用量与统计口径。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm test`：**199/199**。
  - `node --test --test-name-pattern "history|status/doctor/storage" test/session.test.mjs test/m1-cli.test.mjs`：2/2。
  - 真实 Pi 原生历史：2 个助手条目，input 13740（含 cacheRead 7296），output 38，费用 0.00103677322；storage 原生会话 28623 字节、基线 0。
- 任务书必需验证逐项：
  - 恢复累计量不重复相加：按助手条目 ID 去重，不累加会话 stats；测试与真实历史输出。
  - 主会话用量与 worker 范围区分：worker run 结果仍记录本 run 用量；history 统计原生会话自身条目，不混入 run 结果。
  - 模型切换本身不使业务检查失效：沿用检查摘要只含输入／规范／范围，不含模型；本项不修改该规则。
  - status/doctor/storage 只读：测试断言数据库字节不变；不建目录、不接收结果、不跑模型、不自动修复。
  - 私密正文／凭据不输出：history 只输出条目类型／时间／引用与聚合用量，测试断言不含原生正文。
- 证据位置：`validation/m3a-usage-history/README.md`、`report.json`、`tests/`（history/attach/storage/read-only）。
- 未解决问题／决定：
  1. 未知原生格式不解析为用量，返回 null 并保留 problem。
  2. 费用为配置模型估算，不是账单；未知价格不填零。
  3. storage 只单列 Git 基线引用数量，不计算共享对象可达大小；不自动 gc。
  4. 真实用量证据来自任务022 的 Pi 会话，本项未额外调用模型。
- 对下一项的交接：024 可复用 history 用量、storage 原生／基线统计和只读断言；开发者模式不得把这些查询变成写路径或模型轮次。
优先扫描下一编号（阻塞时可继续跳过）：[024 完成私有诊断并验收日常使用](024-developer-mode-m3a-gate.md)。
