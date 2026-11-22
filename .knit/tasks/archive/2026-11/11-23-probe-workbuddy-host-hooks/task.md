---
id: k-fdb8c6110481
title: 实测 WorkBuddy 桌面端的项目级 Hook 路径、协议格式、PATH 与后台能力
status: delivered
stage: null
verification: self
parent: k-a9c3c3ddec63
dependsOn: []
priority: P1
createdAt: 2026-11-22T16:23:26.582Z
---

## 目标与范围

在动手编写 WorkBuddy 主会话适配代码（`k-eaa1664e9b5f`）之前，先对本机已安装的 `WorkBuddy.app`（`~/.workbuddy`）进行受控实测，摸清其项目级定制与运行环境的全部真实行为，杜绝凭猜测写代码：

需要实测并留下可复现证据的 4 个问题（产出写到本任务目录 `.knit/tasks/11-23-probe-workbuddy-host-hooks/research/workbuddy-hooks.md`）：

1. **项目级配置与 Hook 发现路径**：
   - 验证 WorkBuddy 打开一个临时本地项目目录时，实际读取哪个项目级路径下的规则与 Hook（如 `.workbuddy/settings.json`、`.codebuddy/settings.json`、`.workbuddy/hooks.json`、`.codebuddy/rules/`、`AGENTS.md`，还是必须通过插件目录注册），以及是否受项目信任提示影响。
2. **Hook 生命周期事件与真实输入输出协议**：
   - 捕获 `SessionStart`、`UserPromptSubmit`（或 `UserPromptExpansion`）与 `PreToolUse` 的**真实 stdin JSON 样本**（核实字段名如 `session_id`、`transcript_path`、`cwd`、`tool_name`、`tool_input`）；
   - 核实 `transcript_path` 指向的会话记录文件真实格式（如何可靠识别用户消息，防止误把系统/助手消息当用户授权）；
   - 核实上下文注入的真实有效输出格式（纯文本 stdout 还是 `hookSpecificOutput.additionalContext` JSON）与 `PreToolUse` 拒绝执行的真实有效输出（`exit 2` 还是 JSON `permissionDecision: "deny"`），以及 Bash 工具的真实 `matcher` 名称。
3. **桌面 GUI 环境下的 `PATH` 与 Node／CLI 可达性**：
   - 实测在 WorkBuddy 桌面 App 的 Hook 脚本与 Bash 工具里，`PATH`、`which node`、`node -v`、`which knit`、`which pi`、`which agy` 的实际结果；验证通过何种最小包装（例如 `zsh -lc` 或显式路径引导）能稳定找到 `node >= 24`、`knit`、`pi`、`agy`。
4. **后台执行与唤醒能力（确定 GUI 降级档位）**：
   - 实测 WorkBuddy 的 Bash 工具是否支持后台运行命令并在完成后自动唤醒主会话，以及同步命令的默认超时时间；验证在 WorkBuddy Bash 里执行 `knit run start <id>` 启动 `detached` worker（Pi RPC 与 AGY stream-json）后，worker 是否能在 Bash 返回后继续存活并正常结算。

边界：
- 本任务是纯研究与探针任务，不修改 `src/`、`assets/` 或本仓库生产配置；所有探针实验在 `/tmp` 临时夹具目录完成，不改动用户 `~/.workbuddy/` 的真实设置与登录状态。
- 所有结论必须给出实测样本或原始输出，没测到的标明「未核实」。

## 完成条件

### Requirement: 产出经本机 WorkBuddy 实测核实的协议与环境调研报告

#### Scenario: research/workbuddy-hooks.md 覆盖全部 4 项问题并附真实样本

- GIVEN 本机已安装的 `WorkBuddy.app` 与临时测试项目夹具
- WHEN 完成项目级路径探测、Hook stdin/stdout 捕获、`PATH` 检查与后台 `detached` 进程实测，并整理结果到 `.knit/tasks/11-23-probe-workbuddy-host-hooks/research/workbuddy-hooks.md`
- THEN 报告清晰记录：1）生效的项目级 Hook 与规则路径；2）三个事件的真实 stdin JSON 样本、transcript 用户消息提取方式及注入／拒绝输出格式；3）GUI 环境下 `node`/`knit`/`pi`/`agy` 的 `PATH` 现状与可行引导方案；4）Bash 工具的后台唤醒与超时行为，为 `k-eaa1664e9b5f` 提供零猜测的实施依据

## 待澄清

- [assumed] 若探测 `WorkBuddy.app` 界面触发 Hook 需要用户在桌面 GUI 中打开临时夹具目录并发送 1~2 条测试消息，由主会话准备探针目录与脚本、用户配合在 GUI 中点开触发，实测完成后回收临时目录。

## 相关资料

- `.knit/tasks/11-23-agy-host-hook-handler/task.md` — 共用宿主钩子内核需求契约
- `docs/research/REX-PANE.md` — 历史环境实测研究报告写法参考
- `.knit/tasks/11-23-agy-main-session-plugin/plan.md` — 总体多宿主接入规划

## 结果

已完成 WorkBuddy Desktop 5.9.3 运行时代码只读核实与模拟 GUI PATH / detached 子进程实测，产出 research/workbuddy-hooks.md：确认项目级 Hook 路径为 .workbuddy/settings.json（WorkBuddy Desktop 显式设置 CODEBUDDY_PROJECT_CONFIG_DIR=.workbuddy 并以 CODEBUDDY_DISABLE_SYSTEM_REMINDER_MD=1 禁用 AGENTS.md/CODEBUDDY.md 自动注入），确认 SessionStart/UserPromptSubmit/PreToolUse 的 stdin/stdout 协议与 transcript JSONL 过滤规则、Bash matcher 为 ^Bash$、WorkBuddy 前置内置 Node v22.22.2 的 PATH 坑与可移植 sh 引导方案，以及 Bash run_in_background + 两档降级策略；真实 GUI 窗口点击交互标明未实机复核。
