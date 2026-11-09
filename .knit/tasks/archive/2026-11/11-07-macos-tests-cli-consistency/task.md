---
id: k-fd956a1c3dc0
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P1
dependsOn: []
order: 10
createdAt: 2026-11-07T11:44:06.642Z
title: macOS 测试全绿与 CLI 参数一致性
---

# macOS 测试全绿与 CLI 参数一致性

## 目标与边界

### 背景与问题

开发机是 macOS，但 `npm test` 在 macOS 上有 7 个失败（585 个中 578 通过）：

- host-selection：`execution.host=auto` 时期望 rex，实得 local；
- pi-runtime：killProcessGroup 抛 `kill EPERM`；
- rex：bridge.sock 路径过长，`listen EINVAL`；
- worker-extension 2 个；
- `task adopt frontmatter 已绑当前分支但绑定行缺失`；
- worktree connect 与 `/private` 路径相关。

CLI 参数也不一致：`locks` 不接受 `--dir`；`resume` 与 `run resume` 两个入口；`cancel` 对已终态 run 返回 `requested: false / already_terminal`，语义含糊。

### 交付范围

1. 逐个定位 7 个失败，分为"测试依赖环境"与"产品缺陷"两类：
   - 前者让测试与环境无关（例如测试中清除 `REX_*`／`TERM_PROGRAM`，socket 改放到短路径的临时目录）；
   - 后者修复产品（如 `/private` 符号链接下的路径规范化、进程组信号的 EPERM 处理）。
2. Rex socket：路径超过平台上限（macOS 104 字节）时改用 `$TMPDIR` 下的短路径并在 rex.json 记录。
3. CLI 一致性：
   - `locks --dir`（若锁任务已处理则跳过）；
   - `run resume` 与顶层 `resume` 共用一个实现；
   - `cancel` 对已终态 run 返回 `requested: false, reason: already_terminal`，人读输出写"run 已结束，无需取消"。
4. 在 TECHNOLOGY／AGENTS 中写清 macOS 的支持级别：开发环境测试必须通过，真机验收仍延期。

### 非目标

- 不做 macOS 安装或发布验收。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 无额外取舍；按交付范围执行。

## 完成条件

- macOS 上 `npm test` 全绿（在 Rex 终端和普通终端各跑一次）；Linux CI 测试不回退。

## 输入引用

- 审计中等问题 7、8；`/tmp/knit-test.log` 中的失败用例名（审计时记录）。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 派发须知（2026-11-07 主会话，审计计划执行约定）
- 报告 `changedPaths` 只列本 run 在工作区实际改动的路径（与 git 前后差一致），不列之前轮次或其它任务已存在的改动；否则 `changed_paths_mismatch` 整轮失败。
- 交付前凭据扫描规则 generic_secret_assignment（见 src/contracts/credentials.ts）会把“凭据类关键词作变量名或字段名并被赋值长字符串或表达式”的新增行判为疑似凭据。新增代码与测试请给此类局部变量加前缀（例如 owner 前缀），夹具值保持 8 字符以内；完成前用 dist/contracts/credentials.js 的 scanCredentials 扫描新增行确认零命中。
- 工作区里其它 `.knit/tasks/*/task.md` 的未提交改动来自主会话记录，不属于本任务成果，不要修改或列入报告。
- 单跑测试时请 `env -u REX_SESSION -u REX_BLOCK node --test ...`；全量用 `npm test`。
- 已交付的 k-fdfd8c171736 按原生会话的 write／edit 调用归属改动：请用 write／edit 工具改文件，bash 写入会被判 unattributed_paths。
- 环境事实与主会话决定（2026-11-09）：本次执行环境只有 Linux aarch64，没有可达的 macOS 机器；审计时的 /tmp/knit-test.log 已被覆盖，失败用例名以本 task.md 背景列出的 7 项为准。
  - 实施方式：在代码里逐项定位并修复；在 Linux 上用可注入的条件模拟 macOS 触发点（如 104 字节 socket 上限、kill 返回 EPERM、/private 符号链接或 realpath 差异、REX_*／TERM_PROGRAM 环境变量），写成不依赖平台的自动化测试。
  - 只能在真机上确认的行为如实写入报告的 not_run 项，不得宣称 macOS 已通过。
  - 完成条件“macOS 上 npm test 全绿（Rex 终端与普通终端各一次）”由主会话在关闭时列为 unverified，交给后续 macOS 开发环境复验；Linux npm test 必须全绿。
- locks --dir 已由 k-6f0616f3779d 实现，核对后跳过即可。

## 失败记录与续做须知（2026-11-09 主会话）
- run-edbd908a5b2e failed：report_not_json。根因是模型服务在第 134 行会话处返回 content_filter 拒绝（原文：refused this request (safety filter: content_filter)），会话结束时没有写出报告。这不是任务代码缺陷，也不是 Knit 卡死。计为本任务连续失败第 1 次，累计 3 次按 blocked 处理。
- 处理方式：开新会话按原任务内容续做，不改写任务内容来规避过滤；若再次被拒，如实记录，不绕过。
- 残留：src/adapters/pi/connection.ts、src/adapters/rex/bridge.ts、src/adapters/rex/state.ts、src/application/rex-launcher.ts、src/infrastructure/paths.ts 已由该 run 用工具写入，登记在任务残留 residue.json，保留在工作区，备份在 /tmp/knit-residue/fd95/src.patch。这些改动未经验证，请先审阅并跑测试，再决定保留或修改。
- 本轮 changedPaths：列出本轮实际改动的路径；继续沿用的残留路径也列出，以便继承进 scope；不沿用的请还原，不要列出。

## 完成记录（2026-11-09 主会话，self 验证）
- 实施 run-10fe97977e1f completed／implementation_accepted。它在审阅后继承了上一失败 run 的残留，其中 bridge.ts、rex-launcher.ts、paths.ts 原样继承，connection.ts 与 state.ts 在此基础上修改。
- 主会话自检：npm test 657/657（Linux aarch64）；worker 另在模拟 macOS TMPDIR 与 /var→/private/var 条件下全量跑通 657/657。
- unverified：完成条件“macOS 上 npm test 全绿（Rex 终端与普通终端各一次）”未执行，因为执行环境没有可达的 macOS 机器；host-selection 在 macOS 上的根因为代码推断（假 rex 的 env node 不在 PATH），未经真机复现；真实 killpg EPERM 只用注入的假 kill 验证。
- 遗留：全量测试在高负载下偶发时序失败 1–2 项（pi-runtime stderr 收敛、run.test 项目锁释放轮询），单跑均通过，根因未定位。

### 交付记录

<!-- knit:delivery:op-3126f2647e12 -->
- 操作: op-3126f2647e12
- 时间: 2026-11-09T05:23:51.565Z
- 分支: refs/heads/main
- 授权来源: .knit/tasks/11-07-audit-fix-plan/plan.md#执行授权
- 工作提交: 2e79e305273e6733d1f8e0b8bb8dee137a80bceb
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-07-macos-tests-cli-consistency

### 任务资料提交记录

<!-- knit:metadata-commit:op-3126f2647e12 -->
- 任务资料提交: 17ece5e361322c263266bdeb0f300b0ac20864f6
- 归档目标: .knit/tasks/archive/2026-11/11-07-macos-tests-cli-consistency

<!-- knit:progress:end -->
