# 024 完成私有诊断并验收日常使用

- 里程碑：M3A
- 执行角色：实现与验证 Agent
- 顺序参考（非硬依赖）：[023 完善用量、历史和只读诊断查询](023-usage-history-and-diagnostics.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[010](010-session-context.md)、[015](015-cli-bridge-m1-gate.md)、[023](023-usage-history-and-diagnostics.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

完成开发者模式的完整通道，并验收M3A日常接续的健壮性。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [OPERATIONS.md](../../design/OPERATIONS.md)：第6节：开发者模式。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第8节诊断要求。
- [DESIGN.md](../../design/DESIGN.md)：第16.1/16.4节M3A项目。

## 实施范围

- 实现私有分写者JSONL、轮换／容量说明、/knit dev on/off会话作用域与生效来源。
- 持续白名单stepKey／摘要／耗时与计数；不开网络debug，不记正文、凭据、提示词或工具原文。
- 验证--dev与会话开关的stdin/stdout/stderr／worker／桥接传播，错误只观察不吞业务失败。
- 联合021–023验收adopt、树、多会话提醒、升级、指令与查询；存在问题先修复再通过M3A。

## 交付物

- M3A开发诊断与日常使用报告
- 开启／关闭诊断的规范化业务等价证据

## 完成前必须验证

- 同输入下业务结果、文件和模型／工具次数相同；只读即使--dev也不建日志。
- 日志可删不影响回执或恢复，私有权限／Git忽略准确，模型不因诊断开关多跑一轮。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不增加第三套事实权威、常驻服务或自动日志采集平台。
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
  - `src/cli/dev.ts`：写命令在 `.knit/.runtime/diagnostics/<command>/<pid>-<time>.jsonl` 追加白名单 JSONL（目录 0700、文件 0600）；只读 status／doctor／storage／init／list／history／resolve／show 不建目录；写失败只忽略诊断。
  - `assets/templates/pi/extensions/knit.ts`：新增 `/knit dev on|off`（兼容 `/knit-dev`）会话开关，`core` 调用按 `state.dev` 传 `--dev`；reload／fork 默认关闭；REPL 帮助保留。
  - `test/m1-cli.test.mjs`：私有 JSONL、权限、只读不建目录、`--dev` 与普通业务投影 deepEqual、模板命令断言。
  - `validation/m3a-developer/`：开发通道证据与 021–023 联合验收索引。
  - `OPERATIONS.md`：回写 M3A 私有日志与会话开关。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm test`：**200/200**。
  - `node --test --test-name-pattern='--dev' test/m1-cli.test.mjs`：2/2。
  - `npm run -s pack:check`：通过。
- 任务书必需验证逐项：
  - 私有分写者 JSONL／权限／只读不建日志：测试覆盖目录 0700、文件 0600、只读不建目录；日志删除不影响回执。
  - 白名单／不记正文凭据提示词工具原文：沿用 ALLOWED 字段，测试断言无 content／prompt；不新增网络 debug。
  - stdin/stdout/stderr／worker／桥接传播：stdout 仍单协议响应；stderr 诊断；worker 继承 `--dev` stderr；桥接会话开关按 `state.dev` 转 CLI。错误只观察不吞业务失败。
  - 开关等价：deepEqual 业务投影；不增加模型轮次。
  - 联合 021–023：adopt／树／多会话／升级／指令／查询证据均有独立 validation 目录并通过；无遗留阻塞。
- 证据位置：`validation/m3a-developer/README.md`、`report.json`、`tests/dev-channel.txt`；`validation/m3a-adopt-tree/`、`validation/m3a-init-upgrade/`、`validation/m3a-usage-history/`。
- 未解决问题／决定：
  1. 未跑真实 Pi `/knit dev on|off` 长模型链路；命令入口由模板断言覆盖，reload 生命周期由 022 真实证据覆盖。
  2. 未做全事件矩阵；日志按调用分片增长，未实现自动轮换／gc，删除不影响恢复。
  3. 日志为私有诊断，不作为权威回执；排查需用户明确读取。
- 对下一项的交接：025 打包／平台矩阵可复用 `--dev` 私有目录忽略与只读不建日志断言；M3A 日常接续已完成。
优先扫描下一编号（阻塞时可继续跳过）：[025 完成平台、打包和使用文档](025-packaging-and-platform-ci.md)。
