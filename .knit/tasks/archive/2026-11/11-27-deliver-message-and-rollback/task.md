---
id: k-80b34debdf66
title: 支持 knit deliver --message 并优化移动回滚报错
status: delivered
stage: null
verification: independent
parent: k-6aaf06ce1d4f
dependsOn: []
priority: P0
createdAt: 2026-11-27T07:55:57.901Z
---

## 目标与范围

为 `knit deliver` 增加 `--message <文案>` 选项以消除非 Pi 宿主和终端交付必须手建临时文案文件的摩擦，并修复目录移动失败回滚时 CLI 裸抛异常的问题：

1. **CLI 与应用层支持 `--message <文案>`（`src/cli/deliver.ts`、`src/application/delivery.ts`）**：
   - `knit deliver <id>` 新增 `--message <文案>`，与 `--message-file <文件>` 互斥（参考 `src/cli/run.ts` 中 `--instruction` 与 `--instruction-file` 的 `.conflicts(...)` 写法）；仅提供长选项 `--message`，不引入 `-m` 短选项，与全仓 CLI 风格保持一致。
   - `DeliveryOptions` 增加 `message?: string`，应用层在同时传入 `message` 和 `messageFile` 时也应拒绝（避免绕过 CLI 直接调应用层时出现二义性）。
   - Git 仓库中，`--preview` 与实际交付均支持 `--message`；实际交付时 `--message` 为空或纯空白应报错拒绝；未提供文案时的拒绝提示和预览提示同步说明支持 `--message <文案>` 或 `--message-file <文件>`。
   - 不在 Git 仓库时沿用原规则，允许省略提交文案，也不因传入 `--message` 报错。

2. **宿主命令解析兼容 `--message`（`src/application/host-command.ts`）**：
   - 将 `--message` 加入 `knitArguments()` 取值选项列表，使 `--message "..."` 与 `--message="..."` 正确消费其参数值，不污染位置参数，也不干扰 `--preview` 识别与 `--authorization` 核对。
   - 当 `--message` 的参数包含未加引号的动态展开（如命令替换）时沿用现有保守策略标记 `uncertain`。

3. **目录移动回滚友好报错（`src/application/delivery.ts`、`src/cli/deliver.ts`）**：
   - `DeliveryResult` 中 `rolledBack` 的 `reason: "move"` 分支携带 `taskDir`（与 `reason: "commit"` 对称），CLI 改为通过 `fail(...)` 输出移动错误原因及清晰的回滚提示（明确说明交付已撤回、任务目录仍在原位置且状态为 `done`），不再直接 `throw result.error` 裸抛堆栈。

4. **模板与设计同步**：
   - 更新 `assets/templates/agents/plugins/knit/rules/AGENTS.md` 中的交付命令示例，补齐提交文案选项（`--message` / `--message-file`），避免 Antigravity 主会话首次交付因漏写文案被拒。
   - 更新 `docs/design/DESIGN.md` 第 9 节命令行列表（`knit deliver` 行补上 `--message <文案>`）。

### 范围外
- 不修改 `assets/templates/pi/extensions/knit.ts`（Pi 桥接继续用 `--message-file`，天然兼容长多行文案及旧版安装 CLI）。
- 不修改本仓库已生成的 `.agents/plugins/knit/rules/AGENTS.md`（按开发规范只改 `assets/templates/` 源文件，发版刷新时再同步）。
- 不含交付预览列出未归属改动文件名、`done` 任务补录 `--paths` 及 `autoMerge` 只读冲突预检（留给下一子任务）。

## 完成条件

### Requirement: `knit deliver` 支持 `--message` 且与 `--message-file` 互斥
#### Scenario: 在 Git 仓库中通过 `--message` 完成预览与实际交付
- WHEN 任务为 `done` 且项目在 Git 仓库中，分别运行 `knit deliver <id> --preview --message "提交文案"` 与带授权的 `knit deliver <id> --authorization "<原话>" --message "提交文案"`
- THEN 预览展示该提交文案且不改动工作区；实际交付完成归档并以该文案提交（末尾自动附 `Knit-Task: <id>`）

#### Scenario: 空文案与互斥参数被清晰拒绝
- WHEN 在 Git 仓库中实际交付时传纯空白 `--message "   "`，或同时传入 `--message` 与 `--message-file`
- THEN 拒绝交付、返回非零退出码并给出明确错误原因，不改动任务状态与目录

### Requirement: 宿主命令钩子正确解析带 `--message` 的交付命令
#### Scenario: 带 `--message` 的预览与带授权交付正确放行或拦截
- WHEN 宿主 `PreToolUse` 检查 `knit deliver <id> --message "fix: 文案含空格" --authorization "用户原话"`（含 `--message=...` 写法）及带 `--message` 的 `--preview` 命令
- THEN `--preview` 直接放行；实际交付准确提取 `--authorization` 原话与会话消息比对，匹配则放行、不匹配则拒绝；含未加引号动态展开的 `--message` 保守拦截

### Requirement: 移动目录失败回滚时给出友好错误而非裸抛堆栈
#### Scenario: 归档移动阶段失败后安全回滚并输出清晰提示
- WHEN 交付进入移动任务目录阶段失败并触发回滚
- THEN CLI 返回非零退出码，标准错误输出移动错误原因并明确提示交付已撤回、任务目录仍在原位置且状态为 `done`，不打印未捕获异常堆栈

### Requirement: 模板、设计与验证完整一致
#### Scenario: 文档同步且全量测试通过并经独立审查
- WHEN 核对 `assets/templates/agents/plugins/knit/rules/AGENTS.md` 与 `docs/design/DESIGN.md#9-命令与工具`，并运行 `npm run typecheck`、`npm run build`、受影响测试（`test/deliver.test.mjs`、`test/deliver-worktree.test.mjs`、`test/host-hook.test.mjs`）以及全量 `npm test`（涉及交付与授权核对核心链路）
- THEN 文档与实现一致，新增回归用例与既有测试全部通过（环境受限跳过的跨文件系统用例除外）；改动保留在任务 Worktree 中，不自行提交，交由独立审查核验

## 待澄清

## 相关资料

- `src/cli/deliver.ts` — `knit deliver` 命令选项与回滚错误渲染
- `src/application/delivery.ts` — `deliverTask` 选项校验、提交与回滚返回结构
- `src/application/host-command.ts` — `knitArguments` 宿主交付命令参数与授权解析
- `assets/templates/agents/plugins/knit/rules/AGENTS.md` — Antigravity 主会话规则模板
- `docs/design/DESIGN.md#8-完成与交付` — 交付与回滚规则
- `docs/design/DESIGN.md#9-命令与工具` — 命令行接口清单
- `test/deliver.test.mjs` — 交付与预览测试
- `test/deliver-worktree.test.mjs` — Worktree 交付与移动回滚测试
- `test/host-hook.test.mjs` — 宿主命令与授权核对测试

## 结果

knit deliver 已支持 --message <文案>（与 --message-file 互斥，CLI 与应用层均校验），host-command 正确解析带 --message 的预览与授权核对（并在独立审查中修复了 --preview 置于未加引号动态 --message 之前的误放行边界），目录移动回滚改为友好标准错误输出而非裸抛堆栈，Antigravity 源模板与 DESIGN.md 第 9 节已同步更新。5 条完成条件全部满足。独立审查（r-f3ae53de02de）结论为 pass，审查者直接修复 host-command.ts 与 host-hook.test.mjs 后独立验证通过 npm run typecheck、npm run build、git diff --check、3 份定向测试（69/76 通过、0 失败、7 项跨文件系统跳过）及全量 npm test（546/553 通过、0 失败、7 项跨文件系统跳过）。未验证：7 项跨文件系统测试因环境未配置 KNIT_TEST_CROSS_DEVICE_DIR 跳过。
