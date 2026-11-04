# 设计：REX 自动呈现（k-6cb0e54b3c8d）

## 解析优先级（高→低）

1. 调用级：`--rex` → rex；`--local` → local；同时出现 `invalid_request`。
2. `.knit/config.json` `execution.host`：`rex` 强制、`local` 强制、`auto`／缺省自动。
3. 自动：环境、CLI、server、方法齐备才 rex，否则 local 并记原因。

`host: "rex"` 或 `--rex` 失败不回退，报明原因（CLI 缺失、连接失败、缺必需方法、无 Rex 环境）；`auto`／未配置才在派发前静默回退。浮层创建或 worker 启动后的失败不换宿主，沿用 `rex_start_failed:*`；活动 run 的 `presentation` 不可变。

## 探测

- 环境：`REX_SESSION` 与 `REX_BLOCK` 均存在。
- CLI：`REX_BIN_DIR/rex` 或 PATH 上的 `rex`（复用 `RexApi` 默认）。
- 能力：`RexApi.check()` + `REX_REQUIRED_METHODS`（7 个方法），不新写协议。
- 结果缓存仅限单次解析，不落业务状态。

## 代码改动点

1. `src/application/config.ts`：`execution.host` 枚举 `auto|local|rex`，`defaultConfig()` 为 `auto`；旧 `local` 仍显式本地；未知值 schema 报错。
2. 新 `src/application/host-selection.ts`：
   - `HostSelection = { host: "local"|"rex"; source: "explicit"|"config"|"auto"; fallbackReason: string|null }`；
   - `selectHost({ explicit, config, env, probe })` 纯决策 + 可注入 probe（默认调 RexApi）；
   - 自动模式仅在探针通过时 rex；显式/config rex 失败抛 `GuardError("rex_unavailable", ...)`（原因含哪一步失败）。
3. `src/application/run-coordinator.ts`：`prepare` 调 `selectHost`；请求落盘 `presentation`、`presentationSource`、`presentationFallbackReason`（可选字段，旧请求缺省 local/config 兼容）；`start` 只读已持久化值，不重新探测。
4. `src/cli/run.ts`：`prepare/implement/check/assist` 增 `--local`，与 `--rex` 冲突报 `invalid_request`；`--scope` 非正式检查仍拒绝 rex；`run list`／`status` 显示 host、来源与回退原因。
5. 桥接：`knit_run` 不传 `--rex` 也按配置/环境自动生效（扩展进程可读 `REX_SESSION`）；不新增 presentation 覆盖参数；schema／两份扩展同步。
6. 文档：DESIGN 5.7/13、OPERATIONS、README、ARCHITECTURE 现行 REX 描述改为已实现 + 触发规则；本仓库 `.knit/config.json` 由主会话在 run 后改 `auto` 并单独提交（`.knit/` 阶段保护）。
7. 测试：优先级矩阵、冲突、三类探针失败、显式 rex 不回退、auto 回退原因、活动 run 呈现不可变、桥接自动生效、旧配置兼容。

## 验证

- `npm test` 全量；新增 `test/host-selection.test.mjs`（或并入既有 rex 测试）。
- 普通终端（无 Rex env）自动 local，原因可见；模拟 env+CLI 通过时 rex。
- 真实 Rex 浮层验收按既有决策延期，报告写明未执行。
