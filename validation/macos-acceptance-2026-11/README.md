# macOS 真机验收（2026-11-11，任务 k-7bdf43be461e）

本目录保存 macOS 开发机上的安装、真实宿主、Rex 浮窗与跨功能对话验收证据。复核对象是本机工作区当前的 `main`（验收时 HEAD `58a2dc2`）与本地候选包；不修改产品代码以外的业务产物。

## 环境

| 项 | 值 |
| --- | --- |
| 系统 | macOS 27.2.1（Darwin 27.2.0，arm64） |
| Node／npm | Node 26.3.0（mise latest，用户决定不切 Node 24）／npm 11.16.0 |
| Pi | 1.5.2 |
| Rex | 客户端在位（`REX_SESSION` 真机浮层可用） |
| 工作区 | `/Users/me/IdeaProjects/knit`，验收时 `main`，仅 `.knit/config.json` 有本机 rebind 改动 |
| 模型 | magpie / group/deepseek（真实模型，未用替身） |

隔离方式：所有安装、init、任务与阶段派发在 `/tmp/knit-macos/` 的临时 Git 仓库与临时安装目录进行，不触碰本仓库业务产物与任务数据。

## 结果

| 场景 | 结果 | 证据 |
| --- | --- | --- |
| 普通终端全量测试 | PASS：719 tests / 719 pass / 0 fail / 0 skipped，3m49s | `test-normal-terminal.log`（本次 shell 由 Rex 终端承载，`TERM_PROGRAM=rex`） |
| 普通终端语义（去掉 `REX_*`／`TERM_PROGRAM`） | PASS：719/719，3m49s | `test-plain-env.log` |
| 打包检查 | PASS | `pack-check.log` |
| 打包内容 | 266 文件、615 kB；仅 `README.md`、`package.json`、`assets/`（9）、`dist/`（255） | `pack.log` |
| 本地安装候选包 | PASS：`knit --version` → 0.1.0，`node_modules/.bin/knit` 指向 `dist/cli/knit.js` | 见下「实测命令」 |
| init | PASS：`项目根: /private/tmp/knit-macos/proj`（realpath 生效）、清单 ready、生成 `.knit/` 与 `.pi/extensions/knit.ts`；注意 `--client` 已移除，现为默认启用的 `--pi` | `init.log` |
| start 冒烟 | PASS：输出 `1.5.2`，stderr 为空 | `start.log`、`start.err` |
| 桥接加载 | PASS：diag `cli_version consistent`、`session_attached`；无任务时模型复述出注入的建任务提示 | `bridge-notask-context.out` |
| 桥接选择任务 | PASS：`knit_task action=use` 选中并写入原生入口；带 `--no-session` 时如实返回 `persisted:false`／`native_entry_not_persisted` | `bridge-select.out` |
| 真实阶段链路（local） | PASS：implement 19–30s 完成并被接收；self 任务按设计直接进入收尾；显式 check 38s 判 pass | `run-96918565aa1e`、`run-6d7588179113`、`run-568c59cd7923` |
| 中断与恢复（Rex） | PASS（业务侧）：取消 9.3s 收敛为 cancelled 并接收；`resume` 新 run 沿用同一输入摘要与整体身份，阶段未被重置；见“发现”F1 的浮层残留 | `run-ce215cf84b71`、`run-410515ebc3c3` |
| Rex 浮层展示 | PASS：派发 2s 内出现 `knit run-<id>` 浮层，实时显示 worker 输出与模型 | `blocks-during.json` 时段观察 |
| 自然语言建任务入口 | PASS：真实模型先给 A/B/C 选项并询问是否建任务，未擅自创建或实施 | `dialogue-task-creation.out` |
| blocking 阻挡 | PASS：含 `[blocking]` 时 `task ready` 拒绝并给出待决项；移除后放行 | 见下「实测命令」 |
| 每轮上下文注入 | **FAIL（续接会话）**：见 F4 | `bridge-turn-context-missing.out` |

## 实测命令

```text
# 工程验证
npm test                                    # 719/719，普通终端（Rex 承载）
env -u REX_SESSION -u REX_BLOCK -u REX_SERVER -u REX_BIN_DIR \
    -u TERM_PROGRAM -u TERM_PROGRAM_VERSION npm test   # 719/719，普通终端语义
npm run -s pack:check                       # 通过
npm pack --pack-destination /tmp/knit-macos # 266 文件

# 安装与初始化（临时目录 /tmp/knit-macos）
npm install /tmp/knit-macos/knit-0.1.0.tgz
./node_modules/.bin/knit --version                       # 0.1.0
knit init                                                # ready（--pi 为默认；--client 已移除）
knit start --dir /tmp/knit-macos/proj -- --version       # 1.5.2

# 阶段链路（临时 Git 仓库）
knit run implement --task <id> --local --provider magpie --model group/deepseek
knit run check --task <id> --local --provider magpie --model group/deepseek
knit run implement --task <id> --rex ...                 # Rex 浮层
knit cancel --run <id> --reason ...                      # 取消探针
knit resume --run <id>                                   # 恢复探针

# 守卫
knit task ready <含 blocking 的任务>                      # 拒绝，列出待决项
```

## 发现

### F1 Rex 浮层终态不关闭，取消后阶段 Pi 进程存活（必现）

- 现象：`--rex` 派发的 run 在 completed 后浮层仍打开（观察 ≥30s，进程已退出但 pane 保留）；取消的 run 同样保留浮层，且其阶段 Pi 进程（`pi`，pid 6937）在取消 9.3s 收敛后仍存活；该进程直到手工 `session.close_layer` 才消失。
- 手工复核 `session.close_layer` 可正常关闭并移除该 block，说明 Rex 侧 API 可用，问题在 Knit 调用链。
- 代码：`src/application/stage-runner.ts:1041` 恒传 `closeOnSettle: false`（为报告补报保留 worker）；`src/application/rex-launcher.ts:855` 的 `closeLayer()` 在 `closeOnSettle === false` 时直接返回；`src/application/rex-launcher.ts` 的 `stop()` 在 bridge 调用成功后不再执行 `terminate()`，因此取消路径也不会关层。`git blame` 显示该门控由 k-1b0c477f4bc6 引入，其单测走默认 `closeOnSettle=true`，未覆盖 StageRunner 的实际取值。
- 与规范冲突：`docs/design/OPERATIONS.md`／k-1b0c477f4bc6 要求终态关闭浮层、取消走 stop／terminate 同路径。

### F2 受管入口用 `npx --no-install knit`，与全局安装方式不一致

- 现象：临时项目的 worker 报告 `knit task record` 未能执行，原因 `npx --no-install knit` 报 `could not determine executable to run`。
- 原因：`init` 生成的 `AGENTS.md` 受管块与桥接提示让 Agent 用 `npx --no-install knit ...`，而 README 的安装脚本把 Knit 装到 npm 全局位置；项目内没有 `node_modules/knit` 时该命令失败。
- 影响：全新项目里 worker 无法通过软链入口写回进度／材料（阶段结果仍能接收）；本仓库测试通过与其它验收不受影响。

### F3 验收材料引用了已移除的 `knit init --client pi`

- 025 平台矩阵与早期文档使用 `--client pi`，当前 CLI 是默认启用的 `--pi`，`--client` 会报 `unknown option`。本任务的完成条件已按现状改为 `knit init`。

### F4 续接会话拿不到每轮 knit 上下文（间歇）

- 现象：同一 Pi 会话第二轮起，模型明确回答“没有 knit 上下文块”；会话文件里第三个 system 消息的 `sections` 为 `{"knit": null}`，即桥接删掉了该分节。
- 代码：`assets/templates/pi/extensions/knit.ts` 的 `before_agent_start` 在 `buildTurnContext()` 返回 `null` 时执行 `delete options.sections.knit`；`buildTurnContext` 默认预算 `contextTimeoutMs()`（300ms），而本机 `knit session context` 冷启动实测约 0.6s，缓存由 `session_start` 的 `refreshTurnContext` 预热，存在竞态。
- 影响：每轮注入不稳定，模型可能拿不到当前任务与下一步；工具仍可用，业务写动作仍由核心核对。

## 三轮复跑（同一台机器、同样流程，独立临时仓库）

第一轮的结论只作单次观察；按“不能以一轮定结果”，在 `/tmp/knit-macos/r2`、`r3` 各重跑完整流程（每轮重新打包、安装、init、建任务、桥接、Rex 派发、取消/恢复、自然语言入口）。

| 项目 | 第 1 轮 | 第 2 轮 | 第 3 轮 |
| --- | --- | --- | --- |
| `npm test`（干净环境） | 719/719，3m49s | 719/719，3m49s（229.8s） | 719/719，3m45s（225.5s） |
| 打包 | 266 文件 615.2 kB | 266 文件 615.2 kB | 266 文件 615.2 kB |
| 安装 + `--version` | 0.1.0 | 0.1.0 | 0.1.0 |
| init / start 冒烟 | ready / `1.5.2` | ready / `1.5.2` | ready / `1.5.2` |
| 桥接第 1 轮注入 | TEXT | TEXT | TEXT |
| 桥接续接轮注入 | NULL（F4） | TEXT | NULL（F4） |
| 实施 run（真实模型） | completed 19–30s | completed 38s（resume 路径） | completed 75.4s |
| 实施接收后浮层 | 仍 open（F1） | 仍 open（F1） | 仍 open（F1） |
| 实施接收后 worker 进程 | 存活 | 存活 | 存活（pid 52939） |
| 取消检查 run | cancelled 已接收 | cancelled 已接收 | cancelled 已接收 |
| 取消后浮层／worker | open／存活 | open／存活（pid 71446） | open／存活（pid 71973） |
| 恢复 run | 同输入摘要，pass | 同输入摘要，pass，193.7s | 同输入摘要，pass，113.2s |
| 恢复到收尾 | deliver | deliver | deliver |
| 恢复接收后浮层／worker | open／存活 | open／存活 | open／存活（pid 75038） |
| 自然语言入口 | 先问是否建任务 | 先问是否建任务 | 先取证再问是否建任务 + 追问范围 |
| 残留锁／残留 worker（清理后） | 无 | 无 | 无 |

三轮判定：

- **F1 必现（3/3）**：无论实施完成、检查通过、还是取消收敛，浮层都不自动关闭，阶段 Pi 进程在接收后仍存活；只有手工 `session.close_layer` 才恢复。三轮分别捕获 pid 71075／71973／52939／75038 存活。
- **F4 间歇（2/3）**：续接会话的 `sections.knit` 出现 `NULL`（第 1、3 轮），第 2 轮正常；同一命令冷启动约 0.6s，与 300ms 预算竞态一致。
- 工程验证、打包、安装、init/start、阶段推进、取消与恢复、自然语言入口三项跨轮稳定复现，不是单次偶然。
- 第 2 轮的取消探针因脚本竞态命中实施 run（任务尚在 implement），取消/恢复语义与第 3 轮检查阶段一致，第 3 轮已按检查阶段复验。

原始日志：本目录 `test-normal-terminal.log`（第 1 轮）、`r2-*`、`r3-*` 见下表；每轮完整证据在 `/tmp/knit-macos/r2`、`r3`（含 pack、install、test、bridge、rex、cancel、resume 日志）。

## 缺陷修复与复验（2026-11-11 后续任务）

验收发现的四条问题已分拆修复，均在 macOS 本机复验：

| 缺陷 | 任务 | 结论 | 复验证据 |
| --- | --- | --- | --- |
| F1 浮层终态不关闭、worker 进程残留 | `k-da46a698c3ab`（independent，检查 pass） | 核心在补报窗口结束后 `terminate()` 收口；取消宽限后强制收敛 | `f1-fix/`：实施 completed 9760ms 浮层 absent、pid 退出；取消接收后同样收敛 |
| F4 续接会话每轮上下文丢失 | `k-50d398bff55f`（independent，二轮检查 pass） | 预热与首轮注入共享在途请求，无缓存首轮 2s、有缓存 300ms，失败保留分节并剥离宿主包装 | `f4-fix/`：三轮上下文按「无任务→A→B」逐轮刷新 |
| F2 受管入口 `npx --no-install knit` 不可用 | `k-731a13eab2f1` | init 解析入口：PATH 中 knit 版本一致写 `knit`，否则写 CLI 绝对路径 | 打包安装后 `knit init` 生成的受管块为 `knit task list` |
| F3 材料中已移除的 `init --client` | `k-4255496e31a0` | 现行规范无失效写法；补文档索引规则与 025 复跑提示 | `grep 'init --client'` 在现行面命中 0 |

平台声明按上述结论更新：`README.md`、`docs/README.md`、`docs/design/TECHNOLOGY.md`（支持目标与 §6）、`docs/design/DESIGN.md`、`docs/history/BLOCKERS.md` B001。仍延期：Node 24 组合矩阵、发布与外部部署。

修复后全量测试：`npm test` 727/727 pass（226s）。期间出现 2 次与本改动无关的临时目录／锁释放抖动（`bridge-query` ENOTEMPTY、`run.test` 锁未在 1s 内释放），隔离与复跑均通过。

## 未执行／延期

- Node 24 + macOS 组合：用户明确用本机 Node 26.3.0 验收，未复跑（Linux 候选沿用 025 记录）。
- npm publish、部署、CI：未执行。
- 浮层最小化／展开、焦点等纯 UI 细节：本轮只核对“出现／关闭／残留”，未逐项记录视觉细节。
