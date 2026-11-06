---
id: k-dc240b5bd511
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-06T06:58:00.899Z
title: init 强制覆盖与按客户端的初始化开关（--force 覆盖项目模板、init/start 改 --pi）
---

# init 强制覆盖与按客户端的初始化开关

## 背景

`knit init` 现在对项目文件（`.knit/config.json`、`.knit/workflow.yaml`、`.knit/agents/*.md`、`.knit/standards/index.md`）只补缺，存在即「沿用」；已有 `--force` 只影响受管内容（`AGENTS.md` 标记块与 `.pi/extensions/knit.ts` 桥接）。版本升级后模板变化无法落到已有项目。用户决定：默认仍不覆盖；新增强制覆盖参数；初始化按客户端开关调用（`knit init --pi`，未来 `knit init --pi --codex`），测试阶段不做旧参数兼容。

## 完成条件

### 1. `--force` 覆盖项目模板文件

- `knit init --force`：对模板声明过的每个路径，若已存在且内容与当前模板不同，就按模板覆盖；内容已一致则不重写（报告为已一致）。
- 覆盖前把原文件备份到 `.knit/.runtime/init-backup/<时间戳>/<相对路径>`（目录 0700，按需创建），结果里返回备份根与备份路径清单；未发生覆盖时不创建备份目录。
- 默认行为不变：不带 `--force` 时项目文件仍「沿用」，受管文件仍按基线核对。
- `knit init --check --force`：计划里把这些项标为将覆盖（含「模板已更新」「与模板不同」等原因），不写任何文件、不建备份。
- 模板已移除的旧文件仍只报告不删除；覆盖不删除项目里用户自建的非模板文件。
- 清单与结果字段：新增覆盖计数／备份信息，JSON 只增不改既有字段；`ready` 判定不变（覆盖成功不降级）。
- 受管文件（桥接、AGENTS 标记块）在 `--force` 下的现有语义保持不变。

### 2. 初始化与启动改为客户端开关

- `knit init` 去掉 `--client <id>`，改为按客户端注册表生成布尔开关：当前只有 `--pi`；不带任何客户端开关时默认 `pi`（保持零参数体验）。
- `knit start` 同步改为 `--pi`（同样默认 pi），错误提示与「先初始化」提示里的命令示例一起更新；`--` 之后的参数仍原样透传给 Pi。
- 未注册的客户端开关（例如未来的 `--codex`）由 commander 直接报未知选项；不再维护「不支持的客户端 ID」分支。
- `src/cli/run.ts` 的 `--client <pi|cli>` 是 worker 运行时选择，语义不同，不改。
- 文档同步：`docs/design/DESIGN.md` 第 14 节命令表与 763／765／775 行说明、`docs/design/OPERATIONS.md` 第 1 节、安装包 README 或模板内的 `knit init` 示例；`--force` 的新语义写清「默认不覆盖、force 覆盖并备份」。

### 3. 测试

- `test/init.test.mjs`：默认沿用；`--force` 覆盖项目文件且备份内容为原文；内容一致时不备份；`--check --force` 只预览；孤儿只报告；`--pi` 与无开关等价；未知客户端开关被拒绝。
- 更新所有调用 `init --client pi` 的测试（`test/bridge-query.test.mjs`、`test/m1-cli.test.mjs` 等）与 `init --client codex` 的拒绝断言。
- `npm run typecheck` 通过；`npm test` 全绿（当前 516 例，新增用例后总数自增）。

## 边界

- 不实现「上次模板基线 + 未改动文件自动升级」；本任务只做默认沿用与显式 `--force`。
- 不删除模板移除的旧文件，不迁移用户自建文件，不改 manifest 版本兼容策略（测试阶段允许不兼容旧清单字段）。
- 不改 run 状态机、交付与归档规则；不改 `src/cli/run.ts` 的 `--client`。
- 实施 run 不得修改 `.knit/` 下任何文件；本仓库实际执行 `knit init --force` 由主会话在 run 之外决定。

## 输入引用

- 代码：`src/application/initialization.ts`（`plan`／`execute`／`record`、`InitPlanItem.action`、`InitResult`）、`src/application/templates.ts`（`TEMPLATE_SPECS`、`templateDigest`）、`src/application/init-manifest.ts`、`src/cli/init.ts`、`src/cli/start.ts`、`src/cli/output.ts`（`formatPlanItem`）。
- 测试：`test/init.test.mjs`、`test/m1-cli.test.mjs:29`、`test/bridge-query.test.mjs:37`、`test/pack*`／`scripts/pack-check.mjs`（模板资产清单如涉及）。
- 文档：`docs/design/DESIGN.md` 第 14 节（310–311、763、765、775 行附近）、`docs/design/OPERATIONS.md` 第 1 节。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 实施结果（run-1957c2235973，18 分钟）

- `src/application/clients.ts`（新）：客户端注册表（当前仅 `pi`，`default: true`）与 `resolveClientIds`；`src/cli/client-flags.ts`（新）：按注册表生成 `--pi` 开关、解析所选客户端（无开关 → 默认项）。
- `src/cli/init.ts`：去掉 `--client <id>` 与「不支持的客户端 ID」分支，改用注册表开关；`--force` 说明改为「按当前模板覆盖已有项目资料并备份原文件」；输出新增「已一致（未重写）」「覆盖（已备份原文件）」「备份根」；`--check` 增 `--force` 预览提示。
- `src/cli/start.ts`：同样改为 `--pi`，错误与「先初始化」提示同步；`--` 后的参数透传不变。
- `src/application/initialization.ts`：`plan(root, {force})` 中项目文件在 force 下与模板比较，不同则标记 `overwrite` + 计数；`check` 接受 force 选项；`execute({clients})` 统一用注册表默认；覆盖前把原文件写入 `.knit/.runtime/init-backup/<时间戳>/<路径>`（0700，同毫秒冲突追加序号），带 `expectedSha256` 原子写覆盖；未发生覆盖不建备份目录；清单与结果新增 `overwriteCount`／`backupRoot`／`backups`／`alreadyCurrent`（旧字段不变）。
- `src/application/templates.ts`：新增 `templateContent()`（config.json 由 `defaultConfig()` 生成），`templateDigest` 复用，去掉 `require`。
- `src/application/init-manifest.ts`：schema 增可选 `overwriteCount`／`backupRoot`／`backups` 与条目 `backupPath`。
- `src/cli/output.ts`：`formatPlanItem` 支持 `overwrite` 标签「覆盖」。
- 文档：`docs/design/DESIGN.md` 第 14 节（命令表、763／765／775 行）、`docs/design/OPERATIONS.md` 第 1 节、`README.md` 的 `init`／`start` 示例。

### 验证（主会话复核 2026-11-06）

- `npm test`：519/519 通过（较上一版 +3）。
- 临时仓库实测：`knit init --pi` 创建 10 项；改坏 `.knit/config.json` 与 `.knit/agents/implement.md` 后 `init --check --force` 显示「覆盖 …（将按模板覆盖并备份）」且不写文件；`init --force` 覆盖两项、生成 `backupRoot`，备份内为原坏内容，目录 0700；再跑 `--force` 全部「沿用」且不新建备份；不带 `--force` 仍沿用。
- `knit init --codex` → `error: unknown option '--codex'`，退出码 1；`knit init --help` 与 `knit start --help` 均只见 `--pi`；`knit run prepare --help` 仍保留 `--client`（worker 运行时选择未受影响）。
- 本仓库 `knit init --check --force`：仅 `.knit/config.json` 与模板不同（项目里刻意保留了 `phases.*.model`），预览标为将覆盖但未执行——正好验证默认不覆盖、需显式 `--force`；其余 5 个项目文件与桥接、AGENTS 块均一致。
- `knit doctor`：`[ok] init-manifest: state=ready`，旧清单无新字段仍可读。

### 已知边界

- 未实现「基线 + 未改动文件自动升级」：跨版本仍需显式 `--force`。
- 备份只保存被覆盖前的原文，不自动清理；`.knit/.runtime` 在忽略规则内。
- `knit init` 输出的「沿用: N 个项目文件」计数含受管项（既有文案，未在本任务调整）。

### 交付记录

<!-- knit:delivery:op-939a2fddf590 -->
- 操作: op-939a2fddf590
- 时间: 2026-11-06T07:37:07.732Z
- 分支: refs/heads/main
- 授权来源: user 2026-11-06 本会话明确授权：init 强制覆盖与客户端开关按完整方案实施并本地提交，不含 push／发布
- 工作提交: bcff877f563ae34cd314acaf246dba5e7983779f
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-06-init-force-overwrite-and-client-flags

<!-- knit:progress:end -->
