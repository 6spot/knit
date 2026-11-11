# Knit 研究依据与取舍

首轮研究记录日期为 2026-10-31，Magpie 与 REX 在后续补充核查。下文分别记录固定快照中的源码能力、模型工作约定和 Knit 的选择。

## 17.1 研究快照

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

## 17.2 Trellis

Trellis 提供显式任务、Session 关联、引用清单、记录脚本和 Worktree 配置。Knit 采用任务身份、即时需求写回、实施／检查分工、可读目录名和整目录归档。

- 创建确认、每次需求澄清后更新 PRD 属于工作流指令。初始 PRD 模板简短，程序元信息主要存于 `task.json`。
- `implement.jsonl`／`check.jsonl` 保存文件与理由。实际读取与理解仍由 Agent 完成。
- 当前任务存于 `.runtime/sessions/<context-key>.json`，Pi Extension 提供上下文关联；`finish` 负责清关联。
- Journal 脚本具备指纹、幂等和索引修复，历史检索提供补充线索；语义漏记由 Agent 核对。
- 检查角色允许直接修复；Knit 将修复交回实施，随后重新检查。
- `safe_archive_paths_to_add` 包含 archive 根目录；Knit 的归档提交按单任务源／目标路径限定。
- 日期 helper 生成 `MM-DD`，归档按当前 `YYYY-MM` 分组并保留目录名。Worktree 配置提供目录、复制清单和初始化命令。

依据：[工作流](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/workflow.md)、[任务实现](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/task_store.py)、[命名前缀](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/paths.py)、[归档路径](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/task_utils.py)、[Pi Extension](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/pi/extensions/trellis/index.ts.txt)、[提交 helper](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/trellis/scripts/common/safe_commit.py)、[收尾流程](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/common/commands/finish-work.md)、[Worktree 配置](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/markdown/worktree.yaml.txt)。

## 17.3 Agent OS v3

v3 将执行与编排交回 Agent。发现、索引和注入主要由命令文档指导模型完成。`shape-spec` 要求保存讨论成果，`shape.md` 包含问题、范围、决定与上下文。

Knit 采用短规范索引、语义选择、按需读取和实施前保存讨论结论。规范正文由项目维护，任务保存引用、适用理由和例外。

依据：[变更记录](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/CHANGELOG.md)、[规范索引](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/index-standards.md)、[注入](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/inject-standards.md)、[需求塑形](https://github.com/buildermethods/agent-os/blob/e892e61d322759165e7d9173e92c1010406c9f4d/commands/agent-os/shape-spec.md)。

## 17.4 Spec Kit

Spec Kit 通过 Constitution、Spec、Plan、Tasks 关联要求与实施。澄清工作流增量保存已接受答案，converge 对照实现差距；一致性分析依赖模型判断，验证仍需实际证据。

本快照的核心 Feature 定位支持 `SPECIFY_FEATURE` 与目录发现，Git 分支检测位于可选扩展，核心创建脚本提供资料创建。Knit 采用显式身份与绑定，并保留完成条件、需求／验证关联和规范变化后的覆盖判断。

依据：[Spec 模板](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/spec-template.md)、[澄清](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/clarify.md)、[一致性分析](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/analyze.md)、[差距检查](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/converge.md)、[规范修订](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/templates/commands/constitution.md)、[定位实现](https://github.com/github/spec-kit/blob/7370e592f3cd9c06e5b698983957e227c75b30e2/scripts/bash/common.sh)。

## 17.5 GSD Core

GSD 的 STATE 保存紧凑摘要，执行与暂停工作流要求整理进展，状态命令维护字段。Worktree 流程包含基线、目录、分支和恢复校验。

Knit 采用当前位置、关键决定、阻塞、下一步、完成证据和分步恢复。GSD 的 Pi／sandbox storage seam 作为适配设计参考，实际存储与兼容情况按对应实现核查。

依据：[状态模板](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/templates/state.md)、[执行](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/execute-plan.md)、[暂停](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/pause-work.md)、[恢复](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/resume-project.md)、[分支校验](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/references/worktree-branch-check.md)、[恢复政策](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/execute-phase/steps/worktree-recovery-policy.md)、[创建环境](https://github.com/open-gsd/gsd-core/blob/1ec5c812b79dc1cc487d0873d18b03449b11c106/gsd-core/workflows/new-workspace.md)。

## 17.6 Pi 与 SoL-Pi

Pi 提供上下文、Skills、模板、Session 树、自定义条目与扩展接口。主项目桥接由 Knit init 生成，阶段使用受控资源加载限定当前执行项目的上下文；独立 Worktree 的边界管理见 [WORKTREE.md](WORKTREE.md)。

`getBranch()` 表示当前叶节点的祖先路径，`getEntries()` 表示整棵树。`appendEntry()` 负责持久化条目，上下文注入另行处理。Session 开始通过 `session_start` 区分 startup、reload、new、resume、fork，对话树切换通过 `session_tree` 处理。

`createAgentSession()` 公开选项支持 cwd、model、tools、resourceLoader、sessionManager；AgentSession 提供 subscribe、prompt、abort 和 dispose。模型解析与资源范围由 Knit 显式传入。

SoL-Pi 使用 `sol-pi-online-context-state-v1`、`appendEntry()` 和当前分支恢复计划。Knit 借鉴公共 API 的使用方式，维护自身状态。SoL-Pi 测试矩阵的范围按其兼容文档理解，本机 Pi 1.4.0 的兼容性仍需相应执行验证。

核查位置：Pi 1.4.0 的 README、docs、`dist/core/{resource-loader,session-manager,sdk,agent-session}` 和 subagent 示例；SoL-Pi `219568034fa5` 的 README、配置／兼容文档及 online-context-compact 源码。

## 17.7 Magpie

固定快照包含 Go 内置功能插件运行时和外部 JS 插件宿主，两者有各自的注册、运行和权限边界。

| 机制 | Knit 采用方式 |
| --- | --- |
| Manifest、宿主 API 范围、Requires／Provides | 借鉴内部模块职责与依赖分离，不引入对外插件清单 |
| runtime 依赖服务，插件通过公共接口连接 | 核心业务与内部适配装配分离 |
| Ctx 注册、OnDispose、失败回滚与逆序清理 | 借鉴内部实例的失败清理与资源生命周期，不引入公开注册 API |
| API 兼容检查与状态原因 | 内部实现能力核实、构建测试及可见错误 |
| 默认启用、InUse 保持功能 | 运行中的内部实例保留到工具终态，后续运行按新选择装配 |

页面插件的 iframe、来源校验和权限桥属于 Magpie 页面扩展点。Knit 采用内部适配和统一 worker 协议，项目 Pi 桥接由初始化生成；不照搬对外插件运行时。

依据：[运行时](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/pluginrt.go)、[运行时测试](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/pluginrt_test.go)、[配置](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/pluginrt/config.go)、[架构文档](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/docs/subsystems/plugin-runtime.md)、[外部宿主](https://github.com/yetone/magpie/blob/3baf3b6dfdfb9fd2478be6a9eb3b9ae784f7a258/internal/plugin/host.go)。核查覆盖源码、文档和测试内容，Magpie 测试套件未执行。

## 17.8 REX

核查覆盖 rex 技能、`rex __internal skill`、`rex whoami --json`、CLI 帮助和官方文档。当前 `run` 默认创建新窗口，支持 session／window 定位、split、cwd、label、focus、keep-open、shell=none、json 和 wait。

CLI 创建结果、终端状态和程序状态提供定位与观察能力。Knit 通过自己的回执与取消协议判断阶段结果和工具终态。

## 17.9 公共资料、会话恢复与跨 Agent 接入

下表中的 Worktree 准备已按 [WORKTREE.md](WORKTREE.md) 实现；跨客户端接入仍用于后续设计。Pi 会话恢复按[第 9 节](../design/DESIGN.md#9-主会话session-与上下文集成)实现，范围以[第 15 节](../design/DESIGN.md#15-交付范围)为准。

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

## 17.10 成熟开源工具的 Worktree 准备

样本按大型编辑器／Agent、并行任务工具与专用 Worktree 管理工具选取。采集时 VS Code 约 194.4k stars、OpenCode 约 223.6k、Vibe Kanban 约 28.5k、Worktrunk 约 9.7k、Claude Squad 约 8.7k；stars 用于辅助判断公开关注度，实际用户数未核实。下表以[第 17.1 节](#171-研究快照)固定的发布快照为依据，独立 Copilot Chat 仓库另作会话入口参考。

| 工具 | 核查到的创建与准备行为 | 采用边界 |
| --- | --- | --- |
| VS Code | Git 创建后按 `git.worktreeIncludeFiles` 复制同时被忽略且匹配配置的内容；另有 `git.worktreeSymlinkFolders` | 两项默认空且 experimental；此复制路径使用设置项，不读取 `.worktreeinclude` |
| Worktrunk | `wt step copy-ignored` 为独立步骤，可接入钩子；`.worktreeinclude` 限定 ignored 集合 | 缺少 include 时范围为 ignored 集合扣除排除项；`--require-include` 可要求清单。`pre-start` 阻塞后续执行，`post-start` 后台运行 |
| Vibe Kanban | 仓库配置分别提供 `copy_files`、`setup_script` 和并行 setup 选项 | 已有目标跳过，单项复制失败记录后继续；并行 setup 可与 coding agent 同时运行 |
| OpenCode Worktree 服务 | `create/createFromInfo` 经 Git 创建后异步 bootstrap，再运行项目 start 与调用级 `startCommand` | 该服务先发 Ready 再运行脚本，脚本错误记日志；发布版另有 project-copy 入口，按调用链分别理解 |
| Claude Squad | 从 HEAD 或现有分支创建，并记录基线提交 | 创建辅助函数会先尝试强制移除同目标环境并删除残留目录；Knit 按绑定复用与现场核实规则恢复 |

核查到的路径由 Git 提供基线，并以额外配置或脚本处理环境资料。Worktree 实现按[第 6.7 节](WORKTREE.md#67-公共资料与环境准备)使用基线、当前任务交接、额外资料白名单与顺序初始化；必需资料完整、初始化成功后才启动阶段。公共资料提交按项目需要建立基线，未提交资料按明确清单准备。失败保留目录、逐项结果与成功步骤，恢复时核实后继续。本节研究只说明取舍依据，现行规则以 [WORKTREE.md](WORKTREE.md) 为准。

本次核查范围为发布版源码、配置、文档和已有测试源码，未执行参考项目测试套件或实际 Agent 流程。默认能力、可选命令和实验性设置分别记录；复制返回成功或 Ready 事件的语义以具体实现为准。

依据：[VS Code 配置](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/package.json)、[创建与准备](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/src/repository.ts)、[复制筛选](https://github.com/microsoft/vscode/blob/2c33b50b16c472efe58357d1d2a8a5414bc23fbf/extensions/git/src/worktreeInclude.ts)、[Copilot Chat 会话入口](https://github.com/microsoft/vscode-copilot-chat/blob/8b43cd385bcfdc01aef5604434d2bbff73c66a5b/src/extension/chatSessions/vscode-node/chatSessionWorktreeServiceImpl.ts)、[Worktrunk 复制步骤](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/src/commands/step/copy_ignored.rs)、[筛选与排除项](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/src/commands/step/shared.rs)、[钩子语义](https://github.com/max-sixty/worktrunk/blob/e42f0f6fef2fdbd98fc92e5cd6c3cbea55b65b38/docs/src/content/docs/hook.md)、[Vibe Kanban 复制实现](https://github.com/BloopAI/vibe-kanban/blob/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053/crates/local-deployment/src/copy.rs)、[setup 与 Agent 执行链](https://github.com/BloopAI/vibe-kanban/blob/4deb7eca8f381f7cbc1f9d15515a9ab8f8009053/crates/services/src/services/container.rs)、[OpenCode Worktree 服务](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/opencode/src/worktree/index.ts)、[project-copy 策略](https://github.com/anomalyco/opencode/blob/810c0eba1a7348036f8bdf61e6632d0c36c6876c/packages/core/src/project/copy-strategies.ts)、[Claude Squad 创建流程](https://github.com/smtg-ai/claude-squad/blob/ce1ffb4392b01f38e2c4599c7c84d2a93973b138/session/git/worktree_ops.go)。

## 17.11 项目初始化与规范演进

Trellis 由独立 CLI 创建项目工作流与平台资料，Pi 配置器生成项目级扩展／角色；初始化对已有文件区分保留与覆盖。Knit 借鉴“CLI 初始化、项目桥接接原生能力、核心资料共享”，不要求单独安装全局 Pi Extension。

`finish-work` 提醒核对规范缺口，`update-spec` 从设计决定、调试教训和重复错误更新规则，要求具体约定、示例、失败边界与测试，并避免重复和一次性细节。Knit 将其融入任务与收尾：记录候选，核对后更新设计／开发规范及索引，后续任务按需读取；不保证每任务必有新规则，也不把模型提示词约定说成自动代码保证。

来源：[独立初始化](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/commands/init.ts)、[Pi 项目配置](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/configurators/pi.ts)、[收尾检查](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/common/commands/finish-work.md)、[更新规范](https://github.com/mindfold-ai/Trellis/blob/f089cb3286071199e84118dee86b6d76aab032f1/packages/cli/src/templates/common/skills/update-spec.md)。

## 17.12 技术约束核查

早期包元数据核查读取本机已安装 Pi 1.4.0 的 package、SDK／CLI 文档、extensions 类型／加载器和 bash 工具定义；npm 只读查询确认该版本可取得，engines 为 Node >=22.19，TypeScript 6.0.3 已发布。SDK 使用 ESM、typebox 1.3.27、yaml 2.9.0，并公开 sendMessage、registerTool、createBashTool／BashOperations。 这是历史技术事实，当前 Pi 接入使用本机 CLI；不据此引入 SDK、绑定其编译器／schema 版本或推定业务链路通过。

本机 Node v25.5.0、Git 2.54.0。只在内存做 TypeBox 1.3.27 JSON schema 往返校验实验，确认合法值通过、错误 action 与多余字段被拒；未运行模型或完整 SDK 恢复。这不是 Node24 基线兼容验收。

官方资料核查：Node24 为维护期 LTS，计划支持至 2028-04-30；Commander15 要求 Node>=22.12；TypeBox1 与旧 @sinclair/typebox0.34 API 不同，锁定版本后按其 exports 实现；YAML2 提供 Document 编辑，但不保证注释和文本字节完全不变。Node 自带测试运行器适用于本版的端口注入与临时仓库测试。

依据：[Node 生命周期](https://nodejs.org/en/about/previous-releases)、[发布计划](https://github.com/nodejs/Release/blob/main/schedule.json)、[Commander15](https://github.com/tj/commander.js/blob/v15.0.0/Readme.md)、[TypeBox](https://github.com/sinclairzx81/typebox)、[TypeBox1.3.27](https://www.npmjs.com/package/typebox/v/1.3.27)、[YAML2](https://eemeli.org/yaml/)、[Node24 测试运行器](https://nodejs.org/docs/latest-v24.x/api/test.html)、[Pi SDK1.4.0](https://www.npmjs.com/package/@earendil-works/pi-coding-agent/v/1.4.0)、[TypeScript6.0.3](https://www.npmjs.com/package/typescript/v/6.0.3)。

Pi 接入以[第 17.14 节的本机 CLI 实测](#1714-m0-主体验验证边界)为准；本节的 SDK 包元数据核查不构成引入 SDK 的决定。其他技术候选见 [TECHNOLOGY.md](../design/TECHNOLOGY.md)，接口存在与元数据满足要求不代表产品已实现或通过验收。

## 17.13 存储与诊断验证计划

首版不再预先排除 SQLite。内部 Session、binding、operation 更新可纳同一短事务；该对比已在 Node24.21.0 实际执行并选定 SQLite（见 [TECHNOLOGY](../design/TECHNOLOGY.md) 第 8 节与任务004）；外部 Markdown、Git、原生历史仍分别核验。内置 node:sqlite 已实测满足事务、锁与只读要求，未引入外部驱动。

M0 驱动核查入口：[Node24 SQLite API](https://nodejs.org/docs/latest-v24.x/api/sqlite.html)。需实际确认支持状态、事务／busy 行为、只读副作用与打包成本，不用本机 Node25 实验代替。开发者模式的脱敏 stepKey、摘要、I/O／事务计数可用于比较，不记录 SQL 参数、正文或凭据；它不是新状态库或模型调试调用。

## 17.14 M0 主体验验证边界

本机 Pi 1.4.0 已通过直接 CLI RPC 完成真实实施、独立检查、新进程原生恢复、受控模型工具取消和确定性 Git 收尾；未导入 SDK 或安装额外依赖。受信项目 `.ts` 扩展自动加载、宿主 reload、真实交互 CLI 的 `/reload`、轮外被动消息与实际唤醒、忙时 follow-up 和会话变化后的回调防误投均已实际核验。原始报告、代码、Git bundles、修正记录与文件指纹保存在 [CLI 验证资料](../../validation/pi-cli-1.4.0/README.md)，逐项结果见[验证清单](../../validation/pi-cli-1.4.0/MATRIX.md)。

实测限制必须保留：不存在的 session 路径可被打开为新空会话；启动时未登记模型可被合成描述符，不能仅凭 `get_state` 字符串认定可用；强杀 CLI 后受控工具子进程仍可能存活；Git hook 能扩张 `commit --only` 的提交范围。实验均已核实实际效果、清理自有进程，并保留恢复证据。宿主轮外消息实验使用受控回调，尚不代表 Knit worker 到宿主的产品传输协议完成。

本轮完成的是 CLI 能力验证，不将产品任务状态、规范演进、init 所有权、授权、占用／接管、存储选择或 Node24 打包验收记为通过。正常关闭、受控取消与强制中断分别记录；不能由本例外推任意 daemon、远端副作用或外部并发都可自动恢复。

M1 开发诊断只做结构化 stderr、白名单及最小等价冒烟；私有日志和 Pi 会话开关归 M3A。同步目录检测只是本机最佳努力提示，云同步不是跨机锁；不能将 Git 忽略等同云排除，也不能仅因目录名认定不支持。

## 17.15 参考项目的会话、模型、取消与提交边界

固定快照的 Trellis 与 GSD Pi 子任务使用 `--no-session`；Spec Kit Pi integration 的 workflow resume 主要复用步骤检查点。它们没有在这些入口统一承担 Knit 的原生 worker 身份恢复保证；Trellis 另有通用 CLI 恢复命令，不能与一次性 Pi 子任务混为一谈。

取消确有实现：Trellis Pi 工具杀直接 CLI 子进程，GSD Pi dispatcher 杀进程组，Spec Kit capture 管理 POSIX 进程组／Windows Job，并明确脱离边界的程序可能存活。模型解析主要依配置及客户端；GSD 还存在保留当前模型的 fail-open 策略，不等于 Knit 指定不可用即阻塞。提交方面，Trellis 选择资料 pathspec 但可覆盖 archive 子树，GSD 的 commit helper 用独立 index 与 `--only`；Spec Kit 可选 Git 扩展默认关闭，启用后是项目范围 `git add .`。这些路径都不能证明任意 hook 下严格单任务隔离。

逐项解释、15 份固定源码指纹与摘录见[参考边界对照](../../validation/reference-boundaries/README.md)。本轮只读源码，未运行参考项目模型或测试套件，也不将这些做法自动改为 Knit 策略。

## 17.16 原生恢复失败后的文件续做

默认 `agent.resume: prefer` 采用已授权兜底：优先恢复原生记录，旧记录不可用时沿同一客户端自动创建新 Session，读取任务要求、适用正式规范、进度、已有执行事实与当前代码续做；来源和原因留存，阶段／修复次数／scope 不因换会话重置。旧执行未知、模型不可用或任务归属不明仍阻塞。

[独立文件续做实验](../../validation/session-fallback/README.md) 已动态验证缺失记录触发新会话、初始历史为空、真实工具读取任务与进度文件、完成剩余代码并经控制器复跑测试通过。模型总结自行改变了阶段／次数，控制器未采纳；权威任务文件与控制器值不变，旧报告及校验更正一并留存。本例不替代损坏／兼容触发分类等产品实现后验收。

## 17.17 整体设计一致性审查

九份系统文档已按本机 CLI、单一候选仓储及 prefer 新会话续做统一核对。跨 run 原生文件与 run 证据分开，opening／available 与模型首轮启动分开，项目安装 ready 与 Pi 项目信任分开；草案应用／撤回、关闭与迟到结果、共享锁根、只读历史和完成结果连接均补齐对应规则。技术版本仍是产品设计选择，文件／SQLite 与 Node24 组合验收在该轮未被写成已通过（后续任务004已实际执行存储对比并选定 SQLite，见 17.13 与 TECHNOLOGY 第 8 节）。

问题和修正记录、当前决定与尚待实现的验收见[整体审查资料](../../validation/design-audit/README.md)。本轮仅修订设计与做文档／旧证据完整性校验，未安装依赖、发模型请求或实现产品。

## 17.18 OpenSpec 的行为场景写法

固定来源：[Fission-AI/OpenSpec docs/concepts.md](https://github.com/Fission-AI/OpenSpec/blob/a959be77cf045ea3156dc5089c9e2f1d6ce9ce70/docs/concepts.md)，commit `a959be77cf045ea3156dc5089c9e2f1d6ce9ce70`（@fission-ai/openspec 1.17.0）。2026-11-11 的离线研究摘记为任务 k-185ace3b9556 的 `research/openspec-format.md`；本轮依据固定材料，未运行 OpenSpec CLI 或模型。

采用 `### Requirement:`／`#### Scenario:` 与大写 GIVEN／WHEN／THEN／AND（含加粗关键字）的行为契约表达：一个可验证例子对应一个结论，避免自由列表混合多个触发条件导致独立检查漏验。Knit 放在已有 task.md 的 `## 完成条件`，按位置生成 Rn.Sm，ready 校验结构，声明 scenarios 的阶段在报告收尾／接收机械核对覆盖和总 pass 一致性。核心不解释 MUST／SHOULD／MAY 强度或判断内容合理性，语义仍由 Agent 与用户确认。

不采用 specs／changes／proposal 目录、ADDED／MODIFIED／REMOVED 增量规格与 archive 合并模型，也不引入 OpenSpec 命令、schema、profile 或 npm 依赖：本期仅改善任务验收表达与覆盖，Knit 的任务输入更新、冻结、scope 和归档已有独立权威。长期行为规格与增量归并是否引入留待第二期决定，不由本次研究扩大产品范围。现行格式、原因码与升级边界见 DESIGN §3.3、§8.1 和 ROLE-CONTRACT §2、§5。
