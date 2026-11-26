---
id: k-9a36f357607f
title: 拆分宿主上下文的静态规范与动态状态注入
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-26T13:43:44.714Z
---

## 目标与范围

**要解决的问题**：目前 [host-hook.ts](src/application/host-hook.ts) 把整套静态讨论规范（`discussion.md` + `task-splitting.md` + `task-writing.md`，约 10 KB）、环节补充规范、避坑条目以及动态任务状态拼成一整段字符串，只存一个 `lastDigest`。在 Antigravity 和 WorkBuddy 这类通过历史消息追加上下文的宿主里，每次任务状态变化（选任务、`ready`、`start`、执行结束、`close`、`deliver`）都会导致整套 10~20 KB 的规范与 WorkBuddy 宿主指引再完整注入一遍，单个任务生命周期会在对话历史中堆积 7~10 份重复规范（100~180 KB 冗余上下文）。

**改动目标**：
- 在 `src/application/session-context.ts` 与 `src/application/host-hook.ts` 中，将钩子宿主的上下文拆分为独立跟踪摘要的模块：**讨论静态规范**、**当前环节补充规范（含避坑清单）**、**动态任务状态**（以及 WorkBuddy 宿主的静态指引）。
- 当仅任务状态变化、静态规范和当前环节补充规范未变时，Antigravity 与 WorkBuddy 钩子只注入轻量的动态任务状态块，不再重复发送已注入过的静态讨论规范或宿主指引。
- 当切换环节或规范文件/避坑分区内容本身发生变化时，仅增量注入发生变化的那部分规范 + 动态任务状态。
- 当内容完全未变时，继续返回空（零注入），保持「任务状态没变时每轮输出稳定」原则。
- 兼容已有 `.knit/.runtime/host-sessions/*.json` 旧格式会话状态文件（旧文件只有 `taskId` 和 `lastDigest`，读取时平滑迁移/回退，不抛错）。
- 同步更新 `docs/design/DESIGN.md` 第 5 节与第 9 节关于钩子宿主增量注入的说明。

**明确不做 / 边界**：
- `knit context [id]` CLI 命令的完整输出格式保持不变（供命令行直接查看及 Pi 桥接每轮替换系统提示使用）。
- Pi 桥接模板 `assets/templates/pi/extensions/knit.ts` 保持原系统提示替换机制不变（不引入未核实的 Pi 扩展消息接口）。
- 不改动 `.knit/standards/`、`.knit/workflow.yaml`、`.knit/config.json` 或 `.knit/agents/` 等受保护路径。
- 不触碰 `host-command.ts` 的命令解析与交付授权核对逻辑。

**实现思路**：
- 在 `session-context.ts` 中保留 `contextLines` 完整渲染不变，另提供分块渲染或结构化片段（如 `discussionBlock`、`statusBlock`、`supplementBlock`），使 `host-hook.ts` 可以分别计算摘要并只拼接本次发生变化的片段。
- 在 `host-hook.ts` 的 `SessionState` 中按区块记录摘要（如 `discussionDigest`、`supplementDigest`、`statusDigest`，以及可选的宿主附注摘要如 WorkBuddy 的 `guidanceDigest`）。
- 特别注意 `pitfalls.md` 的处理：当前任务切换环节（例如从无任务 `discuss` 进入 `implement` 再进入 `deliver`）时，避坑清单选区会变化；应确保避坑清单归入独立摘要或随当前环节补充规范跟踪，这样切换环节时能收到新分区的避坑条目，而同一环节内仅状态变更（如 `ready` → `active` → 结束）时不会重复注入整个 `discussion.md` 或 `development.md`。
- 选中任务损坏或读不出来时，仍只输出错误提示（以及必要时未发过的讨论规范），不因重复注入膨胀。
- `selectHostTask` 切换或取消任务时，只清空需要刷新的动态状态摘要（保留已发送的 `discussionDigest` 等静态摘要），避免仅仅执行 `knit context --use <id>` 就把 `discussion.md` 再灌一遍。

## 完成条件

### Requirement: 钩子宿主首轮完整注入、后续按块增量注入
#### Scenario: Antigravity 首轮注入完整规范，选任务及状态变化时不重复注入讨论规范
- WHEN Antigravity 会话首次触发 `SessionStart` 注入上下文，随后选中任务、确认需求、任务状态发生变化（含取消/归档）并触发 `PreInvocation`
- THEN 首轮包含完整 `discuss` 规范和未选中提示；选中任务或状态变化后的后续注入包含最新任务状态、目录、下一步及新增/变化的环节补充规范，且不再重复包含未变化的 `knit:standards/discussion.md` 等讨论规范正文；状态和规范都未变化时返回 `{}`

#### Scenario: WorkBuddy 宿主指引和静态规范不随状态变化重复注入
- WHEN WorkBuddy 会话首次触发 `SessionStart`，随后选中任务或任务状态变化并触发 `UserPromptSubmit`
- THEN 首轮 `additionalContext` 包含讨论规范与 WorkBuddy 宿主指引；后续仅状态变化时，只注入变化的状态和必要的新环节补充规范，不重复附加相同的讨论规范和宿主指引

#### Scenario: 规范或避坑分区变化时自动补发更新内容
- WHEN 同一会话中切换任务环节导致适用补充规范或避坑分区变化，或磁盘上的规范文件内容被修改
- THEN 下一次 `PreInvocation` / `UserPromptSubmit` 自动注入发生变化的规范或避坑分区块，未变化的讨论规范不重复发送

### Requirement: 兼容性与已有 CLI/Pi 行为保持
#### Scenario: 旧格式 host-sessions 状态文件与 `knit context` 命令兼容
- WHEN `.knit/.runtime/host-sessions/` 中存在仅含 `{ taskId, lastDigest }` 的旧状态文件，或直接调用 `knit context [id]`
- THEN 旧状态文件能正常读取并更新而不报错；`knit context [id]` 仍输出完整的讨论规范、任务状态与补充规范；选中任务损坏无法读取时返回错误提示且不崩溃

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#5-交接` — 现行主会话上下文与宿主钩子设计
- `src/application/host-hook.ts` — 钩子会话状态与去重内核
- `src/application/session-context.ts` — 主会话上下文组装与渲染
- `src/adapters/antigravity/host-hook.ts` — Antigravity 宿主钩子适配
- `src/adapters/workbuddy/host-hook.ts` — WorkBuddy 宿主钩子适配
- `test/host-hook.test.mjs` — 钩子注入与去重回归测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build` 和 `node --test test/host-hook.test.mjs test/context.test.mjs test/bridge.test.mjs`，再补跑一次全量 `npm test`（因涉及跨宿主共用上下文模块），全部通过。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已拆分 Antigravity 与 WorkBuddy 宿主上下文为独立摘要块（discussion/status/supplement/pitfalls/guidance），仅在对应块变化时增量注入，兼容旧会话状态文件，保留 knit context 与 Pi 桥接完整输出，并同步更新 docs/design/DESIGN.md 第 5、9 节。验证：npm run typecheck、npm run build 通过；node --test test/host-hook.test.mjs test/context.test.mjs test/bridge.test.mjs 34/34 通过；全量 npm test 503 通过、0 失败、7 项跨文件系统测试因未配置 KNIT_TEST_CROSS_DEVICE_DIR 跳过。未验证：未启动真实桌面宿主或模型。
