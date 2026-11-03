# 实施计划：typebox → @earendil-works/pi-schema

前提事实：`pi-schema` 未在 npm 发布；Pi 仓库 `packages/schema` 的发布名为 `@earendil-works/pi-schema@1.5.0`。当前 TypeBox 使用面 = 构建器（`Type.*`）+ `Static` + `Value.Check`／`Value.Errors`；对象默认开放，48 处对象显式 `additionalProperties: false`。pi-schema `obj()` 默认关闭。

## 执行方式（本轮）

主会话已先行完成迁移草案并验证（typecheck、275 项测试、pack:check 均通过），补丁保存在 `/tmp/knit-typebox-migration.patch`。本轮 implement run 的落地方式：

1. 第一步先在工作区应用该补丁（`git apply /tmp/knit-typebox-migration.patch`），再按下方步骤逐项复核、补缺并运行验证。不要先执行 `npm install`，避免 lockfile 与补丁冲突；补丁已含依赖变更。
2. 补丁不可用或与当前工作区不一致时，按步骤 1–8 重做迁移，不跳过验证。
3. run 阶段不要写 `.knit/` 元数据（stage 保护路径会拒绝）；进度与记录由主会话在接收结果后更新。
4. 最终报告的 `changedPaths` 必须与实际改动完全一致，并按完成条件如实记录验证输出。

## 步骤

- [x] 1. 依赖替换：应用补丁中的 `package.json`／`package-lock.json`（移除 typebox，加入 `@earendil-works/pi-schema@1.5.0`），确认 lockfile 无 typebox。
- [x] 2. 复核 `src/contracts/schema.ts`：`checkSchema()`／`schemaErrors()` 封装 `compile()`，以 WeakMap 缓存已编译校验器，统一 dynamic schema 与模块级 schema。
- [x] 3. 复核 contracts 迁移：`protocol`、`session`、`run`、`metadata`、`standards`、`delivery`、`restore`、`acceptance`、`context-plan`、`task-inputs`、`completion`、`bridge-tools` 改用 pi-schema 构建器与 `Static`；原开放对象补 `open: true`，原 `additionalProperties: false` 由 `obj()` 默认关闭承接。
- [x] 4. 复核应用／基础设施／worker／CLI 迁移：`config`、`init-manifest`、`task-document`、`informal-check`、`restore`、`run-coordinator`、`stage`、`run-store`、`knit-worker`、`resume`；`Value.Check`→`checkSchema`，`Value.Errors`→`schemaErrors`，`instancePath`→`path`。
- [x] 5. 复核桥接链路：模板删除 typebox 导入，工具参数直接使用 `dist/contracts/bridge-tools.json` 的纯 JSON Schema；`scripts/build-bridge-schema.mjs` 注释与生成链路同步。
- [x] 6. 复核测试迁移与定向回归：`test/contracts.test.mjs` 改用编译校验；`test/bridge-query.test.mjs` 去掉 typebox 解析假设；对象开放／关闭、协议错误路径、bridge schema 生成断言。
- [x] 7. 复核文档：`docs/design/TECHNOLOGY.md` 现行技术选择已更新；ARCHITECTURE／OPERATIONS 无过期表述；历史档案与 validation 保留。
- [x] 8. 验证：`npm run typecheck`、`npm test`、`npm run pack:check`；`grep` 核对 `src/`、`assets/`、`scripts/`、`test/` 无 typebox 引用；记录实际输出与未覆盖项。

## 执行结果

- 实施 run：`run-07e1f5b6cfeb`（implement，completed，已接收，reason=`implementation_accepted`），changedPaths 32 项。
- run 内应用同一补丁后复核：新旧 92 个导出 schema 结构对比（仅 `Record` 表示等等价差异）、2378 例新旧校验器差分抽样零分歧。
- 主会话复跑：`npm run typecheck` 通过；`npm test` 275/275 通过（82.6s）；`npm run pack:check` 通过。
- run 结果 diff 与预先验证的补丁 `diff -q` 逐字节一致；未引入计划外文件改动。
- 接收后以 `knit init --force` 刷新受管生成桥接 `.pi/extensions/knit.ts`（原文件仍 import typebox，会使本仓库桥接加载失败）；该文件属 init 管理产物，不在 run scope，作为项目维护变更单独保留。
- 未覆盖：其它用户项目的已生成桥接需各自重新 init；历史 `validation/` 夹具与历史文档中的 typebox 原值按边界保留。

## 风险与处理

- **对象开放性**：TypeBox 默认开放，pi-schema 默认关闭；逐个保留原语义，并用回归锁定 open／closed 两面。
- **联合类型分派**：pi-schema 对带 `lit` 标签的对象联合做标签分派；已验证相同标签的多个分支仍按完整校验接受。
- **错误文本**：`ValidationError.message` 与 TypeBox 不同；只用于诊断输出，结构改为 `path`，不承担协议语义。
- **动态 schema**：`run-store.parseJson` 等按参数传入 schema，用 WeakMap 缓存编译结果避免重复编译。
- **桥接模板**：模板被生成的用户项目不装 pi-schema；去掉构建器导入同时消除该隐性依赖。

## 回退

实施前工作区已回退到干净 HEAD；补丁可由 `/tmp/knit-typebox-migration.patch` 重新应用。任一验证失败按 `git status`／`git diff` 定位并保留任务记录，必要时 `git checkout --` 恢复单文件，不提交历史。
