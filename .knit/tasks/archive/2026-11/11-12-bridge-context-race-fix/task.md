---
id: k-8fc483a6e41e
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: 10
createdAt: 2026-11-12T01:25:17.418Z
title: 补修上下文竞态：任务变更后拒绝旧请求回填
---

## 目标
修复桥接上下文竞态：旧查询已读取任务／阶段快照后，若主会话选择或相关状态发生变更，旧结果不得被下一轮当成 fresh，也不得晚到覆盖更新后的缓存。
用户于 2026-11-12 明确要求修复本轮复查发现的 F4、F2，并选择新建两个补修任务；本任务范围与实施已获授权，优先修本项。

## 证据与关联
- 原任务 k-50d398bff55f（11-11-bridge-context-injection）保持原 closed/completed 历史；本任务是额外竞态补修，不重写原验收。
- 初始隔离探针：默认 300ms 预算，A 上下文已读但回包阻塞 → 切到 B → 释放 A；核心当前选择 B，注入仍包含 A、不包含 B且无过期标记。
- 当前请求按同一 Knit session 复用，在 assets/templates/pi/extensions/knit.ts:946 无变更代际核对即标 fresh。
- 本会话初始探针保留在 /tmp/knit-repair-check-c7s7GE/f4-race-probe.mjs 和 f4-race-result.json，可读取作为复现参考；可持续回归必须落到仓库的可移植测试中。

## 范围
- assets/templates/pi/extensions/knit.ts：在途请求、缓存、任务选择／提示相关写动作后刷新、会话切换及每轮注入。
- .pi/extensions/knit.ts：当前与资产模板逐字一致；同步本次程序修复，保持两份一致。不要直接改 init manifest，主会话后续用正常 init 核对受管基线，不使用 --force。
- test/bridge-query.test.mjs：加入有明确读快照／释放回包时序的隔离回归，覆盖旧响应晚到与失败降级，不用纯长 sleep 碰运气。
- 必要时同步 docs/design/DESIGN.md 中对应上下文语义；不改与本修复无关章节。
- validation/bridge-context-race-fix-2026-11-12/：简明可移植复现与实际验证记录，不保存真实原生对话或鉴权数据。

## 约束与非目标
- 保留全部既有未提交改动，不恢复旧版本、不修改原关闭任务。
- 不增加业务持久字段／独立状态机，不增加模型轮次，不改变现有无缓存首轮 2s、后台刷新 10s 与默认 300ms／可配置轮次预算；不得靠放宽超时掩盖竞态。
- 保留已有 <knit> 解包、不堆叠、超时标注、context_refresh_failed 等诊断与原生上一轮分节回填行为。
- 普通未变更轮次仍只做必要的一次 session context 查询；只读查询不冒充任务状态变化。
- 不改 .knit/ 下配置、工作流、阶段提示词、规范或运行凭据；任务规划资料按接口管理。测试在隔离夹具中执行，不调用真实模型、不控制用户现存 Rex 会话，不提交／推送／发布。
- 新 independent 检查是主会话派发的全新只读上下文，不以主会话自检代替；完整真机／真实 Pi 验收、本轮以外平台矩阵仍延期。

## 完成条件
### Requirement: 任务变更后旧请求失效
#### Scenario: A 请求未回包时切换到 B
- GIVEN 桥接 A 的上下文请求已读到 A 快照但尚未返回
- WHEN 成功选择 B，当前轮的 B 查询在配置预算内成功，并释放旧 A 回包
- THEN 当前轮注入 B，不将 A 当作 fresh，也不与旧包装堆叠
- AND 测试对照核心 session context 的当前选择，而非只检查字符串非空

#### Scenario: 旧回包晚于 B 的新缓存
- GIVEN 变更到 B 后已有成功的新 B 缓存，旧 A 请求仍在途
- WHEN 旧 A 回包最后到达，随后下一轮刷新失败
- THEN 缓存和回填仍以 B 为准，A 不能覆盖 B
- AND 失败回填注明可能过期，不伪报 fresh

### Requirement: 降级和预算保持既定行为
#### Scenario: 变更后新查询失败
- GIVEN 已有上一轮合法分节且旧查询不再代表当前选择
- WHEN 新查询失败或超时，无法取得当前上下文
- THEN 保留合法上一轮分节并明确可能过期，记录相应诊断
- AND 不静默清空分节，不以旧在途响应当作成功的新鲜结果

#### Scenario: 普通轮次与预算回归
- GIVEN 未发生任务／会话变更的普通续接会话
- WHEN 连续用户轮次刷新、custom 轮次保留或发生既有超时分支
- THEN 现有每轮注入、单次查询、包装解包与降级测试继续通过
- AND 产品默认预算不增加，不增加持久状态或模型调用

### Requirement: 模板与实际项目桥接一致
#### Scenario: 同步产物与隔离 init
- WHEN 核对本仓库资产模板、.pi 桥接副本与隔离项目 init 的生成结果
- THEN 程序内容一致并包含本修复，init 不依赖 force 或外部包安装

## 验证安排
- 实施：typecheck、build、针对 bridge-query 的隔离回归，记录真实命令和结果；适当清除测试的宿主 Rex／stage 环境并隔离测试密钥。
- 正式独立检查覆盖全部 Rn.Sm，阅读最终实际产物与新增测试，重跑相关回归；发现问题交回，不改代码。
- 主会话汇总两项后在普通与真实 Rex 终端各跑一次 npm test；不把这些检查宣称完整真机验收。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-1f081e135ed4 -->
- 操作: op-1f081e135ed4
- 时间: 2026-11-12T17:46:12.964Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 77738498595ae9e9d6a3ba3cdc9df712e6ca6420
- 结果: 正常交付；检查 run-fb487ecb56f4 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-12-bridge-context-race-fix

### 任务资料提交记录

<!-- knit:metadata-commit:op-1f081e135ed4 -->
- 任务资料提交: a419a1e83c88c65cd01084646e3a063e0414e24b
- 归档目标: .knit/tasks/archive/2026-11/11-12-bridge-context-race-fix

<!-- knit:progress:end -->
