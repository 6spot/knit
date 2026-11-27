---
id: k-5ead32984c04
title: 优化 CLI hook 懒加载与 canSkipHostCommand 快路径
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P1
createdAt: 2026-11-27T08:42:35.082Z
---

## 目标与范围

背景：
- 宿主在每次工具调用（如 Antigravity `PreToolUse`、WorkBuddy / Qoder `pre-tool-use`、Pi `tool-call`）都会触发 `knit hook ...`。目前 `src/cli/knit.ts` 在模块顶层静态导入 `commander`、全部普通子命令模块和 `./shared.js`（进而拉入 `task-store`、`project-config`、`yaml` 等），且三个命令型宿主适配器（`antigravity/host-hook.ts`、`qoder/host-hook.ts`、`workbuddy/host-hook.ts`）在顶层静态导入 `application/host-hook.ts` 中的 `hostContext`（进而拉入 `session-context` 与 `task-store`），导致普通命令的钩子放行快路径耗费大量无关模块加载时间。
- `canSkipHostCommand`（位于 `src/application/host-command.ts` 并镜像于 `assets/templates/pi/extensions/knit.ts`）当前的正则将任意空白前的 `.` 及 `\b(sh|bash|zsh|dash|ksh|...)\b` 一律判为不可跳过，导致 `find .`、`rg foo .`、`git add .`、`cat scripts/build.sh`、`rg sh-syntax src/` 等高频普通命令频繁误触发 `sh-syntax` WASM 解析（在 Pi 中还会额外拉起子进程）。

范围：
1. **CLI `hook` 入口短路与懒加载**（`src/cli/knit.ts`）：
   - 保留 `stdout`/`stderr` 的 `EPIPE` 处理逻辑。
   - 在加载 `commander`、读取 `package.json` 及加载普通子命令模块（`deliver`、`project`、`run`、`task`、`shared`）之前，识别直接钩子调用（`process.argv[2] === "hook"` 且仅传入宿主名与事件名两个非选项参数，排除 `-h`/`--help` 等选项），直接按 `pi` 或 `HOST_SPECS` 中的 `hook` 路由动态导入对应模块并执行。
   - 未知宿主、缺少/多余参数、包含 `-h`/`--help` 等情况，以及所有非 `hook` 子命令，均回退到原有 `commander` 路径，保持现有 CLI 行为与退出码不变。
   - 快路径与 `commander` 注册的 `hook` 动作共享执行逻辑，避免重复维护。
2. **宿主适配器 `PreToolUse` 路径与 `hostContext` 解耦**（`src/adapters/antigravity/host-hook.ts`、`src/adapters/qoder/host-hook.ts`、`src/adapters/workbuddy/host-hook.ts`）：
   - 顶层直接从 `../../application/host-command.js` 导入 `checkHostCommand`，不再在顶层静态导入 `../../application/host-hook.js`。
   - 仅在上下文注入事件（Antigravity 的 `SessionStart`/`PreInvocation`，WorkBuddy / Qoder 的 `session-start`/`user-prompt-submit`）分支内动态 `await import("../../application/host-hook.js")` 读取 `hostContext`。
   - 保持 `src/application/host-hook.ts` 对外导出不变。
3. **收紧 `canSkipHostCommand` 减少误判同时坚守安全边界**（`src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts`）：
   - 保持两处实现完全一致。
   - 保留对 `$`、`` ` ``、`\` 及不区分大小写的 `knit` 子串的保守拦截（一律不可跳过）。
   - 对 `eval|sh|bash|zsh|dash|ksh|source|base64` 排除前后紧贴词字符、`.` 或 `-` 的误杀（如 `scripts/build.sh`、`foo.bash`、`sh-syntax`、`--dash`、`source-map` 可走快路径；`sh -c`、`/bin/bash`、`./sh`、`env bash`、`eval ...`、`source setup`、`base64 file`、`b"ash" -c` 等仍必须拦截）。
   - 对 dot-source 命令 `.` 仅在可能处于命令起始上下文时拦截（包括行首/字符串开头、控制符与分组 `[;\r\n&|(){}!]` 之后、环境变量赋值 `=[^\s]*` + 空白之后、重定向 `[<>][ \t]*[^\s]+` + 空白之后、以及 shell 命令前缀关键字 `if|then|elif|else|while|until|do|time|coproc|builtin|command|exec|nohup` 加可选标志 + 空白之后），避免 `find .`、`rg foo .`、`git add .`、`git diff -- .`、`ls .` 等参数位置上的 `.` 误触发，同时确保 `. setup`、`true && . setup`、`FOO=1 . setup`、`if true; then . setup; fi`、`command -p . setup`、`</dev/null . setup`、`"" . setup` 等所有可执行 dot-source 形式均不可跳过。
   - 注意避免正则回溯风险（ReDoS）。
4. **测试补充**（`test/host-hook.test.mjs` 等相关测试）：
   - 为 `canSkipHostCommand`（同时校验 `src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts`）补充常见误杀回归用例（`find .`、`find . -name '*.ts'`、`rg foo .`、`git add .`、`git diff -- .`、`cat scripts/build.sh`、`rg sh-syntax src/`、`npm test -- --dash`、`rg --path=. foo` 等）与完整安全绕过矩阵（各类命令起始 `.` 变形、引号拼接、路径前缀 `./sh` / `/bin/bash`、重定向/赋值/关键字后 `.`、`$VAR`、反引号、反斜杠、`knit` 等）。
   - 补充懒加载验证：通过模块加载钩子或子进程实测，确认 `knit hook agy PreToolUse` / `workbuddy pre-tool-use` / `qoder pre-tool-use` / `pi tool-call` 在普通命令快路径下不会加载 `commander`、`yaml`、`host-hook.js`、`session-context.js`、`task-store.js` 和 `sh-syntax`；同时验证 `knit hook --help`、`knit hook agy --help`、`knit hook pi unknown` 等非快路径行为不回归。

不在范围内：
- 不直接修改仓库里已生成的 `.agents/` 或 `.pi/` 副本，也不执行全局 `pack:install`。
- 不修改 `sh-syntax` AST 解析逻辑（`inspectCall`、`knitArguments`）或授权核对规则。

## 完成条件

### Requirement: CLI hook 快路径懒加载
直接调用 `knit hook <host> <event>` 时不加载重型 CLI 与业务依赖，同时保留非快路径的既有行为。

#### Scenario: 普通命令经过各宿主钩子快路径不加载重依赖
- GIVEN 已构建 `dist/cli/knit.js`
- WHEN 通过子进程分别调用 `knit hook agy PreToolUse`、`knit hook workbuddy pre-tool-use`、`knit hook qoder pre-tool-use` 和 `knit hook pi tool-call` 并传入普通命令（如 `git status` 或 `find .`）
- THEN 命令返回正常放行结果且退出码为 0
- AND 进程运行期间未加载 `commander`、`yaml`、`application/host-hook.js`、`application/session-context.js`、`application/task-store.js` 和 `sh-syntax`

#### Scenario: 帮助与异常参数回退到既有 commander 行为
- GIVEN 已构建 `dist/cli/knit.js`
- WHEN 调用 `knit hook --help`、`knit hook agy --help` 或 `knit hook pi unknown` 等非快路径参数
- THEN 帮助输出、错误提示与退出码与改造前一致

### Requirement: 宿主适配器按事件懒加载 hostContext
Antigravity、WorkBuddy、Qoder 宿主适配器仅在上下文注入事件时动态加载 `application/host-hook.js`。

#### Scenario: PreToolUse 路径不触发 hostContext 模块加载
- GIVEN 仅调用 `agyHostHook("PreToolUse", ...)`、`qoderHostHook("pre-tool-use", ...)` 或 `workbuddyHostHook("pre-tool-use", ...)`
- WHEN 传入普通命令或 Knit 命令
- THEN 不加载 `application/host-hook.js`（以及 `session-context.js`、`task-store.js`）
- AND 对 Knit 命令的改写与授权拒绝行为保持不变

#### Scenario: 上下文注入事件正常工作
- GIVEN 一个已初始化 Knit 的项目目录
- WHEN 触发 `SessionStart` / `PreInvocation` 或 `session-start` / `user-prompt-submit`
- THEN 正常加载 `hostContext` 并按既有协议返回注入上下文

### Requirement: canSkipHostCommand 减少误杀且坚守安全边界
`src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts` 中的 `canSkipHostCommand` 保持一致，对高频普通命令放行，对所有潜在绕过或可执行命令保守拦截。

#### Scenario: 高频普通命令走快路径不触发 sh-syntax
- GIVEN `src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts` 导出的 `canSkipHostCommand`
- WHEN 传入 `find .`、`find . -name '*.ts'`、`rg foo .`、`git add .`、`git diff -- .`、`ls .`、`cat scripts/build.sh`、`rg sh-syntax src/`、`npm test -- --dash`、`rg --path=. foo`
- THEN 两处 `canSkipHostCommand` 均返回 `true`
- AND `inspectHostCommand` 不加载 `sh-syntax`

#### Scenario: 绕过变体与命令起始点号均进入完整解析
- GIVEN `src/application/host-command.ts` 与 `assets/templates/pi/extensions/knit.ts` 导出的 `canSkipHostCommand`
- WHEN 传入 `. setup`、`true && . setup`、`FOO=1 . setup`、`if true; then . setup; fi`、`command -p . setup`、`</dev/null . setup`、`"" . setup`、`(. setup)`、`{ . setup; }`、`! . setup`、`./sh -c true`、`/bin/bash -c true`、`b"ash" -c true`、`eval 'knit deliver id'`、`source setup`、`base64 file`、`k"nit" deliver id`、`$CMD deliver`、``echo `date` ``、`k\nit deliver id`
- THEN 两处 `canSkipHostCommand` 均返回 `false`
- AND `inspectHostCommand` 加载 `sh-syntax` 并正确检出或改写受控 Knit 命令

### Requirement: 全量构建与测试验证通过
改造后类型检查、编译与全量测试全部通过。

#### Scenario: 完整验证回归
- WHEN 运行 `npm run typecheck && npm run build && npm test`
- THEN 类型检查、编译和所有非跳过用例全部通过

## 待澄清

无。

## 相关资料

- [src/cli/knit.ts](src/cli/knit.ts)
- [src/application/host-command.ts](src/application/host-command.ts)
- [src/application/host-hook.ts](src/application/host-hook.ts)
- [src/adapters/antigravity/host-hook.ts](src/adapters/antigravity/host-hook.ts)
- [src/adapters/qoder/host-hook.ts](src/adapters/qoder/host-hook.ts)
- [src/adapters/workbuddy/host-hook.ts](src/adapters/workbuddy/host-hook.ts)
- [assets/templates/pi/extensions/knit.ts](assets/templates/pi/extensions/knit.ts)
- [test/host-hook.test.mjs](test/host-hook.test.mjs)

## 结果

完成 CLI hook 快路径懒加载、三个命令型宿主适配器 hostContext 动态导入，以及应用层与 Pi 模板 canSkipHostCommand 的防误杀与安全边界收紧；审查修复了两类点号命令边界并补充回归用例，npm run typecheck && npm run build && npm test 通过（554/561 通过，7 项跨文件系统测试跳过），独立审查 pass。
