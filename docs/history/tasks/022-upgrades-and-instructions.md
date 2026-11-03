# 022 完善初始化升级与指令生效核对

- 里程碑：M3A
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[021 完善分支接管、对话树和多会话关联](021-adopt-tree-and-sessions.md)
- 实际依赖：[003](003-pi-cli-runtime.md)、[008](008-project-initialization.md)、[010](010-session-context.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

让版本更新和人工定制可持续，避免桥接及规则重复加载。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第7、9.1–9.2、14节。
- [OPERATIONS.md](../../design/OPERATIONS.md)：第1节。
- [STATES.md](../../design/STATES.md)：初始化／Session兼容与输入计划。

## 实施范围

- 完善受管模板旧基线升级、冲突展示、未知来源与新版本处理，保留人工修改。
- 核对CLI/worker/桥接协议与本机安装映射，移动／换机器后需init，不嵌本机绝对路径。
- 完善项目／用户适用规则、角色／runtime层、显式与原生指令去重及变化版本确认。
- 验证reload销毁旧监听／定时器，ready与项目信任分别处理；不能落实必需策略时显式阻塞。

## 交付物

- 升级／兼容／指令去重能力
- 真实模板升级与原生reload证据

## 完成前必须验证

- 重复init/reload不重复工具或消息观察器，用户修改不被静默覆盖。
- 阶段上下文冻结与新规则作为成果的边界正确，不追溯未来规范或复制完整主会话系统提示。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不为兼容未知客户端引SDK或插件平台。
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
  - `src/application/initialization.ts`：init 读取上次 `init-manifest.json` 的 `baselineSha256`，受管桥接与旧基线一致时按新模板更新；人工／未知来源仍 conflict，`--force` 才覆盖。清单 `templateVersion` 高于当前安装包时 `version_conflict` 拒绝降级；安装映射每次按当前 CLI 入口重写。`init --check` 不再把“当前内容等于新模板”误报为需要 update。
  - `assets/templates/pi/extensions/knit.ts`：新增进程级 `Symbol.for("knit.bridge.observer")` guard；reload／重复加载前停止上一个观察器，`session_shutdown` 与 `/knit-reload` 释放 timer，避免重复通知。ready 与 Pi 项目信任仍分开。
  - `test/init.test.mjs`：新增旧受管基线升级、人工冲突、版本降级拒绝、安装映射重写、桥接不嵌绝对路径测试。
  - `test/m1-cli.test.mjs`：模板断言 observer guard；status 断言发起分支。
  - `validation/m3a-init-upgrade/`：真实 CLI 旧基线升级、真实 Pi `/knit-reload` 与 `knit_status` 冒烟证据。
  - `DESIGN.md`、`OPERATIONS.md`：回写旧基线／降级／安装映射／observer guard。
- 实际验证命令与结果：
  - `npm run -s typecheck`：通过。
  - `npm run -s build`：通过。
  - `npm test`：**199/199**。
  - `node --test --test-name-pattern "上次受管基线|安装映射移动" test/init.test.mjs`：2/2。
  - `node --test --test-name-pattern "桥接 schema" test/m1-cli.test.mjs`：1/1。
  - 真实 CLI：`init --check` 识别旧基线可更新；`init` 后桥接恢复当前模板；旧安装映射路径被重写。
  - 真实 Pi 1.4.0 RPC：`/knit-reload` 返回 `disposition: handled`，原生 Session ID／文件不变；随后 `knit_status` 成功返回 `completed`。
- 任务书必需验证逐项：
  - 重复 init/reload 不重复工具或消息观察器：init 幂等测试、observer guard 静态断言与真实 reload 冒烟；`startObserver` 先停旧 timer，`session_shutdown`／reload 释放。
  - 用户修改不被静默覆盖：旧基线升级测试；人工改写桥接仍 conflict，项目资料仍只补缺；`--force` 才覆盖受管内容。
  - 阶段上下文冻结与新规则作为成果边界：沿用 010／011／013 的 ContextPlanner 冻结输入、正式规范摘要与结果接收；本项未把未来规范或完整主会话系统提示复制进阶段。
  - 指令去重／版本确认：ContextPlanner 已按 sourceId／digest 生成分层清单，正式规范与角色／runtime 各自计摘要；本项补 init 模板版本与安装映射核对，未新增第二套提示拼接。
  - ready 与项目信任分开：init `ready`／`bridgeReady` 只证明文件与映射；真实 Pi 使用 `--approve` 项目信任，桥接不默认绕过。
- 证据位置：`validation/m3a-init-upgrade/README.md`、`report.json`、`tests/`、`reload/`；`test/init.test.mjs`、`test/m1-cli.test.mjs`。
- 未解决问题／决定：
  1. 未安装多个旧版 Knit 包做跨版本二进制升级矩阵；用清单旧 baseline 模拟受管旧内容。
  2. 未在 Pi 进程内直接计数 timer；observer guard 用模板静态断言与真实 reload 生命周期验证。
  3. 项目维护正文仍只补缺，不自动三方合并；未知来源需显式 `--force`。
  4. AGENTS.md 受管块仍按块内容逐字核对；未新增块级历史基线迁移，人工改动继续冲突而非静默合并。
- 对下一项的交接：023 可复用 init 的模板版本／安装映射核对和 Session status 分支投影；查询／诊断不得写产品状态。
优先扫描下一编号（阻塞时可继续跳过）：[023 完善用量、历史和只读诊断查询](023-usage-history-and-diagnostics.md)。
