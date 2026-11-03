---
id: k-248eafc8fb31
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T15:14:06.963Z
title: Worktree：创建、连接与本机绑定
---

需求冻结（主会话核对 WORKTREE.md §6.1/6.2/6.6、DESIGN §3.5/§3.7/§15.2、TaskBindingSchema（src/contracts/metadata.ts）与 sqlite-metadata-store bindings 表后决策）：

命令设计（新增 `knit worktree` 命令组）：
1. `knit worktree create --task <id> [--path <dir>] [--branch <refs/heads/…>] [--global]`：默认路径 `.knit/worktrees/<MM-DD>-<slug>/`（slug 取任务目录名去掉日期前缀；日期取任务 createdAt 月日），默认分支 `knit/<MM-DD>-<slug>`；被其它任务占用时 slug 加短序号 `-2/-3…` 后同名的路径与分支一并确定。`--path/--branch` 显式指定时按指定值（仍查占用）。`--global` 或内部路径不可用时用 `~/.knit/worktrees/<project-key>/<MM-DD>-<slug>/`（project-key=主目录 basename+绝对路径 8 位 hash；启动前报告最终路径与原因）。
2. `knit worktree connect --task <id> --path <dir>`：连接已有目录；核对 `git worktree list --porcelain` 含该路径、仓库归属本项目、分支为 refs/heads/…；不符报错保留现场。
3. 创建语义：从主检出当前 HEAD（已提交基线）`git worktree add -b <branch> <path> <baseline>`；创建前保证忽略规则生效——查根 .gitignore 与 .knit/.gitignore 是否已有匹配 `.knit/worktrees/` 的规则，无则在根 .gitignore 追加一行（保留现有规则，缺文件则创建）；基线 commit 记入绑定。

绑定扩展（TaskBindingSchema opt 字段，SQLite record JSON 序列化自动兼容，无表迁移）：`worktree: opt(obj({ layout: lit("project")|lit("global"), path: str（项目内为绝对路径，project 布局同时记 relativePath 线索）, branch: str, baseline: str（commit sha）, createdAt: str, registeredAt: str }))`。创建/连接成功后写入；binding 的 relativePath/branch 主字段本任务不改（仍指主检出），切换执行位置属任务 11 交接语义。

守卫与幂等：
- 任务已归档拒绝；活动 run 不阻塞创建（不影响主目录执行）；任务锁内串行。
- 幂等重试：binding.worktree 已存在且路径/分支/基线核实一致（路径存在、porcelain 登记、分支可解析到基线或其后代）→ 直接返回已注册不重建；路径存在但未注册→按 connect 语义核实后登记；分支已被其它 worktree 检出或路径非空且非登记目录→报错保留现场（git_occupied/path_occupied/branch_mismatch）。
- 连接/创建均不产生 Git 提交、不改主检出分支、不启动模型；失败保留目录与分支并报告实际效果。
- 元数据不可用（锁/库故障）时如实报错，不写半份绑定。

测试（隔离夹具，合成任务目录符合 frontmatter 与记录区标记）：a) create 默认命名/分支/基线与 binding.worktree 落库；b) 命名占用加序号；c) 显式 path/branch；d) connect 已有 worktree 成功、错误仓库/非 worktree 目录/分支不符拒绝；e) 幂等重试不重建；f) 分支被其它 worktree 占用报错；g) gitignore 规则保证（已有关不动、缺失追加、现有规则保留）；h) global 布局路径与 project-key；i) 创建后主检出分支与任务 binding 主字段不变。全量 npm test 绿。

模型说明：deepseek 429 限流至 2026-11-04 15:49，本任务派发显式 --provider magpie --model auto/glm-5.3-flash。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施（run-0032f043cd66，已接收 implementation_accepted；模型 magpie/auto/glm-5.3-flash，deepseek 429 限流期间显式指定）：新增 src/application/worktree-manager.ts（478 行：默认命名 .knit/worktrees/<MM-DD>-<slug>、slug 去日期前缀+短序号占用处理、project-key 推导、gitignore 规则保证——已有关不动/缺失追加/缺文件创建；create 从主检出 HEAD `git worktree add -b` 并记 baseline；connect 核对 porcelain 登记/仓库归属/本地分支；幂等重试与断点恢复——已登记核实一致不重建、路径存在未登记按 connect 语义核实；占用/冲突报错保留现场）+ src/cli/worktree.ts（create/connect 命令）+ TaskBindingSchema.worktree opt 字段（layout/path/relativePath/branch/baseline/createdAt/registeredAt，SQLite record JSON 自动兼容无表迁移）+ CLI 注册与 output 错误映射。验证（self）：npm test 334/334 绿，新增 11 组 worktree 用例覆盖冻结方案 a–i 全部场景（默认命名/序号/显式值/connect 三类拒绝/幂等/断点恢复/分支占用/global 布局/主字段不变/归档拒绝/工具函数）。主检出 binding 主字段与分支本任务未改，切换执行位置留给任务 11 交接语义。

### 交付记录

<!-- knit:delivery:op-288916c025e2 -->
- 操作: op-288916c025e2
- 时间: 2026-11-03T21:04:10.342Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: f4ae8315adb3f564706c6ceb1376d91129053f91
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-create-connect-binding

### 任务资料提交记录

<!-- knit:metadata-commit:op-288916c025e2 -->
- 任务资料提交: 5712540eb82257cd2de24ae3b0b8ef1c456677a7
- 归档目标: .knit/tasks/archive/2026-11/11-03-worktree-create-connect-binding

<!-- knit:progress:end -->
