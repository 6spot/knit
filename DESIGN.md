# Knit：轻量 Pi 项目辅助层设计

初始记录日期：2026-10-31  
状态：设计草案，尚未实现。

Knit 为个人开发提供任务记录、项目规范、四环节协调、模型选择、提交归档和中断恢复。首版在当前项目目录执行，交付边界见第 15 节。Worktree 和扩展能力保留为后续设计。Agent 的工程协作要求见 `AGENTS.md`。

## 1. 定位与原则

Knit 首版通过 Pi 接入，以 Markdown 与 Git 保存长期事实，以本机运行资料和 Agent 原生 Session 保存执行关联。任务、Git 与运行协议由核心管理，主会话接入、Agent 执行与终端启动通过各自接口衔接。需求讨论、代码编写、代码检查、提交归档围绕同一项任务推进。

- 模型负责理解需求、判断范围、选择规范与解释结果。
- 程序负责身份、路径、引用、Git 操作、运行状态和结果校验。
- 任务资料保存当前结论和关键经过，执行 Session 保存对话与工具记录。
- 创建任务以用户授权为前提；明确要求创建即视为授权。子任务使用相同规则。
- 普通讨论和小修改可以直接完成，用户按需要选择是否建立正式任务。

### 1.1 依赖边界

| 组件 | 职责 |
| --- | --- |
| Pi 公共运行时／SDK | 首版主会话接入与默认 AgentRuntime |
| Git | 首版用于状态核对与提交；合入、分支及 Worktree 管理用于后续能力 |
| Knit 核心 | 任务、规范、阶段 worker、运行协议与恢复 |
| HostAdapter／AgentRuntime | 主会话能力与阶段 Agent 的平台适配 |
| SoL-Pi 等 Extensions | 可选的上下文、计划或其他会话辅助 |
| REX 等终端插件 | 后续可选的可见进程启动、窗口定位与展示 |

Pi、Knit、Git 和可用模型配置组成完整运行环境。Knit 通过自己的资料与公开接口完成核心流程；第三方扩展可以独立停用或更换。终端插件增强执行环境，任务身份、模型策略、检查结论和 Git 操作由核心管理。

## 2. 总体结构与权威信息

Knit 首版以 Pi package 安装，提供薄 Extension、阶段 worker 和确定性项目工具。平台入口通过 HostAdapter 调用核心，worker 通过 AgentRuntime 执行阶段。项目目录如下：

```text
AGENTS.md                         # 项目入口与协作规范
.knit/
  config.json                     # 项目配置
  workflow.md                     # 四环节职责与操作规则
  agents/
    implement.md                  # 通用实施角色指令
    check.md                      # 通用检查角色指令
    runtimes/<runtime-id>.md       # 按需增加的平台补充，如 pi.md、codex.md
  standards/
    index.md                      # 规范路径、简述与适用范围
    ...                           # 规范正文
  tasks/
    MM-DD-<slug>/
      task.md                     # 任务入口
      ...                         # 设计、研究等辅助资料
    archive/YYYY-MM/
      MM-DD-<slug>/
        task.md
        ...
  .runtime/                       # 本机运行、绑定与恢复资料，Git 忽略
    sessions/<knit-session-id>.json # 主／子 Session 的统一索引与原生定位
    bindings/<task-id>.json         # 任务位置和会话／运行引用
    runs/<run-id>/                 # 本目录执行的请求、注入清单与回执
```

任务目录直接位于 `tasks/` 下，归档目录按归档月份组织。配置、工作流、角色指令和规范由项目维护。平台补充文件按实际差异增加；辅助资料在形成独立阅读价值时增加，文件名按内容确定。首版目录只包含当前项目资料与本机运行记录；后续 Worktree 布局见第 6 节。

| 信息 | 权威位置 |
| --- | --- |
| 任务目标、完成条件、进展、关键结论与下一步 | 当前承载任务的目录中的 `task.md` |
| 项目规范与适用范围 | 规范正文和 `standards/index.md` |
| 主／子 Session 的身份、关系与原生定位 | 项目主目录 `.knit/.runtime/sessions/<knit-session-id>.json` |
| 会话原始对话与工具记录 | 对应客户端的原生 Session 记录 |
| 当前主 Session 选择的任务 | HostAdapter 的会话关联存储；Pi 使用自定义条目 |
| 任务的本机执行位置与阶段 Session 引用 | 项目主目录 `.knit/.runtime/bindings/<task-id>.json` |
| 阶段请求、状态与结果回执 | 执行目录 `.knit/.runtime/runs/<run-id>/` |
| 代码、分支与提交状态 | 文件系统与 Git |
| 任务列表与归档列表 | 从当前项目的任务目录派生；后续增加 Worktree 列表 |

Session 索引保存身份和关系，任务绑定保存执行位置，运行回执保存每次执行结果。正文中的业务事实以任务资料为准，执行结果以实际产物和验证为准。主 Session 与子 Session 均可从索引查询，历史原文由对应客户端读取。

## 3. 任务主文档与身份

### 3.1 最小元信息

`task.md` 使用简短 frontmatter 和可读正文。

| 字段 | 含义 |
| --- | --- |
| `id` | 带 `k-` 前缀的随机稳定身份，创建时检查冲突 |
| `status` | `open` 或 `closed`，表示任务是否仍需推进 |
| `outcome` | 结束时填写：`completed`、`cancelled` 或 `superseded` |

标题保存在 Markdown 一级标题。任务类型、优先级、负责人、日期等信息按实际需要增加。

`id` 在改名、迁移和归档后保持不变。关联保存身份与路径线索，路径失效时按身份核对。一个工作目录中出现多个同 ID 文件时报告歧义。后续 Worktree 支持按执行绑定区分同 ID 的当前资料和历史副本。

### 3.2 目录命名与归档

任务目录使用 `MM-DD-<slug>`，日期取创建时的本地月日。

```text
任务资料：.knit/tasks/11-01-fix-login/task.md
归档资料：.knit/tasks/archive/2026-11/11-01-fix-login/task.md
```

归档保留整个任务目录的名称和内容。外层 `YYYY-MM` 是归档月份，内层 `MM-DD` 是创建月日；跨月完成时两者分别保留各自含义。

创建时核对当前项目的任务目录。名称被其他任务占用时，为 slug 添加短序号，例如 `11-01-fix-login-2`。后续 Worktree 与工作分支命名见第 6.2 节。

任务后来改名时按稳定 ID 更新资料路径线索与绑定。归档目标已存在时按 ID 和操作回执区分断点恢复与其他任务占用；其他任务占用时停止归档并报告。

### 3.3 正文内容

| 内容 | 要求 |
| --- | --- |
| 目标与边界 | 说明目的、本次范围及相关依赖 |
| 完成条件 | 给出可观察、可核对的完成结果 |
| 当前位置 | 保存当前环节、可靠结果、阻塞和下一步 |
| 关键经过 | 保留影响后续判断的决定、发现与理由 |
| 结果与验证 | 记录交付、检查、未执行事项和待确认结果 |
| 相关引用 | 指向规范、代码、辅助资料、Session 和工作 Commit |

创建时保存标题、目标、当前位置和下一步。实施前补足完成条件及必要设计。简单任务使用短段落，条件较多时编号并关联验证证据。

当前状态随进展更新，关键经过保留有效理由。详细工具输出和逐轮尝试存于执行 Session。

### 3.4 规模控制

调查材料较多时，按阅读需要拆为任务目录内的辅助文档。子目标具备独立实施、验收和结束边界时，Agent 提出拆分并按任务创建规则取得授权。

### 3.5 当前目录执行与绑定

首版以初始化确认的当前项目根为执行目录，实施、检查、工作提交与归档均在该目录进行，使用当前分支。Knit 按阶段核实 cwd、仓库及任务身份；执行位置变化时停止并报告。

`.knit/.runtime/bindings/<task-id>.json` 保存协议版本、任务 ID、项目目录、实际任务路径、最近 run 引用及各阶段的 Knit Session ID，原子更新。任务路径优先相对项目根保存；客户端归属和原生定位由 Session 索引保存。主 Session 的任务选择独立于绑定。

换 Session 继续时按 ID 核实当前项目中的任务、绑定与旧 run；旧运行未确认结束前保持占用。绑定缺失时，从本项目任务与运行记录核对重建；指向其他目录或身份不明时报告阻塞并保留记录。后续跨目录绑定与交接见第 6 节。

## 4. 四环节轻量编排

| 环节 | 职责 | 阶段结果 |
| --- | --- | --- |
| 需求讨论 `discuss` | 澄清目标、范围、条件、规范与执行环境 | 可实施的任务内容，或明确的待决项 |
| 代码编写 `implement` | 实施变更，执行适当验证 | 变更范围、验证结果与待复核问题 |
| 代码检查 `check` | 独立核对要求、规范、实际内容与验证 | 通过、需修复或阻塞，附证据与位置 |
| 提交归档 `deliver` | 提交、按授权交付、整理记录和归档 | Commit、最终位置及遗留事项 |

流程为 `discuss → implement → check → deliver`。检查要求修复时回到实施，修复后重查；需求实质变化时回到讨论。阶段可以在同一轮连续完成，也可以跨 Session 延续。

讨论在目标清楚时简短完成。代码编写环节涵盖代码、测试、配置和文档。取消或被替代的任务记录结束原因与实际完成范围。

自动修复与重查默认最多两轮。仍有阻塞时保存发现、现状和需要解决的问题。阶段按已有授权衔接，新增取舍或授权边界由主 Agent 与用户处理。

执行细步骤保存在 Session，阶段结果和下一步写回任务。计划工具用于辅助展示，Knit 使用自身资料恢复流程。普通小修改同样覆盖四项职责，提交行为遵循用户授权。

## 5. 执行角色、检查与模型选择

### 5.1 主 Agent 与阶段执行器

主 Agent 负责用户沟通、任务意图、阶段协调、结果汇总和收尾。需求讨论默认在主会话完成。

实施和检查由 Knit worker 通过选定 AgentRuntime 创建或恢复独立 Session，首版使用 Pi SDK，cwd 指向任务执行目录。主 Session 与阶段 Session 均登记到统一索引；实施与检查分别保存引用，后续修复与重查优先恢复各自角色的会话。恢复使用记录中所属客户端的实现。检查者返回发现和证据，修复交回实施环节。worker 的职责限于受委派阶段；任务创建、递归委派、提交、合并、推送与环境清理由主 Agent 和确定性工具协调。

检查上下文包含目标、完成条件、适用规范、变更范围、实际文件和验证入口。实施报告作为待核对证据传入，检查以实际内容为依据。

检查角色默认提供读取和必要验证工具，省略 `write`／`edit`。shell 的可用性意味着仍可能发生写入，执行前后需比对相关代码；检查者改变代码时，该次结果重新判定。

### 5.2 模型选择

每次阶段启动按以下优先级确定最终模型：

1. 本次调用明确指定的模型。
2. 项目对该阶段配置的模型。
3. 阶段启动时主 Agent 当前实际使用的模型。

模型以 provider 和 model 标识传递，启动前由选定 AgentRuntime 检查可用性。跨平台使用模型标识时采用显式配置的映射；缺少映射、模型或鉴权时报告阻塞，保留用户选择。阶段请求与结果记录实际模型；创建和恢复 Session 均使用本次解析结果，后续阶段重新按上述规则解析。

指定讨论模型时，由独立上下文协助分析，主会话承担沟通与结论确认。收尾模型协助整理和复核，Git 操作由工具执行。凭据通过对应 AgentRuntime 支持的公开鉴权机制取得。

### 5.3 检查结论与有效范围

检查结论为 `pass`、`changes_requested` 或 `blocked`，附完成条件覆盖、发现、位置、验证和未执行事项。必要人工验收尚未完成时，结论保留该条件。

检查记录基线和范围内文件内容指纹，涵盖已暂存、未暂存及相关未跟踪文件。代码变化后重新判断覆盖范围；需求或规范的实质变化也触发范围判断。纯记录更新、提交和归档移动按其实际内容判断是否需要重查。

阻塞发现和一般建议分别列出。检查的可信度来自实际验证与证据，模型或上下文的独立性提供另一轮判断。

### 5.4 核心 worker 与执行宿主

```text
主会话 → HostAdapter → 核心：阶段、上下文、AgentRuntime、最终模型、cwd
                              ↓ 选择 ExecutionHost
                   内置 local             后续 REX 插件
                   后台子进程             可见终端中的子进程
                              ↓
                 同一个 Knit worker → AgentRuntime → 原生 Session
                              ↓
                    核心校验结构化结果并推进阶段
```

worker 随 Knit 安装，负责运行协议、事件输出、结果回执、取消与资源释放。ExecutionHost 负责启动、定位和呈现该进程，默认 local 由 Knit 直接启动。AgentRuntime 负责指令适配、模型与工具策略、原生 Session 和阶段执行。

内置 Pi AgentRuntime 调用 `createAgentSession()`，显式传入 model、cwd、tools、resourceLoader 和 sessionManager。可执行扩展加载集合默认空，额外资源由 Knit 明确指定；受控资源加载提供当前执行项目的规则、角色指令、规范和必要上下文。Knit 编排入口运行在父会话，首版由内置 local 启动 worker。

核心解析最终模型，worker 经 AgentRuntime 再核对。凭据留在对应公开鉴权渠道。首版使用 local 后台执行；后续可见模式输出模型文本、工具进度和结果摘要。需要用户决策时返回主会话处理。

### 5.5 插件协议（后续）

本节保留扩展协议设计。首版直接使用内置 Pi 与 local，不实现外部插件发现、加载与动态生命周期。

插件扩展点为 `execution.host` 和 `agent.runtime`，内置实现分别为 local 与 Pi。REX 通过前者接入，后续 Codex 运行实现通过后者接入。

| 部分 | 规范 |
| --- | --- |
| Manifest | 唯一 `id`、Knit 插件 `apiVersion: 1`、`provides`、可选配置描述及 `activate(ctx)` |
| 加载 | 加载用户显式启用且信任的已安装模块 |
| 注册 | `ctx.registerExecutionHost()`、`ctx.registerAgentRuntime()` 注册服务，`ctx.onDispose()` 登记清理 |
| 执行宿主接口 | `probe()` 检查能力，`launch()` 启动，`inspect()` 观察，按能力提供 `focus()` |
| 宿主启动输入 | run ID、worker 的绝对程序与 argv、cwd、必要环境和请求文件位置 |
| 宿主启动返回 | 绑定 run ID 的 handle，含插件 ID、协议版本及终端定位信息 |
| AgentRuntime 接口 | `probe()`、`prepareInstructions()`、`openSession()`、`readHistory()`、`run()`、`cancel()`、`dispose()` |
| 生命周期 | 激活、提供服务、停止接收新运行、清理；失败保存原因并回滚注册 |

核心领域代码与 worker 依赖公共接口，加载层按配置组装插件，ExecutionHost 所需的启动与结果服务由核心提供。运行请求记录选定 AgentRuntime 模块与版本；worker 只加载本次需要且已获信任的实现。插件程序随安装包提供，项目中的角色 Markdown 作为资料加载。模块在 `activate()` 中注册资源。重复插件／服务 ID、API 不兼容或激活失败时，撤销该次注册并报告原因；清理按逆序执行。

插件停用时进入 draining 状态，待存量运行终态核实、恢复资料收妥后撤销服务。正在使用的 AgentRuntime 保留到其 Session 和工具结束；进程意外丢失时先核实其原生子进程。运行结果与取消渠道使用核心协议，父进程退出或插件卸载后仍可查找。

插件在宿主权限下执行，能力声明用于接口校验。进程崩溃和同步阻塞仍受实际运行方式影响；错误回滚覆盖正常抛错与生命周期清理。

### 5.6 运行协议

每次执行使用新 `run-id`，资料位于执行目录的 `.knit/.runtime/runs/<run-id>/`。

| 文件 | 写入方 | 内容 |
| --- | --- | --- |
| `request.json` | 核心 | 协议版本、任务 ID、阶段、发起主 Session ID、所属客户端与 AgentRuntime 版本、上下文与统一注入计划、启动基线与原有改动清单、模型、cwd、工具策略、恢复策略及 Knit Session 引用 |
| `launch.json` | 核心 | 启动意图、ExecutionHost 与 handle |
| `instructions.json` | worker | 已落实的注入清单：来源 ID、作用域、指纹、注入途径、版本和原生产物位置 |
| `state.json` | worker | 实例身份、运行状态、Knit／原生 Session 引用和已知子进程定位 |
| `result.json` | worker | 终态、实际 AgentRuntime／模型／cwd、Session 引用与阶段报告 |
| `cancel.request` | 核心 | 取消请求，按需建立 |

未建正式任务的执行使用空任务 ID。原始工具记录引用对应客户端的原生 Session；平台生成的临时指令、配置与输出放在本 run 的 `native/` 下。worker 获得原生 Session 引用后立即写入状态，核心核实后登记 Session 索引并更新绑定；父会话失联时可从原 run 补齐索引。

首版同一项目的阶段执行与提交归档使用项目级占用，串行运行。核心先保存启动意图，通过本机原子占用认领项目、执行目录与已有 Session，再允许 worker 原子认领该 run。占用按统一的固定键序取得，贯穿执行与工具终止确认，覆盖 Knit 内的阶段和收尾操作。后续多目录交接或合入将所涉路径一并纳入占用集合。worker 状态与结果采用原子写入。

终态为 `completed`、`failed` 或 `cancelled`。worker 将阶段报告封装为 `result.json`，报告按下表校验。报告缺失或校验失败时记录 `failed` 与原因。`completed` 表示 worker 完成，阶段业务结论仍由报告与实际证据决定。核心再次校验协议、身份、请求对应关系及内容；窗口状态、屏幕文字和退出码作为辅助观察。

| 报告 | 最小字段与判定 |
| --- | --- |
| 通用 | `summary` 为文本，`validation`、`blockers` 为数组，可为空。每条验证记录方法、结果和证据，结果为 `pass`、`fail` 或 `not_run` |
| `discuss` | `ready` 为布尔值，表示任务是否可实施；为真时仍核实目标、完成条件与必要资料 |
| `implement` | `changedPaths` 为路径数组；核心结合启动基线核对实际差异 |
| `check` | `verdict` 为 `pass`、`changes_requested` 或 `blocked`，另有 `coverage`、`findings`、`unverified` 数组；通过需证据有效且没有未处理阻塞 |
| `deliver` | `commits`、`pending` 为数组，`archivePath` 为路径或空值；主 Agent 与确定性工具以实际 Git 和文件结果核实，遗留必需交付项时保持待收尾 |

主会话完成的讨论与收尾可直接登记同等阶段结果，按需启动 worker。检查通过仅对本次核对内容有效，实质变化后重新检查。

启动响应丢失时，按 run 和 handle 查找原运行。父会话退出、窗口关闭或心跳停止后，核对回执、实例和存活证据。状态未知时保留占用并调查，确认原运行终止后才允许重试。旧 PID 和旧状态标记需结合实例身份核实。

取消通过 `cancel.request` 发出，worker 调用公开取消接口，等待工具结束或确认中止后写入 `cancelled`。超时显示“取消待确认”，保留现场与占用。

任务运行或状态未明期间，核心阻止另一份阶段写入和提交归档。检查使用的 shell 同样纳入协调。本机占用的覆盖范围是 Knit 管理的执行。

首版保留 Session 索引、绑定与运行资料，任务归档后仍可查询和恢复；写回任务不触发自动清理。后续清理须先核对所有引用，保留恢复所需的请求、回执、注入清单与原生定位。绝对路径、终端 ID 和进程身份存于本机资料和 Session。

### 5.7 REX 终端插件（后续）

选择 REX 后，worker 在 REX session 内新建的可见终端窗口执行。REX window 对应 session 内的窗口／标签页。

1. `probe()` 核对 CLI、连接、继承的目标 session 与参数能力。身份失效时用 `rex whoami --json` 等查询核实目标，无法确定时返回阻塞。
2. 使用 `rex run --json --cwd … --label … --keep-open --shell=none -- <worker 程序与参数>`，明确传入目标 session。默认新窗口，配置分屏时指定 `--split` 及锚点。
3. 程序路径由 Knit 安装位置和当前 Node 运行时解析，启动 argv 包含 worker 入口、run ID 和请求文件位置。阶段请求通过文件交付，鉴权通过选定 AgentRuntime 的公开渠道取得；核对 REX 与父会话的环境差异，必要配置不足时报告阻塞。
4. 保存创建结果并补齐窗口／block 定位。标签包含任务／运行短 ID 与阶段，首次默认聚焦，配置可保留主窗口焦点；`--keep-open` 保留退出输出。
5. 核心从 worker 回执读取阶段结果。`--wait` 可辅助观察终端子进程退出码，handle 用于定位、观察与重连。

显式选择的 REX 不可用时报告原因和可选宿主，宿主切换由用户选择。断连或创建响应丢失后先查原运行，继续执行以原 run 的核实结果为前提。

### 5.8 主会话与 AgentRuntime 适配

| 接口 | 职责 | 首版实现 |
| --- | --- | --- |
| HostAdapter | 主会话身份、当前模型、任务选择的持久化、上下文提示与用户交互 | Pi Extension 与公开 Session API |
| AgentRuntime | 指令适配、模型与工具能力、创建／恢复 Session、执行、取消及标准化报告 | 内置 Pi SDK |
| ExecutionHost | 启动与定位 worker、显示输出、按能力聚焦 | 内置 local |

同一客户端的主会话入口与 AgentRuntime 共享稳定的客户端 ID。客户端标识、模型标识和 ExecutionHost 分别记录。任务、四环节、模型优先级、规范选择、Git、归档、运行协议与恢复决策由核心统一实现；平台适配负责调用各客户端公开接口。

HostAdapter 按平台入口安装，向核心提供主 Session 身份、当前模型和事件。主会话启动、恢复、Fork 或切换时登记或更新统一索引。Pi 的自定义条目与对话树由 Pi 接入处理；其他宿主使用其公开能力或 Knit Session 记录中的关联字段保存选择，并声明可用事件。

AgentRuntime 的 `probe()` 声明原生恢复、指令更新、模型选择、工具限制、历史读取、事件与取消能力。`prepareInstructions()` 是该执行上下文落实统一注入计划的唯一入口；`openSession()` 接收新建／恢复意图与索引引用；`readHistory()` 按需要读取并标准化历史片段；`run()` 输出进度并返回阶段报告。所需能力不足时报告具体阻塞。

原生引用包含所属客户端、原生 Session ID、必要定位信息和可用的分支／检查点，由该客户端的适配实现解释。Pi 记录交给 Pi 实现，Codex 记录交给 Codex 实现。恢复时按索引选择原客户端；当前主会话、项目默认或终端变化均保持该归属。原客户端未安装、未启用、未获信任或版本不兼容时报告阻塞并保留原记录。

后续接入 Codex 后，例如本次主会话运行在 Pi，已有检查 Session 属于 Codex，核心仍调 Codex AgentRuntime 恢复该检查，再将标准化结果交回 Pi 主会话。首版仅提供 Pi 实现，遇到其他客户端记录时保留引用并报告未支持。

Pi 通过 `SessionManager.open()` 打开指定记录后创建 AgentSession；Codex 接入使用其版本支持的指定 Session ID 恢复接口。主会话由原客户端的入口恢复，接入层核实并刷新关联；子会话由 worker 调用记录所属的 AgentRuntime 恢复。

切换 ExecutionHost 时复用同一 AgentRuntime 和 Session。用户明确切换客户端时，新客户端建立自己的 Session，核心关联新旧记录，并通过历史读取提供必要背景。主会话和子会话可使用不同客户端，每条 Session 保持自己的格式与归属。首版交付 Pi 接入和 Pi AgentRuntime，Codex 按上述接口接入。

## 6. Worktree（后续设计）

本章保留 Worktree 的完整设计与研究结论。首版不实现本章的创建、连接、枚举、交接、复制、初始化、迁移、修复或清理；首版执行与绑定按第 3.5 节处理。

### 6.1 任务资料交接

正式代码任务默认建议专用 Worktree，用户也可选择当前目录或已有 Worktree。同一任务有一个当前可写执行目录，实施和检查共用该目录。

任务可以先在主目录创建并讨论，准备实施时再建立执行环境。创建 Worktree 包含带入本任务未提交资料的交接：

1. 保存当前结论，确定源目录、任务 ID 和文件清单。清单包含相对路径、内容指纹及相对于源 Git 版本的删除项。自动额外交接范围为 `.knit/tasks/<任务目录>/` 中的主文档及辅助资料，包含最新工作区内容和未跟踪文件。公共资料和本机环境按第 6.7 节准备。
2. 从已提交基线创建 Worktree，将任务资料交接到对应路径，保留任务 ID。按完整清单核对当前文件和删除项；交接期间源内容变化时重新核对快照。
3. 通过 ID 定位目标中的同任务旧版本和旧路径。目标内容与相应基线一致时应用源版本、已确认的删除项和目录改名，使交接后任务资料只位于选定路径。目标存在不同的本地修改或来源不明的额外资料时保留两边内容并报告冲突，待核实后再交接。
4. 资料核对与第 6.7 节环境准备均成功后，持久更新任务绑定，再切换 Session 关联和后续写入目录，随后启动阶段 worker。
5. 准备与交接回执保存身份、源／目标、文件指纹和步骤结果。源资料在核对完成前保留；未跟踪的旧目录可转存到 `.knit/.runtime/transfers/` 恢复备份。已跟踪源文件及其暂存状态保持原样，作为迁出前副本等待整理。

主 Agent 可留在原会话，后续读写通过任务绑定指向 Worktree。每项任务交接自己的资料，后续迁换执行目录沿用这一流程。

### 6.2 创建与连接

默认 Worktree 路径为 `.knit/worktrees/MM-DD-<slug>/`，首次工作分支为 `knit/MM-DD-<slug>`。名称取首次创建执行环境时任务当前的目录名，日期保留任务创建月日。首次命名核对任务目录、计划路径和分支；被其他任务占用时给 slug 添加短序号，再按同一名称确定新环境。已有绑定的目录与分支保留实际名称，任务改名后按稳定 ID 定位。

全局备用路径为 `~/.knit/worktrees/<project-key>/MM-DD-<slug>/`，其中 `~` 是用户主目录，项目标识区分同名项目。用户选择全局位置或内部布局实际不可用时使用该位置，启动前报告最终路径和原因。已有目录与分支按实际名称连接。

- 路径以项目主目录为锚点，从任务 Worktree 继续时定位同一个容器。
- 创建前保证 `/.knit/worktrees/` 的 Git 忽略规则生效，保留现有规则。
- Knit 枚举排除 Worktree 容器；构建、搜索、格式化和监视工具按各自规则配置排除。
- worker 的项目上下文以目标 Worktree 根为边界，读取其中的入口、规则和配置，保留适用用户级规则。
- 创建／连接前核对仓库、基线、分支、路径与 Git 占用登记。目标已有内容或分支已占用时，先核实是否属于当前任务。

代码与公共项目资料从选定的已提交 HEAD 开始，任务资料按第 6.1 节交接。未提交代码依赖先明确归属与处理范围；公共资料、本机复制白名单与初始化命令按第 6.7 节准备。

### 6.3 使用期间的校验

阶段启动前核对 cwd、仓库、任务身份和预期分支，并核实已选定的规范、上下文引用与初始化依赖可用；缺失时列出阻塞项。创建时记录基线，后续允许 HEAD 随合法提交前进。

目录或分支异常时停止该目录的新写入，保存现状并调查。重连或更换环境以实际成果、绑定和运行状态核实为前提。

任务正文在当前执行目录维护。Session 选择独立，文件写入按任务与目录串行协调；并行工作使用各自任务／Worktree，子任务遵循创建授权。

### 6.4 交付与清理

默认保留 Worktree 和分支。清理需获得授权，并确认阶段已终止、成果已保存、提交可找回、修改及未跟踪／忽略资料已处理。

清理范围为 Knit 创建或明确接管的环境，使用普通 Git 删除流程。删除分支还需确认成果已合入目标，或用户明确授权丢弃。同一收尾请求已包含清理授权时，在条件满足后执行。

清理作为独立操作记录结果。清理前核对绑定、Session 索引、run 和原生记录的引用；仍依赖待删除目录的资料须先保全并核实可读，再更新定位。引用未收妥时保留目录。失败时报告保留的目录和分支，任务交付与归档按已成功步骤记录。

### 6.5 随项目移动

项目内布局使 Worktree 文件随项目目录一起移动。移动前确认活动运行终态，移动后核对 Git 管理路径、Session 路径和运行引用。

Git 支持且使用环境兼容时可采用 `--relative-paths`；该选项可能启用 `extensions.relativeWorktrees`，采用前需明确仓库兼容要求。常规关联失效时，核实新位置后用 `git worktree repair` 修复，再更新本机绑定。

全局 Worktree 仍保留在全局位置，项目移动后重新核实关联。重新 clone 恢复已提交内容，本机未提交成果与被忽略的工作目录通过原本机资料迁移。

### 6.6 持久关联与继续执行

项目主目录 `.knit/.runtime/bindings/<task-id>.json` 保存协议版本、任务 ID、仓库定位线索、实际 Worktree 路径、预期分支、创建基线、实际任务路径、最近运行引用及各阶段的 Knit Session ID。运行引用包含 run ID、原执行目录与回执位置；客户端归属、角色与原生定位由 Session 索引保存。项目内路径优先相对项目主目录保存，全局路径记录本机绝对位置。

绑定以稳定任务 ID 为键，表示任务在哪里继续。主 Session 的关联表示该会话选择了哪个任务。

1. 交接成功后，按任务串行、原子更新绑定。后续写入先核实当前绑定，阶段启动前保存 run 引用。
2. 用户继续任务时，核对目录存在、Git 登记与仓库归属、分支和任务 ID，读取最新任务正文、文件变化和验证结果。
3. 查询旧 run：仍在运行则重连／观察，已结束则整理回执，状态未知则调查。继续工作复用已核实的原 Worktree；需要继续同一阶段时按第 9.4 节优先恢复对应 Session，并建立新的 run。
4. 绑定缺失时枚举 `git worktree list --porcelain`，按任务 ID、分支、基线和交接线索核对。定位唯一时重建绑定，有歧义或目录缺失时报告并保留现场。
5. 改名、合入交接、归档和目录迁移时更新实际位置。结束任务后保留定位线索并结束活动执行；清除 Session 选择只影响该会话。

### 6.7 公共资料与环境准备

| 资料 | 来源与处理 |
| --- | --- |
| 项目入口、配置、工作流、角色指令、规范和忽略规则 | 已提交版本从选定 Git 基线检出；需要采用的本地差异按复制白名单准备 |
| 当前任务的最新资料 | 按第 6.1 节自动交接完整快照 |
| 明确选定的未提交公共资料与本机文件 | 按 `worktree.copy` 白名单复制，默认空 |
| 依赖安装、生成文件等环境步骤 | 在目标 Worktree 顺序执行 `worktree.postCreate`，默认空 |
| 本次 Agent 指令与原生适配产物 | 由 worker 在本 run 的 `.runtime` 目录生成 |

创建前生成准备计划，列出本次阶段需要的公共资料、所需版本及来源，并核对源工作区与基线的差异。基线缺少的必要资料和需要采用的本地差异，明确纳入本次复制白名单；基线与复制计划共同满足依赖后即可创建。也可按已有授权做限定范围的提交，建立后续可直接检出的公共基线；提交遵守第 10.2 节的路径与暂存保护规则。所需资料没有有效来源时报告阻塞。

复制白名单用于公共资料与本机环境，使用相对源项目根的路径，逐项保存来源、目标、基线指纹、源内容指纹与处理结果。复制前展开清单并核对目标均位于目标 Worktree 内；目标不存在或与检出基线一致时，按已确认清单应用源快照。符号链接、路径越界、目标本地变化或来源不明的已有内容触发停止与报告。`.env` 等本机资料只在明确列入时处理，复制保留源文件。任务资料按本任务交接，运行资料与 Worktree 容器通过各自定位管理。

顺序为：核对准备计划 → Git 创建 → 交接当前任务与白名单文件 → 执行初始化命令 → 核实依赖与指令输入 → 更新绑定并启动阶段。初始化步骤使用目标 cwd，记录每步结果；失败即停，保留目录、资料与已成功步骤。恢复时核对文件及步骤，可能有外部副作用的命令按实际状态决定是否重跑。

## 7. 记录更新与防漏

- 确认需求、范围或关键选择后，及时更新对应正文并保留必要理由。
- 实施前核对目标、完成条件、依赖和设计是否完整。
- 阶段结束、暂停或切换任务时，整理可靠结果、验证、阻塞与下一步。
- 探索结论形成后保存，假设标明待验证。
- 恢复时对照任务、实际文件、Git 与验证，再加载对应执行 Session 继续。

主 Agent 负责协调任务正文写入，worker 默认读取任务资料并返回报告。原主会话继续讨论时，新结论写入绑定指向的权威任务文件；首版位于当前项目目录。

需求、范围、完成条件或关键约束实质变化时，主 Agent 判断旧 run 与检查的有效性。需要改变执行内容时请求取消旧 run，确认工具终态后使用新上下文继续。普通措辞和进度整理按实际影响处理。

Extension 在阶段边界提示保存、检查引用与执行有限机械校验。正文记录按进展写入工作区，Git 提交按交付规则执行。语义完整性由 Agent 结合需求和证据判断。

## 8. 规范、冲突与例外

规范由三层组成：项目入口、语义索引、按需正文。入口提供工作流与规范位置，索引说明每份规则的范围和用途，Agent 按任务加载实际相关内容。

实施和检查前确认适用规范。规范引用包含路径与适用理由，任务例外记录范围、理由及授权依据。通用规则变更作为项目级变更处理。

规则冲突时结合宿主指令层级、项目要求和任务授权说明取舍；无法判断时报告具体冲突。相关规范实质变化后，重新判断方案与检查覆盖范围。引用失效由程序提示，内容是否充分读取与采用由 Agent 核实。

### 8.1 角色指令与平台注入

阶段输入由核心提供的职责与操作约束、`.knit/workflow.md`、通用角色文件、可选平台补充、当前任务与规范引用组成。实施和检查分别使用 `.knit/agents/implement.md` 与 `check.md`；讨论与收尾使用随 Knit 发布的阶段指令，项目按需提供同名角色文件。

`.knit/agents/runtimes/<runtime-id>.md` 保存平台特有的工具用法、输出约定等补充。每个上下文只选择自己的阶段角色、所属客户端补充和相关任务／规范；辅助资料按需读取。任务、四环节和 Git 规则来自核心与公共项目资料。输入冲突按宿主指令层级与任务授权处理，额外载入资料遵守本次工具和资源策略。

核心生成统一注入计划，每项包含稳定来源 ID、内容指纹、作用域、优先级与更新版本。角色、工作流、规范选择和任务上下文由核心确定；客户端适配只处理原生接口、参数、文件格式与加载方式。

每个执行上下文由对应客户端适配负责落实一次注入计划：主会话由 HostAdapter 接入，子会话由 AgentRuntime 的 `prepareInstructions()` 接入。两者使用相同的来源标识与去重规则。每项选择原生自动加载、显式指令参数或受控资源加载中的一种途径；原生已加载的内容在清单中标明来源，显式渲染只处理尚未覆盖的项。引用清单与实际加载结果分别记录。

主会话的生效清单随 Session 索引登记，子会话的 `instructions.json` 保存实际途径、指纹与版本并由索引引用。Pi 使用受控系统提示与资源加载；后续平台使用其公开指令入口。子会话临时原生文件放入本 run 的 `native/`，已有 `AGENTS.md` 与平台配置按项目资料维护。适配层核对所需指令的加载覆盖及资源范围；阶段使用当前执行项目的规则与适用用户级规则。

恢复时比较上次已生效清单与当前计划。仍被原生会话保留且未变化的项保持一次；变化项使用客户端支持的更新方式明确生效。历史消息与报告标为背景资料，当前职责、模型与工具策略由本次计划确定。客户端无法落实必要更新或无法确认所需指令已生效时报告阻塞。

## 9. 主会话、Session 与上下文集成

### 9.1 Pi 主会话任务关联

Pi HostAdapter 用自定义 Session 条目保存选择、清除和相关执行引用。恢复沿当前 `getBranch()` 路径读取最近一条关联，再核实身份、绑定与实际文件。

明确清除或最近关联失效时，状态分别为未选择或需修复。用户重新选择后建立新的关联。

持久化条目与模型上下文分别处理：元数据用 `appendEntry()` 保存，模型收到的是当前任务位置、下一步及必要提示。

### 9.2 Pi 会话与分支行为

| 事件 | 行为 |
| --- | --- |
| 恢复原 Session | 核实持久绑定，读取原执行目录的最新任务 |
| 新 Session | 用户指定任务后按 ID 定位并关联 |
| Fork | 继承分叉点的选择，后续各自选择，目录写入仍受串行协调 |
| 切换对话树 | 沿该路径恢复关联，磁盘和 Git 保持实际状态 |
| 切换 Git 分支 | 重新校验关联与上下文 |
| 任务改名 | 按 ID 更新资料路径与绑定，保留该 Session 的任务选择 |
| 任务归档 | 更新归档位置并结束该任务的活动关联 |
| Session 删除 | 通过任务资料、绑定和 Git 重新选择 |

### 9.3 运行状态与持久化

任务保存当前环节、阶段结果、下一步和关键 Session／run 引用；绑定保存执行位置、阶段 Session ID 与最近运行引用；统一 Session 索引保存主／子会话的归属、关系与原生定位。恢复时核实这些记录与实际文件，旧路径按定位线索核对。

执行细步骤和工具记录留在各客户端的原生 Session。运行请求、注入清单、回执和操作记录按恢复需求保留，Session 索引随实际状态更新可用性。

### 9.4 阶段 Session 恢复

默认 `agent.resume: "prefer"`。同一任务和阶段有可用 Session 引用时，按其记录所属的 AgentRuntime 优先恢复；首次进入阶段时才按调用与项目配置选择客户端。每次执行使用新 run ID，旧 run 的终态与回执保持原样。

1. 按绑定和 Session 索引找到原执行目录、旧 run 与原生记录，核实客户端、仓库、任务、会话种类、角色和运行实例。旧 run 仍存活时观察，状态未知时调查并保留占用。
2. 确认旧 worker 及其工具已终止后，按第 5.6 节取得占用并再次核实状态，检查记录可读性、客户端可用性、适配版本和 cwd 兼容性。
3. 由记录所属的 AgentRuntime 加载指定原生 Session。原操作系统进程已经结束时，恢复对象是其持久化会话记录；重新解析本次模型与工具策略，核对最新任务、文件和注入清单，落实恢复上下文。
4. 会话中的历史计划、工具调用与检查结论按当前现场重新判断。未完成的工具副作用先核实，再决定下一步。
5. 客户端缺失、身份不匹配、记录损坏或原生恢复失败时，保留原引用与失败原因并报告。明确重新开始时在已核实的执行目录创建新 Session；明确切换客户端按第 5.8 节处理，首版仅支持 Pi。

实施修复复用实施 Session，独立重查复用检查 Session；检查请求带入当前内容指纹与待核对范围。任务目录改名只更新资料定位。后续更换执行目录或终端展示方式时，仍需核实原生引用、cwd 与资源边界。

### 9.5 统一 Session 索引

主会话和子会话在项目主目录 `.knit/.runtime/sessions/<knit-session-id>.json` 登记。核心以所属客户端、原生 ID 和必要实例定位匹配已有记录；首次登记生成稳定 Knit Session ID。记录包含：

| 字段组 | 内容 |
| --- | --- |
| 身份 | 协议版本、Knit Session ID、所属客户端、适配版本、原生 ID 与定位 |
| 职责与关系 | 主／子会话种类、阶段角色、父 Session ID，以及 Fork／明确切换产生的来源引用 |
| 工作关联 | 参与任务 ID、run 引用、原 cwd、可用分支／检查点与注入清单引用 |
| 可用性 | 最近核实时间、原生记录是否可读取、关联运行的已知状态与缺失原因 |

主会话由 HostAdapter 在会话事件时登记。新子会话在启动前分配 Knit Session ID，并登记客户端、角色和创建它的主 Session；worker 取得原生引用后写入状态，核心核实并补齐索引。记录统一原子更新，失联后可按回执补齐。父 Session 表示创建来源，每次 run 另记本次发起的主 Session，恢复保留原有来源关系。索引保存定位、关联与注入清单，原生对话和工具历史保存在对应客户端记录中。

Session 查询可按任务、客户端、主／子类型和父子关系定位，再读取对应阶段报告或指定历史片段。原生文件缺失、客户端卸载或项目迁移后保留索引并显示待核实原因。索引缺失时，通过当前客户端身份、任务引用和原 run 回执核实重建。

## 10. 提交、交付与归档

### 10.1 策略与授权

正式任务完成流程包含工作提交和归档提交，执行遵循用户已有授权及“暂不提交”等明确约束。首版交付方式为 `local`，在当前项目、当前分支提交并归档。报告分别说明已提交、已归档及待处理事项。

后续增加项目可配置的 `merge` 交付，使用 `delivery.target` 或本次指定的本地目标，缺少目标时报告阻塞。合入遵守已有授权及明确约束；推送、PR、发布和部署分别取得对应授权。完成条件要求首版尚不支持的交付操作时，明确报告待人工完成，不将其标为已交付。

### 10.2 工作提交

检查有效且完成条件满足后整理工作提交，内容包括代码／文档成果和必要任务记录。按有意义的工作边界形成 Commit。

1. 列出候选任务路径，结合任务开始时已有改动确认归属。
2. 核对同文件混合修改，范围无法可靠区分时先整理或明确归属。
3. 使用限定路径提交，程序检查实际 Commit 范围，并保持其他路径的暂存与工作区状态。
4. Hook 失败或其他进程改变内容时保存现状，核对检查有效性后继续。

自动提交使用明确路径集合。暂存整理保留用户现场；stash、reset、amend、rebase 或历史改写需要对应的明确操作意图。

### 10.3 交付顺序与冲突

`local`：工作提交 → 整理最终结果 → 在当前项目归档 → 归档提交 → 报告当前分支与目录。

后续 `merge`：工作提交 → 核对源与目标目录、取得目录占用 → 核对目标 index 清洁并执行已授权合入 → 验证整合结果 → 转交任务资料与绑定 → 在目标目录归档 → 归档提交。

以下为后续合入的冲突处理规则。

目标目录存在运行中的阶段或状态未明的占用时，先核实其终态。目标 index 已有暂存内容时，保留该内容并报告待处理，处理后再合入。

只交接本任务资料、持续维护一个任务正文位置，可以减少记录分叉。合入前核对以下情况：

- 同路径未跟踪草稿可能阻挡 Git 覆盖。核对交接回执后，原稿可转存恢复备份；含新增内容时先保存并判断归属。
- 已跟踪文件或 index 存在其他修改时，保留现场并明确范围。双方分别提交同文件的不同内容时按实际冲突处理。
- 代码、规范、配置和忽略规则的分支变化按双方差异及任务要求核对。解决冲突后重新判断检查覆盖；语义取舍不明确时保存现场并请求必要决策。

全局选择 ours／theirs、删除挡路文件或还原用户修改不能代替冲突判断。合入失败保留源 Worktree 和提交；已经成功的合入由操作结果识别，后续从归档等剩余步骤继续。

### 10.4 归档提交

整理结果、验证、遗留事项和实际工作 Commit，设置结束状态与 outcome，将整个任务目录移到 `.knit/tasks/archive/<归档年-月>/<原任务目录名>/`。

首次归档记录任务 ID、源路径、目标路径和归档月份。跨月重试沿用该操作目标。移动与归档提交分别记录结果；后续环境清理另记独立结果。移动后提交失败时显示“已移动、待提交”，按 ID 和回执继续。

归档提交范围为本任务源／目标路径及实际相关引用。归档文档保存工作 Commit，归档 Commit 哈希由 Session 操作结果和最终报告提供。

任务可按完成、取消或被替代归档。暂停保留活动任务及执行绑定。没有代码工作提交时记录实际情况。

## 11. 失败与中断恢复

| 情况 | 处理 |
| --- | --- |
| 讨论尚未形成方案 | 读取已保存结论和待决项继续 |
| 换 Session 继续任务 | 按 ID 查绑定，核实当前项目、执行目录与旧 run |
| 绑定缺失或路径异常 | 用本项目任务身份与运行记录核对；涉及其他目录时保留记录并阻塞 |
| 原主会话继续讨论 | 更新绑定目录的任务，判断旧执行／检查有效性 |
| 阶段中断或取消 | 核对回执、实例、文件变化与遗留进程，终态确认后优先恢复阶段 Session |
| 原 worker 已退出，原生 Session 有效 | 由记录所属的 AgentRuntime 加载指定会话，校验当前模型、注入清单、cwd 与工具策略 |
| 恢复时当前客户端或项目默认变化 | 按旧 Session 的客户端归属恢复；客户端不可用时报告阻塞 |
| 原生 Session 明确不可恢复 | 报告原因并保留旧引用，明确新建时在核实后的执行目录建立会话 |
| 后续 REX 断连或启动响应丢失 | 查找原 run 与 handle，核实后重连或结束处理 |
| 后续插件停用或卸载 | 用核心运行资料读取结果和请求取消，后续选择可用宿主 |
| 实施完成、检查未完成 | 从检查继续 |
| 检查后代码变化 | 判断并补充检查范围 |
| 工作提交失败 | 保留修改与暂存状态，处理原因后重试 |
| 已提交、记录落后 | 核对基线、Commit 和文件后补记录 |
| 后续合入成功、归档未完成 | 连接目标位置，继续归档 |
| 归档已移动、提交失败 | 按回执定位并完成归档提交 |
| 后续归档成功、清理失败 | 报告成果与保留环境，单独处理清理 |

收尾操作记录轻量操作 ID、预期状态和结果。每次恢复核实实际产物；重试前确认旧阶段及 Git 操作状态，按已完成步骤继续。

## 12. 列表与资料维护

首版列表只采集当前项目。未归档列表枚举 `.knit/tasks/` 直接子目录的 `task.md`，归档列表枚举 `.knit/tasks/archive/YYYY-MM/<任务目录>/task.md`。目录位置表示归档状态，正文 `status` 表示是否仍需推进；未归档区域中的 `closed` 任务显示待收尾，归档区域中的异常状态显示待核实。

后续 Worktree 列表按 Git 登记与绑定采集各执行目录，区分同 ID 的当前资料和历史副本；不可达绑定保留条目并标明待修复。

Session 列表从第 9.5 节统一索引查询主／子会话、客户端、任务、父子关系和 run，历史内容经对应适配读取。不可读取的原生记录保留条目和原因。首版直接读取文件，索引和运行资料按第 5.6 节保留；后续按性能需要增加可重建缓存。规范索引包含语义描述，按规范变化维护。

任务内容增长时整理当前状态、合并过期描述，并按阅读需要拆出辅助材料。

## 13. 配置

以下 AgentRuntime 优先级用于新建 Session。恢复已有 Session 时按第 9.4 节读取其所属客户端；默认配置变化保持旧记录的归属。

首版项目覆盖项保存在 `.knit/config.json`。

| 配置 | 默认值／行为 |
| --- | --- |
| `agent.runtime`／`phases.<phase>.runtime` | `pi`；调用选择优先，其次阶段配置，再其次项目默认。首版仅支持 Pi |
| `phases.<phase>.model` | 未配置时使用阶段启动时主 Agent 的当前模型，包含 provider 与 model 标识 |
| `agent.resume` | `prefer`；本次可明确选择 `new` |
| `execution.host` | `local`；首版仅支持内置后台执行 |
| `delivery.mode` | `local`；在当前项目、当前分支提交归档 |
| 自动修复重查上限 | 两轮 |

```json
{
  "agent": { "runtime": "pi", "resume": "prefer" },
  "execution": { "host": "local" },
  "delivery": { "mode": "local" }
}
```

项目阶段配置保存在 `phases.implement`、`phases.check` 等条目。项目命令和验证方式从现有说明读取，必要覆盖项写入配置。

后续增加外部插件与 REX 配置、其他客户端、Worktree 执行环境及根目录、`worktree.copy`、`worktree.postCreate`、`delivery.mode: "merge"` 与 `delivery.target`。首版对这些未支持的配置或调用选择报告原因，保持当前任务和执行位置，不静默忽略或替换。后续 Worktree 配置语义见第 6 节，合入规则见第 10 节。

## 14. 接入已有项目

初始化识别仓库、当前主会话入口、`AGENTS.md`、已有平台资料、规范和验证方式。保留现有内容，增加 Knit 短入口；规范索引可以引用原位置。

建立项目配置、工作流、实施／检查角色模板和规范索引，任务与规范正文按实际需求增加。首版接入 Pi，维护 `/.knit/.runtime/` 忽略规则；保留当前项目结构和分支，不创建额外执行目录。后续启用 Worktree 时按第 6 节准备布局、公共资料与忽略规则，终端插件按第 5 节安装启用。

后续迁入旧框架资料时，先明确来源、任务身份、引用和执行位置映射，再完成资料与关联交接。

## 15. 交付范围

### 15.1 首版闭环

首版使用 Pi 与内置 local，在当前项目、当前分支原地执行；同一项目的阶段与收尾串行运行。

1. 按授权创建任务，维护单主文档、稳定身份、当前状态与结束结果。
2. 读取规范索引和相关正文，向当前角色提供必要指令。
3. 通过 Pi 主会话协调讨论、实施、独立检查和提交归档；按既定优先级选择模型，检查失败按上限修复重查。
4. 使用内置 Pi worker，记录主／子 Session、任务绑定与 run；支持取消、中断核实和 Pi 原生记录恢复。
5. 在当前项目做限定路径工作提交与归档提交，保留无关修改及暂存；中断后按实际结果继续。
6. 查询当前项目任务、归档与主／子 Session。运行资料保留，归档不删除恢复引用。

先以一个任务走通上述流程并完成第 16.1 节验收，再增加后续能力。首版依赖 Pi、Git 和可用模型；SoL-Pi、计划工具及其他扩展可独立停用。

### 15.2 后续能力

- Worktree 的全部实现：创建、连接、枚举、分支管理、任务资料交接、公共资料复制、初始化、迁移、修复与清理。
- 外部插件加载与生命周期、REX 可见执行、其他 AgentRuntime 与主会话客户端接入。
- 自动合入与跨目录交付，多任务并行调度。
- 跨执行目录恢复、旧框架资料迁入、自动清理及资料迁存、列表性能缓存。

这些能力保留接口与设计。首版直接调用内置 Pi 与 local，接口用于划分职责；多后端注册与通用能力协商随扩展实现。研究结论不自动增加首版交付项；首版不为后续能力执行探测、生成配置或建立占位资源。

## 16. 验收与验证记录

### 16.1 首版验收

| 场景 | 预期结果 |
| --- | --- |
| 单任务闭环 | 在当前项目、当前分支完成讨论、实施、独立检查、提交归档；无 Worktree 探测或操作 |
| 任务授权、改名与归档占用 | 按授权创建，稳定 ID 与路径一致；名称冲突、跨年和跨月重试保留正确记录 |
| 角色、规范和指令 | 只加载相关内容，主／子会话与角色范围正确；原生加载和显式注入去重，恢复时更新变化项 |
| 模型选择与依赖 | 三层优先级生效；模型不可用或要求后续能力时明确阻塞，停用其他扩展后仍能完成 |
| 独立检查与修复 | 报告字段有效，结论有证据；内容变化使旧检查重新判断，修复与重查分别使用对应 Session |
| 进程与阶段报告 | 核实实际模型、cwd 和工具策略；报告缺失或无效时失败，退出码不替代业务结论 |
| Pi 会话恢复 | 旧运行终止后先占用再加载原生记录，历史可读；失败保留引用，明确新建后继续；其他客户端记录不交 Pi 恢复 |
| 主／子 Session 与绑定查询 | 可按任务、角色、父子关系、客户端和 run 定位；绑定缺失可核实重建，其他目录绑定明确阻塞 |
| 原主会话继续讨论 | 结论写当前项目权威文件，实质变化影响旧执行与检查 |
| 串行、取消与启动丢响应 | 查明旧 run，未确认工具终止前保留占用，不重复启动或开始收尾 |
| 用户已有修改与暂存 | 根据启动基线核对归属，限定路径提交；混合改动无法区分时阻塞，保留其他现场 |
| 提交或归档中断 | 按 ID、Git 和操作回执识别已成功步骤；保留首次归档月份和目标，避免重复提交 |
| 归档与恢复资料 | 归档后仍能查询 Session 与 run，运行资料不自动清理，引用不因任务结束而失效 |

### 16.2 已完成的设计实验

独立临时 Git 仓库验证了：限定路径的工作提交与归档移动提交保留其他路径的暂存内容；Git 新 Worktree 从已提交基线开始；普通删除在存在未跟踪工作时拒绝。

本机 Git 2.54.0 验证了项目内 Worktree 与忽略规则。常规关联整体移动后可用 `git worktree repair` 恢复；`--relative-paths` 样例移动后仍可用，同时启用了 `extensions.relativeWorktrees`。

合入实验覆盖：单一任务记录写入方与独立路径变化可合入；未跟踪草稿阻挡覆盖并保留原稿；双方不同内容新增同路径产生 add/add 冲突。

补充实验确认，未提交的项目 `.knit/config.json` 留在主目录，新 Worktree 中缺少该文件。目标有无关暂存内容时，快进合入可保留暂存并成功，而产生合并提交的实验被 Git 拒绝；目标 index 清洁作为 Knit 合入前置条件。

这些实验覆盖 Git 行为。Knit 的公共资料准备、唯一注入、统一 Session 索引、按客户端归属恢复、模型透传、资源隔离、绑定恢复、并发占用、插件生命周期和取消流程待实现验收。限定路径提交仍需验证同文件分块、Hook 副作用和并发 index。REX 能力核查使用只读 CLI 与文档，完整终端集成待实现验证。

### 16.3 后续能力验收

| 范围 | 专项场景 |
| --- | --- |
| Worktree 与交接 | 基线、命名占用、任务完整快照、未提交资料、删除与改名、来源变化、目标冲突和交接中断 |
| 公共资料与初始化 | 明确白名单、路径和指纹、部分失败、步骤顺序与副作用核实；全部成功后才启动阶段 |
| 多目录与迁移 | 仓库登记、跨目录列表、规则隔离、整体移动和关联修复；失效绑定保留条目 |
| 跨客户端与展示宿主 | 归属不随配置变化，原生恢复由所属实现处理；历史读取、模型映射、cwd 兼容和切换关联可核对 |
| 插件与 REX | 激活失败回滚、draining、取消、断连、卸载与终端呈现；业务结果仍以核心回执为准 |
| 合入与清理 | 目标占用与 index、草稿阻挡、真实冲突、合入后归档重试；清理前保全 Session 与 run 引用 |

## 17. 研究依据与取舍

首轮研究记录日期为 2026-10-31，Magpie 与 REX 在后续补充核查。下文分别记录固定快照中的源码能力、模型工作约定和 Knit 的选择。

### 17.1 研究快照

| 项目 | 固定提交 | 研究版本 |
| --- | --- | --- |
| Trellis | `f089cb3286071199e84118dee86b6d76aab032f1` | CLI 0.6.17 |
| Agent OS | `e892e61d322759165e7d9173e92c1010406c9f4d` | 配置 3.0，v3 系列 |
| Spec Kit | `7370e592f3cd9c06e5b698983957e227c75b30e2` | 1.2.6.dev0，研究时 Release v1.2.5 |
| GSD Core | `1ec5c812b79dc1cc487d0873d18b03449b11c106` | 默认 next，1.19.0 |
| 本机 Pi | 安装版 | 1.4.0 |
| 本机 SoL-Pi | `219568034fa5` | package.json 0.1.1 |
| Magpie | `3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258` | main；提交时间 2026-11-01T00:07:57+08:00 |
| 本机 REX CLI | 安装版与官方文档 | 按本机帮助核查 |
| 本机 Codex CLI | 安装版 | 0.166.0；核查 `exec resume --help` |
| Codex App 与指令文档 | 在线官方文档 | 按页面描述区分 App、CLI 与指令加载 |
| VS Code | `2c33b50b16c472efe58357d1d2a8a5414bc23fbf` | 1.144.0；复制与软链接设置仍标为 experimental |
| VS Code Copilot Chat | `8b43cd385bcfdc01aef5604434d2bbff73c66a5b` | v0.43.0；独立会话入口对照 |
| OpenCode | `810c0eba1a7348036f8bdf61e6632d0c36c6876c` | v1.19.5；区分 Worktree 服务与 project-copy 入口 |
| Vibe Kanban | `4deb7eca8f381f7cbc1f9d15515a9ab8f8009053` | v0.1.44-20260424091429 |
| Worktrunk | `e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38` | v0.81.0 |
| Claude Squad | `ce1ffb4392b01f38e2c4599c7c84d2a93973b138` | v1.0.20 |

### 17.2 Trellis

Trellis 提供显式任务、Session 关联、引用清单、记录脚本和 Worktree 配置。Knit 采用任务身份、即时需求写回、实施／检查分工、可读目录名和整目录归档。

- 创建确认、每次需求澄清后更新 PRD 属于工作流指令。初始 PRD 模板简短，程序元信息主要存于 `task.json`。
- `implement.jsonl`／`check.jsonl` 保存文件与理由。实际读取与理解仍由 Agent 完成。
- 当前任务存于 `.runtime/sessions/<context-key>.json`，Pi Extension 提供上下文关联；`finish` 负责清关联。
- Journal 脚本具备指纹、幂等和索引修复，历史检索提供补充线索；语义漏记由 Agent 核对。
- 检查角色允许直接修复；Knit 将修复交回实施，随后重新检查。
- `safe_archive_paths_to_add` 包含 archive 根目录；Knit 的归档提交按单任务源／目标路径限定。
- 日期 helper 生成 `MM-DD`，归档按当前 `YYYY-MM` 分组并保留目录名。Worktree 配置提供目录、复制清单和初始化命令。

依据：[工作流](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/workflow.md)、[任务实现](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/task_store.py)、[命名前缀](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/paths.py)、[归档路径](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/task_utils.py)、[Pi Extension](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/pi/extensions/trellis/index.ts.txt)、[提交 helper](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/safe_commit.py)、[收尾流程](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/common/commands/finish-work.md)、[Worktree 配置](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/markdown/worktree.yaml.txt)。

### 17.3 Agent OS v3

v3 将执行与编排交回 Agent。发现、索引和注入主要由命令文档指导模型完成。`shape-spec` 要求保存讨论成果，`shape.md` 包含问题、范围、决定与上下文。

Knit 采用短规范索引、语义选择、按需读取和实施前保存讨论结论。规范正文由项目维护，任务保存引用、适用理由和例外。

依据：[变更记录](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/CHANGELOG.md)、[规范索引](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/index-standards.md)、[注入](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/inject-standards.md)、[需求塑形](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/shape-spec.md)。

### 17.4 Spec Kit

Spec Kit 通过 Constitution、Spec、Plan、Tasks 关联要求与实施。澄清工作流增量保存已接受答案，converge 对照实现差距；一致性分析依赖模型判断，验证仍需实际证据。

本快照的核心 Feature 定位支持 `SPECIFY_FEATURE` 与目录发现，Git 分支检测位于可选扩展，核心创建脚本提供资料创建。Knit 采用显式身份与绑定，并保留完成条件、需求／验证关联和规范变化后的覆盖判断。

依据：[Spec 模板](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/spec-template.md)、[澄清](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/clarify.md)、[一致性分析](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/analyze.md)、[差距检查](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/converge.md)、[规范修订](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/constitution.md)、[定位实现](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/scripts/bash/common.sh)。

### 17.5 GSD Core

GSD 的 STATE 保存紧凑摘要，执行与暂停工作流要求整理进展，状态命令维护字段。Worktree 流程包含基线、目录、分支和恢复校验。

Knit 采用当前位置、关键决定、阻塞、下一步、完成证据和分步恢复。GSD 的 Pi／sandbox storage seam 作为适配设计参考，实际存储与兼容情况按对应实现核查。

依据：[状态模板](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/templates/state.md)、[执行](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/execute-plan.md)、[暂停](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/pause-work.md)、[恢复](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/resume-project.md)、[分支校验](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/references/worktree-branch-check.md)、[恢复政策](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md)、[创建环境](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/new-workspace.md)。

### 17.6 Pi 与 SoL-Pi

Pi 提供项目上下文、Skills、模板、Session 树、自定义条目和扩展接口。项目上下文按 cwd 与祖先链加载，Skill 正文按需读取。Knit 使用受控资源加载实现目标 Worktree 的上下文边界。

`getBranch()` 表示当前叶节点的祖先路径，`getEntries()` 表示整棵树。`appendEntry()` 负责持久化条目，上下文注入另行处理。Session 开始通过 `session_start` 区分 startup、reload、new、resume、fork，对话树切换通过 `session_tree` 处理。

`createAgentSession()` 公开选项支持 cwd、model、tools、resourceLoader、sessionManager；AgentSession 提供 subscribe、prompt、abort 和 dispose。模型解析与资源范围由 Knit 显式传入。

SoL-Pi 使用 `sol-pi-online-context-state-v1`、`appendEntry()` 和当前分支恢复计划。Knit 借鉴公共 API 的使用方式，维护自身状态。SoL-Pi 测试矩阵的范围按其兼容文档理解，本机 Pi 1.4.0 的兼容性仍需相应执行验证。

核查位置：Pi 1.4.0 的 README、docs、`dist/core/{resource-loader,session-manager,sdk,agent-session}` 和 subagent 示例；SoL-Pi `219568034fa5` 的 README、配置／兼容文档及 online-context-compact 源码。

### 17.7 Magpie

固定快照包含 Go 内置功能插件运行时和外部 JS 插件宿主，两者有各自的注册、运行和权限边界。

| 机制 | Knit 采用方式 |
| --- | --- |
| Manifest、宿主 API 范围、Requires／Provides | ID、API 版本与执行宿主能力声明 |
| runtime 依赖服务，插件通过公共接口连接 | 核心接口与加载层分离 |
| Ctx 注册、OnDispose、失败回滚与逆序清理 | 可撤销注册与明确生命周期 |
| API 兼容检查与状态原因 | `apiVersion: 1` 校验及可见错误 |
| 默认启用、InUse 保持功能 | 显式启用，存量运行进入 draining |

页面插件的 iframe、来源校验和权限桥属于页面扩展点。Knit 的终端插件按受信本地模块执行，运行结果由统一 worker 协议交付。

依据：[运行时](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/pluginrt.go)、[运行时测试](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/pluginrt_test.go)、[配置](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/config.go)、[架构文档](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/docs/subsystems/plugin-runtime.md)、[外部宿主](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/plugin/host.go)。核查覆盖源码、文档和测试内容，Magpie 测试套件未执行。

### 17.8 REX

核查覆盖 rex 技能、`rex __internal skill`、`rex whoami --json`、CLI 帮助和官方文档。当前 `run` 默认创建新窗口，支持 session／window 定位、split、cwd、label、focus、keep-open、shell=none、json 和 wait。

CLI 创建结果、终端状态和程序状态提供定位与观察能力。Knit 通过自己的回执与取消协议判断阶段结果和工具终态。

### 17.9 公共资料、会话恢复与跨 Agent 接入

下表中的 Worktree 准备与跨客户端接入用于后续设计；首版 Pi 会话恢复按第 9 节实现，范围以第 15 节为准。

| 来源 | 核查到的做法 | Knit 采用方式 |
| --- | --- | --- |
| Trellis Worktree 配置模板 | `copy` 明列资料，`post_create` 顺序初始化并在失败时停止 | 本机白名单与初始化步骤独立配置 |
| GSD quick Worktree 工作流 | 指令要求根据 `commit_docs`，在派发前暂存并提交 PLAN／CONTEXT／RESEARCH 等资料 | 公共资料提交可建立基线，按项目需要与已有授权执行 |
| Agent OS 安装与 Spec Kit 创建脚本 | 在所选项目中安装规范／命令或创建 Feature 资料 | 将资料创建与 Worktree 准备分别处理 |
| Codex App 官方 Worktree 文档 | 已跟踪文件来自 Git checkout；本地托管 Worktree 可用 `.worktreeinclude` 复制匹配的忽略文件，另有忽略的 `AGENTS.override.md` 特例 | 默认依赖基线，额外本机资料使用明确清单 |
| Codex App local environments | 项目 `.codex` 保存可检入共享的环境配置；创建 Worktree 时运行 setup script | 版本化公共配置，初始化步骤在新执行环境中运行 |
| Pi SDK 与本机 Codex CLI | `SessionManager.open()` 打开指定记录；`codex exec resume <SESSION_ID>` 可恢复指定会话 | 原生引用持久化，进程结束后由新 worker 加载原会话 |
| Trellis Pi／Codex 适配 | 平台配置器、原生角色模板及 CLI 新建／恢复命令分别适配 | 通用角色源与平台注入分开，宿主入口与 AgentRuntime 接口分开 |

Codex App 的复制行为适用于其管理的本地 Worktree；官方页面将其他普通未跟踪文件与匹配的忽略文件区分，并说明跳过源符号链接及已有目标。该行为的研究范围为 App；Knit 的复制与准备规则由自身实现。`AGENTS.md` 文档说明指令按目录发现、合并并受大小上限约束，跨平台注入需按各平台入口处理。

依据：[Trellis CLI 适配](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/cli_adapter.py)、[Pi 配置器](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/configurators/pi.ts)、[Codex 配置器](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/configurators/codex.ts)、[Codex 角色模板](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/codex/agents/trellis-implement.toml)、[GSD 派发前提交步骤](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/quick/steps/worktree-pre-dispatch-commit.md)、[Agent OS 安装脚本](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/scripts/project-install.sh)、[Spec Kit 创建脚本](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/scripts/bash/create-new-feature.sh)、[Codex App Worktree](https://developers.openai.com/codex/app/worktrees)、[Codex App 环境](https://developers.openai.com/codex/app/local-environments)、[Codex 指令加载](https://developers.openai.com/codex/guides/agents-md)。Pi 核查位置为 1.4.0 的 `docs/sdk.md`、`examples/sdk/11-sessions.ts` 与 `examples/sdk/07-context-files.ts`；Codex CLI 核查仅运行版本与帮助命令，未启动模型或恢复实际会话。

### 17.10 成熟开源工具的 Worktree 准备

样本按大型编辑器／Agent、并行任务工具与专用 Worktree 管理工具选取。采集时 VS Code 约 194.4k stars、OpenCode 约 223.6k、Vibe Kanban 约 28.5k、Worktrunk 约 9.7k、Claude Squad 约 8.7k；stars 用于辅助判断公开关注度，实际用户数未核实。下表以第 17.1 节固定的发布快照为依据，独立 Copilot Chat 仓库另作会话入口参考。

| 工具 | 核查到的创建与准备行为 | 采用边界 |
| --- | --- | --- |
| VS Code | Git 创建后按 `git.worktreeIncludeFiles` 复制同时被忽略且匹配配置的内容；另有 `git.worktreeSymlinkFolders` | 两项默认空且 experimental；此复制路径使用设置项，不读取 `.worktreeinclude` |
| Worktrunk | `wt step copy-ignored` 为独立步骤，可接入钩子；`.worktreeinclude` 限定 ignored 集合 | 缺少 include 时范围为 ignored 集合扣除排除项；`--require-include` 可要求清单。`pre-start` 阻塞后续执行，`post-start` 后台运行 |
| Vibe Kanban | 仓库配置分别提供 `copy_files`、`setup_script` 和并行 setup 选项 | 已有目标跳过，单项复制失败记录后继续；并行 setup 可与 coding agent 同时运行 |
| OpenCode Worktree 服务 | `create/createFromInfo` 经 Git 创建后异步 bootstrap，再运行项目 start 与调用级 `startCommand` | 该服务先发 Ready 再运行脚本，脚本错误记日志；发布版另有 project-copy 入口，按调用链分别理解 |
| Claude Squad | 从 HEAD 或现有分支创建，并记录基线提交 | 创建辅助函数会先尝试强制移除同目标环境并删除残留目录；Knit 按绑定复用与现场核实规则恢复 |

核查到的路径由 Git 提供基线，并以额外配置或脚本处理环境资料。后续 Worktree 实现按第 6.7 节使用基线、当前任务交接、额外资料白名单与顺序初始化；必需资料完整、初始化成功后才启动阶段。公共资料提交按项目需要建立基线，未提交资料按明确清单准备。失败保留目录、逐项结果与成功步骤，恢复时核实后继续。本节研究与第 6 节均不构成首版实现要求。

本次核查范围为发布版源码、配置、文档和已有测试源码，未执行参考项目测试套件或实际 Agent 流程。默认能力、可选命令和实验性设置分别记录；复制返回成功或 Ready 事件的语义以具体实现为准。

依据：[VS Code 配置](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/package.json)、[创建与准备](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/src/repository.ts)、[复制筛选](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/src/worktreeInclude.ts)、[Copilot Chat 会话入口](https://github.com/microsoft/vscode-copilot-chat/blob/8b43cd385bcfdc01aef5604434d2bbff73c66a5b/src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts)、[Worktrunk 复制步骤](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/src/commands/step/copy_ignored.rs)、[筛选与排除项](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/src/commands/step/shared.rs)、[钩子语义](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/docs/src/content/docs/hook.md)、[Vibe Kanban 复制实现](https://github.com/BloopAI/vibe-kanban/blob/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053/crates/local-deployment/src/copy.rs)、[setup 与 Agent 执行链](https://github.com/BloopAI/vibe-kanban/blob/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053/crates/services/src/services/container.rs)、[OpenCode Worktree 服务](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/worktree/index.ts)、[project-copy 策略](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/project/copy-strategies.ts)、[Claude Squad 创建流程](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/worktree_ops.go)。

## 18. 规范维护

需求变更按主题更新结构、规则、示例、引用和验收。命名与路径变更沿创建、资料交接、Worktree、分支、绑定、列表、恢复和归档链路检查。具体协作与写作要求见 `AGENTS.md`。
