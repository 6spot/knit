---
id: k-8f2a69252930
title: 接入 Antigravity CLI 并开放按环节选择 Agent
status: delivered
stage: null
verification: independent
parent: k-b2ac5d4c4c11
dependsOn:
  - k-19da925fecc2
  - k-eb039beccd06
priority: P2
createdAt: 2026-11-22T00:57:38.167Z
---

## 目标与范围

让工作流可按环节选择 Antigravity CLI（`agy`），使 Pi 实现后的 `agy` 审查能在任务 Worktree 中读写和运行测试，沿用 Rex 交互、同会话补报与主会话自动续跑。基于已交付的共用执行流程增加适配器。Worktree 准备、Rex 窗格、后台回退、报告校验与补报、取消、结算和等待通知继续由 Knit 管理。

- `stages[].agent` 接受 `pi` 或 `antigravity`。省略时用派发入口传来的主会话客户端，普通终端以 Pi 为缺省。Pi 的模型和思考等级依次取本次派发覆盖、环节、工作流顶层、主会话。`agy` 只取本次派发覆盖和环节，缺省参数交给 CLI，模型用自己的 ID，`thinking` 对应 `--effort`。`knit workflow validate` 报告显式配置错误与行号。
- `agy` 使用原生交互客户端和公开的后台 stream JSON 协议。用 `Stop` 和当轮转录或后台回执判断报告、等待输入和权限阻塞。保留 Rex 原生审批与追加输入。报告格式不符时复用 Knit 的校验和同会话补报。执行终态落账后，原 Pi 主会话通过共用等待链路收到带实际 Agent 的通知并开始新一轮。历史运行缺少 Agent 字段时按 Pi 读取。
- 环节 `tools` 显式列表是能力上限，原生审批在此范围内生效。省略或写 `tools: all` 开放各类别，沿用客户端审批。模型连接继续可用。只允许工具写入任务 Worktree，保护 CLI 配置、Knit 控制文件和 Git 元数据。CLI 持久化所需的状态写入单独限定到运行需要的路径，工具能力不授予这些写入。缺少 `external` 时在会话启动前阻止未授权的 MCP、插件等来源，缺少 `network` 时阻止命令及其他工具联网。遇到环境或组合无法兑现的限制，在创建本次 Worktree 与执行记录前报出缺失项。
- 首版保留 `tools: [read, write, exec]` 验收。以 macOS 的外层系统沙箱和独立命令进程复验为实施依据。批准的通用命令沿独立执行路径运行，保留原命令、工作目录和结果。Knit 在取消或收尾时管理该进程及其子进程。结合启动配置、钩子和系统限制保护执行路径。运行隔离的验证以 macOS 为起点，按可兑现的能力决定是否派发。

真实模型的整链路实机验收由接入交付后的子任务执行。实现与独立审查使用模拟客户端、macOS 本地隔离夹具和仓库现有测试。模板改动写入 `assets/templates/`，由安装版升级流程生成项目副本。交付走 Knit 任务分支和交付授权流程。

### 运行隔离实测依据

- macOS arm64、`agy` 1.5.13、真实 Rex 和后台对照中，屏蔽工作区 `.agents/mcp_config.json` 读取后夹具无启动，配置可读且 `disabled: true` 时仍启动。外层沙箱屏蔽全局 MCP、钩子与插件输入，允许 `agy` 访问模型。两个试过的状态目录环境变量未重定向转录。允许必要的默认 CLI 状态目录写入后，会话数据库、`Stop` 转录及后台同 ID 恢复可用。
- macOS 拒绝在外层 `sandbox-exec` 内加载 `agy` 的内层终端沙箱。仅用外层时，固定命令无法写出 Worktree，仍能连接回环夹具。`PreToolUse` 将固定命令改为调用本地客户端，独立进程用自己的 `sandbox-exec` 执行，Worktree 外写入和测试套接字访问均收到 `EPERM`。Rex 使用 `decision: force_ask`、`permissionOverrides` 指向原命令，以及 `overwrite.CommandLine` 转发到独立进程，卡片显示原命令，分别可批准和拒绝。实测只覆盖固定请求。通用命令入口、状态保护、其他工具入口和取消由本任务实现并验证。

## 完成条件

### Requirement: 按环节选择 Agent，在任务 Worktree 中执行并沿原会话收尾

#### Scenario: 工作流校验、派发选择与历史读取

- GIVEN 普通终端、Pi 主会话、含可选 `agent` 的流程及缺少 Agent 字段的历史记录
- WHEN 校验 Agent、模型及思考等级并分别派发 Pi 和 `agy`
- THEN 校验指出错误行号。模型与思考等级按各 Agent 的规则选取，CLI 缺省参数仅在适用时下传。`run status` 和 `run wait` 显示实际 Agent，旧记录按 Pi 读取，原有 Pi 路径通过回归

#### Scenario: Rex 或后台审查并通知原主会话

- GIVEN 模拟客户端覆盖 Pi、`agy`、Rex 和后台，`agy` 能给出权限拒绝、等待与报告回执
- WHEN 交互执行收到追加输入和审批、无效报告触发补报，窗格启动失败触发后台回退，或执行遇到权限阻塞、关窗与取消
- THEN 等待期间保持执行进行中，补报在原会话至多一次。后台回退使用同一个 Agent。必要操作拒绝时保留错误与可取得的 `denied_actions`，包括顶层 `SUCCESS`。有效报告或失败原因随终态入账，原 Pi 会话收到一条触发续跑的通知。主动取消结束会话及独立命令子进程，取消结果随工具返回

#### Scenario: 按声明限制原生工具、MCP 启动、命令写入和联网

- GIVEN 临时 Git 仓库及 Worktree、外部和符号链接目标、可控的 MCP 及网络夹具，环节配置 `tools: []`、`tools: [read]` 或 `tools: [read, write, exec]`
- WHEN 启动后台或 Rex 执行并尝试原生读写、MCP 启动、工具联网与通用命令。在 Rex 对允许的原命令分别批准和拒绝
- THEN 允许能力可用，第三组能在 Worktree 运行命令并写入允许的文件。受限操作、外部写入、工具联网与未授权 MCP 启动被阻止。CLI 可保存会话转录，运行时权限不通过工具继承。审批显示原命令，批准后才执行。无法落实限制时派发前报错

在 macOS 的 Rex 与普通终端各运行一次 `npm test`，记录 `npm run typecheck` 以及隔离夹具的结果。复审以仓库测试、已有的本地夹具和代码审查逐项核对三个场景。重点复验正常结算、主动取消、关窗与钩子路径检查。对照父任务核对内置适配器登记与共用执行入口。写明未能验证的行为和原因。

## 待澄清

## 相关资料

- 已交付的 [共用执行流程](../archive/2026-11/11-21-shared-agent-execution/task.md) 与 [Antigravity CLI 可行性实测](../archive/2026-11/11-21-agy-feasibility/research/agy-feasibility.md)。派发、Worktree、报告和通知见 `docs/design/DESIGN.md`。
- CLI 协议与权限参考。 [Headless](https://antigravity.google/docs/cli/headless/) · [Hooks](https://antigravity.google/docs/hooks/) · [CLI 权限](https://antigravity.google/docs/permissions/?tab=cli) · [CLI 沙箱](https://antigravity.google/docs/sandbox/?tab=cli)

## 结果

按环节选择 Pi 或 Antigravity CLI，共用 Worktree 派发、Rex 窗格、后台回退、报告补报、取消和原 Pi 会话通知。macOS 首版覆盖 tools: [read, write, exec]，保留原生审批并在结算、取消或关窗时回收独立命令子进程。独立审查 r-7c996cd5a2f1 通过三个完成场景。Rex 与普通终端的 npm test 各 402 项通过、0 失败、0 跳过，包含跨文件系统用例。类型检查、打包检查、差异检查及三个额外夹具通过。真实模型的整链路由父任务的后续子任务验收。
