# Pi 1.4.0 CLI 验证与追溯资料

验证日期：2026-11-01。本机模型标识为 `magpie / group/openai`，不推断路由背后的上游模型。范围仅为本机 Pi 1.4.0，不涉及其他客户端、Worktree 或 Knit 产品实现。

**结论：直接启动本机 CLI、使用 stdin/stdout RPC，即可完成实施、独立检查、获取用量、原生会话恢复和确定性提交归档。项目薄扩展可使用宿主公开 API，在真实交互模式中接收回调并唤醒模型；不需要在 Knit 中导入 SDK 或安装额外运行依赖。**

本次按[验证清单](MATRIX.md)逐项实际测试。初始测试错误及更正均保留；最终没有悬而未决的测试失败。这里的“通过”表示该场景观测成立，不能把发现的原生限制当作产品已解决的问题。

## 必须带入后续实现的四个限制

1. **不存在的会话路径可能成功打开为新空会话。** 实测返回 success、Session ID 改变、消息为空、文件未创建。恢复必须先检查原记录存在，再核对实际 Session ID 和历史；不能只相信响应成功。
2. **CLI 启动可以接受未登记的模型标识。** `get_state` 可能返回这个标识，但本地可用模型清单中没有，RPC `set_model` 也会拒绝。启动后必须核对清单或执行受校验的 `set_model`，不能只比较字符串。当前指定模型实际可用，未做静默替换。
3. **强杀 CLI 不等于工具子进程全部结束。** 实测 SIGKILL 后受控 Python 工具仍存活；已核实身份并清理后才恢复。正常 abort 能终止本次受控模型 Bash。任意 daemon、远端副作用及未知工具进程不在这一保证内。
4. **`git commit --only` 不能隔离 hook 的副作用。** 实测 pre-commit 中的 `git add` 将无关路径加入了提交。必须核对实际 commit 范围／内容；发生越界保留真实提交事实并报告，不能自动改写历史。

## 资料布局

| 路径 | 内容 |
| --- | --- |
| [MATRIX.md](MATRIX.md) | 场景、结果、直接证据及边界 |
| [01-control-plane/report.json](01-control-plane/report.json) | 最初零模型调用的控制面报告，原样保留 |
| [02-full-loop/REPORT.md](02-full-loop/REPORT.md) | 首次真实闭环完整报告 |
| [02-full-loop/report.json](02-full-loop/report.json)、[analysis.json](02-full-loop/analysis.json) | 原始统计及恢复去重后的增量用量 |
| [02-full-loop/fixture](02-full-loop/fixture) | 实现、测试、归档资料和工作区样例 |
| [02-full-loop/repo.bundle](02-full-loop/repo.bundle) | 完整实验提交历史，不是嵌套 Git 仓库 |
| [03-edge-cases](03-edge-cases) | 取消、中断、扩展、通知、模型选择及 Git 异常证据 |
| [scripts](scripts) | 只依赖标准库／本机 CLI 的实验代码；不是产品实现 |
| [USAGE.json](USAGE.json) | 全部轮次按原生 Session ID + assistant entry ID 去重汇总 |
| [PATHS.json](PATHS.json) | 原临时位置与当前资料位置的映射 |
| [ENVIRONMENT.json](ENVIRONMENT.json) | 版本、平台与本机文档指纹 |
| [MANIFEST.json](MANIFEST.json) | 归档文件 SHA-256 与验证依据 |
| private-native/ | 原生完整记录，仅本机，Git 忽略，目录 0700、文件 0600 |
| .work/ | 隔离工作仓库和终端原始数据，仅本机，Git 忽略 |

原始 JSON 中的临时绝对路径不改写，避免把迁移后的路径冒充实验当时的位置。原生记录已另存 private-native/，其位置映射在其中的 locations.json；报告和代码不依赖原临时目录继续存在。bundle 只含提交可达对象；未提交的 index 和工作区版本额外用 index.diff、worktree.diff 与 unrelated-index.txt 保留。

## 验证范围

- RPC 控制和 JSONL 分帧、Unicode、非法模型／游标、缺失会话、EOF。
- 当前真实模型、工具集合／系统提示变化、独立 Session 检查、用量增量和原生恢复。
- 模型正在运行工具时取消、清理队列、取消后恢复，以及强制中断后的检查点与原生恢复。
- 受信项目 `.pi/extensions/*.ts` 自动发现、宿主 reload、真实 TUI 的 `/reload`。
- 宿主轮外回调的仅投递与实际唤醒、忙时 follow-up、切换会话后的回调防误投。通知实验的来源是受控定时回调；尚无 Knit worker→桥接的产品传输协议。
- 限定提交、hook 失败与范围扩张、commit 成功但回执丢失、归档移动后检查点丢失。

纯 CLI RPC 只控制自身启动的进程，不能附着另一个已打开的主 Pi 进程。交互会话的主动通知依靠该宿主已加载的薄扩展；本实验未向用户正在使用的主会话安装扩展或执行 reload。资源开关和工具集合不是操作系统沙箱。

Knit 尚未实现的任务状态、规范演进、并发占用、存储选择、init 文件所有权、完整授权和交付协议，仍需在实现后验收；本资料不宣称这些产品机制通过。文件与 SQLite 对比、Node24 产品打包兼容也不包含于本轮。研究结果不自动扩大首版范围。

## 用量

首次闭环新增 73,131 token（含缓存），Pi 配置价格估算 $0.079214。含全部补测与重复尝试，原生已记录合计 138,516 token，估算 $0.144944，其中本次补测新增 65,385 token、$0.065730。均为配置价格估算，不是供应商账单；中断流可能没有完整上游用量回报。

原生 assistant 记录数不是顶层提示数或 HTTP 请求数。恢复统计是 Session 累计，不能直接把多次 `get_session_stats` 相加。

## 复核与重跑

只读复核无需模型请求：在本目录运行 `python3 scripts/verify_archive.py`，检查文件指纹、JSON/JSONL、Git bundles、快照重放、测试代码及实验进程清理。验证器使用新的临时目录，不改现有证据。

真实模型脚本是一次性实验夹具。**不要在当前归档目录原地重跑**：复制 scripts/ 到新临时目录的 scripts/，建立该临时目录的 .work/ 和 03-edge-cases/，然后从那里执行。模型脚本使用 `PI_PROVIDER`、`PI_MODEL` 与 `PI_REASONING_LEVEL`；在普通终端需显式设置本机已配置值。脚本默认本次已验证的 Pi 可执行路径，换机器须先核对路径与 `pi --version`。

run_edge_cases.py 可按场景名选择运行；run_control_repeat.py 全程零模型请求；run_git_cases.py 只操作新夹具仓库；run_interactive.py 会启动独立伪终端并实际请求当前模型。首次 run_probe.py 保存在 02-full-loop/，按其原结构仅在新的空目录运行。

## 更正记录

- 自动发现首次用了 `.mjs` 夹具，未被发现；按产品约定的 `.ts` 入口重测通过。显式 `--extension .mjs` 在通知测试中已通过。
- 首次 TUI 后检查找错了自定义记录字段；原生格式为 `custom_message.content`。直接重查同一原生日志后通过，没有重复发模型请求。
- 首次 abort 耗时包含后续恢复耗时，保留原结果；修正计时位置后单独重测，通过。

- 归档校验首次用通用 splitlines() 解析 JSONL，会误切测试中的 U+2028/U+2029。已改为只按 LF 分帧，保留合法原始字节并重验。

上述初始结果与脚本版本在 results-attempt1.json、interactive-attempt1.json、archive-check-attempt1.json 和 scripts/attempts/ 中保留。
