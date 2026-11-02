# 034 取消违背首版规则的固定阶段总时限

- 里程碑：审计修复（P1）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../validation/design-implementation-audit/README.md)，发现 F034。
- 受影响原任务：003、013、017。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §5.9；OPERATIONS §4（约91行）：只观测，不按固定运行总时长自动取消 为验收依据；按需阅读对应章节。

## 已核实偏差

StageRunner 默认 promptTimeoutMs=900000。该值限制整个阶段；到期 runtime 返回未收敛，runner dispose 并失败，dispose 会 abort／必要时终止 Pi。合法持续活动超过15分钟也会因此被停止。

- 代码位置（审计基线）：src/application/stage-runner.ts:147、238、314；src/adapters/pi/runtime.ts:223、237；dispose 路径。
- 证据等级：源码核实，未动态复现。
- 实际证据：源码调用链核实；本轮未等待15分钟，未将缩短时限的建议场景当作已运行证据。
- 最小场景：修复时注入可控时钟／短等待的 fake runtime，证明长阶段在无取消意图时继续；不需要真实模型长跑。
- 证据文件：[审计记录目录](../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 按规范移除完整阶段的固定总截止时间，保留控制请求超时、启动确认、心跳丢失与显式取消。
- 区分请求无响应与模型仍在合法执行，错误要反映真正原因。
- 统一 runtime.waitSettled 的默认与调用语义，防止另一入口重新引入默认总时限。

## 完成前必须验证

- 有持续活动的阶段跨原截止时间仍可完成；显式取消、控制请求卡死与占用丢失仍能收敛。
- 无需真实模型等待15分钟，用可控时间或缩短测试时钟验证语义。
- 优先复用 test/pi-runtime.test.mjs、test/stage.test.mjs、test/run.test.mjs、test/infrastructure.test.mjs，新增测试仅覆盖有业务后果的不变量。
- 运行受影响测试、类型检查及构建；记录命令、环境和结果。需要真实宿主的条目不可用替身冒充完成。
- 同步相关契约／规范中的实现与验证说明，不能通过删掉原要求宣称修复。

## 边界与交接

- Git／故障实验仅在隔离夹具执行；不提交、推送、发布或修改真实仓库历史。
- 保留其他执行者改动；现有产品任务 check-report-fence 不属于本项。
- 阻塞按 BLOCKERS.md 记录事实并继续独立工作；依赖按接口与产物判断，不把编号当硬依赖。
- 修复后交给 [043 独立复验](043-audit-independent-regression.md)；本任务文件不另存一份状态。

## 执行记录

- 2026-11-02：审计主执行者创建任务，记录上述偏差、证据与验收条件；尚未实施本项修复。
- 2026-11-02：开发 Agent 实施修复并验证完成。
  - `src/adapters/pi/runtime.ts`：`prompt`／`waitSettled` 的 timeoutMs 改为 `number | null`，缺省 null（无截止）；非 null 时仅控制单个 RPC 响应与观察等待，阶段终态仍只由 agent_settled、真实退出、abort 或连接失败决定。
  - `src/application/stage-runner.ts`：`promptTimeoutMs` 缺省由 900_000 改为 null——移除完整阶段的固定总截止时间；显式取消（cancelWatch）、占用丢失（ownershipWatch）、取消宽限（cancelGraceMs）与控制请求超时保留；error 归因不再被“未收敛超时”覆盖。
  - 保留调用方可注入有限 timeoutMs 的能力（测试与后续控制需要），但产品装配不再设置阶段总时限。
  - 测试：`test/stage.test.mjs` 新增“无固定阶段总时限”：fake-pi 停在 waitFile（信号位于 .knit/.runtime 内不进工作区差异），阶段进入 running 后逗留无自动停止；发出信号后正常完成并接收。取消收敛由既有“取消在安全点收敛”与心跳丢失用例继续覆盖。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 220 项全过（Linux + Node v24.21.0）；pi-runtime 真实模型冒烟不受影响（12 项全过）。
  - 设计同步：DESIGN §5.9 与 OPERATIONS §4“不按固定运行总时长自动取消”现与实现一致；`promptTimeoutMs` 语义改为单请求／观察等待，不是阶段总时限。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
