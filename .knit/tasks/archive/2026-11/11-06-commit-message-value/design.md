# 交付提交说明：格式与行为设计

状态：方案已确认（2026-11-06），未实施。实现前复核；行为变化按任务输入更新规则处理。

## 1. 目标与不变量

- 产物提交说明由主会话起草，核心只校验、拼装、持久化，不调用模型。
- 机器锚点从首行前缀移到 trailer；首行保留给人读。
- 恢复、幂等与合入判定不依赖首行文本，仍能按操作 ID 找到提交。
- 一个任务仍只有一个产物提交；不 amend、不改写历史。
- 提交范围（selected paths）、完成资格、授权规则不变。

## 2. 输入通道

`knit deliver <taskId> --message-file <path>`

- 单任务：`--message-file` 可直接给路径。
- 批量：`--message-file` 可重复，取值 `<taskId>=<path>`；存在多个任务时裸路径报用法错误。
- `--plan` 同样接受 `--message-file`：只读取、校验并预览（首行、正文行数、来源），不创建操作、不暂存。
- 用法错误或校验失败：非零退出，在创建操作、`git add` 与任何 Task 修改之前拒绝。

`--message-file` 只作用于产物提交；`metadata`／`archive` 使用确定性模板，不接受文案输入。

## 3. 文案格式

文件为 UTF-8 纯文本，按 LF 归一，去除行尾空白，补单个结尾换行；允许 CRLF 输入。

```
<首行：可读标题>
<空行>
<正文：为什么改、改了什么、验证到什么程度，可分条>
```

校验规则：

| 项 | 规则 | 失败原因 |
| --- | --- | --- |
| 空内容 | 去空白后非空 | `message_empty` |
| 首行 | 恰一行，1..72 个字符（按码点） | `message_subject_invalid` |
| 首行前缀 | 不得以 `knit: ` 开头（旧机器格式），不得只含任务／操作 ID | `message_subject_invalid` |
| 空行 | 首行与正文之间必须有一个空行 | `message_body_missing` |
| 正文 | 至少一行非空；≤ 4000 字符 | `message_body_missing` / `message_too_long` |
| 保留键 | 正文行不得以 `Knit-` 开头 | `message_trailer_conflict` |
| 总量 | 整个文件 ≤ 8 KB | `message_too_long` |

不做语义校验：核心无法判断「为什么」是否属实，真实性由主会话与其检查证据负责。

## 4. 最终消息结构

产物提交：

```
<主会话首行>

<主会话正文>

Knit-Task: k-<id>
Knit-Operation: op-<id>
Knit-Stage: artifact
Knit-Verification: none|self|independent
```

模板兜底（无 `--message-file`）：

```
<任务标题> (<taskId>)

结果：completed|cancelled|superseded
验证：<verification> — <完成依据或 run 引用；缺失时写「未记录」>
```

- 首行超 72 字符时按码点截断并加 `…`。
- 记录 `messageSource: template`；有文案时为 `agent`。
- 交付结果与 `--plan` 都显示来源；用模板时在报告里给出「未提供提交文案」的可读提示，不静默降级。

资料提交（确定性）：

```
chore(task): <任务标题> (<taskId>)

结果：<outcome>
验证：<verification> — <依据>
产物提交：<workCommit 短哈希>（无则写「无」）
资料：任务记录、完成凭据

Knit-Task / Knit-Operation / Knit-Stage: metadata
```

归档提交（确定性）：

```
chore(task): archive <目录名> (<taskId>)

移动：tasks/<目录名> → tasks/archive/<YYYY-MM>/<目录名>
产物提交：<hash 或 无>
资料提交：<hash 或 无>

Knit-Task / Knit-Operation / Knit-Stage: archive
```

标题同样按 72 字符截断，确保首行可读；trailer 每行一个，位于末尾，与正文空行分隔。

## 5. 校验与拼装的边界

- 核心负责：解析文案、校验、规范化、拼装 trailer、截断模板首行、去重（输入已含 trailer 时拒绝而不是静默删除）。
- 主会话负责：第一次确认前的内容质量、风格与仓库现状一致（如 `git log --oneline -5` 观察前缀与语言）、不虚构验证结论。
- 提交后由 commit-msg hook 改动消息的情况沿用现有核对（trailer 不匹配即 `commit_message_mismatch`），不新增静默修复。

## 6. 持久化与重试

- 交付操作按阶段保存最终消息文本与 `messageSource`；`artifact`／`metadata`／`archive` 各自一份。
- 重试：已提交阶段直接按持久化记录核对，不重拟；未提交阶段沿用已保存文案，新传入文件被忽略，证据里记 `message_ignored_on_retry`。
- 已提交后的措辞修改不在本次支持范围（需要 amend），按现状报告，由人工决定。
- 操作记录仍以操作 ID 为幂等键；消息内容进入证据，不改变提交范围核对。

## 7. 识别与恢复

新增 `src/application/delivery.ts` 中的解析辅助：

- `readKnitTrailers(message)`：逐行匹配 `^Knit-(Task|Operation|Stage|Verification): (.+)$`，返回结构化结果；缺失返回 `null`。
- `isStageCommit(message, stage, operationId)`：优先按 trailer 判定（`Knit-Stage` 与 `Knit-Operation` 同时匹配）；无 trailer 时回退旧格式 `knit: <stage> ` + 操作 ID。

调用点：

- `DeliveryService.findOperationCommit`：仍用 `git log --grep=<operationId>` 缩小候选（trailer 行同样命中），再用 `isStageCommit` 判定；保留 `--all-match` 与 `knit: deliver` 旧前缀回退。
- `worktree-merge` 中 archive／metadata／产物提交的识别全部改走 `isStageCommit`。
- `history-search` 不改：检索仍覆盖提交说明全文，新正文直接可搜。

旧操作记录（无 trailer 字段）继续按旧格式核对；不要求迁移历史提交。

## 8. 主会话行为与文档

在以下位置补「交付前起草一次」的规则（措辞一致）：

- [ROLE-CONTRACT.md](../../../docs/design/ROLE-CONTRACT.md)：`deliver` 收尾锚点行，补「起草产物提交文案、在授权交付前展示一次、不得虚构验证」。
- [DESIGN.md](../../../docs/design/DESIGN.md) 第 10.2 节：文案来源与校验规则；第 10.4 节：归档提交模板。
- [OPERATIONS.md](../../../docs/design/OPERATIONS.md) 交付实现说明：`--message-file`、校验失败不产生副作用、重试复用持久化文案。
- AGENTS 受管块模板（`src/application/templates.ts`）与 `.pi/extensions/knit.ts` 注入的交付行：交付前起草文案并展示一次。
- 阶段提示词不新增 writer：文案由主会话在 `deliver` 前产生，不进入 implement／check 报告字段。

## 9. 明确不纳入

- 一个任务拆多个产物提交；按块提交与 scope 重算。
- amend／rebase／历史改写；旧提交文案回填。
- 模型生成文案或摘要；核心调用任何模型。
- 项目级可配置提交模板（Trellis `session_commit_message` 一类）；本项目先固定格式，出现真实需求再单独立项。
- 改变完成资格、授权来源、branch 校验或归档移动逻辑。

## 10. 实现与验证要点

代码面：

- `src/cli/deliver.ts`：解析 `--message-file`（单值与 `<taskId>=<path>` 重复值），传递到服务层。
- `src/application/delivery-service.ts`：操作前校验、文案持久化、按阶段拼装、`findOperationCommit` 改造、模板生成。
- `src/application/delivery.ts`：trailer 解析与 `isStageCommit`。
- `src/application/worktree-merge.ts`：判定改走统一辅助。

测试面：

- 单元：解析与校验（空、超长首行、缺空行、`Knit-` 冲突、CRLF、8 KB 上限）、模板截断、trailer 解析、旧格式回退。
- 集成：带文案交付；无文案回落模板并报告来源；非法文案在无副作用状态下失败；重试复用持久文案并忽略新文件；metadata／archive 新模板；旧格式操作恢复；`worktree-merge` 判定；`history-search` 命中新正文。
- 回归：`test/delivery.test.mjs`、`test/closeout.test.mjs`、`test/worktree-merge.test.mjs` 的 subject 断言按新格式更新。
