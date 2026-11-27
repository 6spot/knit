---
id: k-3ad44485c09e
title: 加固受保护路径大小写校验、路径安全与子模块快照
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn: []
priority: P0
createdAt: 2026-11-27T13:37:25.601Z
---

## 目标与范围

封堵路径安全、受保护路径守卫与工作区子模块快照中的四处安全与完整性漏洞，确保执行者无法在大小写不敏感文件系统、悬空符号链接、非法角色路径或子模块变更上绕过 Knit 的隔离与检测。

### 具体改动与思路

1. **路径原语加固（`src/infrastructure/paths.ts`）**：
   - `safeJoin` 在目标路径不存在（`existsSync(target)` 为假）时，使用 `lstatSync(target, { throwIfNoEntry: false })` 检测是否存在悬空符号链接；若为符号链接，沿链接目标核验或直接抛出 `path_escape`，防止经项目内悬空符号链接向项目根外写文件。
   - `projectRelative` 显式拒绝空字符串 `""` 与含 `\0` 的输入（返回 `null`），避免 `posix.normalize("")` 静默返回 `"."` 扩大改动范围。
   - 下沉“不存在尾段 + 符号链接”的公共安全解析能力（供上层与适配器复用），同时清理未使用的 `basename` 导入。
2. **受保护路径大小写防护与子模块快照（`src/application/workspace.ts`）**：
   - `protectedChanges` 与快照判断受保护路径的 `raw()` 统一按 `toLowerCase()` 做前缀与精确匹配，封堵 macOS APFS 等大小写不敏感文件系统下执行者新建 `.knit/Config.json`、`.knit/Standards/inject.md` 等变体绕过拦截并在合并后被主检出加载的风险。
   - `takeSnapshot` 对 Git 子模块条目（`mode === "160000"`）记录真实子模块 `HEAD` 提交与工作区脏状态（不再退化为 `"directory - -"`），使 `changesBetween` 能准确检出执行者切换或修改子模块的行为。
3. **角色文件与相关资料路径安全（`src/domain/workflow.ts`、`src/application/handoff.ts`）**：
   - `workflow.ts` 语义校验核对所有环节及并行执行器的 `prompt` 必须满足 `projectRelative(prompt) !== null`，拒绝 `../` 越界路径与绝对路径并指出准确行号。
   - `handoff.ts` 的 `readText` 与 `readMaterial` 统一改用 `safeJoin` 并核验 `statSync(...).isFile()`（目录分支保持现有目录提示语义，角色文件与 `plan.md` 指向目录时返回友好失败而非抛 `EISDIR`），封堵 `prompt` 路径穿越与仓库内符号链接读取项目外敏感文件。

### 边界与约束

- 不改变 `.knit/workflow.yaml` 合法相对角色路径的既有校验行为，不修改 `handoff.ts` 的字节预算策略（预算调整归后续子任务 `k-3b3852762282`）与 `matchingFingerprints` 哈希优化（归 `k-f331f86e46a8`）。
- 遵循 `.knit/standards/development.md` 的文件粒度与测试分层规范，测试追加到既有测试文件（`test/infrastructure.test.mjs`、`test/workspace.test.mjs`、`test/workflow.test.mjs`、`test/handoff.test.mjs`），不新建按任务命名的碎片测试文件。
- 因涉及高风险受保护路径与快照对比逻辑，验证时除 `npm run typecheck`、`npm run build` 和定向单测外，须补跑一次全量 `npm test`。

## 完成条件

### Requirement: 路径与符号链接安全边界
#### Scenario: safeJoin 拦截指向项目外的悬空符号链接
- WHEN 项目根内存在指向项目根外尚不存在目标的悬空符号链接，并调用 `safeJoin` 解析该链接路径
- THEN `safeJoin` 抛出 `path_escape` 错误而不是返回该链接路径

#### Scenario: projectRelative 拒绝空串与 NUL 字符
- WHEN 向 `projectRelative` 传入 `""` 或包含 `\0` 的路径
- THEN 返回 `null`

### Requirement: 受保护路径大小写无关拦截与子模块快照检测
#### Scenario: 大小写变体无法绕过受保护路径守卫
- WHEN 执行者在工作区新增或修改 `.knit/Config.json`、`.knit/Workflow.yaml`、`.knit/Standards/extra.md` 或角色文件的大小写变体
- THEN `protectedChanges` 将其识别为受保护路径变更并拦截，且快照对其始终保留内容指纹

#### Scenario: 工作区快照能检出 Git 子模块变更
- WHEN 仓库包含 Git 子模块，且在两次快照之间切换了子模块提交或修改了子模块状态
- THEN `changesBetween` 报告该子模块路径已变更

### Requirement: 工作流角色文件与交接资料防路径穿越与防符号链接逃逸
#### Scenario: workflow 校验拒绝越界或绝对 prompt 路径
- WHEN `.knit/workflow.yaml` 的环节或执行器声明 `prompt: ../outside.md` 或绝对路径
- THEN `parseWorkflow` 报错并指出对应行号

#### Scenario: handoff 读取角色与点名资料拦截逃逸符号链接与目录误读
- WHEN 角色文件指向目录、或「相关资料」点名的仓库文件是指向项目根外的符号链接
- THEN 交接拼装拒绝并给出明确原因，不读取项目根外内容也不抛出未捕获 `EISDIR`

### Requirement: 构建与全量回归通过
#### Scenario: 类型检查、构建与全量测试通过
- WHEN 运行 `npm run typecheck`、`npm run build` 及全量 `npm test`
- THEN 全部通过且无新增失败

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 5 节交接与第 7 节受保护路径规则
- `AGENTS.md` — 架构入口、高风险独立审查与验证范围要求
- `.knit/standards/development.md` — 编码风格、文件粒度与测试分层规范
- `src/infrastructure/paths.ts` — 路径规范化与 `safeJoin` 实现
- `src/application/workspace.ts` — 快照与受保护路径检查
- `src/domain/workflow.ts` — 工作流语义校验
- `src/application/handoff.ts` — 角色与点名资料读取

## 结果

7 个验收场景已满足，独立复审通过。首轮审查指出异常子模块可能漏记改动或中断结算、悬空链接的尾分隔符校验不一致、同一计划目录重复报错。返工后，这三项都有回归覆盖；异常子模块发生文件变更时会更新指纹，恢复内容后交付指纹重新匹配。独立复审的 4 个定向测试文件 107/107 通过，复审期间无代码改动。最终实现在第二个可写卷上通过全量 npm test，599/599 通过，0 失败、0 跳过；类型检查、构建和 git diff --check 通过。
