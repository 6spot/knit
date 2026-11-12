---
id: k-50d398bff55f
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: k-7e4dbba9dca7
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-11T14:10:08.504Z
title: 修复续接会话每轮 knit 上下文缺失
---

## 目标
修复 F4：Pi 续接会话第二轮起可能拿不到每轮 knit 上下文（system 分节的 `knit` 被删为 null）。

## 现状与证据
- 桥接 `before_agent_start` 在 `buildTurnContext()` 返回 null 时执行 `delete options.sections.knit`。
- `buildTurnContext` 默认预算 300ms；本机 `knit session context` 冷启动约 0.6s；缓存由 `session_start` 的 `refreshTurnContext` 预热。
- 三轮复跑：第 1、3 轮续接轮 `sections.knit=NULL`，第 2 轮正常。证据 `validation/macos-acceptance-2026-11/r2-bridge-injection.txt`、`r3-bridge-injection.txt`。

## 范围
- 定位根因（预算竞态、预热时序、`sessionOf` 失败或 pi 1.5.2 事件语义），按事实给结论，不用推测代替证据。
- 保证续接轮也有当轮上下文：可调整预算、预热或失败时的保留策略；不得静默删除分节。
- 补测试覆盖续接轮注入与刷新失败路径。

## 完成条件
### Requirement: 续接会话注入
#### Scenario: 多轮连续有上下文
- GIVEN 一个已选中任务的 Pi 会话
- WHEN 连续发起三轮用户消息
- THEN 每轮 system 分节都包含当轮 knit 上下文
- AND 上下文中的任务与阶段和 `knit session context` 输出一致

#### Scenario: 刷新失败不静默清除
- GIVEN 本次刷新超时或失败
- WHEN 注入前拿不到新数据
- THEN 保留上一轮上下文并标注可能过期
- AND 记录诊断事件说明失败原因

## 目标与边界
- 不改核心写动作的授权、阶段与版本核对。
- 只修注入可靠性，不改上下文内容口径。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## F4 真机复验与测试

- 包与项目：修复后 pack 266 文件 620.5 kB → `/tmp/knit-f4/app`；项目 `knit init` ready。
- 探针：4 轮续接会话；system 分节依次为「无选定任务」→ A → B，任务改选后的下一轮立即反映新上下文（证据 `validation/macos-acceptance-2026-11/f4-fix/`）。
- 单测：`npm test` 727 项中 726 pass；唯一失败 `test/run.test.mjs`「prepare 只发布请求…」为 worker 退出后 1s 内锁未释放，已在 `58a2dc2` 干净 worktree 复现同样失败，非本改动引入（另记）。
- 修复要点：session_start 预热与首轮注入共享同一在途请求；无缓存时首轮预算 2s（CLI 冷启动约 0.6s），有缓存仍 300ms；刷新失败保留上一轮分节并标注“上下文可能过期”，不再 delete sections.knit。


## 2026-11-11 实施补修（run-cd24f8ba5ae9）

- 检查发现回填分节把 Pi 已渲染的 `<knit>…</knit>` 当 raw 再注入，真实会话出现嵌套 `<knit>` 与重复 marker。修复：previousKnitSection 回填前经 unwrapKnitSection 剥离宿主包装（兼容旧版多层嵌套）与 marker；withStaleNotice 继续去旧过期行；无需刷新的 custom 轮次原样保留正文与过期标注。
- 单测：`node --test test/bridge-query.test.mjs` 20/20；新增断言使用真实 `<knit>` 包装形状，覆盖无缓存失败回填、旧版嵌套收敛、custom 保留过期标注。
- 全量：`npm test` 727/727 通过（typecheck+build+test）；另一次全量出现 worktree-parallel 并行用例 1 项 failed（fake worker 接收阶段，bridge 不参与），随后复跑全通过。
- 真机（macOS Pi 1.5.2，项目 /tmp/knit-f4-real-Vp1I，替换为新桥接）：`KNIT_DEV=1 KNIT_BRIDGE_CONTEXT_TIMEOUT_MS=1 pi -p --approve -c "只回复：收敛2"` 后会话 system#39 为单层 `<knit>`、1 个 marker、1 条“上下文可能过期”，stderr 有 context_refresh_failed 与 context_previous_section_used；默认预算下一轮 system#46 恢复 fresh、无过期说明。旧版嵌套 system#31 保留为历史，未继续增长。会话：~/.pi/agent/sessions/--private-tmp-knit-f4-real-Vp1I--/2026-11-11T15-58-31-610Z_knit-f4-probe.jsonl

### 交付记录

<!-- knit:delivery:op-bb7309100aff -->
- 操作: op-bb7309100aff
- 时间: 2026-11-12T17:31:00.806Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 8fc5c4dc0557a7a7fb4884fb3fdf6651dd070f21
- 结果: 正常交付；检查 run-29596ef451c8 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-11-bridge-context-injection

### 任务资料提交记录

<!-- knit:metadata-commit:op-bb7309100aff -->
- 任务资料提交: 05982d7ce15cac7f67b311f70125d049546fc498
- 归档目标: .knit/tasks/archive/2026-11/11-11-bridge-context-injection

<!-- knit:progress:end -->
