---
id: k-4013f43dcbdb
title: 梳理并修订系统内置交付规范
status: delivered
stage: null
verification: self
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-24T14:10:31.446Z
---

## 目标与范围

精简并校准系统内置交付规范 `assets/standards/delivery.md`，删去与现行 `knit deliver` 实现脱节、重复或过时的条款，并将关闭 `worktree.autoMerge` 时的手工合并清理命令指引下沉到 `knit deliver` 的实际输出中，减少无关提示词噪音。

- **改动范围**：
  - `assets/standards/delivery.md`：按「收尾核对、授权与交付、提交文案、异常与红线」重排精简：
    - 保留极简收尾核对（对照完成条件核实实际改动与验证结果再汇报，没跑的验证不写成通过、数字照实际输出写；任务返工过时汇报返工原因并问用户是否记入避坑清单），删除“收尾由主会话自己做，不派执行者”、汇报文风偏好以及与 `knit deliver` 矛盾的“提交和归档各自要有授权”。
    - 精简授权与交付规则：交付（`knit deliver`，一步完成归档与提交）前须取得用户明确授权，已授权的不重复确认；一次交付授权同时覆盖后续合并与清理，不含推送、发布、部署；派发过的任务补改动在 Worktree 里改；取消任务（`knit task cancel`）不可逆，由用户决定。
    - 整节删除过时的「提交范围」（手工 `git add` 与 `git show --stat`）。
    - 大幅精简「派发过的任务」：删除大段 `autoMerge` true/false 命令操作说明，只保留不可逆安全红线（合并失败或清理被 Git 拒绝时以输出为准、不看退出码，保留现场并把 Git 错误原样报给用户；不自行解冲突、不强行合并、不用 `--force` 删 Worktree、不用 `git branch -D`）以及“同一原因失败两次即停下报告”。
    - 精简「提交文案」：去掉强制手写 `Task: <任务 ID>` 的要求（统一由 `knit deliver` 自动追加 `Knit-Task: <id>`），仅保留首行写明改动结果（不能只有任务编号）、由主会话交付时直接写好提交、以及不手写 `Knit-` 开头的行。
  - `src/cli/deliver.ts`：当派发过的任务在 `autoMerge` 关闭（`integration === null`）且已生成提交时，在 `"这个提交还没有合并进主检出的分支"` 之后补充一行后续合并与清理命令提示（使用 `shellQuote` 转义 Worktree 路径，给出 `git merge --no-edit <branch>`、`git worktree remove <path>`、`git branch -d <branch>`）。
  - `test/deliver-worktree.test.mjs`：更新受影响的 `knit deliver` 精确输出断言，不新增碎片测试文件。
  - `docs/design/DESIGN.md`：同步更新第 8.2 节关于 `autoMerge` 关闭时 `knit deliver` 输出说明，保持文档与代码一致。
- **不包含与延后**：
  - 不改动 `knit deliver` 的归档、提交、回滚、合并与授权核对核心事务逻辑。
  - 不改动其它三份内置规范（`discussion.md`、`task-splitting.md`、`task-writing.md`）。
  - 全局安装升级（`npm run pack:install`）使新版内置规范在全局 `knit` 生效，留待本任务交付后按用户单独授权执行。

## 完成条件

### Requirement: 系统内置交付规范精简且与现行交付机制一致

#### Scenario: 内置交付规范仅保留最小必要规则且无过时冲突条款

- GIVEN 读取 `assets/standards/delivery.md`
- WHEN 核对 frontmatter 与正文条款
- THEN 保持 `stages: [deliver]` 与 `title: 交付规范` 声明；保留极简收尾核对（含返工避坑提醒）、统一交付授权（覆盖合并与清理、不含推送/发布/部署）、不含 `Task:` 强求的提交文案底线（首行说清结果、不手写 `Knit-` 行）以及 Worktree 安全红线与两次失败停止；不再包含“不派执行者”、手工 `git add`/`git show --stat`、“提交和归档各自授权”及冗长的 `autoMerge` 命令操作步骤

### Requirement: 关闭 autoMerge 时由 deliver 输出给出后续合并与清理指引

#### Scenario: autoMerge 关闭交付后输出明确的合并与清理命令

- GIVEN 存在任务 Worktree 且 `.knit/config.json` 中 `worktree.autoMerge` 未开启（缺省或显式 `false`）
- WHEN 执行 `knit deliver <id> --authorization ... --message-file ...` 成功提交
- THEN 标准输出在“这个提交还没有合并进主检出的分支”之后给出在主检出运行的合并与清理命令（含 `git merge --no-edit <branch>`、`git worktree remove <path>`、`git branch -d <branch>`），`npm run typecheck`、`npm run build` 与定向测试 `node --test test/deliver-worktree.test.mjs test/deliver.test.mjs test/standards.test.mjs test/context.test.mjs` 全部通过

## 待澄清

无。

## 相关资料

- `assets/standards/delivery.md` — 现行系统内置交付规范
- `src/cli/deliver.ts` — `knit deliver` 命令输出与指引
- `src/infrastructure/process.ts` — `shellQuote` 路径引用工具
- `test/deliver-worktree.test.mjs` — 既有 Worktree 交付输出测试（优先在此更新断言）
- `docs/design/DESIGN.md#8. 完成与交付` — 第 8.2 / 8.3 节交付与合并清理设计说明

## 结果

已精简系统内置交付规范 assets/standards/delivery.md（47 行收敛至 27 行），删除手工暂存、分别授权、不派执行者、重复 Task: trailer 及冗长的 autoMerge 步骤；在 src/cli/deliver.ts 中为关闭 autoMerge 的 Worktree 交付补充了使用 shellQuote 转义的合并清理命令提示，并同步 test/deliver-worktree.test.mjs 与 docs/design/DESIGN.md 第 8.2 节。验证：npm run typecheck、npm run build 通过；node --test test/deliver-worktree.test.mjs test/deliver.test.mjs test/standards.test.mjs test/context.test.mjs 共 68/68 通过；未执行 npm run pack:install（延后至交付后单独授权）。
