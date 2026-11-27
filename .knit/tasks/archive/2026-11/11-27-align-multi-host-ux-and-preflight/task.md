---
id: k-48ccd026c70d
title: 对齐多宿主上下文与规范指引、补齐预检初始化并修复文档死链
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-98e125987b31
  - k-3e85bbaa5d20
  - k-3b3852762282
priority: P1
createdAt: 2026-11-27T13:37:26.604Z
---

## 目标与范围

全面对齐四大宿主（Pi、Antigravity、WorkBuddy、Qoder）与普通 CLI 的内置规范、任务状态下一步指引、角色模板、环境预检与初始化告警，收口分裂的三套项目根定位逻辑，并修复 `docs/AGENT-INTEGRATION.md` 的 3 处死链。

### 具体改动与思路

1. **多宿主规范、角色模板与下一步指引对齐（`assets/standards/discussion.md`、`assets/templates/agents/{implement,review}.md`、`src/application/session-context.ts`）**：
   - `assets/standards/discussion.md`：将“这几种派给执行者（`knit run start`）”等表述调整为不与 WorkBuddy/Qoder 原生子 Agent 模式正面冲突的写法（按当前宿主方式派发外部执行者或使用原生子 Agent，具体命令遵循宿主指引）。
   - `assets/templates/agents/implement.md` 与 `review.md`：更新“在第一条消息里”等措辞，使其同时准确覆盖默认开启 `resume: true` 时的续聊增量消息。
   - `src/application/session-context.ts`：
     - `nextLine` 在 `dispatchMode === "native"` 时妥善处理 `step.kind === "arbitrate"`（不再向 WorkBuddy/Qoder 输出会被自家钩子拦截的 `knit run start --instruction`）；
     - `step.kind === "close"` 补全必填 `--result <总结>`；
     - 支持区分工具式宿主（如 Pi 可通过参数或环境变量感知，提示 `knit_task` / `knit_run` / `knit_deliver` 而不再引导 Pi 去跑必然失败的 `knit context --unuse`）；
     - `statusLines` 补齐 `（确认后改过需求）` 警示（与 `task list`/`task show` 对齐）；`contextLines` 在环节无补充规范时省略冗余空行以对齐 `contextBlocks`；
     - `host-hook.ts` 任务读不出分支一并保留 `pitfalls` 与 `guidance`（若尚未发送）；
     - `buildTaskStatus` 对运行中成员批量一次 `processIdentities` 判活；替换硬编码 `"pi"` 为 `DEFAULT_AGENT`；
     - 对已交付终态任务按 task/record 版本避免每轮钩子重复全仓扫 `git log` 查 `taskCommit`。
2. **环境预检、流程展示、初始化告警与项目根收口（`src/application/init.ts`、`src/cli/{shared,project,run,deliver}.ts`、`src/application/delivery.ts`）**：
   - `cli/project.ts`：`reportEnvironment`（`workflow validate --env`）在推导出 `agent = executor.agent ?? session` 后，调用 `validateAgentTarget({ agent, model, thinking })` 核对模型与思考等级兼容性，杜绝“预检就绪、派发立拒”；`workflow show` 在环节中补展示 `resume` 状态、对省略 `agent` 的执行器准确标注依赖派发入口（不硬套 Pi 缺省）、将进入次数上限标签写清晰（与首次后再进的语义一致，消除 +1 歧义）。
   - `application/init.ts`：`initGuidance` 区分“用于 `--force` 探测已有桥接（`some`）”与“用于完整性告警（`every` 并明确列出缺失的具体钩子事件，防漏合 `PreToolUse`）”；宿主引导命令按 `HOST_SPECS` 的 `optionOrder` 排序；区分可派发宿主与纯原生桌面宿主的后续引导文案。
   - `cli/shared.ts`、`cli/project.ts`、`application/host-hook.ts`：统一 `projectRoot`、`hostProjectRoot` 与 `validationRoot` 的项目根定位规则，使非 Git 子目录和独立初始化 `.knit/` 的子目录在所有命令与钩子下行为一致；`loadWorkflow` 像 `knitRoot`/`loadTask` 一样统一调用 `fail()` 设 `process.exitCode = 1`，消除 6 处调用点手工补退出码。
   - CLI 输入防御与文案收口：`cli/run.ts` 为 `--instruction-file` 补友好存在性/文件类型报错（与 `--message-file` 对齐），复用 `THINKING_LEVELS` 常量，清理未用 `RUNS_DIR` 导入与零外部引用的 `export { statusLines }`；`cli/deliver.ts` 与 `delivery.ts` 将 `--authorization` 描述对齐为明确要求“用户同意交付的原话（整条或完整一行）”；`cli/project.ts` 修复 `standards record` 空/尾逗号 `--section` 报错残缺，以及 `standards pitfalls` 在 `pitfalls.md` 开头声明损坏时应报错而非返回退出码 0。
3. **文档死链修复与设计同步（`docs/AGENT-INTEGRATION.md`、`docs/design/DESIGN.md`）**：
   - 修复 `docs/AGENT-INTEGRATION.md` 3 处因文件归并失效的链接（`agent-target.ts` → `domain/workflow.ts`、`run-session.ts` → `application/run-execute.ts`、`run-report-retry.test.mjs` → `test/run-execute.test.mjs`），并同步 `docs/design/DESIGN.md` 相关章节。

### 边界与约束

- 不修改 `src/cli/knit.ts` 的懒加载入口与 `assets/templates/{qoder,workbuddy}/knit-hook.sh`（归 `k-f331f86e46a8`），不修改 `src/application/host-command.ts`（已在 `k-98e125987b31` 完成）。
- 修改了内置规范与模板，须运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`（测试追加到 `test/context.test.mjs`、`test/init.test.mjs`、`test/workflow-cli.test.mjs`、`test/standards.test.mjs`、`test/deliver.test.mjs`、`test/host-hook.test.mjs`）。

## 完成条件

### Requirement: 多宿主规范、状态指引与模板一致无冲突
#### Scenario: 原生宿主待裁决、Pi 上下文指引与 stale 状态提示准确
- WHEN WorkBuddy/Qoder 选中处于 `arbitrate` 的任务、Pi 读取已结束任务的上下文、或选中需求确认后被改过的任务
- THEN 原生宿主不再推荐 `knit run start`；Pi 不再被引导去执行必然失败的 `knit context --unuse`；状态块明确标出 `（确认后改过需求）` 且 `close` 提示包含 `--result`

#### Scenario: discussion.md 与角色模板适配原生宿主和默认续聊
- WHEN 检查内置 `discussion.md` 与 `implement.md`/`review.md` 模板
- THEN 不再与 WorkBuddy/Qoder 原生流程冲突，且角色说明覆盖续聊增量消息

### Requirement: 预检、初始化完整性核查与 CLI 一致性
#### Scenario: workflow validate --env 检出省略 agent 时的不兼容模型/思考等级，workflow show 显示 resume
- WHEN `workflow.yaml` 省略 `agent` 且配置与当前入口不兼容的 `model` 或 `thinking` 并运行 `knit workflow validate --env`；或运行 `knit workflow show`
- THEN `--env` 报出具体的模型/思考等级不兼容问题并返回退出码 1；`workflow show` 展示各环节 `resume` 配置且不误导省略 `agent` 的缺省来源

#### Scenario: initGuidance 检出残缺桌面钩子、项目根定位统一且 CLI 边界报错友好
- WHEN 已有 `.qoder/settings.json` 只合入了 `SessionStart` 而缺失 `PreToolUse`、在非 Git 子目录运行 `knit task list` 与 `knit context --use`、传入不存在的 `--instruction-file` 或损坏的 `pitfalls.md` 调 `standards pitfalls`
- THEN `initGuidance` 明确点名缺失的 `PreToolUse` 钩子；非 Git 子目录各命令根定位一致；`--instruction-file` 与损坏 `pitfalls.md` 返回友好中文报错与非零退出码

### Requirement: 文档零死链且打包与全量回归通过
#### Scenario: 文档链接检查、pack:check 与全量测试通过
- WHEN 校验 `docs/AGENT-INTEGRATION.md` 所有相对链接并运行 `npm run typecheck`、`npm run build`、`npm run pack:check` 及全量 `npm test`
- THEN 文档零死链且所有检查与测试通过

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 4、5、6、9、10 节规范、上下文、预检与初始化说明
- `docs/AGENT-INTEGRATION.md` — 宿主接入协议（含 3 处待修死链）
- `assets/standards/discussion.md` — 内置讨论规范
- `assets/templates/agents/implement.md` — 实现角色模板
- `assets/templates/agents/review.md` — 审查角色模板
- `src/application/session-context.ts` — 主会话上下文与任务状态渲染
- `src/application/init.ts` — 初始化与桥接引导检查
- `src/cli/shared.ts` — 项目根与 `loadWorkflow`
- `src/cli/project.ts` — `init`/`context`/`standards`/`workflow` 命令
- `src/cli/run.ts` — `run` 命令与 `--instruction-file`
- `src/cli/deliver.ts` — `deliver` 命令文案

## 结果

五个验收场景通过。按实际宿主显示派发、裁决、收尾和取消选择指引。环境预检核对省略执行器时的模型与思考等级，初始化能列出缺失钩子，接入文档 40 处相对链接全部有效。独立审查 r-4bf8c74e65f7 修复宿主变量污染普通 CLI 夹具，以及 Git 引用变化后已交付任务的提交缓存失效。修正后在保留真实 Pi 环境的宿主工作树通过类型检查、构建、打包、git diff --check 和跨卷全量 670/670，0 失败、0 跳过。
