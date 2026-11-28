---
id: k-72cbe3f04c43
title: 修复 Pi 动态上下文注入造成的提示词缓存失效
status: delivered
stage: null
verification: independent
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-28T03:06:18.250Z
---

## 目标与范围

让 Pi 主会话在任务选择、状态或环节变化后复用已有提示词前缀，同时让模型及时看到最新任务状态、下一步和当前环节适用规范。本项先于 `修复 Pi 执行完成通知的忙时投递、压缩防丢与 Shell 挂载（k-7a4922a00e1e）` 实施，两项任务共用 `assets/templates/pi/extensions/knit.ts`。

明确不做与边界：

- 保留 `knit context [id]` 默认的完整命令行输出，以及 Antigravity、WorkBuddy 和 Qoder 现有的宿主钩子注入行为。
- 不复用 `src/application/host-hook.ts` 的磁盘会话摘要文件（不往 `.knit/.runtime/host-sessions/` 写入 Pi 摘要），避免磁盘状态与 Pi 的压缩或会话树分支切换脱节。
- 不修改交付授权核对的实现逻辑（仅补充回归测试覆盖新增自定义消息的隔离）。
- 不修改 `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 或 `.knit/agents/` 等受保护路径。

### 背景与证据

提交 `bbd6984` 已为 Antigravity 和 WorkBuddy 增加按块增量注入。Pi 仍在 `before_agent_start` 把整份 Knit 上下文写进 `sections.knit`。本机 Pi 1.7.0 的 Magpie `openai-responses` 配置会把后续系统段合并到请求开头的 `developer` 消息。Knit 段里仅增加一条说明，也会改写该消息并击穿整段提示词缓存。

2026-11-27 至 28 日的同一 Pi 会话里，714 次有用量记录的请求中有 708 次读到了缓存。以下三次请求使用同一模型 `remote/group/astra`。Knit 段更新前后没有发生会话压缩，数字取自模型返回的 `usage`，单位为 token。

| 时点 | `cacheRead` | 未命中的 `input` |
| --- | ---: | ---: |
| Knit 段更新前 | 83,840 | 408 |
| 更新后首次请求 | 10,624 | 66,565 |
| 随后一次请求 | 77,568 | 2,055 |

用 Pi 1.7.0 的 Responses 适配器离线重放，已验证把变化放入一条追加的 Pi 自定义消息后，既有请求项逐项相同，工具声明也相同。实际缓存用量还需修复后另行授权实测。

### 修复方案

1. **提供无状态的分块 CLI 输出**：保留 `knit context [id]` 默认纯文本输出，新增结构化分块输出（如 `knit context [id] --json`），直接复用 `src/application/session-context.ts` 的 `contextBlocks`，返回 `discussion`、`status`、`supplement`、`pitfalls` 块。选中任务损坏或读不出来时，仍返回 `discussion` 块并在 `status` 中给出错误详情，不崩溃。
2. **稳定系统提示，动态变化走末尾自定义消息**：
   - `sections.knit` 只承载稳定的 `discussion` 块（不含 `pitfalls`）。选中任务读不出来时，**不把报错写入 `sections.knit`**，而是放入动态消息的 `status` 块，避免瞬时错误击穿整段缓存。
   - 当前任务状态、下一步、随环节变化的补充规范与避坑分区，合并为一条带有 Knit 来源标记的 Pi 自定义消息（`customType: "knit.context"`、`display: false`，`details` 记录版本号与各块摘要），在 `before_agent_start` 中通过返回值 `{ message }` 追加到本轮输入末尾（不调用 `pi.sendMessage`，也不额外唤醒模型）。
   - 当本轮存在工具调用且即将进入下一拍（`turn_end` 且 `toolResults.length > 0`，例如同轮内通过 `knit_task` 切换了任务/环节，或忙时收到了执行完成通知）时，若动态块发生变化，通过 `turn_end` 边界的 `entries` 追加一条同样格式的 `display: false` 增量自定义消息，消除同轮工具调用间的规范盲区；本轮无工具调用即将结束时不追加，不额外触发模型请求。
3. **按当前分支对模型可见的内容比对与重建**：
   - 查当前选中任务继续读取完整 `sessionManager.getBranch()` 中的最新 `knit.selection`（自定义状态条目不进模型上下文，不能被压缩抹掉）。
   - 判断哪些动态块仍对模型可见时，读取 `sessionManager.buildSessionContext()`（夹具或旧版缺失该方法时，回退按 `getBranch()` 从最新 `compaction` 条目起裁切），从可见的 `knit.context` 消息的 `details` 归并当前生效摘要。
   - 首次进入会话提供完整动态上下文；后续只追加变化的块，相同状态零追加。压缩、恢复、切换分支后，缺少状态的分支自动补齐，已含相同状态的分支不重复发送。
   - 当 `supplement` 或 `pitfalls` 从非空变为空（例如切回 `draft` 或取消选中任务）时，显式附带一句简短失效说明（标明此前注入的环节规范或避坑条目已不再适用），再更新对应摘要，防止模型沿用历史消息中的旧规范。
   - 打开带有旧全量 `sections.knit` 的历史会话时，迁移后的首次请求允许将 `sections.knit` 收敛为讨论规范（触发一次系统段更新），从下一次请求起前缀保持稳定。
4. **同步文档**：更新 `docs/design/DESIGN.md` 第 5 节和第 9 节中关于 Pi 主会话上下文注入的描述。

### 环境前置与验证

- 仓库可移植回归：运行 `npm run typecheck`、`npm run build`、`node --test test/bridge.test.mjs test/context.test.mjs`、全量 `npm test` 和 `npm run pack:check`。在 `test/helpers/bridge.mjs` 扩展 `buildSessionContext()`、压缩、分支切换与 `turn_end` 边界夹具，确保无本机 Pi 安装时 `npm test` 也能完整通过。
- 离线 Responses 请求级重放（环境前置：本机安装 Pi 1.7.0，运行 `pi --version` 确认版本）：使用本地 Pi 1.7.0 的 Responses 转换逻辑做脱敏请求结构对比；若运行环境未安装 Pi 1.7.0，该重放用例应明确跳过并在交付报告中注明，不得导致全量 `npm test` 失败。
- 真实模型的缓存用量复验按仓库约定另行取得授权，本项验收结论限定在请求结构与上下文正确性；改动留在任务 Worktree 分支，不自行提交，交独立审查。

## 完成条件

### Requirement: 任务上下文及时更新，已有提示词前缀可复用

Pi 桥接通过稳定的讨论规范系统段和末尾追加的增量自定义消息维持上下文新鲜度，不因动态状态变化改写已有提示词前缀。

#### Scenario: 动态更新只在请求末尾追加，重复进入同一状态零追加

- GIVEN 一段已有历史的 Pi 会话，模型、工具定义和静态讨论规范固定
- WHEN 通过桥接切换任务、变更任务状态或环节，以及在同一轮工具调用中切换任务后进入下一拍，随后在相同状态下再次进入新一轮
- THEN `sections.knit` 逐字不变；在本地 Pi 1.7.0 Responses 离线重放中，更新前已有的 `developer` 消息和历史输入项逐项相同，工具声明也相同
- AND 新增部分以 `display: false` 的 `knit.context` 自定义消息追加在末尾，包含最新状态或变化块；随后在相同状态下额外追加的 Knit 消息数为零

#### Scenario: 选中、切换环节、取消选择与任务读取失败均能正确反映当前有效规范

- WHEN 从无任务到选中任务，依次变更状态、切换环节、切换回草稿或取消选中，以及选中的任务被删除或损坏无法读取
- THEN 每一步的模型可见输入都能识别当前任务、下一步和适用规范，只改变任务状态时不重复注入讨论规范或未变化的环节规范
- AND 环节补充规范清空或取消选择时，新增消息显式标明旧环节规范不再适用或当前无选中任务
- AND 任务读取失败时，错误提示通过动态消息送出，不改写 `sections.knit`

#### Scenario: 压缩、恢复、切换分支和旧会话均能重建当前状态

- WHEN 恢复已有上下文的会话、压缩掉上次动态注入、切换到另一条会话分支，或打开带有旧全量 `sections.knit` 的历史会话
- THEN 压缩后或缺少状态的分支在下一次请求自动补齐当前动态上下文，同时保留被压缩前的 `knit.selection` 任务选择；已含相同状态的分支不重复注入
- AND 旧会话迁移后的首次请求将 `sections.knit` 收敛为讨论规范并补齐动态上下文，之后继续操作时 `sections.knit` 保持稳定

#### Scenario: 变更后仍能区分用户授权、宿主上下文和命令行输出

- WHEN 用户没有发过相应授权原话，而 `knit.context` 自定义消息中含有相同字样，并通过命令行运行 `knit context [id]`
- THEN 授权核对仍拒绝交付并要求真实用户消息
- AND `knit context [id]` 默认仍输出完整的适用规范和任务信息，且 Antigravity、WorkBuddy、Qoder 的钩子行为不受影响

## 待澄清

## 相关资料

- `assets/templates/pi/extensions/knit.ts` — Pi 桥接源模板
- `src/application/session-context.ts` — 主会话上下文分块与渲染
- `src/cli/project.ts` — `knit context` 命令入口
- `src/application/host-hook.ts` — 其他钩子宿主的按块增量注入参考
- `docs/design/DESIGN.md#5-交接` — 现行主会话上下文与注入设计
- `docs/design/DESIGN.md#9-命令与工具` — 现行 Pi 桥接与 `knit context` 行为说明
- `.knit/tasks/archive/2026-11/11-26-split-host-context/task.md` — 此前按块增量注入的范围与取舍
- `test/helpers/bridge.mjs` — Pi 桥接测试夹具
- `test/bridge.test.mjs` — Pi 桥接现有测试
- `test/context.test.mjs` — 上下文命令与分块测试

## 结果

四个验收场景全部通过，独立复审 r-afb056025d05 判定 pass。Pi 系统段只承载讨论规范，任务状态、下一步、环节规范和避坑条目按变化追加为隐藏消息。Pi 1.7.0 Responses 离线重放确认，工具调用后发生完整或部分自动压缩时，首个请求即补齐缺块；重试、续拍和会话重开后已有输入前缀与三个工具声明逐项相同，状态相同零追加。CLI 瞬时失败保留此前有效的讨论段，合法空值可清除。工具模式下两次读取同一已交付任务的 context --json 结果逐字相同，GIT_TRACE 的 git log 次数为 1、0。默认文本、其他宿主钩子及真实用户授权隔离回归通过。主机在最终工作树复核 typecheck、构建、跨卷全量 npm test 679/679（0 失败、0 跳过）、pack:check 和 git diff --check 全部通过。修复保存在任务工作树的 8 个文件，待提交和安装。实际线上 cacheRead 用量需另行授权实测。
