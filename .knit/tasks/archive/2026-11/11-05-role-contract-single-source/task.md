---
id: k-8ed2dceaaa4d
status: closed
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-05T08:45:16.626Z
title: 角色契约单一来源：消除增删角色的硬编码面
stage: deliver
---

## 拆分（5 个子任务，按依赖顺序执行；父任务负责总体验收）

| 子任务目录 | 内容 | 前置 |
| --- | --- | --- |
| `11-05-config-layer-yaml-workflow` | 配置层：YAML 解析、校验、降级、默认模板（plan P1） | — |
| `11-05-stage-model-transitions` | 阶段模型与状态机：`stage` 字段、锚点、转移与回退上限（P2） | 配置层 |
| `11-05-report-acceptance-context-permissions` | 报告声明校验、接收流转、顶部提示行、能力权限（P3、P4） | 阶段模型 |
| `11-05-workflow-cli-and-bridge` | `workflow` 命令组、`--stage`、桥接去静态枚举、删 `assist`／`advisory`（P5、P6） | 配置层、阶段模型 |
| `11-05-templates-init-docs` | 模板与 init、删 `workflow.md`、孤儿报告、文档重写（P7、P8） | 阶段模型、报告、CLI |

- 每个子任务验证：`self`（`npm test` + 各自场景）。
- 父任务验证：`independent`，全部子任务完成后按 `design.md` §14 场景 1–10 复核。
- 实施按子任务逐个授权；未授权的子任务保持 discuss。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 验证要求调整

- 时间: 2026-11-05T11:07:41.378Z
- 方式: self → independent；理由: 改动横跨状态机、契约、CLI、桥接、模板与文档，自检兜不住

### 独立检查结果（run-2c95d3c3f951 与 run-1b087745ad50）

两次独立检查对 design §14 场景 1–10 的**默认配置**均判定通过（默认四环节、自定义阶段与 `onVerdict` 回退、`maxVisits` 停止、无 prompt、能力白名单、无检查阶段直达收尾、默认降级在途、桥接派生、非法写入拒绝带行号、顶部提示行、init 不再生成 `workflow.md`），`npm test` 503/503、`pack:check` 通过。结论 `changes_requested`，原因是**降级在途 run 只对默认 implement/check 成立**：

1. **提示词身份未冻结**：prepare 时按 config 的 `prompt`（或缺失）算 `effectiveInputsDigest`，降级后 worker／接收按 `keepLegacyStagePrompt` 回退到 `.knit/agents/<stage>.md`，摘要不等 → `request_stale`。指针：`src/application/context-planner.ts:251-256`、`src/worker/knit-worker.ts:276`、`src/application/run-acceptance.ts:205`、`src/application/check-validation.ts:40`。
2. **降级接收硬编码 implement/check**：`run-acceptance.ts` 的 `legacyStageOf` 只识别这两个 id。自定义 `verify`（verdict 枚举）在 prepare 后降级会被当实施接收、不写检查凭据，任务到 deliver 后 `task close` 报 `check_missing`；降级流程又拒绝新 run prepare，无法恢复。指针：`src/application/run-acceptance.ts` 降级接收段、`src/application/run-coordinator.ts:186-193`。
3. **降级在途放宽工具白名单**：`context-planner.ts` 的 `toolPolicyFor` 在 fallback 返回全部能力，worker 采用重算后的 `plan.toolPolicy`，未用请求冻结值；实测 check 阶段 `[read, exec]` 在 prepare 后降级变成可写。指针：`src/application/context-planner.ts`、`src/worker/knit-worker.ts`。

现有测试只覆盖默认两阶段的降级在途路径，未覆盖自定义 prompt／无 prompt／自定义结论阶段／自定义报告声明／工具策略。

### 修复要求（本次实施）

- 在 prepare 时把生效阶段定义冻结进 run 请求（提示词路径或“无提示词”、工具策略、报告字段、是否为结论阶段），worker 与接收都按冻结值执行与校验；配置在 run 中途降级不影响该 run 的输入摘要与工具面。
- 降级接收按冻结阶段定义判断结论／产出，不再写死 `implement`／`check`；自定义结论阶段在降级后也能正常接收并落到收尾，不留下 `check_missing` 死路。
- 补回归用例：自定义 prompt、无 prompt、自定义结论阶段、自定义报告声明、`tools` 白名单在 prepare 后降级的完整 run（fake-pi 即可）。
- 验证：`npm run typecheck` + `npm test`；报告写清每项修复对应的探针证据。

### 总体验收结论（2026-11-05）

五个子任务全部完成并归档：P1 `k-4ef4cfc4095c`、P2 `k-63006e478faa`、P3 `k-9a6dcc91e184`、P5 `k-6c7e0d19a830`、P7 `k-402485d91cd6`。父任务按 design §14 场景 1–10 做两轮独立检查，第二轮发现降级在途缺陷后进入修复，第三轮检查 `pass`。

#### 运行记录

- 实施 `run-4eb4589f9095`（accepted）：逐条实跑 §14 场景 1–10 共 11 个探针；同时发现降级流程给新计划注入旧阶段提示词的问题并修复（`keepLegacyStagePrompt`）。
- 检查 `run-2c95d3c3f951`：默认配置场景全通过，但结论 `changes_requested`；接收因 coverage 未逐项列路径被拒（`check_scope_incomplete`）。
- 检查 `run-1b087745ad50`（accepted，`changes_requested`）：复现三项降级在途缺陷 —— ① 提示词身份未冻结导致 `request_stale`；② 降级接收写死 implement／check，自定义结论阶段会 `check_missing` 且无法恢复；③ 降级放宽工具白名单。
- 修复 `run-7551b2aab897`（accepted，repair cycle 1）：prepare 冻结阶段定义进 run 请求（提示词或无提示词、能力白名单、报告字段、结论标记、`onVerdict`／`maxVisits`），worker／StageRunner／接收／检查凭据复核统一用冻结值；降级接收按冻结定义判断结论，不再依赖写死阶段名；新增 5 个 fake-pi 回归。
- 检查 `run-f991c43105a2`（accepted，`pass`）：核对三项修复落地，另发现并修复 `previousImplementResult` 仍按当前配置判断历史 run 的问题；`npm test` 509/509、`pack:check`、scope 摘要逐项比对均通过。

#### 场景覆盖（§14）

1 默认 YAML 行为一致；2 自定义三阶段＋`onVerdict` 回退＋`maxVisits` 停止；3 无 prompt 不报错；4 不写 tools 不限、`[read]` 不可写、`[read, external]` 放开扩展；5 无检查阶段直达收尾；6 坏 YAML 降级 `start → deliver` 且四处可见、在途 run 跑完；7 桥接按配置派生并可调；8 非法写入拒绝带行号；9 每轮顶部提示行；10 删除 `workflow.md` 无悬空引用、init 不再生成。

#### 验证

`npm test` 509/509（typecheck + build + 全量）；`knit workflow validate` 有效；`knit doctor` workflow `[ok]`；`knit init --check` 模板项全部 keep；`pack:check` 通过。

#### 已知边界

- 检查报告记录的展示口径问题：冻结阶段叠加降级时顶部 `stageBrief` 链路显示“准备 → 收尾”，完成条件“完成后 → 收尾”，不影响输入摘要、工具面与接收。
- 旧版本已 prepare、请求里没有 `stageDefinition` 的历史 run 在降级后仍走 `legacyStageOf`（只识别 implement／check）；无法回溯冻结，新请求不受影响。
- `test/stage.test.mjs` “runtime 启动失败保留 pi 侧错误细节”仍有既有竞态（stderr 尾部偶发为空），与本任务改动无关，另行处理。

### 交付记录

<!-- knit:delivery:op-5553d5c662d8 -->
- 操作: op-5553d5c662d8
- 时间: 2026-11-05T17:42:17.723Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-05 本会话明确授权：整条链逐任务本地提交（选项 A），不含 push／发布／归档
- 工作提交: cd0b5111ea0bc387c16e184f9f1d0f6dc0947d2e
- 结果: 正常交付；检查 run-f991c43105a2 通过
- 归档目标: .knit/tasks/archive/2026-11/11-05-role-contract-single-source

### 任务资料提交记录

<!-- knit:metadata-commit:op-5553d5c662d8 -->
- 任务资料提交: 45a40a52c5267b070373a7ae40cab0e5b85e1de0
- 归档目标: .knit/tasks/archive/2026-11/11-05-role-contract-single-source

<!-- knit:progress:end -->
