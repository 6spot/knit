---
id: k-3b3852762282
title: 升级交接预算优先级与 8KB 阈值、优化读盘并统一围栏解析
status: delivered
stage: null
verification: independent
parent: k-8d244665f694
dependsOn:
  - k-3ad44485c09e
  - k-3e85bbaa5d20
  - k-d35eccd06f9d
priority: P1
createdAt: 2026-11-27T13:37:26.500Z
---

## 目标与范围

落实用户已确认的交接预算优先级重排与 8KB 短文档内联升级，优化交接按需读盘与并行资料复用，同时统一抽取符合 CommonMark §4.5 的 Markdown 围栏与 frontmatter 工具，彻底修复行内反引号围栏吞标题/绕过 `[blocking]` 的解析漏洞及规范/避坑边界瑕疵。

### 具体改动与思路

1. **交接预算升级与 I/O 优化（`src/application/handoff.ts`、`src/application/run-prepare.ts`、`docs/design/DESIGN.md`）**：
   - **已定下的预算优先级与阈值调整**：保持第一条消息的展示顺序不变，将 `totalBytes`（默认 64KB）的预算分配顺序反转为：**`previous-report` > `<worktree-changes>` 补丁 > `own-last-report` > `plan.md` > `materials`**，确保返工和审查最核心的反馈绝不被普通参考文档挤掉。
   - **短文档内联阈值放宽至 8KB**：有 `read` 权限时，普通 `.md` 文件和 `#标题` 章节的内联上限由 `min(4096, handoff.fileBytes)` 放宽为 **`min(8192, handoff.fileBytes)`**，改善中文 UTF-8 文档过早整块被裁的问题。
   - **无 `read` 权限提示与未跟踪清单上限**：当环节 `tools` 不含 `read` 时，超限块给出准确提示（说明无 `read` 权限无法自行读取，建议调整 `handoff` 预算或精简资料）而非误导执行者“按路径自己读”；`<worktree-changes>` 的未跟踪文件列表设条数上限（如 200 条 + `等共 N 个文件` 提示），避免漏配 `.gitignore` 时撑爆交接消息。
   - **按需读盘与并行复用**：`readMaterial` 接收 `canRead` 与单文件字节上限——对有 `read` 权限的非 `.md` 文件（`pathOnly`）及无 `#anchor` 且 `stats.size > fileBytes` 的超大文件，仅 `statSync` 验证存在性而不执行无用的整文件 `readFileSync`；`run-prepare.ts` 派发多执行器并行批次时跨成员复用已加载的 `standards` 与仓库 `materials`；`render()` 对 XML 属性值转义 `"`、`&` 与换行防止破坏标签边界。
   - 同步更新 `docs/design/DESIGN.md` 第 5 节交接预算优先级、8KB 阈值与未跟踪文件上限说明。
2. **统一 CommonMark §4.5 代码围栏与 Markdown 解析工具（`src/domain/`）**：
   - 在 `src/domain/` 收口一份公共 Markdown 解析工具（遵循 `.knit/standards/development.md` 文件粒度规范：复用方覆盖 `task.ts`、`task-requirements.ts`、`standards.ts`、`pitfalls.ts`、`handoff.ts` 共 5 处），统一实现：
     - 符合 CommonMark §4.5 的代码围栏跳过：反引号开围栏的 info string 中包含反引号时**不视为开围栏**（彻底修复行首出现内联三反引号片段时吞掉后续 `## 完成条件`、`## 待澄清` `[blocking]` 与 `## 结果` 的漏洞）；
     - 公共 frontmatter 切分与 `trimBlankLines`（消除 4 处重复与细微漂移）。
   - `domain/task.ts`：`referencesOf` 改用公共围栏跳过，避免 `## 相关资料` 中的示例代码围栏被误当文件路径；同时支持常见说明分隔符（` — `、` - `、`：`），仅提取每行首个反引号路径。
   - `domain/task-requirements.ts`：`scenarioStateOf` 的 `requirement`/`scenario` 标题匹配加上词边界或冒号边界（如 `/^requirement(?:\s*[:：]|\s*$)/i`），避免普通标题 `### Requirements 背景` 被误判为 `heading_malformed`。
   - `domain/standards.ts`：`yaml.toJS({ maxAliasCount: 100 })` 包裹 `try/catch`；对 `title`/`stages` 以外的未知 frontmatter 键记入 `problems`（防用户将 `stages` 误拼为 `stage` 后规范静默永不注入）；`title` 做 `.trim()`；损坏 frontmatter 规范被点名时不再连带原始坏 YAML 注入提示词。
   - `domain/pitfalls.ts` & `src/application/project-config.ts`：`pitfallScope` 拒绝将 `"通用"` 与环节 id 混写在同一分区标题（如 `## 通用, implement`），并拒绝空 `--section`；`recordPitfall` 防护缺失闭合 `---`；`savePitfall` 写入前先 `mkdirSync(dirname(path), { recursive: true })`，避免新建 `.knit/standards/` 落成 `0o700` 权限。

### 边界与约束

- 不修改 `src/domain/report.ts` 的报告尾块提取逻辑（已在 `k-fc88509c221b` 独立加固）。
- 测试追加到 `test/handoff.test.mjs`、`test/handoff-worktree.test.mjs`、`test/task-domain.test.mjs`、`test/standards.test.mjs`，并运行 `npm run typecheck`、`npm run build` 及受影响测试文件（因涉及 `task-domain` 与 `handoff` 核心路径，建议补跑一次全量 `npm test`）。

## 完成条件

### Requirement: 交接预算优先级重排、8KB 内联阈值与按需读盘
#### Scenario: 预算吃紧时优先保留上轮报告与代码 diff
- WHEN 总交接字节接近 64KB 上限，同时存在较大的 `materials`/`plan.md` 与 `previous-report`/`<worktree-changes>` 补丁
- THEN 预算优先分配给 `previous-report` 和 `<worktree-changes>` 补丁，优先裁切 `materials` 而非丢弃上轮报告与 diff

#### Scenario: 8KB 中文短文档完整内联、无 read 提示准确且未跟踪清单有上限
- WHEN 有 `read` 权限时点名 6KB 的 `.md` 文件、无 `read` 权限时点名超限文件、或 Worktree 存在超过 200 个未跟踪文件
- THEN 6KB `.md` 被完整内联；无 `read` 超限块不再提示“按路径自己读”；未跟踪列表按上限截断并注明总数

#### Scenario: pathOnly 与超限大文件免读盘且 XML 属性转义安全
- WHEN 有 `read` 权限时点名非 `.md` 文件或超限文件，或规范标题含双引号
- THEN `pathOnly` 文件不整文件读入内容即生成路径提示；渲染输出的 XML 标签属性安全转义不破坏结构

### Requirement: CommonMark 围栏解析与规范/避坑边界修复
#### Scenario: 行首内联反引号代码片段不吞噬后续章节与 blocking 项
- WHEN `task.md` 正文某行以三反引号内联代码片段开头，其后存在 `## 待澄清` 的 `- [blocking]` 与 `## 结果`
- THEN `clarifyStateOf`、`headingsOf`、`extractRequirement` 均正确识别后续所有标题与 `[blocking]`，不被误判为未闭合围栏

#### Scenario: 相关资料跳过围栏、英文复数标题不误伤、未知规范字段报错与 savePitfall 目录权限正确
- WHEN `## 相关资料` 含代码围栏、`## 完成条件` 含 `### Requirements 说明`、项目规范误写 `stage: [implement]`、或新目录首次调用 `savePitfall`
- THEN 围栏内示例不作为文件引用；`### Requirements 说明` 不报格式错；未知 `stage` 字段被记入规范 `problems`；新建的 `.knit/standards/` 具备普通入库目录权限（非 `0o700`）

### Requirement: 构建与回归验证通过
#### Scenario: 类型检查、构建与测试通过且文档同步
- WHEN 运行 `npm run typecheck`、`npm run build` 及全量 `npm test`
- THEN 全部通过且 `docs/design/DESIGN.md` 第 5 节已同步

## 待澄清

## 相关资料

- `docs/design/DESIGN.md` — 第 4、5 节规范、避坑清单与交接预算设计
- `.knit/standards/development.md` — 文件粒度、编码风格与测试分层规范
- `src/application/handoff.ts` — 交接拼装与点名资料读取
- `src/application/run-prepare.ts` — 并行交接组装调用点
- `src/application/project-config.ts` — `savePitfall` 实现
- `src/domain/task.ts` — 任务标题、相关资料与文档解析
- `src/domain/task-requirements.ts` — 场景与待澄清解析
- `src/domain/standards.ts` — 项目规范解析
- `src/domain/pitfalls.ts` — 避坑分区与记录解析

## 结果

六个验收场景通过。上一批报告与工作树补丁优先获得预算，两位并行审查者复用已加载的资料并独立核算额度。整篇文档与点名章节在 8192 字节时均可内联，8193 字节时按权限给出提示。任务、规范、避坑和交接共用 Markdown 围栏规则，现存双 --- 头部兼容。独立审查 r-e7b32a2c017e 通过。定向 120/120，最终宿主类型检查、构建、打包、git diff --check 与跨卷全量 665/665 通过，0 失败、0 跳过。
