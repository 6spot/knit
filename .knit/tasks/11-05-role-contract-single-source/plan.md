# 实施计划：YAML 驱动流程（k-8ed2dceaaa4d）

依据：`design.md`（digest `7f52d55f…`）。**未获实施授权前不动代码。**

## 顺序原则

先立数据模型，再改使用方；每步可独立 typecheck + 跑相关测试；不追求一次性大改导致中间态不可验证。

依赖链：P1 →（P2、P3 并行）→ P4 →（P5、P6）→ P7 → P8 → P9。P1 是全链路前置。

## P1 配置层（不接线）

产出：

- 新增 `src/domain/workflow.ts`：`WorkflowDefinition`、YAML 解析（`yaml` 依赖已在）、校验（结构／id 正则与唯一／`onVerdict` 目标存在／回退环有上限／`version`）、降级推导（`start → deliver` + 原因码）。
- 新增 `src/contracts/workflow.ts`：配置 schema、校验结果结构、`workflowMode`。
- 默认模板常量：带完整顶部注释（字段说明、能力表、常见错误）。
- 单测：合法／非法各 10+ 用例，含降级原因码与行号。

验证：`npm run typecheck` + 新增 `test/workflow.test.mjs`。

## P2 状态机与阶段值

产出：

- `contracts/task-inputs.ts`：`TaskPhase` → `TaskStage`（锚点 + 配置阶段 id）。
- `domain/task.ts`：`transition(workflow, stage, event)`；删除逐阶段 `onXxx`；访问计数与 `repair_round_limit` 迁移到转移层。
- `task.md` frontmatter：`phase` → `stage`（写入端改名；旧值只读原样展示）。

验证：`test/domain.test.mjs`、`test/task.test.mjs` 更新 + 新增"自定义阶段流转／回退上限"用例。

## P3 报告与接收

产出：

- 报告模型：固定 `summary`／`validation`／`blockers` + 阶段声明字段；`paths` 严格 diff 校验沿用。
- `run-acceptance.ts`：按声明校验、按配置转移、写访问计数；删除 `advisory` 早退分支。
- 非正式检查保留独立固定格式。

验证：`test/run.test.mjs`、`test/closeout.test.mjs`。

## P4 上下文与权限

产出：

- `context-planner.ts`：删除 `workflow` 分节；`--stage`；能力 → `ToolPolicy`；生成顶部提示行（流程链路 + 当前阶段 `name`／`description`／完成条件）。
- `adapters/pi/runtime.ts`：能力展开为 `--tools` 与 `--no-extensions`／`--no-mcp`／`--no-skills`／`--offline` 开关。
- `stage-runner.ts`：删除 `roleOf` 特判。

验证：`test/m1-cli.test.mjs` 的上下文断言 + 新增"能力→参数"单测（可用假 runtime 记录参数）。

## P5 CLI

产出：

- 新增 `src/cli/workflow.ts`：`init|show|validate|add|remove|move|set-prompt|set-tools|set-report|set-next`；写入全量校验并回显新流程摘要。
- `run prepare/start --stage`；`assist <mode>` 与 `advisory` 分支删除；`assist_deliver_removed` 错误码清理。
- `knit context --stage`。

验证：`test/cli.test.mjs`、`test/m1-cli.test.mjs`。

## P6 桥接

产出：

- `contracts/bridge-tools.ts` + `.pi/extensions/knit.ts` + `assets/templates/pi/extensions/knit.ts`：删除静态枚举（`action`、`role`、`mode`），按配置派生；新增 `knit_workflow`；修复 turn context 里"按 workflow.md 推进"的悬空提示。
- 两份桥接同步（现有测试会比对）。

验证：`test/init.test.mjs`、`test/contracts.test.mjs`。

## P7 模板与 init

产出：

- `assets/templates/.knit/workflow.yaml`（带注释）；`TEMPLATE_SPECS` 增删；删除 `assets/templates/.knit/workflow.md` 与本仓库 `.knit/workflow.md`。
- init 增加"模板已移除文件"的孤儿报告（默认只报不删）。
- `AGENTS.md` 受管块与 init 生成的块保持一致（主会话规则唯一来源）。

验证：`test/init.test.mjs` 新增孤儿报告用例；`knit init --check` 在临时目录实跑。

## P8 文档

产出：`DESIGN.md` §15.1／§5／§6、`STATES.md` §3/§8、`OPERATIONS.md`、`GLOSSARY.md`、`ROLE-CONTRACT.md`、`docs/README.md`、`README.md` 改写为配置解释规则；`docs/research/*` 不动。

验证：全文检索 `workflow.md`、`advisory`、`assist`、`四环节`、`role` 残留，逐条判断保留（历史）或删除。

## P9 全量验证

- `npm test`（typecheck + build + 全部 test）
- `npm run pack:check`
- 场景 1–10（`design.md` §14）逐条实跑，记录到任务记录
- 独立检查（`independent`）：另起执行者按 `design.md` 与 `task.md` 验收条件复核

## 风险与处理

| 风险 | 处理 |
| --- | --- |
| 阶段改名影响面大（`phase` 字段散落 task.md／run／报告／桥接） | P2 一次改完，全仓检索 `phase` 残留；旧值只读展示 |
| 删除 `workflow.md` 后 worker 上下文变薄 | P4 顶部提示行 + 阶段提示词文件承担；实跑对比检查阶段行为 |
| 桥接派生依赖运行时读配置，读失败会退化 | 退回字符串参数 + 核心返回合法清单；启动日志给出原因 |
| `external`／`network` 放开后不可复现 | 默认不开；run 记录写实际能力开关，报告可追溯 |
| 现有 6 个 open 任务带旧 `phase` 值 | 默认模板同名 id；其余只读展示，不批量改写 |
| 一次性大改导致中间态不可测 | 按 P1–P9 顺序，每步跑对应测试后再进入下一步 |

## 需要授权

- 实施授权（授权前不动代码）
- 验证要求 `self → independent`
