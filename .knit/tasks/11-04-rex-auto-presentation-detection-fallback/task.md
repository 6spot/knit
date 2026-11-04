---
id: k-cf42205bcf76
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-04T14:52:38.103Z
title: REX 自动呈现：配置/环境识别与派发前回退
---

# REX 自动呈现：配置/环境识别与派发前回退

当前状态：仅登记已确认需求，保持 discuss，不 ready、不启动实施。用户已确认采用方案 A：自动默认 + 只在派发前回退。

## 目标

REX 不再要求调用方（用户、主会话或智能体）手工拼 `--rex`：在 Rex 终端内派发正式阶段时自动使用 Rex 浮层；识别不到或能力不足时静默回退 local；同时保留显式覆盖与项目配置开关。非正式检查（`run check --scope`）仍不支持 Rex。

## 已确认的解析规则（优先级从高到低）

1. 调用级显式覆盖：`--rex` 强制 Rex；新增 `--local` 强制本地；两者同时出现报 `invalid_request`。
2. 项目配置 `.knit/config.json` → `execution.host`（当前为无约束 str 且从未被读取，本任务改为枚举并实际生效）：
   - `auto`：检测通过用 rex，否则 local（新 `knit init` 的默认值）；
   - `local`：始终本地；
   - `rex`：必须用 Rex，不可用时报错，不回退。
3. 未配置该字段：按 `auto` 处理。

显式 `host: "rex"` 或 `--rex` 不可用时报告原因，不静默回退；`auto` 与未配置才允许回退。

## 自动识别条件（三者同时满足才认为 Rex 可用）

- 进程环境存在 `REX_SESSION` 与 `REX_BLOCK`（Rex 终端注入）。本会话实测：`REX_SESSION=session:01a1905e-...`、`REX_BLOCK=block:01a1a586-...`、`REX_BIN_DIR=/usr/bin`，`rex whoami --json` 可返回本机 endpoint 与版本 `0.0.1793741575-g1b6654`。
- `rex` CLI 可执行（`REX_BIN_DIR` 或 PATH；沿用 `RexApi` 默认 `rex`）。
- `rex api list --json` 含 7 个必需方法（`session.new_layer`、`set_layer_state`、`float_block`、`view`、`list_blocks`、`describe_block`、`close_layer`）。本机实测 74 个方法全部具备。

复用现有 `REX_REQUIRED_METHODS` 与 `RexApi.check()`，不新写探测协议。

## 回退语义（已确认）

- 只在派发/启动前回退：未识别到 Rex 环境、CLI 缺失、server 不可连、缺必需方法 → 记录原因后以 local 派发，run 正常创建。
- 浮层已创建或 worker 已启动后的失败不自动换宿主，沿用现有 `rex_start_failed:*` 与失败语义；用户重新派发时再按当时检测结果决定。
- `host: "rex"` / `--rex` 失败不回退，报明确原因（CLI、连接或缺失方法）。
- 活动 run 的 `presentation` 不可变规则保持不变（`run-coordinator.ts:223`）。

## 必须同步的实现与文档

- `src/application/config.ts`：`execution.host` 改枚举 `auto|local|rex`，`defaultConfig()` 改 `auto`；旧配置 `local` 继续表示本地。
- 集中解析点：新增 host 解析（建议 `src/application/host-selection.ts`），由 `RunCoordinator.prepare` 使用；CLI 不再各自判断 `options.rex`（`src/cli/run.ts:63` 等）。`run prepare` 落盘解析结果与来源（explicit/config/auto），`run start` 只用已持久化的 `presentation`。
- `src/cli/run.ts`：`prepare/implement/check/assist` 增加 `--local`；冲突校验；`--scope` 非正式检查保持拒绝 Rex。
- `.pi/extensions/knit.ts` 的 `knit_run`：不传 `--rex` 也随配置/环境自动生效（自动识别发生在扩展进程内，`REX_SESSION` 可读）。
- `knit run list` / `knit status`：显示实际 host 与回退原因（可观测，不写入业务状态）。
- 文档：DESIGN 5.7 与第 13 节（`execution.host` 语义、`--local`、回退）、OPERATIONS 命令行为、README、ARCHITECTURE（如调整装配）；现行文档仍把 REX 写成「后续」，一并改为已实现 + 新触发规则。
- 本项目 `.knit/config.json` 改为 `"host": "auto"`，使本仓库自身立即生效。
- 测试：解析优先级矩阵、`--rex`/`--local` 冲突、探针缺方法/CLI 缺失/session 缺失、`host=rex` 失败不回退、auto 回退原因可见、活动 run 呈现不可变、桥接自动生效。

## 完成条件与验收

- Rex 终端内 `knit run implement --task k-xxx`（不加 `--rex`）产生 Rex 浮层；普通终端同一命令走 local。
- `execution.host: "rex"` 在无 Rex 环境失败并给出原因，不静默回退；`--local` 可在 Rex 内强制本地。
- 未识别到环境或探测失败时 local 派发成功，原因可在 status/list 核对。
- 主会话经 `knit_run` 派发时与 CLI 行为一致。
- 现有测试通过，新增分支有针对性测试；completion/验收资格与既有 RPC 链路行为不变。

## 边界（含已确认取舍）

- 不做运行中自动换宿主（方案 B）。
- 不做 `schemaVersion` 升级迁移；`execution.host` 旧值 `local` 视为显式本地。若希望历史项目默认切到 auto，需要另行决定。
- 真机 macOS+Rex GUI 浮层验收继续按既有决策延期，不宣称完整通过。
- `knit_run` 本轮不增加显式 `presentation`/`rex` 覆盖参数，桥接契约不变；只做配置/环境自动生效。
- `run resume` 沿用旧 run 已持久化的 `presentation`，不重新探测宿主。
- `host: "rex"` 下探测失败使用新增错误码 `rex_unavailable`，保留具体原因（CLI 缺失、连接失败或缺失方法）。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
