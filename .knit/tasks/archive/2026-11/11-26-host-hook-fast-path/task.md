---
id: k-2eb875ed4150
title: 为宿主命令钩子增加快路径并消除 WorkBuddy 双重 Node 启动
status: delivered
stage: null
verification: independent
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-26T14:23:18.243Z
---

## 目标与范围

**要解决的问题**：
1. 每次宿主执行任意普通 Shell 命令（如 `ls -la`、`git status`、`npm test`、`rg`），都会触发完整命令检查链路：
   - Pi 桥接（`assets/templates/pi/extensions/knit.ts`）每次 `bash` 都 spawn 一次 `knit hook pi tool-call` 子进程并加载 `sh-syntax` WASM，固定耗时 ~108 ms；
   - `src/application/host-command.ts` 入口 `inspectHostCommand` 即使面对完全不包含 `knit` 或子 shell 的命令，也直接动态加载 `sh-syntax` WASM 并解析 AST；
2. WorkBuddy 钩子脚本（`assets/templates/workbuddy/knit-hook.sh`）每次调用都会先 `node -e '...'` 启动一次 Node 进程检查主版本号 ≥ 24，再 `exec knit` 启动第二次 Node 进程，导致每次钩子固定耗时 ~170 ms。

**改动目标（高风险授权核对链路，本任务要求独立审查）**：
1. **安全零漏检的命令快路径（`src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts`）**：
   - 在 `inspectHostCommand`（以及 Pi 桥接 `tool_call` 中调用 `startKnit` 之前）增加保守的快路径判断：只有当命令确定**既不可能调用 `knit`、也不可能通过间接执行/脚本/变量/命令替换构造 `knit`** 时，才直接快速返回无匹配（不加载 `sh-syntax`、Pi 桥接不 spawn 子进程）。
   - **安全红线（宁可慢、绝不漏）**：凡命令中包含以下任一情况，必须走完整 `sh-syntax` AST 检查，**绝不能走快路径跳过**：
     - 含子串 `knit`（不区分大小写，或任何引号/反斜杠拆分可能涉及 `knit`，最稳妥策略：含 `eval`、`sh`/`bash`/`zsh`/`dash`/`ksh`、`$()` / 反引号 `` ` ``、`$变量` 展开、`base64`、`source`/`.`、或反斜杠/引号紧邻字母拼接如 `k"nit"` / `k\nit` 时一律不走快路径，或者定义清晰的保守白名单/黑名单边界并在测试中证明绕过尝试全被拦截！）。
     - 推荐保守判定条件（供实现与独立审查重点核验）：仅当整条命令同时满足：
       1. 不包含 `knit`（不区分大小写）；
       2. 不包含任何 shell 展开/执行/拼接元字符或间接调用特征：不含 `` ` ``、`$`、`\`、`'`、`"`（或者允许普通双/单引号但只要出现引号/反斜杠就只在确定无 `eval`/嵌套 shell 且剥离引号与反斜杠后也不含 `knit` 时放行——最简单、最易证明安全的是：**先把命令中的单引号、双引号和反斜杠去掉再做不区分大小写的 `knit` 子串检查，且原命令不含 `$`、`` ` ``、`\b(eval|sh|bash|zsh|dash|ksh|source)\b`**，若全不命中才走快路径！）。
     - 这样像 `ls -la`、`git status`、`git diff --stat`、`npm test`、`node --test test/a.test.mjs`、`cat "src/a.ts"`、`rg 'foo' src/` 都能 100% 命中快路径（Pi 桥接 <1 ms，`host-command.ts` 免加载 WASM），而任何 `k"n"it deliver`、`k\nit deliver`、`$CMD deliver`、`$(echo knit) deliver`、`eval ...`、`sh -c ...` 全都进入 `sh-syntax` 完整解析，绝无安全回退！
2. **消除 WorkBuddy 钩子脚本的双重 Node 启动（`assets/templates/workbuddy/knit-hook.sh`）**：
   - 保留 `PATH` 前置逻辑和 Node < 24 时回退登录 shell 的行为；
   - 去掉 `node -e '...'` 二次启动：改为通过 `node -v`（POSIX shell 字符串截取 `v="${v#v}"; major="${v%%.*}"` 校验 `major >= 24`，实测仍需启动一次轻进程但避免跑 JS 引擎初始化，或者更优：**直接检查 `knit` 存在且在单次启动中校验，或 `node -v` 极速路径**；若本机 `node -v` 耗时显著低于 `node -e`，或能通过 `command -v knit` 结合 `knit` 自身/登录 shell 回退实现单次启动，优先采用单次 Node 启动且在 Node 22 模拟环境下完整验证回退登录 shell 仍生效！）。
- **已明确的验收边界（消除歧义）**：快路径只需与**现有 `inspectHostCommand` AST 检查严格行为等价（不改变既有交付核对边界，仅保证不新增任何漏检）**——现有 AST 检查本就不解析 `npm test` 内部脚本或运行时才确定的动态命令名。因此，只要命令满足下述保守判定条件即走快路径，所有会被现有 AST 识别为 `knit`、`eval`、嵌套 shell（`sh`/`bash`/`zsh`/`dash`/`ksh`）或动态/混淆 `knit` 调用的命令全部进入完整 `sh-syntax` 解析：
     - 保守判定条件：把命令中的单引号、双引号和反斜杠剥离后做不区分大小写的 `knit` 子串检查，若**不含 `knit`**，且原命令**不含 `$`、反引号 `` ` ``、且不含 `\b(eval|sh|bash|zsh|dash|ksh)\b`（也不含以这些名字结尾的路径可执行名）**，即可安全走快路径直接返回 `{ command, quotes: [] }`（Pi 桥接同步使用同一保守判定跳过 `knit hook pi tool-call` 子进程启动）。
   - WorkBuddy 钩子脚本（`assets/templates/workbuddy/knit-hook.sh`）改用 `node -v` + POSIX shell 字符串截取校验 Node ≥ 24 即可，不再要求消除 `node -v` 进程本身（保留 Node 22 与缺失 `knit` 时回退登录 shell 的守卫）。

**明确不做 / 边界**：
- 不改变任何命中 `knit deliver` / `knit context --use/--unuse` / `knit task new` / `knit run start` 时的解析、改写与授权核对行为。
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）以及 `.pi/extensions/knit.ts`（只改模板 `assets/templates/pi/extensions/knit.ts` 和 `assets/templates/workbuddy/knit-hook.sh`）。

## 完成条件

### Requirement: 命令快路径绝对不削弱交付授权核对与命令改写
#### Scenario: 常见非 Knit 命令走快路径，跳过 WASM 解析与 Pi 子进程启动
- WHEN 在 `inspectHostCommand` 或 Pi 桥接 `tool_call` 中执行普通命令（如 `ls -la`、`git status`、`npm test`、`cat "README.md"`、`grep 'hello' src/`）
- THEN 直接放行且不改写命令；Pi 桥接不启动 `knit hook pi tool-call` 子进程（通过测试中计数/观测验证）

#### Scenario: 所有 Knit 命令与混淆/间接调用均进入完整 AST 核对
- WHEN 执行包含 `knit deliver`、`knit context --use`、`knit task new`、`knit run start`，或包含引号/反斜杠拼接（如 `k"nit" deliver`、`k'n'it deliver`、`k\nit deliver`）、变量展开（`$CMD deliver`）、命令替换（`$(printf knit) deliver`）、`eval` 或嵌套 shell（`sh -c ...` / `bash -c ...`）的命令
- THEN 全部进入完整解析流程，未授权的 `deliver` 全部被拦截，合法预览、合法原话授权及 `context --use` / `task new` / `run start` 的环境改写与原有测试 100% 一致

### Requirement: WorkBuddy 钩子脚本减少进程启动且保持 Node 24 版本守卫
#### Scenario: WorkBuddy 钩子在 Node ≥ 24 与旧版 Node 22 环境下均行为正确
- WHEN 在正常 Node ≥ 24 环境和模拟 PATH 优先命中旧版 Node 22 的环境下执行 `assets/templates/workbuddy/knit-hook.sh`
- THEN Node ≥ 24 环境不再调用 `node -e` 做额外 JS 执行检查且能直接执行 `knit hook workbuddy`；PATH 优先命中 Node 22 或缺少 `knit` 时仍正确回退到登录 shell 执行

## 待澄清

## 相关资料

- `src/application/host-command.ts` — 共享宿主命令 AST 解析与交付授权核对
- `assets/templates/pi/extensions/knit.ts` — Pi 主会话 `tool_call` 钩子模板
- `assets/templates/workbuddy/knit-hook.sh` — WorkBuddy 桌面钩子启动脚本模板
- `test/host-hook.test.mjs` — Antigravity 与 WorkBuddy 钩子及授权核对测试
- `test/bridge.test.mjs` — Pi 桥接模板与 `tool_call` 测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`node --test test/host-hook.test.mjs test/bridge.test.mjs test/init.test.mjs`，以及 `tsc -p tsconfig.templates.json`（含在 `bridge.test.mjs` 中）、`npm run pack:check` 与全量 `npm test`，全部通过。
- 本任务为 `independent` 独立审查任务，实现后将派发独立审查环节核对所有安全边界；改动留在任务 Worktree 分支，不自行提交。

## 结果

已为宿主命令钩子增加与现有 sh-syntax AST 严格等价的保守快路径（host-command.ts 与 Pi 桥接模板普通命令跳过 WASM 加载与 CLI 子进程启动，Pi 钩子实测中位耗时降至 0.00025 ms），并将 WorkBuddy 钩子脚本由 node -e 改为 node -v + POSIX 字符串截取校验 Node >= 24，保留旧版 Node 22 与缺失 knit 的登录 shell 回退守卫。验证：独立审查 r-2677e4169244 结论 pass；npm run typecheck、npm run build、tsc -p tsconfig.templates.json、npm run pack:check、sh -n、git diff --check 通过；定向测试 44/44 通过；全量 npm test 508 通过、0 失败、7 项跨文件系统跳过。未验证：未启动真实 Pi 或 WorkBuddy 桌面客户端。
