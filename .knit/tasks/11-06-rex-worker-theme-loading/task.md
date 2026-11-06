---
id: k-9cf83cf5f2a7
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T10:01:01.170Z
title: Rex 子进程不再强制禁用主题
---

# Rex 子进程不再强制禁用主题

## 目标与边界

现象：Rex 浮层中的 Pi TUI 启动时报 `Failed to load theme "simplify-light"/"simplify-dark": Theme not found`，回退系统主题；主会话正常。用户当前使用 simplify-light。

根因（已复现）：

- `src/application/rex-launcher.ts` 的 `buildRexPiArgs` 固定传入 `--no-themes`。
- Pi 1.5.0 在 `--no-themes` 下禁用主题发现，但仍按 settings 的 `theme` 解析自定义主题名；找不到就报错并回退系统主题。
- `pi --no-themes`（TUI）可复现；`pi` 不带该参数正常；`pi --no-themes --use-theme system` 不报错但使用系统主题。
- “This project is not trusted”来自 `--no-approve`，与本问题无关；用户级主题包不受项目信任影响。

目标：去掉 Rex 子进程的 `--no-themes`，让 Rex 中的 Pi TUI 使用用户当前主题（simplify-light/dark），与主会话一致。本地 RPC 子进程没有 TUI、不会显示该错误，本次不改。

边界：

- 只改 `buildRexPiArgs` 的参数列表；保留 `--no-approve`、`--no-context-files`、`--no-prompt-templates`、扩展／工具／MCP／技能开关和参数顺序中其余项。
- 不修改主题包、Pi settings、`--use-theme` 或上游 Pi。
- 不修改 `src/adapters/pi/runtime.ts` 的本地 `--no-themes`；如需统一另起任务。
- 子进程在 worktree 中仍使用同一 agent 目录；用户级主题不依赖项目信任。

## 完成条件

- `buildRexPiArgs` 不再输出 `--no-themes`，其余参数与顺序不变。
- 测试：扩展 `test/rex.test.mjs` 的 buildRexPiArgs 用例，断言不含 `--no-themes`、仍含 `--no-approve` 等关键项；运行受影响测试。
- 手动验证：Knit 项目中 `pi`（不带 `--no-themes`）启动 TUI 无主题错误；带 `--no-themes` 可复现错误（只作根因说明，不在测试中启动真实 TUI）。
- 文档：在 DESIGN 的 Rex 段落补一句 Rex 子进程沿用用户主题、不强制禁用主题发现，或等价说明。
- 报告 `changedPaths`／`validation`；不提交、不推送。

## 输入引用

- 用户报告：Rex 子进程一直识别不到主题；当前使用 simplify-light；选择去掉 Rex 的 `--no-themes`。
- 代码：`src/application/rex-launcher.ts` 的 `buildRexPiArgs`、`test/rex.test.mjs` 的 buildRexPiArgs 用例；本地参数在 `src/adapters/pi/runtime.ts`（本次不改）。
- 规范：`docs/design/DESIGN.md` §5 REX 呈现、`docs/design/OPERATIONS.md` §5；Pi 1.5.0 themes 文档（`--no-themes` 禁用发现，`--use-theme` 选初始主题）。
- 复现命令：`pi --no-themes`（TUI）报 Theme not found；`pi` 正常；`pi --no-themes --use-theme system` 无报错。

## 验证方式

self：实施者运行受影响测试与 `npm test`（全量失败若是既有环境问题，按基线说明），报告实际改动与未验证项。真实 Rex 浮层在下一次 run 使用新参数后确认无主题错误。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 主会话复核（verification=self）

- `npm run -s typecheck`：pass。
- `TMPDIR=/tmp node --test test/rex.test.mjs`：15/15 pass；buildRexPiArgs 用例断言不再含 `--no-themes`，其余开关顺序保持。
- 直接检查 `dist/application/rex-launcher.js` 的 `buildRexPiArgs` 输出：`has --no-themes: false`，`has --no-approve: true`。
- 手动 TUI 复核（Knit 项目）：`pi --no-themes` 报 Theme not found；`pi` 不带该参数正常加载 simplify-light/dark。根因与修复方向一致。
- 本轮实现 run 的 Rex 浮层由其启动时的旧参数创建，仍可能显示旧错误；下一次使用新构建的 run 才使用新参数。主题包本身未修改。
- 全量 npm test 523 项中 519 通过、4 失败，均为既有 macOS 环境问题（host-selection PATH、kill EPERM、/var 与 /private 路径）。
- 工作区仅 `docs/design/DESIGN.md`、`src/application/rex-launcher.ts`、`test/rex.test.mjs` 三处改动；未提交、未推送。

### 交付记录

<!-- knit:delivery:op-d6e06fbc8081 -->
- 操作: op-d6e06fbc8081
- 时间: 2026-11-06T12:32:50.788Z
- 分支: refs/heads/main
- 授权来源: user:chat#提交推送归档
- 工作提交: 2e5990a2e64da08b9d1a7c42928d33f4eefa8138
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-rex-worker-theme-loading

<!-- knit:progress:end -->
