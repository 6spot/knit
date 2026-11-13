# OpenSpec 格式事实（借鉴依据）

来源：`Fission-AI/OpenSpec` 主分支 `docs/concepts.md`，commit `a959be77cf045ea3156dc5089c9e2f1d6ce9ce70`，npm `@fission-ai/openspec` 1.17.0。2026-11-11 由主会话经 curl 读取。阶段 worker 默认离线，以本文件为准，不再联网核对。

固定来源：<https://github.com/Fission-AI/OpenSpec/blob/a959be77cf045ea3156dc5089c9e2f1d6ce9ce70/docs/concepts.md>

## 1. 规格的结构

规格文件是 `openspec/specs/<domain>/spec.md`，层级固定：

```markdown
# Auth Specification

## Purpose
Authentication and session management for the application.

## Requirements

### Requirement: User Authentication
The system SHALL issue a JWT token upon successful login.

#### Scenario: Valid credentials
- GIVEN a user with valid credentials
- WHEN the user submits login form
- THEN a JWT token is returned
- AND the user is redirected to dashboard

#### Scenario: Invalid credentials
- GIVEN invalid credentials
- WHEN the user submits login form
- THEN an error message is displayed
- AND no token is issued
```

| 元素 | 用途 |
| --- | --- |
| `## Purpose` | 该规格所属领域的概述 |
| `### Requirement:` | 系统必须具备的一项行为 |
| `#### Scenario:` | 该需求的一个具体例子，可被测试或明确验证 |
| SHALL／MUST／SHOULD／MAY | RFC 2119 强度词：MUST／SHALL 为必须，SHOULD 为推荐，MAY 为可选 |

好的场景可测试，覆盖正常路径与边界情况，使用 Given／When／Then 或类似结构。

## 2. 规格写什么、不写什么

规格是行为契约，不是实施计划。

- 写：用户或下游系统依赖的可观察行为；输入、输出与错误条件；外部约束（安全、隐私、可靠性、兼容性）；可测试或可明确验证的场景。
- 不写：内部类名与函数名、库与框架选择、逐步实施细节、执行计划（后两者归 `design.md`、`tasks.md`）。
- 判别：实现可以改变而外部可见行为不变的内容，通常不属于规格。

## 3. 渐进严格度

- Lite（默认）：简短的行为优先需求、清楚的范围与非目标、少量具体验收检查。
- Full（高风险）：跨团队或跨仓库变更；API／契约变更、迁移、安全与隐私；歧义可能造成昂贵返工的变更。
- 原文结论：多数变更应停留在 Lite。

## 4. 增量规格（本任务不实现，供第二期参考）

变更目录 `openspec/changes/<name>/specs/<domain>/spec.md` 只写变化：

| 区段 | 含义 | 归档时 |
| --- | --- | --- |
| `## ADDED Requirements` | 新增行为 | 追加到主规格 |
| `## MODIFIED Requirements` | 行为变化 | 替换同名需求 |
| `## REMOVED Requirements` | 废弃行为 | 从主规格删除 |
| `## Purpose` | 全新能力的用途 | 新建主规格时作为 Purpose，规格已存在则忽略 |

用增量而非全文的理由：变化清楚、两个变更改同一规格的不同需求不冲突、审阅只看变化、适合存量代码。

## 5. 与 Knit 的对应

| OpenSpec | Knit | 本任务 |
| --- | --- | --- |
| `proposal.md` | `task.md`「目标与边界」 | 不动 |
| `design.md`、`tasks.md` | 任务目录 `design.md`、`plan.md` | 不动 |
| `### Requirement:`／`#### Scenario:` | `task.md`「完成条件」（现为自由列表） | 引入写法 |
| 增量规格与 `openspec/specs/` | 无 | 不做，第二期 |
| `/opsx:*` 命令、schema、profile | workflow 与阶段 | 不引入 |

层级正好对齐：OpenSpec 的 `## Requirements` 对应 Knit 的 `## 完成条件`，其下 `###`、`####` 两级可原样使用，第二期搬运时不用改标题层级。

## 6. Knit 现状（改动前的代码事实）

- 任务模板：`src/application/task-service.ts:86` `renderInitialTaskBody`，「完成条件」占位为 `<!-- 可验证结果与必需验收 -->`。
- 「待澄清」解析：`src/contracts/task-inputs.ts` `clarifyStateOf`，区段到下一个一级或二级标题为止；「完成条件」里的三、四级标题不会截断它。
- 检查提示词：`assets/templates/.knit/agents/check.md` 第 1 条为“对照 task.md 的完成条件逐条核对”。本仓库 `.knit/agents/check.md`、`implement.md` 与模板逐字相同。
- `coverage`：`workflow.yaml` 声明为 `string[]`。`src/domain/report.ts:101` `uncoveredScopePaths` 只要求每个 scope 路径被某一项以路径前缀命中，多出来的项不影响判定。
- 核心检查阶段指令：`src/application/stage.ts:193` 说明 coverage 每项一个路径。
- 保护路径：`src/application/stage-runner.ts:1356` 起，阶段内改动 `.knit/` 下非任务资料即 `protected_path_modified`。worker 能改 `assets/templates/.knit/agents/*.md`，不能改本仓库的 `.knit/agents/*.md`。
- 已有项目的提示词同步：`docs/design/ROLE-CONTRACT.md` 第 5 节规定由主会话按模板差异显式同步并单独提交。
