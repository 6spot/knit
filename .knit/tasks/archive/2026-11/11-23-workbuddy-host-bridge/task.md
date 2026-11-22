---
id: k-eaa1664e9b5f
title: 实现 WorkBuddy 薄钩子协议入口、--workbuddy 模板与 GUI 降级适配
status: delivered
stage: null
verification: independent
parent: k-a9c3c3ddec63
dependsOn:
  - k-ea0e6d690522
  - k-fdb8c6110481
priority: P1
createdAt: 2026-11-22T16:23:26.707Z
---

## 目标与范围

依据前置探针任务 `k-fdb8c6110481` 产出的实测结论（`research/workbuddy-hooks.md`），复用 `k-9c0e2fa7c112` 建立的共用钩子内核 `src/application/host-hook.ts`，以零 MCP 方式接入 WorkBuddy 作为 Knit 主会话宿主，并落齐桌面 GUI 降级适配：

1. **WorkBuddy 薄协议翻译入口（`knit hook workbuddy <event>`，隐藏子命令）**：
   - 仅做协议翻译（不重复写任何会话状态、去重或授权匹配核心逻辑，全部委托 `src/application/host-hook.ts`）：
     - 将 WorkBuddy 真实 stdin 字段（如 `session_id`、`cwd`、`transcript_path`、`tool_input.command`）映射为共用内核入参；
     - 在会话启动与每轮用户提交事件中，按实测有效的输出格式注入变更后的 `knit context`（内容不变跳过注入，无 `.knit/` 静默退出 0 无输出）；
     - 在 `PreToolUse`（匹配实测 Bash 工具名）中：
       - 拦截非 `--preview` 的 `knit deliver`，按实测 transcript 格式只读提取当前会话用户消息列表交由共用内核核对原话授权，未通过按实测协议拒绝（如 `exit 2` 或 JSON `deny`）；
       - 执行 `knit context --use`／`--unuse` 时透传 `KNIT_HOST=workbuddy` 与 `KNIT_HOST_SESSION`；
       - **绝不**为 `knit run start` 设置 `KNIT_SESSION_AGENT=workbuddy`（WorkBuddy 只做主会话，派发由 `.knit/workflow.yaml` 的 `agent`/`model` 或缺省 `pi` 决定）。
2. **`knit init --workbuddy` 开关、模板与桌面 GUI 降级适配**：
   - 在 `assets/templates/` 新增 WorkBuddy 桥接模板（路径按 `k-fdb8c6110481` 实测结果确定），接入 `src/application/init.ts` 与 `src/cli/init.ts` 的 `--workbuddy` 布尔开关（可与 `--pi`、`--agy` 任意组合；`--force` 遵循已有或本次指定才恢复的规则）。
   - **桌面 GUI 降级处理**：
     - **极简 `PATH` 引导**：若探针证实 WorkBuddy GUI 默认 `PATH` 缺少 `node >= 24`、`knit`、`pi` 或 `agy`，在钩子命令入口采用探针验证通过的最小 login shell 引导（不硬编码个人绝对路径）；
     - **后台唤醒降级**：在 WorkBuddy 桥接规则文案中按探针结论写清派发等待方式——若支持后台自动唤醒则后台挂 `knit run wait <id>`；若不支持后台自动唤醒，则明确约定 `knit run start <id>` 立即返回，可按需用 `knit run wait <id> --timeout <秒>` 短等或等用户下轮发言由钩子自动注入最新完成状态，不卡死同步 Bash；
     - 同时确保 AGY 执行者隔离层（`src/adapters/antigravity/isolation.ts`）不会把 WorkBuddy 项目桥接文件当成冲突或允许执行者修改（按需加入只读/写保护边界）。
3. **补齐打包检查、文档与独立审查测试**：
   - 更新 `scripts/pack-check.mjs` 与 `docs/design/DESIGN.md`（第 2、5、9、10 节）；
   - 新增专属单测 `test/workbuddy-host-hook.test.mjs`（使用 `k-fdb8c6110481` 捕获的真实形状 stdin 与 transcript 夹具）及 `test/init.test.mjs` 的 `--workbuddy` 覆盖。

边界：
- 受保护文件（`.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 及流程引用的 `.knit/agents/`）由 `src/application/workspace.ts` 的 `protectedChanges` 强制检查，模板只写在 `assets/templates/`。
- 零 MCP、无常驻进程、不将 WorkBuddy 接入工作流执行者（Worker）。

## 完成条件

### Requirement: knit hook workbuddy 复用共用内核完成免关键词去重注入与交付原话授权拦截

#### Scenario: 真实形状 WorkBuddy stdin 与 transcript 夹具下注入、去重、选任务与授权核对全部准确

- GIVEN 按 `k-fdb8c6110481` 实测形状构造的 WorkBuddy Hook stdin 负载与会话记录夹具
- WHEN 依次测试无 `.knit/` 目录、首次注入、不变跳过、切换选中任务、普通 Bash 命令、`knit deliver --preview`、缺授权/子串/伪造原话的 `knit deliver` 与完整原话匹配的 `knit deliver`
- THEN 普通目录与不变轮次零冗余注入；切换任务后立即更新注入；普通命令与 `--preview` 放行；非法交付被拒绝且给出可继续做法；完整原话匹配放行；`knit run start` 不被错误注入 `KNIT_SESSION_AGENT=workbuddy`

### Requirement: knit init --workbuddy、打包检查与 GUI 降级测试全绿

#### Scenario: --workbuddy 按需生成桥接副本且全量测试通过

- GIVEN 临时项目目录与更新后的 `init.ts`、`pack-check.mjs`、`DESIGN.md`
- WHEN 分别运行 `knit init`、`knit init --workbuddy`、`knit init --pi --agy --workbuddy`、`knit init --force`，以及 `npm run typecheck`、`npm run pack:check` 和双终端 `npm test`
- THEN 仅在带 `--workbuddy` 时生成对应桥接文件，`--force` 仅恢复已启用或本次指定的桥接，`pack:check` 覆盖新增模板且全部测试通过

## 待澄清

## 相关资料

- `.knit/tasks/archive/2026-11/11-23-probe-workbuddy-host-hooks/research/workbuddy-hooks.md` — 前置探针任务产出的 WorkBuddy 实测协议与环境报告（已归档）
- `src/application/host-hook.ts` — 共用宿主钩子内核
- `src/application/init.ts` — `knit init` 按宿主分模板初始化逻辑
- `src/cli/init.ts` — `knit init` 开关定义
- `scripts/pack-check.mjs` — npm tarball 检查脚本
- `docs/design/DESIGN.md` — 目录布局、初始化与多宿主主会话接入说明

## 结果

已完成 WorkBuddy 薄钩子协议入口（knit hook workbuddy）、--workbuddy 初始化模板（.workbuddy/settings.json 与 knit-hook.sh）、GUI 路径引导与两档等待降级、AGY 执行者写保护及 DESIGN.md/pack-check 更新；经独立审查（r-eedaba98534d）修复 <user_query> 转录提取和 init --force 识别边界后复验通过：typecheck、pack:check、git diff --check 及 Apple Terminal 与 Rex 双终端全量 npm test（496/496 通过、0 失败、0 跳过）全绿。
