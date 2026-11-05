---
id: k-6c7e0d19a830
status: closed
outcome: completed
branch: refs/heads/main
verification: self
parent: k-8ed2dceaaa4d
priority: P2
dependsOn:
  - k-4ef4cfc4095c
  - k-63006e478faa
order: null
createdAt: 2026-11-05T11:07:47.914Z
title: workflow 命令组、--stage 与桥接去静态枚举
stage: deliver
---

## 目标

提供 `knit workflow` 命令组让 AI／用户改配置并当场校验；`run`／`context` 改用 `--stage`；桥接取消静态枚举；删除 `assist`／`advisory` 整条链路。

依据：`../11-05-role-contract-single-source/design.md` §11／§13。

## 交付物

- 新增 `src/cli/workflow.ts`：`init｜show｜validate｜add｜remove｜move｜set-prompt｜set-tools｜set-report｜set-next`；写入全量校验、失败带行号拒绝、成功回显新流程摘要。
- `src/cli/run.ts`：`--stage`；删除 `assist <mode>`、`assist_deliver_removed`、`advisory` 分支。
- `src/contracts/bridge-tools.ts`、`.pi/extensions/knit.ts`、`assets/templates/pi/extensions/knit.ts`：删除 `knit_run.action`／`knit_context.role`／`knit_run.mode` 静态枚举，按配置派生；新增 `knit_workflow`；修复 turn context 里"按 workflow.md 推进"的悬空提示。

## 规则

- 读取配置失败时退回字符串参数，由核心返回合法阶段清单，不静默通过。
- 两份桥接同步（现有测试会比对）。

## 依赖

`k-4ef4cfc4095c`、`k-63006e478faa`。验证：`npm run typecheck` + `npm test`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-a42dcd9f4f1b，30 分钟，workflowMode=config）

- `src/cli/workflow.ts`（新增，577 行）：`init｜show｜validate｜add｜remove｜move｜set-prompt｜set-tools｜set-report｜set-next`；写入走“先全量校验 → YAML AST 只改目标节点 → 写入前再校验 → 带 sha256 原子写”，失败按 `WorkflowInvalidError` 输出 YAML 行号并保持原文件；成功回显流程摘要。
- `src/cli/run.ts`：`run prepare --stage <stage>`（替换按阶段名的固定枚举）；删除 `assist <mode>`、`assist_deliver_removed` 与 `advisory` 分支；`knit assist` 命令整体不存在。
- `src/contracts/bridge-tools.ts`：`knit_context.role` → `stage`；`knit_run` 去掉 `mode` 与静态 action 枚举（改非空字符串）；新增 `workflow` 工具 schema。
- `.pi/extensions/knit.ts` 与 `assets/templates/pi/extensions/knit.ts`（两份一致）：启动时用 `knit workflow show --json` 派生阶段枚举写入 `knit_run.action`／`knit_context.stage`；配置无效或读不到时退回字符串参数，由核心报合法阶段清单；新增 `knit_workflow`；修复“按 workflow.md 推进”的悬空提示（改引 `AGENTS.md` 与 `.knit/workflow.yaml`）。
- `src/application/diagnostics.ts`：`knit doctor` 增 `workflow` 行（缺省模板／config／降级原因）。
- `src/cli/session.ts`、`src/cli/knit.ts`：register workflow 命令组、角色枚举只留实现／检查。

### 验证（主会话复核 2026-11-05）

- `npm test`：500/500 通过（含 typecheck、build）。
- 临时项目 `/tmp/knit-p2-probe` 实跑工作流命令组：
  - `workflow show` 在未创建配置时显示“缺省模板（config）”与两阶段全字段。
  - `workflow add review --name 复核 --description … --tools read,exec --report verdict:[…] --after check` 写入并回显三阶段链路。
  - `workflow set-next review changes_requested implement` 写入成功。
  - 非法写入被拒并给行号：`第 70 行：onVerdict 键 "nope" 未在 report 的枚举字段中声明`；`workflow remove implement` 因仍被引用被拒（`第 46 行`、`第 61 行`）。
  - 坏 YAML（`id: Build`）：`workflow validate` 给 `第 3 行` 原因并非零退出；`workflow show` 显示“配置降级：invalid_stage_id”与 `start → deliver`。
- 本仓库实跑：`knit doctor` 输出 `[ok] workflow: 缺省模板；准备 → 实现 → 检查 → 收尾`；`knit context --task … --stage check` 产出能力派生工具策略（`read`+`exec`，deny `write`／`edit`）。
- 非法阶段诊断：`run prepare --stage nope --provider … --model …` → `阶段不在生效流程中: nope；合法阶段: implement、check`。
- 桥接两份文件 `diff` 一致；`test/bridge-query.test.mjs` 断言 `knit_context.stage` 按配置派生 `["start","build","verify","deliver"]`，坏配置退回字符串。
- 受保护路径无改动。

### 已知边界（后续任务承担）

- `assets/templates/.knit/workflow.yaml`、删除模板与本仓库 `.knit/workflow.md`、`TEMPLATE_SPECS`、`src/application/templates.ts` 的旧文案、`src/application/delivery.ts` 的授权默认路径 `.knit/workflow.md`、`assets/templates/.knit/agents/runtimes/pi.md` 里的 advisory 描述，均属 P7（`k-402485d91cd6`）“模板与文档重写／全文残留检索”。
- 自定义阶段派发需要 `config.phases[<stage>]` 或显式 `--provider/--model`；未配置时当前报“未提供 <stage> 阶段模型”，先于“阶段不在流程中”诊断（`model-selection` 在 `prepare` 前解析）。设计未涉及 `config.phases`，按既有行为保留。

### 交付记录

<!-- knit:delivery:op-694f4189b438 -->
- 操作: op-694f4189b438
- 时间: 2026-11-05T14:34:16.247Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: e4b154b85202ee33a3bb7194ed0fba31cb8e4705
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-05-workflow-cli-and-bridge

### 任务资料提交记录

<!-- knit:metadata-commit:op-694f4189b438 -->
- 任务资料提交: 6717a448875730590c1211004b1891734310dfa6
- 归档目标: .knit/tasks/archive/2026-11/11-05-workflow-cli-and-bridge

<!-- knit:progress:end -->
