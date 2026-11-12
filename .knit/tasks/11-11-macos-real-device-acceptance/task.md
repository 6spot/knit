---
id: k-7bdf43be461e
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn: []
order: null
createdAt: 2026-11-11T13:02:14.236Z
title: macOS 真机验收：安装、真实宿主、Rex 浮窗与跨功能对话
---

# macOS 真机验收：安装、真实宿主、Rex 浮窗与跨功能对话

## 目标与边界

### 背景与问题

macOS 当前只到「开发环境级」支持：`docs/design/TECHNOLOGY.md` 第 6 节要求 macOS 开发机 `npm test` 全绿，并把 macOS 安装、发布与真机运行验收列为延期（B001，`docs/history/BLOCKERS.md:41`）。025 平台矩阵的 macOS 行「未执行」（`docs/history/tasks/025-packaging-and-platform-ci.md`），`validation/real-host-acceptance-2026-11/` 的跨功能对话验收不含 macOS／Rex 浮窗真机部分，`docs/design/DESIGN.md` 第 16.3 节把 REX 浮窗 GUI 验收记为按决定延期。

本机条件已具备：macOS 27.2.1 开发机、Pi 1.5.2、Rex 客户端在位。用户在 2026-11-11 决定在本机执行完整验收（范围 C）。

### 交付范围

1. 工程验证：普通终端与 Rex 终端各跑一次 `npm test`（typecheck、build、全部用例），并跑 `pack:check`。
2. 安装冒烟：`npm pack` → 临时目录 `npm install` 本地 tgz → `knit --version`／`knit init`（默认启用 Pi，`--pi` 可省略）／`knit start --dir <临时项目> -- --version`，核对包内文件与排除项。
3. 真实宿主：临时 init 项目中用真实 Pi 1.5.2 加载桥接，核对每轮上下文注入（无任务与有任务两种）。
4. 阶段链路：临时项目里真实派发 implement／check run（真实子进程与真实模型），核对报告接收、状态转移、凭据与残留锁／进程。
5. Rex 浮窗真机行为：派发时浮层展示、阶段结束自动关闭、中断后恢复（以用户观察为准）。
6. 真实模型跨功能对话：自然语言建任务入口与澄清门、`blocking` 阻挡 `task ready`、场景化验收核对。
7. 资料收口：更新 `README.md`、`docs/README.md`、TECHNOLOGY 第 6 节与 B001 记录，使平台声明与证据一致；验收记录落在 `validation/macos-acceptance-2026-11/`。

### 非目标

- 不切 Node 24 复跑矩阵：用户明确用本机 Node 26.3.0 验收，Node 24 组合沿用 Linux 候选与 025 记录，报告如实标注组合差异。
- 不 npm publish、不部署、不新增 CI 配置、不推送。
- 不把 macOS 声明为「发布就绪」；npm 发布与外部部署仍未进行。
- 不重做 Linux 已有验收，不改业务行为（发现阻断缺陷时按下述口径处理）。

### 关键事实

- 环境组合：macOS 27.2.1 + Node 26.3.0（mise latest）+ npm 11.16.0 + Pi 1.5.2 + Rex 当前版本。
- 包 `engines` 为 `node >=24`，Node 26 在允许范围内；`@types/node` 为 ^24，typecheck 结果以实跑为准。
- 工作区当前仅 `.knit/config.json` 有本机 rebind 改动，验收须在隔离临时目录进行，不污染业务产物。

### 历史验收与本次交付口径（2026-11-12）

本任务承载 2026-11-11 已执行验收的历史证据，以及已完成补修任务的报告收口；本次先复核这些报告与已保存日志的一致性并交付，不冒充今天重新执行过测试或真机验收。新的完整 Mac + Node 26 验收由 k-b9019179b424 单独记录。task.md 与其它任务资料是元数据，不纳入主会话实施的产物指纹。原必验场景与非目标保持不变。

本次产物集合保持相同的全部 35 个叶文件，实施记录改为逐文件指纹，增强可核验性；不删除目录内的已完成产物，不视为禁止目录路径的永久产品规则，也不宣称修复了尾 slash 目录选择缺陷。

## 完成条件

### Requirement: 工程验证与打包
本机代码在 macOS 上通过全部工程检查，且发布包内容符合白名单。

#### Scenario: 普通终端全量测试
- GIVEN 干净工作区与本机 Node 26.3.0
- WHEN 在普通终端执行 `npm test`
- THEN typecheck、build 与 `test/*.test.mjs` 全部用例通过，记录实际通过数与总数
- AND 没有靠跳过或以环境缺失为由豁免的用例

#### Scenario: Rex 终端全量测试
- GIVEN 从 Rex 终端启动的 shell（含 `REX_*` 环境）
- WHEN 执行 `npm test`
- THEN 结果同样全绿，记录通过数与总数
- AND 日志保留两次运行的日志路径

#### Scenario: 打包检查
- GIVEN 工作区可构建
- WHEN 执行 `npm run pack:check`
- THEN 检查通过，包内只有 `README.md`、`package.json`、`assets/`、`dist/`
- AND 不含 `src/`、`test/`、`validation/`、任务目录或私有记录

### Requirement: 安装与初始化冒烟
候选包能在 macOS 上完成安装与项目初始化启动。

#### Scenario: 本地安装候选包
- GIVEN 全新临时目录
- WHEN `npm pack` 产出 tgz 并在临时项目 `npm install` 该 tgz
- THEN `knit --version` 输出 0.1.0
- AND 被安装包的文件清单与 pack 记录一致

#### Scenario: init 与 start 冒烟
- GIVEN 空的临时项目目录
- WHEN 执行 `knit init`，再执行 `knit start --dir <临时项目> -- --version`
- THEN init 报告 ready 并生成 `.pi/extensions/knit.ts` 与 `.knit/` 结构（当前 CLI 的客户端开关是 `--pi`，`--client` 已移除）
- AND start 输出 Pi 实际版本 1.5.2，stderr 无错误

### Requirement: 真实宿主与阶段链路
桥接在真实 Pi 中生效，阶段派发与接收在 macOS 上可完成。

#### Scenario: 桥接加载与上下文注入
- GIVEN 已 init 的临时项目与真实 Pi 1.5.2
- WHEN 在临时项目启动真实 Pi 会话
- THEN 桥接扩展正常加载，无加载错误
- AND 无任务时每轮注入建任务提示，有任务时注入当前阶段与下一步

#### Scenario: 阶段派发到关闭的完整链路
- GIVEN 临时项目中一个有明确验收的小任务，且模型可用
- WHEN 依次执行 `task ready`、派发 implement run、接收、check、接收、`task close`
- THEN 每份阶段报告被核心接收，任务阶段与凭据记录正确
- AND 结束后无残留锁、无残留 worker 进程

#### Scenario: 失败与阻塞不被写成通过
- GIVEN 任一阶段或检查结果失败
- WHEN 汇总验收结论
- THEN 任务按实际结果记录失败项与证据，不以复跑通过或降低口径放行

### Requirement: Rex 浮窗真机行为
此前延期的 REX GUI 行为在真机上可用（以用户观察确认）。

#### Scenario: 浮层展示与收尾关闭
- GIVEN Rex 客户端运行，自动识别生效
- WHEN 派发 implement 阶段
- THEN Rex 浮层展示该 run 的任务与阶段信息
- AND 阶段结束后浮层自动关闭，用户确认行为正常

#### Scenario: 中断与恢复
- GIVEN 浮层中的 run 正在进行
- WHEN 用户中断该 run，再为同一任务重新派发
- THEN 旧执行被确认结束，新执行沿用原阶段与修复次数
- AND 恢复不重置任务阶段、修复预算或 scope，用户确认可用

### Requirement: 真实模型跨功能对话
对用户可见的入口与守卫在真实模型下按规范表现。

#### Scenario: 自然语言入口与澄清门
- GIVEN 真实 Pi 会话与真实模型
- WHEN 用户用自然语言提出一个要建任务的事项
- THEN 模型先取证再提问，并先询问是否建任务
- AND 不擅自创建任务或直接开始实施

#### Scenario: blocking 阻挡与场景核对
- GIVEN 任务「待澄清」含一条 `[blocking]`，或完成条件写成 Requirement／Scenario
- WHEN 执行 `task ready`，或 check 阶段报告缺场景条目
- THEN `task ready` 以 `clarify_blocking` 拒绝
- AND 缺场景条目的检查报告被拒并要求补报

### Requirement: 资料收口
平台声明与本次证据一致，未验证项保持明确。

#### Scenario: 平台声明更新
- GIVEN 验收结果已落 `validation/macos-acceptance-2026-11/`
- WHEN 更新 `README.md`、`docs/README.md`、`docs/design/TECHNOLOGY.md` 第 6 节与 B001 记录
- THEN 声明的 macOS 能力逐条对得上证据
- AND npm 发布、macOS + Node 24 组合等未验证项仍明确写为延期

## 待澄清

- [assumed] 失败处理口径（Agent 建议，待确认）：先保留原始日志；与验收直接相关且一次改动可收口的缺陷在本任务内修复并复验；涉及设计变更或跨模块的重启后续任务，本任务按实际结果记录，不把未复验项写成通过。

## 输入引用

- 支持级别与 macOS 差异处理：`docs/design/TECHNOLOGY.md` 第 6 节。
- 验收矩阵与里程碑放行条件：`docs/design/DESIGN.md` 第 15.1、16.3、16.4 节。
- 宿主与阶段协议：`docs/design/ARCHITECTURE.md`、`STATES.md`、`OPERATIONS.md`、`ROLE-CONTRACT.md`。
- 延期来源：`docs/history/BLOCKERS.md` B001；`docs/history/tasks/025-packaging-and-platform-ci.md`；`.knit/tasks/archive/2026-11/11-07-macos-tests-cli-consistency/task.md`。
- 既有证据：`validation/release-candidate-linux/`、`validation/real-host-acceptance-2026-11/`。
- 验证入口：`package.json` 的 `test`／`pack:check`／`pack:install`；`test/macos-compat.test.mjs`。
- Rex 技能说明：`/Users/me/.agents/skills/rex/SKILL.md`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-b2e07c91ead9 -->
- 操作: op-b2e07c91ead9
- 时间: 2026-11-12T17:49:49.397Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 9a02ece6e37bff6bf1becb064df11d7f1498d544
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-11-macos-real-device-acceptance

<!-- knit:progress:end -->
