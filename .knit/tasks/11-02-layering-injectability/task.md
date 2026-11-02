---
id: k-50aa43d0443c
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:59.529Z
title: 分层与可注入性重构
---

# 分层与可注入性重构

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

架构审查确认的分层与可注入性问题：

1.【中】ports 契约缺失：ports/README.md 声称定义 AgentRuntime、ClientAdapter、ExecutionHost 契约，src/ports/ 中不存在任何此类接口（grep 无命中），三个名字在 src 中不出现。src/application/stage-runner.ts:21-30,143 与 session-service.ts:24-32 直接 import adapters 具体符号（仅 checkFile 有注入点）。文档与代码互相矛盾，后续执行者会按错误地图开发。
2.【中】informal-check.ts:10,162-171 直接 new PiAgentRuntime(...) 并 isolatedEnv()，完全不可注入（对比 stage-runner 留了 runtimeFactory）；163 行直读 process.env.KNIT_PI_BIN，环境副作用进入用例层。违反 DESIGN 15.1 第 3 条「从第一条闭环走正式装配路径」。
3.【中】contracts 反向依赖 infrastructure：src/contracts/task-inputs.ts:7、standards.ts:7 import ../infrastructure/fingerprint.js 的 sha256Text，而该模块依赖 node:fs。
4.【低】交付资格规则双实现：src/application/delivery-service.ts:31 与 src/domain/check.ts:74 的 GIT_DIRTY 判定并存，语义重叠。

建议方向（讨论定夺）：A. 按 ports/README 在 src/ports/ 补契约，组合根注入；B. 修文档使与「固定装配」现实一致。A/B 均需处理 informal-check 注入与 contracts 依赖方向（sha256Text 下沉到无 IO 模块或 contracts 本地实现）。

验收标准：
- application 层不再直接 import adapters 具体符号（或文档明确固定装配且 ports/README 修正）。
- contracts 层无 infrastructure 依赖；npm test 全绿。

讨论结论（2026-11-02，架构师决策，用户已授权按序推进）：

方向：不建完整 ports 抽象层（避免为 v1 引入未用的间接层），采用「固定装配＋显式注入点」并让文档如实描述：
1. ports/README.md 与 DESIGN 15.1 表述修正：声明 application 层当前为固定装配（直接组合 PiAgentRuntime/local 适配器），已存在的显式注入点（StageRunner runtimeFactory、checkFile）如实列出；AgentRuntime/ClientAdapter/ExecutionHost 等未建接口的承诺删除，避免「错误地图」。
2. informal-check.ts：增加与 StageRunner 一致的可选 runtimeFactory 注入（默认 PiAgentRuntime）；KNIT_PI_BIN 读取移出用例层（由调用方传入 piExecutable），isolatedEnv 仍留在适配器侧。
3. contracts 反向依赖修正：sha256Text 下沉到无 IO 的纯模块（如 contracts/ 或 domain/ 内），infrastructure/fingerprint.js 改为复用；contracts 不再 import infrastructure。
4. delivery 资格 GIT_DIRTY 双实现合并：保留 domain/check.ts 为唯一规则源，delivery-service 引用之。

验收标准：
- application 不新增 adapters 依赖面；informal-check 可注入 fake runtime 且不再直读 env。
- contracts 无 infrastructure import（grep 核实）；domain/check 的 GIT_DIRTY 判定为唯一实现。
- 文档（ports/README、DESIGN 15.1）与代码一致；npm test 全绿。

<!-- knit:progress:end -->
