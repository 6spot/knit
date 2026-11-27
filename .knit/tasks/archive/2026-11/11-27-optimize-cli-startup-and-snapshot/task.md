---
id: k-f331f86e46a8
title: 优化 CLI 与钩子冷启动懒加载、快照免重算哈希与桌面脚本兼容
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-3ad44485c09e
  - k-98e125987b31
  - k-48ccd026c70d
priority: P2
createdAt: 2026-11-27T13:37:26.713Z
---

## 目标与范围

针对日常最高频的 CLI 与钩子冷启动路径、交付预览快照哈希以及桌面宿主启动脚本做定向性能优化与跨 Shell 兼容修复，在不引入常驻进程或外部状态的前提下明显降低响应延迟。

### 具体改动与思路

1. **CLI 按子命令懒加载与入口容错（`src/cli/knit.ts`、`src/cli/project.ts`、`src/cli/run.ts`）**：
   - `knit.ts` 改为按一级子命令（`init`/`workflow`/`task`/`standards`/`run`/`context`/`deliver`/`hook`）按需动态导入对应命令模块，不再在任何简单命令（如 `--version`、`knit context`、`knit task list`）启动时一次性全量加载 136 个模块。
   - 将重量级的 `src/adapters/agents.js` 与 `src/adapters/rex/pane.js` 从 `cli/project.ts`、`cli/run.ts` 顶层静态导入改为在真正需要派发/取消/worker/`workflow validate --env` 时按需动态导入。
   - `knit.ts` 对 `hook` 入口的 `JSON.parse(readFileSync(0, "utf8"))` 补 `try/catch` 友好报错退出；在入口补清晰的 Node < 24 提示。
   - 消除单条 CLI 命令内对 `projectRoot`（及其 `git rev-parse` 子进程）的重复调用。
2. **零依赖 `hostProjectRoot` 前置判断（`src/application/host-hook.ts`、`src/adapters/{antigravity,qoder,workbuddy}/host-hook.ts`）**：
   - 将 `hostProjectRoot` 抽离为独立的零重依赖模块（符合 `.knit/standards/development.md` 的“延迟加载边界”建文件准则）。
   - Antigravity、Qoder、WorkBuddy 三个宿主钩子在 `SessionStart`/`PreInvocation`/`UserPromptSubmit` 中先调用轻量的 `hostProjectRoot` 判断当前目录是否在 Knit 项目内，不在 Knit 项目内时直接返回空结果，跳过动态导入 110 模块的 `host-hook.js`（及 `session-context`/`yaml`/`pi-schema`）。
3. **快照 `matchingFingerprints` 消除重复整文件哈希（`src/application/workspace.ts`）**：
   - `matchingFingerprints` 在期望指纹以 `"git "` 开头时，仅调用 `lstatSync` 检查文件类型与可执行位，直接送入 `gitFingerprints`（`git hash-object`），彻底免去先 `fingerprint()` 整文件 `readFileSync` + SHA-256 又丢弃哈希再让 Git 重读一遍的双倍 I/O。
   - 适当提高 `gitFingerprints` 的 `batchSize`（如 256）减少大改动集时的 `git hash-object` 子进程次数，并对并发删文件做好安全容错。
4. **桌面钩子脚本兼容与免双启 Node（`assets/templates/qoder/knit-hook.sh`、`assets/templates/workbuddy/knit-hook.sh`）**：
   - 调整 `PATH` 拼接顺序：优先保留用户已有 `$PATH`（避免前置 `/usr/local/bin` 等目录中的旧版 Node 反向覆盖用户已配好的 Node 24），再将常见目录及主流版本管理器目录（含 Homebrew、`.local/bin`、Volta、asdf、mise、fnm 等）补充到合适位置；尽量避免在每次 `PreToolUse` 调用时既冷启一次 `node -v` 又启一次 `knit` 的双 Node 启动税（同时确保低版本 Node 时仍能正确回退登录 shell）。
   - 回退执行登录 shell 时仅对已确认兼容 POSIX `$1` 的 shell（`*/sh|*/bash|*/zsh|*/ksh`）使用 `-lc`，对 `fish`/`nu`/`tcsh` 及无 `/bin/zsh` 的 Linux 环境安全回退 `/bin/sh -lc`。

### 边界与约束

- 不改变任何 CLI 子命令的用法、参数、退出码、帮助输出与钩子响应协议。
- 不改变 `matchingFingerprints` 对纯字节指纹和混合指纹的既有语义，仅优化 `"git "` 期望值的读盘路径。
- 涉及公共 CLI 入口、高风险 `workspace.ts` 快照函数及桌面桥接脚本模板，须运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`，并实测对比 CLI 与非 Knit 目录钩子耗时。

## 完成条件

### Requirement: CLI 与非 Knit 目录钩子冷启动懒加载提速
#### Scenario: 简单命令与非 Knit 目录钩子不再加载无关重模块
- WHEN 在非 Knit 目录触发 `knit hook agy PreInvocation` / `qoder` / `workbuddy`，或运行 `knit --version`、`knit context`
- THEN 非 Knit 目录钩子不加载 `host-hook`/`session-context`/`yaml`；常规 CLI 仅加载当前子命令所需模块，实测耗时较优化前基线（~54ms / 65–95ms）有可复现下降；钩子 stdin 为空或坏 JSON 时友好退出不打裸堆栈

### Requirement: matchingFingerprints 消除重复整文件读盘与哈希
#### Scenario: 审查快照校验对 git 指纹文件不再执行无用整文件 SHA-256
- WHEN 调用 `matchingFingerprints` 校验含 `"git "` 指纹的审查通过快照（含正常、改动、类型变化及并发删除场景）
- THEN 结果与原有语义完全一致，且不再对 `"git "` 候选文件重复执行整文件 `readFileSync` + SHA-256

### Requirement: 桌面钩子脚本 PATH 优先级与跨 Shell 兼容
#### Scenario: 已有 Node 24 PATH 不被旧版覆盖且非 POSIX SHELL 正常执行
- WHEN 环境 `PATH` 已提供 Node 24、以及 `$SHELL` 设为 `fish` 或未设置（Linux 无 `/bin/zsh`）时运行 `knit-hook.sh`
- THEN 优先命中用户原有 Node 24 而不被前置目录旧 Node 覆盖；非 POSIX `$SHELL` 场景回退安全执行不报 `$1` 语法错

### Requirement: 构建、打包校验与全量回归通过
#### Scenario: 类型检查、pack:check 与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 9 节命令入口与桌面钩子脚本说明
- `docs/AGENT-INTEGRATION.md` — WorkBuddy 与 Qoder 钩子协议
- `.knit/standards/development.md` — 延迟加载边界、性能与测试规范
- `src/cli/knit.ts` — CLI 主入口
- `src/application/host-hook.ts` — `hostProjectRoot` 与会话上下文钩子
- `src/adapters/antigravity/host-hook.ts` — Antigravity 宿主钩子
- `src/adapters/qoder/host-hook.ts` — Qoder 宿主钩子
- `src/adapters/workbuddy/host-hook.ts` — WorkBuddy 宿主钩子
- `src/application/workspace.ts` — `matchingFingerprints` 与 `gitFingerprints`
- `assets/templates/qoder/knit-hook.sh` — Qoder 钩子启动脚本模板
- `assets/templates/workbuddy/knit-hook.sh` — WorkBuddy 钩子启动脚本模板

## 结果

四个验收场景通过。macOS arm64 与 Node 24.16.0 的独立复测中，版本命令冷启动中位数 65.87→30.09 ms，非项目钩子仅加载 5 个模块、约 31 ms。512 个 32 KiB 文件的匹配结果一致，Node 整文件读取 512→0 次，Git 哈希进程 16→2 次。旧 Node 登录 shell 回退保留事件输入，非 POSIX shell 已在 macOS 上验证。独立审查 r-cc4573383410 通过，最终宿主类型检查、构建、打包、git diff --check 和跨卷全量 671/671 通过，0 失败、0 跳过。审查记录一个既有边界，合法 JSON null 传入 Pi tool-call 仍会报 TypeError。
