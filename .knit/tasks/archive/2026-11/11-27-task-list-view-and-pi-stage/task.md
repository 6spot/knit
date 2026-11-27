---
id: k-36389e742157
title: 增强任务列表全局视图并补齐 Pi 桥接 stage 参数
status: delivered
stage: null
verification: self
parent: k-b7380720fbf3
dependsOn: []
priority: P1
createdAt: 2026-11-27T00:42:26.445Z
---

## 目标与范围

**要解决的问题**：
1. 当需求拆成主任务加多个子任务并行推进时，`knit task list` 只平铺输出 `优先级 ID 状态 标题`，看不出父子归属、依赖阻塞、执行是否正在运行或进程已掉线、以及是否遗留未合并的已交付任务分支，需要反复运行 `task show` 和 `run status` 才能拼出全貌。
2. Pi 桥接工具 `knit_run`（`assets/templates/pi/extensions/knit.ts`）漏透传了 CLI 已支持的 `--stage` 参数，并行审查裁决指定目标环节时无法直接通过 `knit_run` 完成。

**改动目标**：
1. **增强活跃任务列表视图（`src/cli/task.ts` 及必要的辅助函数）**：
   - 保持现有主行格式前缀 `优先级  ID  状态  标题`（以及 `（确认后改过需求）`）清晰兼容，针对活跃任务列表（不带 `--archive`）补充全局项目视角信息：
     - **父子层级**：若子任务的 `parent` 也在活跃任务列表中，将其归组并缩进（2 空格）显示在该父任务下方（按原有优先级+创建时间排序规则对顶层任务和同一父任务下的子任务分别排序；支持多层嵌套）；若父任务不在活跃列表中（已归档或不存在），保持顶层显示并在行尾附注 `父:<parentId>`。
     - **依赖阻塞**：对 `dependsOn` 非空的活跃任务，检查尚未满足的依赖（未归档/非 `delivered`、已取消、或虽 `delivered` 但任务分支尚未合并进当前 `HEAD`），在行尾标注 `阻塞:<未满足依赖 ID 列表>`（复用或参考已有依赖状态判定，不重复扫描全部归档）。
     - **活跃运行态**：对存在未结束执行（`endedAt === null`）的活跃任务，检测进程状态：后台进程仍在跑时标注已运行时长（如 `运行中 3m` 或 `<1m`）；后台进程已不在时标注 `进程已退出`；若没有正在跑的执行但 `nextStep` 为 `arbitrate`，标注 `待裁决`。
     - **未合并任务分支提醒**：在 Git 仓库里运行活跃 `knit task list` 时，若本地存在尚未合并进 `HEAD` 且不属于当前活跃任务的 `knit/*` 任务分支（即已交付但尚未合并清理的分支），在列表末尾追加提示段列出分支名及合并提示（若无此类分支则不输出，保持干净）。
   - `--archive` 归档列表保持原有平铺格式不变（避免大量历史归档引入不必要开销）。
   - 若项目没有 `.knit/workflow.yaml` 或流程文件有错，`knit task list` 仍能容错输出列表（仅跳过依赖流程的 `待裁决` 判定），不因流程损坏而瘫痪列表查看。
2. **补齐 Pi 桥接 `knit_run` 的 `stage` 参数（`assets/templates/pi/extensions/knit.ts`）**：
   - 在 `RunParams`、工具参数 schema 和工具描述中增加可选 `stage?: string` 参数；
   - `action === "start"` 时将其透传为 `--stage=<stage>`（沿用现有 `single("--stage", params.stage)` 写法）。
3. **同步文档**：更新 `docs/design/DESIGN.md` 第 9 节 Pi 桥接表格（补充 `stage` 参数说明）与命令行说明。

**明确不做 / 边界**：
- 不修改 Worktree 中的受保护路径（`.knit/workflow.yaml`、`.knit/config.json`、`.knit/standards/`、`.knit/agents/`）以及 `.pi/extensions/knit.ts`（只改模板源文件 `assets/templates/pi/extensions/knit.ts`）。
- 不增加 `knit task list` 对全部归档任务的全量扫描开销（保持 Batch 2 的按需扫描性能）。

## 完成条件

### Requirement: 活跃任务列表展示层级、阻塞、运行态与未合并分支
#### Scenario: 父子层级缩进、依赖阻塞与运行态标注准确显示
- WHEN 项目存在父任务、子任务（含父任务已归档的子任务）、带未满足依赖的任务、正在运行或进程意外退出的任务，以及等待并行裁决的任务，运行 `knit task list`
- THEN 活跃子任务缩进排在对应父任务下方；未满足依赖标出阻塞 ID；运行中任务显示运行状态与时长，进程已退出任务标出 `进程已退出`，等待裁决任务标出 `待裁决`；`--archive` 保持平铺格式不变

#### Scenario: 未合并的已交付任务分支在列表末尾给出提醒
- WHEN Git 仓库中存在尚未合并进当前 `HEAD` 且不属于当前活跃任务的 `knit/*` 分支，运行 `knit task list`
- THEN 列表末尾输出未合并分支提醒；当没有遗留未合并任务分支时，不输出该提示段

### Requirement: Pi 桥接 `knit_run` 支持透传 `stage` 参数
#### Scenario: 通过 `knit_run` start 传递 `stage` 参数生效
- WHEN 在 Pi 桥接中调用 `knit_run`（`action: "start"`, `stage: "implement"`, `instruction: "..."`）
- THEN 工具参数 schema 声明了 `stage`，底层 CLI 收到 `--stage=implement` 参数且通过模板类型检查与打包检查

## 待澄清

## 相关资料

- `docs/design/DESIGN.md#9-命令与工具` — 命令行与 Pi 桥接工具声明
- `src/cli/task.ts` — `knit task list` 实现入口
- `src/application/task-store.ts` — 任务按需扫描与查找
- `src/application/run-control.ts` — `liveWorker` / `startingWorker` 进程状态检测
- `assets/templates/pi/extensions/knit.ts` — Pi 桥接模板源文件
- `test/task-lifecycle.test.mjs` — 任务列表测试
- `test/bridge.test.mjs` — Pi 桥接工具测试
- `test/bridge-run.test.mjs` — Pi 桥接 `knit_run` 测试

## 验证与交付

- 运行 `npm run typecheck`、`npm run build`、`./node_modules/.bin/tsc -p tsconfig.templates.json`、`node --test test/task-lifecycle.test.mjs test/bridge.test.mjs test/bridge-run.test.mjs test/init.test.mjs`、`npm run pack:check` 与全量 `npm test`，全部通过。
- 改动留在任务 Worktree 分支，不自行提交，交由主会话核对并交付。

## 结果

已增强活跃任务列表全局视图（父子多级缩进与外部父任务标注、未满足依赖阻塞标注、运行中时长/进程已退出/待裁决状态、末尾未合并 knit/* 分支提醒；--archive 保持平铺，流程损坏时容错，外部依赖按需查归档早停），并补齐 Pi 桥接 knit_run 的 stage 参数透传及 docs/design/DESIGN.md 第 9 节文档。验证：npm run typecheck、npm run build、tsc -p tsconfig.templates.json、npm run pack:check、git diff --check 通过；定向测试 62/62 通过；默认环境 npm test 524 通过、0 失败、7 跳过，启用临时跨卷与并发度 3 复验 531/531 全通过。未验证：Pi 执行者使用测试脚本，未调用真实模型。
