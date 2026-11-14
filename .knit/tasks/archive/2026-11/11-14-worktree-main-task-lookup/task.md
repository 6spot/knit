---
id: k-3a7f2483b0d8
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-14T04:59:02.923Z
title: Worktree：主检出按绑定查找任务、选择与上下文
---

# Worktree：主检出按绑定查找任务、选择与上下文

## 目标

修复本机真实 Pi 验收 k-b9019179b424 第二轮的 R7.S1 失败：任务正文已 handoff 到活跃 Worktree 后，主检出的 task list 看不到任务，普通 status、主桥接 knit_task use 与 knit_context 报“任务不存在”。主 Agent 按现行 WORKTREE §6.1 可以留在原主会话，但必须能按稳定 taskId 找到已绑定任务并读取正确资料。

依据用户消息 9698c2d8 的持续收口授权处理此阻塞；由正式 worker 实现，magpie/group/deepseek 独立检查。不存在待用户决定的产品取舍：沿用已确定的 mainRoot/executionDir 根模型与失效路由守卫。

## 现场与依据

- 复现包：validation/local-real-pi-acceptance-2026-11/round2/REPORT.md、a6-bridge-route-setup.json、pi/worktree-route-excerpts.json、images/pi-wt-route-failure.png。
- 安装产物基线 2a2f6a0，真实 Pi 1.5.2：主检出 /tmp/knit-self-acceptance2.JyPWM8/projects/目标 index 与 clone；taskId k-d7b23bf7c326；主会话 native 01a1d867-3251-71d0-8810-6f99ff7bb1c5。
- Worktree 内 status 与主检出 worktree status --task 成功，主桥接 use/context 均失败；不是缺失绑定或需要 rebind。
- 现状入口：src/application/session-service.ts 的 assertTaskUsable、src/application/context-planner.ts 的任务定位、TaskService/StatusService 的任务读取与枚举；已有 src/application/worktree-routing.ts 和 CLI taskRoute（task implement/close）应复用。
- 历史 k-1910551e4f50 保留普通 status 完整跨目录视图的未覆盖边界；k-e7876542ec29 只修过 implement/close 双根路由。本任务补主会话读取和选择的缺口，不改历史凭据。

## 范围与约束

1. 以本机主检出绑定为准：运行资料（Sqlite 元数据库、scope、run、session、锁、pi-sessions）始终放 mainRoot；活跃且有效的 Worktree 任务正文和 plan/design/research 从 executionDir 读取。不得把运行资料复制进 Worktree，也不得只靠目录名猜身份。
2. 主检出的 task list/任务查询应包含本项目已绑定且正文已交接的活跃任务，按 taskId 去重，沿用优先级、业务顺序、归档过滤和当前已有的输出字段。普通主检出任务、未绑定资料及归档查询保持既有语义；不扫描其它项目或任意外部目录。
3. status <taskId>、task use、原生选择恢复/每轮 session context、knit_context 及其所需任务/材料定位必须使用同一有效绑定和实际任务正文。实际工作树中的任务最新输入、规划资料和阶段生效规则不能被主检出旧副本或主检出未提交公共规则替代。
4. 主会话仍属于原 mainRoot/cwd，选择事件的 branch 仍用于主会话所在检出的树切换失效；不要把选择分支粗暴改成任务 Worktree 分支。任务分支和执行目录按实际绑定展示。use/clear 必须继续走真实原生条目持久化确认与当前有效路径核验，不绕过选择守卫。
5. 对目录缺失、Git 未登记、分支不符、归属不符或身份冲突给出明确错误/不可用原因及实际登记路径。不得回退主检出同名旧任务。只读查询不修复绑定、不 rebind、不改正文、凭据或选择。
6. 受本次定位复用影响的已有 taskId 操作须核对：record/update/material、rename/ready、implement/close 等在已支持的主检出/Worktree 入口保持双根一致，不能产生第二份正文、scope 或本机凭据；不以“任务不存在”隐藏已有的有效绑定。无需为本任务新增业务动作。
7. 保留 run 的 execution_dir_mismatch、worktree_not_ready、worktree_invalid 等派发守卫及既有调度行为；不新增“主检出自动开始 Worktree run”的核心规则。需要切换目录时返回实际 executionDir 和可执行下一步，不能给出无法继续的任务不存在。正常主检出任务不受影响。
8. 优先在应用层共享任务定位/枚举来修复，不为一个桥接工具增加特例。桥接若确需同步，.pi/extensions/knit.ts 与 assets/templates/pi/extensions/knit.ts 必须逐字相同，保留已完成的通知分流及 wait 行为。
9. 同步当前根模型与命令行为相关的文档，保持规则和示例一致。无新命令、配置项、状态枚举或持久字段；不引 Pi SDK，不改鉴权/模型运行时。
10. 只在隔离夹具验证 Git/原生记录/故障，不操作当前仓库 Git 历史或真实验收夹具。当前 .knit/config.json 的 reportRetries 改动、验收任务资料、validation/local-real-pi-acceptance-2026-11/、未跟踪 reviewer 均保持不动。不修改 AGENTS.md、workflow/提示词、既有任务的本机凭据/checkpoint。

## 完成条件

### Requirement: 主检出可以看到并查询已交接任务

#### Scenario: 活跃 Worktree 任务仅列一次
- GIVEN 一个已 create/handoff/prepare 的任务与一个普通主检出任务，存在真实主检出绑定
- WHEN 从主检出执行 task list 和 status <worktree taskId>
- THEN 两个任务均可见且 Worktree 任务仅一项，status 来自实际任务正文，taskId、阶段、分支与绑定相符
- AND 优先级/业务排序、归档过滤与现有输出字段保持兼容

#### Scenario: 当前 Worktree 与主检出查询同一身份
- GIVEN 同一任务的 mainRoot 与 executionDir 不同
- WHEN 分别从主检出和 Worktree 查询状态/任务材料
- THEN 任务正文、规划资料、scope 和运行引用一致，运行资料仍只读写主检出

#### Scenario: 主检出旧副本不盖过有效绑定
- GIVEN 活跃 Worktree 中已有较新任务正文或改名资料，主检出还留迁出前副本
- WHEN 主检出按同一 taskId 查询/枚举
- THEN 有效绑定指向的正文生效，列表不重复，旧副本不冒充当前任务；无法证明身份一致时明确拒绝

### Requirement: 主桥接可以选择与读取任务

#### Scenario: 主会话选择 Worktree 任务
- GIVEN 已登记在主检出的真实形态主 Session 和可用原生记录，以及有效 Worktree 绑定
- WHEN 经桥接 task use 持久化选择后取得下一轮 session context 与 knit_context
- THEN 选择有效，任务及 plan/design/research 从 executionDir 读取，主 Session 的 cwd 和选择分支仍属于原检出，不要求伪造新会话或 rebind

#### Scenario: reload 恢复与 clear
- GIVEN 主检出会话已选择 Worktree 任务，原生条目已实际写入
- WHEN 重新 attach/resolve 选择，再 clear 并读取下一轮上下文
- THEN 选择按当前有效原生路径正确恢复，clear 后为空，不重复堆叠或复活旧选择

#### Scenario: 阶段规则来自实际执行检出
- GIVEN Worktree 与主检出的规则或规划资料内容不同
- WHEN 为该 Worktree 任务生成阶段上下文
- THEN 使用当前既定规则要求的 executionDir 资料，不把主检出未提交公共规则夹带进去，仍从 mainRoot 读取运行事实

### Requirement: 异常绑定不被静默忽略

#### Scenario: Worktree 缺失或登记不符
- GIVEN 存在绑定但 Worktree 目录缺失、Git 未登记、分支不符或归属不符
- WHEN 主检出列任务并查询/选择/生成上下文
- THEN 列表或查询明确显示不可用原因，选择与上下文拒绝，返回实际登记路径；不回退主检出旧正文，不修改现场

#### Scenario: 主会话切分支仍使旧选择失效
- GIVEN 主会话原生选择事件来自旧主检出分支，即使其指向的 Worktree 仍有效
- WHEN 主会话所在检出切换分支后恢复选择
- THEN 旧选择仍按既有 branch_changed 等守卫失效，不因新增任务路由复活

### Requirement: 双根与已有动作保持一致

#### Scenario: 主检出登记任务事实和材料
- GIVEN 一个有效绑定且任务正文位于 Worktree
- WHEN 从已有支持的主检出或 Worktree 入口执行 record/update/material 及 implement/close 的代表性操作
- THEN 只改实际任务正文/材料，运行事实写 mainRoot，既有输入更新与完成验证守卫保持生效，Worktree 不出现第二套运行资料

#### Scenario: 只读路径无副作用
- GIVEN 当前任务正文、绑定、选择、完成/检查凭据以及 Git HEAD/index 的已知指纹
- WHEN 重复 list/status/context/session 查询
- THEN 不写正文、绑定、选择或业务凭据，不增加模型轮次，不提交或修复现场

#### Scenario: 派发守卫和普通任务回归
- GIVEN 普通主检出任务，以及 Worktree 未准备、失效或派发起点错误的任务
- WHEN 沿既有公开命令派发
- THEN 普通任务行为不变，Worktree 原有执行目录/准备/登记守卫继续拒绝并给出实际执行目录与下一步，不自动绕过守卫

### Requirement: 产物可核验

#### Scenario: 隔离回归与桥接模板一致
- WHEN 执行受影响测试及 npm test 并核对当前规范
- THEN 所有必须场景有实际证据，新增测试能在未修复的查询/选择/上下文路径复现失败，文档与行为一致
- AND 若修改桥接，两份文件逐字相同，既有通知与 wait 测试继续通过

## 验证与延期

验证要求 independent，正式检查用 magpie/group/deepseek。主会话另在 Rex 与普通 Terminal 各跑一遍 npm test。真实 GUI/Pi 的主检出路由验证与整套新基线自用验收在 k-b9019179b424 接续；本修复任务的独立检查不伪称已完成该整套验收。

## 记录

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施 run-616f38475cac 已接收（14 个成果路径）；主会话随后修正新增测试的 Session 查询 API 为 getByKnitId，并增加记录存在和 ID 断言，已用 task implement 登记该路径与验证。首次普通 Terminal 测试为 797/798（错误 API 参数），首次 Rex 因前者失败未运行；原始日志保留 /tmp/knit-route-verify/terminal-first.log、terminal-first.exit、rex-first.exit。修正后受影响用例 16/16，新的普通 Terminal（窗口 27117，/dev/ttys016）和 Rex（block:01a1d8a2-48d1-7dc3-ae14-38f862783583，/dev/ttys015）均 npm test 798/798、exit 0；日志 /tmp/knit-route-verify/terminal.log 与 rex.log。两份桥接未修改且逐字一致，git diff --check 通过。
正式独立检查 run-4844d766c52b（magpie/group/deepseek）completed/pass，已接收 check_pass；覆盖 14 路径、12 场景全 pass，actualChangedPaths=[]。检查者 typecheck/build、新文件16/16、npm test798/798通过；在隔离未修复基线复现原查询故障。保留4条非阻断观察：无taskId的项目概览会静默剔除失效绑定；task list遇任一失效绑定整条失败；test/run.test.mjs prepareOnly单行修改不是本修复必需但保持明确测试意图；第一条新测试在旧基线先因缺少listSync失败，R5.S1另有四条原始故障路径的断言复现。保持现范围，不扩大修复。未单独验证global Worktree的../上下文路径，真实Pi/GUI安装包整体验收由k-b9019179b424接续。
按用户9698c2d8持续授权本地提交和归档，不推送。产物提交文案已向用户展示，文件 /tmp/knit-route-verify/commit.txt；当前.git/config等全局配置未改，.knit/config.json既有reportRetries改动不在本任务提交范围。

### 交付记录

<!-- knit:delivery:op-54081d4a3158 -->
- 操作: op-54081d4a3158
- 时间: 2026-11-14T06:22:08.237Z
- 分支: refs/heads/main
- 授权来源: user:9698c2d8
- 调用: bridge
- 工作提交: 21a2b920e3c5e2e03749fe3b0cfa315c692257a7
- 结果: 正常交付；检查 run-4844d766c52b 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-14-worktree-main-task-lookup

### 任务资料提交记录

<!-- knit:metadata-commit:op-54081d4a3158 -->
- 任务资料提交: 3cfac13752378459ff033bff26bd2a74daafa228
- 归档目标: .knit/tasks/archive/2026-11/11-14-worktree-main-task-lookup

<!-- knit:progress:end -->
