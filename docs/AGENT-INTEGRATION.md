# Agent 接入规范

接入一个客户端时，先确定用户会在哪里用它。用户在客户端内讨论需求、选任务和授权交付，接的是**主会话宿主**。工作流通过 `knit run start` 启动客户端去完成一个环节，接的是**执行者**。同一客户端可以承担两种角色，每种角色都有自己的入口和验收场景。

| 客户端 | 主会话入口 | 工作流执行者 |
| --- | --- | --- |
| Pi | `knit init --pi` 安装项目扩展，通过三个 Knit 工具操作任务、执行和交付 | `agent: pi` |
| Antigravity CLI（`agy`） | `knit init --agy` 安装项目插件，通过钩子和 CLI 操作 | `agent: antigravity` |
| WorkBuddy Desktop | `knit init --workbuddy` 安装项目钩子，通过 `Bash` 调用 CLI | 仅接入主会话。桌面原生子 Agent 由 WorkBuddy 调度 |
| Qoder 桌面端 | `knit init --qoder` 安装项目钩子，默认主 Agent 通过 `Bash` 调用 CLI | 仅接入主会话。Qoder 自身工具与原生子 Agent 完成实现和检查 |

## 1. 在目标客户端验证接入条件

在临时项目里记下客户端版本、平台和启动方式，用一次最小会话回答对应角色的问题。保留能复现结论的输入和输出，供实现协议和编写夹具使用。

- **主会话**。确认项目配置的加载位置和工作区信任条件。用普通需求触发首轮和后续轮次，记录扩展或钩子收到的项目目录、会话标识和上下文注入位置。执行一条普通命令，确认工具名、入参和放行响应。要接交付，再确认怎样从当前会话取到真实用户消息。
- **执行者**。从指定工作目录启动客户端，发送一条消息，在同一会话追问一次，再停止进程。查明如何区分等待输入、审批、提交最终报告和异常退出。想支持原生续聊或 Rex 窗格时，再分别试一次重开会话或窗格内运行。
- **执行者的工具权限**。对打算支持的 `tools` 组合，各选一个应当成功和一个应当被拒绝的操作。尤其要从原生工具和命令两条路径实测只读、工作目录、联网和外部插件的限制。Antigravity 1.5.13 的探针表明，仅靠 CLI 权限配置无法限制 Worktree 外写入及 `network`、`external`。现行适配器在派发前核对版本、macOS `sandbox-exec` 和配置，并对命令另加沙箱。[可行性实测](../.knit/tasks/archive/2026-11/11-21-agy-feasibility/research/agy-feasibility.md) · [现行隔离实现](../src/adapters/antigravity/isolation.ts)

## 2. 接入主会话宿主

1. **安装项目桥接。** 在 `assets/templates/` 维护桥接模板，在 `knit init` 登记宿主选项和生成物。采用命令型钩子时，在 CLI 登记 `knit hook <宿主> <事件>`。CLI 从标准输入读取事件 JSON，客户端适配器按宿主协议生成响应。[钩子入口](../src/cli/knit.ts)

   普通 `knit init` 生成核心文件，首次启用宿主用对应选项，可以一次指定多个宿主，例如 `knit init --pi --agy --workbuddy --qoder`。`--force` 还会识别已启用的桥接，将有差异的桥接、流程和角色文件按相对路径备份到 `.knit/.runtime/backups/<时间>/` 后再恢复模板。已有配置、规范和任务由项目保留。WorkBuddy 或 Qoder 项目若已有自定义 `settings.json`，普通安装保留原文件，需要把模板中的三个钩子合入其中。[初始化实现](../src/application/init.ts) · [CLI 选项](../src/cli/project.ts) · [模板](../assets/templates/)
2. **把上下文送进正确的会话。** 首轮提供 `discuss` 规范，选任务后提供任务状态、下一步和对应环节的补充规范。Pi 在每轮构建系统提示时加入这些内容。钩子宿主复用 `hostContext`，按项目、宿主和原生会话标识保存任务选择及内容摘要，只在 Knit 项目的上下文首次出现或内容变化时注入。可在同一项目打开两个会话，分别选中不同任务，确认各自只收到自己的任务状态。[Pi 扩展模板](../assets/templates/pi/extensions/knit.ts) · [共享宿主钩子](../src/application/host-hook.ts)
3. **连接任务选择与交付。** Pi 通过 `knit_task`、`knit_run`、`knit_deliver` 调用 Knit。命令型宿主在工具执行前把 `knit context --use <id>` 或 `knit context --unuse` 绑定到当前会话，复用 `checkHostCommand` 处理命令。交付预览直接放行。实际交付时，CLI 要求提供 `--authorization`，由宿主桥接核对引用能否匹配当前会话的一条真实用户消息。匹配范围是整条消息或其中完整的一行。提取文本时要剔除宿主合成消息和元数据。分别验证预览、原话不符、原话相符，以及宿主自身的拒绝规则。[共享命令处理](../src/application/host-command.ts) · [主会话验收记录](../validation/multi-host-main-session/README.md)
4. **确定派发后如何继续。** 派发立即返回，结果由发起会话读取。Pi 在 `knit run wait <id>` 结束后唤起新一轮。只接入主会话的宿主按实测能力决定是否派发外部执行者：WorkBuddy 桌面沙箱会拦截外部执行者子进程（实测 `Brokered program policy check unavailable`），因此全程降级为使用自身工具与原生子 Agent 完成实现和检查，`PreToolUse` 直接拒绝 `knit run start` 并提示改用原生流程或外部终端。新宿主按实测能力写明采用哪种方式。[WorkBuddy 宿主指引](../src/adapters/workbuddy/host-hook.ts)

| 钩子宿主 | 配置与上下文事件 | 命令协议要点 |
| --- | --- | --- |
| Antigravity | `.agents/plugins/knit/` 下的 `plugin.json`、`hooks.json` 和 `rules/AGENTS.md`。`knit hook agy` 处理 `SessionStart`、`PreInvocation`，通过 `injectSteps` 注入 | `PreToolUse` 匹配 `run_command`。1.5.13 放行时也要显式返回 `{"decision":"allow"}`，返回 `{}` 会被客户端拒绝。[实现](../src/adapters/antigravity/host-hook.ts) |
| WorkBuddy | `.workbuddy/settings.json` 调用 `knit-hook.sh`，转入 `knit hook workbuddy`。`SessionStart`、`UserPromptSubmit` 通过 `hookSpecificOutput.additionalContext` 注入。桌面端关闭了项目 `AGENTS.md` 的自动注入，项目指引随钩子送入会话 | `PreToolUse` 精确匹配 `Bash`，改写命令用 `updatedInput.command`。桌面 `PATH` 可能先找到内置 Node 22，在该环境下检查脚本能否找到 Node ≥24 和 `knit`。[钩子模板](../assets/templates/workbuddy/) · [桌面协议探针](../.knit/tasks/archive/2026-11/11-23-probe-workbuddy-host-hooks/research/workbuddy-hooks.md) |
| Qoder | 仅默认主 Agent（`agent:default`）加载项目级 `.qoder/settings.json`。`SessionStart`、`UserPromptSubmit` 通过 `hookSpecificOutput` 返回事件名和 `additionalContext`。内容未变时 stdout 为空 | `PreToolUse` 匹配 `^Bash$`。Qoder 将整个 `tool_input` 替换为 `updatedInput`，所以改写 `command` 时一并返回原有的 `timeout`、`description` 等字段。钩子拒绝 `knit run start`，如需外部派发，请在普通终端、Pi 或 Antigravity 中运行。实际交付只接受 `transcript_path` 中真实用户消息的整条或完整一行。[钩子实现](../src/adapters/qoder/host-hook.ts) · [项目模板](../assets/templates/qoder/) |

## 3. 接入工作流执行者

1. **登记派发目标。** 在工作流契约的 `AgentNameSchema` 和 `AGENT_SPECS` 定义 `agent` 名、模型格式、思考等级及缺省值策略，在 `builtinAgents` 增加 `AgentRegistration`，提供 `createAdapter` 和 `sessionDefaults`。Pi 要求 `provider/模型`，可继承工作流或主会话的缺省值。Antigravity 使用自己的模型 ID，省略时由 `agy` 决定。省略 `agent` 时，`knit workflow validate` 可接受任一已登记客户端支持的格式，派发时再按实际客户端复核。命令入口可通过 `KNIT_SESSION_AGENT` 指定客户端，普通终端默认 `pi`。旧执行记录缺少 `agent` 时按 Pi 读取。[工作流契约](../src/contracts/workflow.ts) · [目标校验](../src/domain/agent-target.ts) · [执行者注册表](../src/adapters/agents.ts)
2. **实现一次会话。** 实现 `AgentAdapter.createSession`，接收 `AgentLaunch` 并返回 `AgentSession`。`root` 是任务资料所在的主检出，`cwd` 是执行者工作的 Worktree，`dir` 是本次执行目录。Knit 准备好 `system.md`、`message.md` 和声明的报告字段。`start()` 报告启动结果，`prompt()` 在原会话发消息，等本轮真正结束才返回报告原文或失败原因，`stop()` 停掉客户端。报告落盘、字段校验、同会话补报一次及执行入账均由 Knit 负责。有交互界面的客户端等待用户输入或审批时，保持进行中的状态。[适配器契约](../src/contracts/agent.ts) · [会话与报告处理](../src/application/run-session.ts)
3. **限制环节可用的工具。** 将 `read`、`write`、`exec`、`network` 和 `external` 映射到客户端实际开放的能力。省略 `tools` 或写 `all` 表示请求全部能力，`[]` 关闭项目工具。同一环节配置两个及以上 `executors` 时，必须显式列出 `tools` 并排除 `write`。需要隔离前置条件的客户端通过 `checkDispatch` 检查，无法满足时在派发前返回具体原因。需要在 Worktree 写临时配置的客户端可登记 `workspaceCopies` 和 `cleanRun`，供快照核对和结算清理使用。[派发准备](../src/application/run-prepare.ts) · [执行者注册表](../src/adapters/agents.ts)
4. **接通可选能力。** `paneCommand` 提供交互启动命令，返回 `null` 时走后台。Rex 窗格的打开、监控和回退由 Knit 负责。支持原生续聊时返回可核实的 `resumeId`、实现 `checkResume`，再用 `resume: true` 验证同需求、环节、执行器和 Agent 的续聊。恢复不可用或启动失败时用完整交接新开会话。已经开始执行本轮指令后发生的错误按本轮结果结算，避免重复执行。[Pi 适配器](../src/adapters/pi/execution.ts) · [Antigravity 适配器](../src/adapters/antigravity/execution.ts) · [设计第 7 节](design/DESIGN.md)

在临时项目的 `.knit/workflow.yaml` 写入下面的示例。`knit workflow validate` 应报告配置有效，`knit workflow show` 应列出 `inspect` 环节、`antigravity` 执行者、`read` 能力和 `summary` 报告字段。真实派发还需要有初始提交的 Git 仓库、已确认的测试任务和满足预检的客户端环境。

```yaml
version: 1
stages:
  - id: inspect
    agent: antigravity
    tools: [read]
    report:
      summary: string
```

## 4. 验收与留证

| 验收场景 | 操作与可观察结果 |
| --- | --- |
| 主会话从讨论到交付 | 在装好桥接的临时项目发一句普通需求，观察首轮规范。创建、选中测试任务，确认另一会话的选择独立。让选中任务的状态发生变化，确认下一轮可见。在已完成任务上预览，再分别用不符和相符的授权原话尝试交付，核对任务状态与归档结果。 |
| 执行者从派发到结算 | 用 `knit run start <id>` 从真实入口派发，核对实际 Agent、工作目录、能力及报告。让首次报告的末尾 JSON 代码块漏掉 `summary`，观察 Knit 在同一会话要求补报，核对 `report.md` 中的最终结果。另一次执行中用 `knit run cancel <id>` 取消，检查进程已退出、`knit run status <id>` 已记下结果。 |
| 声明支持的续聊、窗格或通知 | 分别触发支持的路径。续聊核对原生会话标识，恢复失败后核对完整交接。窗格中等待输入时检查任务仍在执行，窗格不可用时观察后台回退。声称能自动通知时，观察发起派发的主会话是否实际收到结果。 |

在记录里给出版本、平台、实际入口、操作、观察结果及证据位置，逐项标明真实客户端、模拟输入或待实测。模板有变更时，用 `npm run pack:check` 检查发布包，在临时项目验证初始化生成物、重复初始化和 `--force` 的备份。改动适配器时运行 `npm run typecheck` 和 `npm test`，再用目标版本的真实客户端复核关键路径。[初始化回归](../test/init.test.mjs) · [宿主协议回归](../test/host-hook.test.mjs) · [原会话补报回归](../test/run-report-retry.test.mjs)

真实会话的证据放在 `validation/` 或对应任务目录里。接入后，在仓库首页列出可用角色和启动入口，在设计第 5 至 7 节及第 9 至 10 节的对应位置更新交接、执行、命令或安装行为。[现行设计](design/DESIGN.md)

### 已有接入的验收记录

- **Pi** 有真实 Pi 和模型从派发到交付、取消的记录，另有 Rex 窗格回退和 Pi 原生会话失效后重新交接的演练。[全流程演练](../validation/slim-h1-2026-11/README.md) · [Rex 演练](../validation/slim-rex-2026-11/README.md) · [原生续聊与回退](../validation/adversarial-review-resume/README.md)
- **Antigravity 1.5.13** 有真实主会话连续六轮从规范注入到交付的记录，也有真实执行者的 Worktree 隔离、Rex 同会话补报与 Pi 主会话续跑证据。[主会话与隔离](../validation/multi-host-main-session/README.md) · [执行者 Rex 验收](../.knit/tasks/archive/2026-11/11-22-antigravity-cli-live-acceptance/evidence.md)
- **WorkBuddy Desktop** 已在真实桌面窗口（`WorkBuddy.app`）完成信任工作区后的三钩子触发、分块增量去重、`PreToolUse` 会话绑定与原话交付授权验收；同时实测确认其桌面沙箱禁止后台派发外部 CLI（`Brokered program policy check unavailable`），已收口为纯 GUI 原生流程并在 `PreToolUse` 拒绝 `knit run start`。[真机验收记录](../validation/multi-host-main-session/README.md)
- **Qoder 0.5.20** 的项目配置范围、事件封包和转录字段依据本机应用的静态探针。安装脚本、钩子响应与授权过滤由隔离夹具验证，真实桌面窗口待验。[宿主协议回归](../test/host-hook.test.mjs)
