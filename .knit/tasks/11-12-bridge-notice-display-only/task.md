---
id: k-e8730699375d
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-12T07:49:00.877Z
title: 桥接通知按类型投递：被动通知只展示、不进上下文
---

# 桥接通知按类型投递：被动通知只展示、不进上下文

## 目标

把桥接的 run 终态通知按「是否需要处理」分成两种投递类型，并让类型决定是否进入 LLM 上下文：

- 需处理通知：进入上下文并唤醒主 Agent（现状）。
- 被动通知：只在 TUI 展示，不进入任何一轮 LLM 上下文，也不触发模型轮次。

当前实现只区分了「是否唤醒」，没区分「是否进上下文」：两条分支都调用 `pi.sendMessage`，而 Pi 的 custom message 一律参与 LLM 上下文，`nextTurn` 只是排队到下一个用户提示，不等于只展示。用户于 2026-11-12 指出这与预期不符：不是所有通知都该进会话上下文。

用户于 2026-11-12 确认目标并授权实施：需要进入 Agent 上下文的通知才进入，其余只做展示。授权不含 Git 提交、推送与真实 Pi 验收。

## 现状与证据

- `.pi/extensions/knit.ts:682` 用 `needsAction` 判定 failed／cancelled／completed 且 `acceptance !== completed`。
- `.pi/extensions/knit.ts:699-701` 两条分支都走 `pi.sendMessage`：需处理 `{ deliverAs: "followUp", triggerTurn: true }`，其余 `{ deliverAs: "nextTurn", triggerTurn: false }`。
- `.pi/extensions/knit.ts:703` 的 `pi.appendEntry(NOTICE_ENTRY, { signature, runId, state })` 只做去重：不带展示文本，桥接也没有注册任何 entry／message renderer。
- `docs/design/DESIGN.md:658`（§9.3）现行规范写的是「首次观察时已完成且已接收的 run 以 nextTurn 进入下一轮上下文，只展示、不启动模型轮次」——文档与当前实现一致，但与本次目标不符。
- Pi 1.5.2 语义（安装包 `docs/extensions.md`）：`pi.sendMessage` 的 custom message 参与 LLM 上下文（:1627），`nextTurn` 是「Queued for next user prompt」（:1647）；`pi.appendEntry` + `pi.registerEntryRenderer` 的 custom entry 不参与 LLM 上下文（:1683、:1847）。
- 现场：2026-11-12 会话中，任务「补修上下文竞态：任务变更后拒绝旧请求回填」的三条终态通知（run-07e589 `changes_requests`、run-514841 `completed`、run-fb487 `pass`）在一次用户轮次后一起出现在上下文。三条文本均为非 pending 形式，即 `completed` + 已接收、`needsAction === false`，被 nextTurn 排队后在下一轮批量进入上下文；这些 run 当时已收尾，主 Agent 只能回复「已收尾的延迟通知」。

## 目标规则

1. 分类语义不变：`needsAction = failed || cancelled || (completed && acceptance !== completed)`；不新增状态，不改 run 状态机。
2. 需处理：保持 `pi.sendMessage({ customType: "knit.notice", … }, { deliverAs: "followUp", triggerTurn: true })`，进入上下文并唤醒。
3. 被动：改为 `pi.appendEntry(NOTICE_ENTRY, data)`，配合 `pi.registerEntryRenderer(NOTICE_ENTRY, …)` 在 TUI 渲染与现在相同的 `[knit.notice]` 卡片（标题＋阶段＋短 run ID＋下一步＋边界注记）；不调用 `pi.sendMessage`。渲染器只渲染带展示文案（`text`）的被动条目；不带 `text` 的条目（需处理通知的去重签名条目、改动前遗留的旧去重条目）返回空、不渲染，避免需处理通知出现两张卡片。
4. 去重：`notified()` 继续按 `knit.notice` 条目的 `data.signature` 去重；被动条目同时承载展示所需字段（text、runId、state、acceptance、signature）。
5. 需处理通知仍额外写一条去重条目（现状）；只有成功投递／追加后才写签名，失败不写。
6. 会话／分支／`--since` 过滤、通知文案、边界注记、轮询节奏与退避全部不变。
7. 被动条目持久保存，reload／续接后由 entry renderer 重新展示；这是展示行为，不是上下文注入。

## 范围

- `assets/templates/pi/extensions/knit.ts` 与 `.pi/extensions/knit.ts`：程序改动，两份保持逐字一致。
- `docs/design/DESIGN.md` §9.3：把「被动 nextTurn 进入下一轮上下文」改为「被动仅展示、不进上下文；只有需处理通知进入上下文并唤醒」，并同步该节其余通知分流措辞。
- `test/bridge-query.test.mjs` 的终态通知用例（:466-515）：被动通知改断言不产生 `host.messages`、只产生 `knit.notice` 条目；需处理三分支继续断言 `followUp` + `triggerTurn: true`。
- `test/host-selection.test.mjs` 的通知规则用例（:436-455）：断言两份桥接一致、`needsAction` 分支不变、被动分支不再出现 `sendMessage`，并断言注册了 `knit.notice` 的 entry renderer。
- 测试替身：`makeHostStub` 补 `registerEntryRenderer` 捕获（当前只有 `appendEntry`／`sendMessage` 捕获），用于断言被动展示路径。

## 非目标

- 不改 run 状态、结果接收、结果发布、轮询频率与退避、分支／会话核对、去重窗口与诊断事件。
- 不改通知正文文案与边界注记内容，不改 `--since` 过滤。
- 不新增配置项、持久字段或独立状态机；不改 worker、CLI、REX 适配层。
- 不调整被动通知的视觉样式（沿用现有 `[knit.notice]` 外观）。
- 不做真实 Pi `/reload` 行为验收（列入延期项，见验证安排）。

## 完成条件

### Requirement: 被动通知只展示、不进上下文

#### Scenario: 完成且已接收
- GIVEN 本会话发起的 run 已 `completed` 且结果已接收
- WHEN 观察器或 `agent_settled` 扫描到终态
- THEN 不调用 `pi.sendMessage`，该通知不进入任何一轮 LLM 上下文
- AND 追加一条 `knit.notice` 条目（含 signature、runId、state、acceptance、完整文案），并由 entry renderer 在 TUI 展示

#### Scenario: 流式期间到达的被动终态
- GIVEN 主 Agent 正在流式回答
- WHEN 被动终态通知到达
- THEN 当前轮不被打断、不插入上下文消息、不触发新轮次
- AND 通知仍立即出现在 TUI 会话记录中

#### Scenario: 重复扫描不重复展示
- GIVEN 同一 run 的终态已写过 `knit.notice` 条目
- WHEN 后续扫描再次看到同一终态
- THEN 不再追加条目、不重复展示

### Requirement: 需处理通知保持现状

#### Scenario: 失败、取消或结果待接收
- GIVEN run `failed`／`cancelled`，或 `completed` 且结果未接收
- WHEN 扫描到终态
- THEN 仍以 `{ deliverAs: "followUp", triggerTurn: true }` 调用 `pi.sendMessage` 进入上下文并唤醒
- AND 文案、去重、分支与会话过滤、失败／取消诊断保持现状

#### Scenario: 去重条目不重复展示
- GIVEN 需处理通知已由 `pi.sendMessage` 展示，并写入不带 `text` 的 `knit.notice` 去重条目
- WHEN entry renderer 渲染该去重条目（或改动前遗留的旧去重条目）
- THEN 渲染器返回空，TUI 不出现第二张卡片

### Requirement: 实现与规范一致

#### Scenario: 双份桥接与文档
- WHEN 核对 `.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts` 与 `DESIGN.md` §9.3
- THEN 两份桥接逐字一致，且都实现「需处理 → sendMessage；被动 → appendEntry + entry renderer」
- AND §9.3 不再声称被动通知进入下一轮上下文，描述与代码、测试一致

## 待澄清

- [assumed] 任务已 `closed` 的 run 产生延迟终态通知时仍照常展示（只是不进上下文）；若要「已关闭任务不再展示、也不排队」属于额外过滤规则，建议另立任务（Agent 建议，待确认）。

## 验证安排

- verification 设为 `independent`：通知是否进入上下文属于宿主协议／信任边界行为，自证不足；由主会话派独立只读检查核对两份桥接、DESIGN §9.3 与回归测试。
- 实施验证：`npm run -s typecheck`、`npm run -s build`、`node --test test/bridge-query.test.mjs`、`node --test test/host-selection.test.mjs`（既有环境失败按干净 HEAD 基线说明）。
- 回归要求：被动通知用例必须真正断言「无 sendMessage／有 entry」，不能只改断言文本；覆盖 completed+accepted、failed、completed 未接收三种分支，并覆盖去重与「去重条目不渲染」。
- 延期（不在本任务宣称完成）：真实 Pi `/reload`（或重启）后观察被动通知可见但不唤醒、不进上下文；真实 Rex 终端同上；macOS 安装与运行验收仍按 AGENTS.md 延期。

## 输入引用

- 用户观察：2026-11-12 会话中三条已收尾 run 的通知进入上下文；要求「不是所有的通知都进会话上下文」。
- 用户决定：先建任务、暂不改代码，把规则和验收写清楚。
- 用户确认（2026-11-12）：「完成该任务的开发」；目的重申为「有些通知需要进入 Agent 上下文就进入，有些是不需要的，只是做一个展示的，就展示」。
- 历史任务：`k-0ca555299a57`（11-06-bridge-notice-wake-only-actionable）决定「被动 nextTurn 进入下一轮上下文」；本任务替换该结论，不重写其历史。
- 代码：`.pi/extensions/knit.ts` 的 `scanRuns`／`notified`／`boundaryNotes`；`assets/templates/pi/extensions/knit.ts` 同内容。
- 规范：`docs/design/DESIGN.md` §9.3；`docs/design/OPERATIONS.md` 中的通知／轮询描述（核对是否重复）。
- 宿主文档：Pi 1.5.2 安装包 `docs/extensions.md` 的 `pi.sendMessage`（:1627）、`nextTurn`（:1647）、`pi.appendEntry`（:1683）、`pi.registerEntryRenderer`（:1847）；示例 `examples/extensions/entry-renderer.ts`。
- 测试：`test/bridge-query.test.mjs`、`test/host-selection.test.mjs`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-12T07:49:34.547Z
- 方式: self → independent；理由: 通知是否进入上下文属宿主协议／信任边界行为，自证不足

主会话完成验收：实施 run-0b840b46685b 与独立检查 run-adaac0bd1a31 均实际使用 magpie/group/deepseek；检查已接收 check_pass，R1.S1/R1.S2/R1.S3/R2.S1/R2.S2/R3.S1 全 pass，检查者未改文件。原生测试输出与验证 README 确认为 bridge-query 23/23、host-selection 11/11（定向合计 34），其它模板相关测试 52/52；实施结果文字“40 passed”是计数误记，不作为凭据。普通及 Rex 全量日志均 739/739 pass，退出 0；typecheck/build/diff --check/cmp 通过。独立阶段初次夹具继承 KNIT_RUN/KNIT_STAGE_RUN_ID 被读阶段约束拒绝，隔离环境后通过，原始失败仍保留。真实 Pi /reload、目视与流式插入位置继续延期；未提交、未推送、未归档，主会话未修改实现。

### 交付记录

<!-- knit:delivery:op-a2da5cb63d38 -->
- 操作: op-a2da5cb63d38
- 时间: 2026-11-12T17:46:16.750Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 9707e981736ca94fff3acfa59ac8a3b8bdf2f80d
- 结果: 正常交付；检查 run-adaac0bd1a31 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-12-bridge-notice-display-only

<!-- knit:progress:end -->
