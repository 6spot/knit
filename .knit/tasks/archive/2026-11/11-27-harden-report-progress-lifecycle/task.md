---
id: k-fc88509c221b
title: 加固报告门禁解析、状态推进与生命周期校验
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-3ad44485c09e
priority: P0
createdAt: 2026-11-27T13:37:25.840Z
---

## 目标与范围

加固审查报告 JSON 解析门禁、流程状态推进与任务生命周期操作中的高危逻辑漏洞，杜绝审查结论被正文旧样例静默劫持、工作流 `verdict` 校验与运行时错配、空理由绕过独立审查以及取消归档失败后任务永久卡死。

### 具体改动与思路

1. **报告解析门禁加固（`src/domain/report.ts`）**：
   - `readReport` 改为仅解析报告**最后一个顶层代码围栏块**（支持反引号与 `~~~` 围栏，且要求开围栏位于行首）。若该尾块解析失败（如 JSON 尾逗号或语法错误），直接返回解析失败以触发一次原会话补报，**绝不向前静默回退采信正文里引用的示例 JSON**。
   - 若尾块内部 JSON 字符串包含转义围栏导致相邻配对截断，仍允许针对该最后一个开围栏与最后一个闭合围栏配对恢复，但不得跨过它向前采信早期独立代码块。
   - `reportOutcome` 将空文本（例如执行者最后一轮只调用了工具未输出正文）返回 `{ outcome: null, problems: ["执行者没有给出报告"] }`，纳入与缺字段一致的“原会话补报一次”流程，补报后仍为空再判失败。
2. **状态推进与审查记录一致性（`src/domain/progress.ts`）**：
   - `nextStep` 对任意存在 `endedAt === null` 的执行（含单执行器运行中，不限于 `batchId !== undefined`）统一返回 `{ kind: "running" }`。
   - 并行审查批次全员 `pass` 后，`stageAfter` 传递 `"pass"` 作为结论以遵守该环节声明的 `onVerdict.pass`（未声明时仍顺序前进）。
   - `lastPassedReview` 要求通过的审查批次之后不再存在新的推进/修改执行批次（例如审查通过后又重新进入非审查写环节或触发了新审查但失败，均视为旧审查通过失效）。
3. **工作流 `verdict` 语义校验与 `sharedPrompt` 清理（`src/domain/workflow.ts`）**：
   - `validateSemantics` 仅从 `stage.report.verdict` 收集 `declaredVerdicts`（声明 `onVerdict` 时要求 `report.verdict` 为枚举字段，避免其它自定义枚举字段通过校验但运行时永不触发跳转）。
   - 修正 `toolsIssueMessage`：并行环节填写了非 `write` 的非法能力名时，准确报非法能力名而非一律误报“不得含 write”，并避免同写 `[write, invalid]` 时重复产出两条同文案错误。
   - 将 `sharedPrompt` 从 `Object.defineProperty(..., { enumerable: false })` 改为显式普通字段，避免对象浅拷贝（`{ ...stage }`）时静默丢失受保护角色路径（同步调整需要比较处）。
4. **生命周期门禁与异常回滚（`src/application/task-lifecycle.ts`）**：
   - `closeTask` 对 `--reason` 先 `.trim()` 判空（独立审查任务无有效 Knit 审查通过记录时，空串或纯空白 `--reason` 一律拒绝）；对所有状态（含 `ready`/`active`）拒绝空字符串 `--paths ""`，防止空串被规整为仓库根导致后续误提整仓改动。
   - `readyTask` 在检测到存在未结束执行（`endedAt === null`）时拒绝重确认，提示等执行结束或先 `knit run cancel <id>`。
   - `cancelTask` 用 `try/catch` 包裹 `archiveTask`：归档移动失败时调用 `saveTask` 将 `task.md` 恢复为原 `document` 并返回清晰拒绝原因，防止任务永久停留在活跃目录的 `cancelled` 态导致无法再次取消或清理。

### 边界与约束

- 不在此任务中为生命周期添加 `withTaskRunLock`（任务锁接入归下一任务 `k-566ade3a274d` 统筹），不修改 `delivery.ts` 或 `run-execute.ts` 内部实现（除必要的空报告补报联动验证）。
- 测试按主题追加到 `test/report.test.mjs`、`test/progress.test.mjs`、`test/workflow.test.mjs`、`test/task-lifecycle.test.mjs` 与 `test/run-execute.test.mjs`。
- 涉及状态推进与报告门禁高风险路径，须运行 `npm run typecheck`、`npm run build` 及全量 `npm test`。

## 完成条件

### Requirement: 报告解析严守尾块边界且空报告允许补报
#### Scenario: 尾块 JSON 语法错误时不静默采信正文早期 JSON
- WHEN 审查报告正文中引用了合法 JSON（含 `"verdict": "pass"`），而报告末尾真正的 json 围栏块存在语法错误（如尾逗号）
- THEN `readReport` 返回解析失败而不是返回正文里的 `"pass"`

#### Scenario: 尾块支持波浪号围栏且空报告可触发原会话补报
- WHEN 报告末尾使用 `~~~json` 围栏给出合法字段，或执行者首轮回复为空文本
- THEN `~~~json` 可被正确解析；空文本返回 `outcome: null` 以允许同会话补报一次

### Requirement: 状态推进与工作流 verdict 校验语义一致
#### Scenario: 单执行器运行中、并行 onVerdict.pass 与后续改代码后的审查失效
- WHEN 存在单执行器未结束运行、并行审查全员 `pass` 且环节配置了 `onVerdict.pass`、或审查 `pass` 后又执行了新的实现环节
- THEN `nextStep` 返回 `running`、并行 `pass` 按 `onVerdict.pass` 跳转、`lastPassedReview` 在后续实现执行后返回 `undefined`

#### Scenario: 工作流校验仅采信 report.verdict 且准确报告并行非法工具
- WHEN `workflow.yaml` 在非 `verdict` 枚举字段下写 `onVerdict`，或在并行环节写 `tools: [read, invalid]`
- THEN `parseWorkflow` 拒绝无效 `onVerdict`，并对 `invalid` 准确报工具名错误且不产生重复同文案错误

### Requirement: 生命周期门禁与取消回滚
#### Scenario: 空白 reason、空 paths、运行中 ready 与取消归档失败回滚
- WHEN 对无审查记录的 `independent` 任务传 `--reason "   "`、对 `ready` 任务传 `--paths ""`、对存在未结束执行的任务运行 `readyTask`、或 `cancelTask` 中归档移动失败
- THEN 前三者均被明确拒绝；`cancelTask` 归档失败后 `task.md` 状态恢复为取消前原状且返回错误原因

### Requirement: 构建与全量回归通过
#### Scenario: 类型检查、构建与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 3、6、7、8 节关于状态推进、报告校验与完成/取消的约定
- `AGENTS.md` — 高风险独立审查边界与验证要求
- `.knit/standards/development.md` — 编码风格与测试分层规范
- `src/domain/report.ts` — 报告解析与补报文案
- `src/domain/progress.ts` — 下一步推导与 `lastPassedReview`
- `src/domain/workflow.ts` — 语义校验与 `sharedPrompt`
- `src/application/task-lifecycle.ts` — `ready`/`close`/`cancel` 用例

## 结果

按已确认的 6 个场景完成。报告只解析末尾顶层围栏，空报告可在同一会话补报一次；运行中状态、并行通过后的跳转及旧审查失效规则已校正；生命周期操作拒绝无效参数，取消归档失败后可恢复并重试。独立审查 r-70f69e4ba267 给出 pass，未修改工作树。已核对宿主日志，定向测试 143/143，含 7 个跨卷场景的全量测试 611/611，0 失败、0 跳过；类型检查、构建和 git diff --check 通过。审查沙箱独立运行 4 个定向文件 110/110，通过数与宿主全量分开记录。独立审查发现的自定义单执行器额外 verdict 入账问题已由补充子任务「仅将环节声明的有效 verdict 记为审查结论（k-907f49ffc929）」修复并先行合并到 main，提交 660dce0。补充修复通过独立审查，两份改动的合并态全量测试 615/615 通过，0 失败、0 跳过。
