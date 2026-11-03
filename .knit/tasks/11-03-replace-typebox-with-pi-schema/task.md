---
id: k-34ae6cc85859
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T14:14:51.578Z
title: 将 typebox 替换为 pi-schema
---

# 将 typebox 替换为 pi-schema

## 目标与边界

将本仓库的 `typebox` 依赖替换为 `@earendil-works/pi-schema@1.5.0`，迁移导入、schema 定义、类型推导、运行时校验与桥接 schema 生成链路，保持既有业务规则和对外 CLI／桥接协议行为。

- 2026-11-03：用户要求“查看今天的任务，实现今天的任务”，撤销原“仅创建任务、不启动实施”的限制；本轮执行实施与自检（verification=self）。
- 包名核实：npm 上不存在 `pi-schema`（404）；`@earendil-works/pi-schema` 为 Pi 仓库 `packages/schema` 的发布名，1.5.0 已发布，包含 `obj/str/lit/union/opt/map` 等构建器、`Static` 类型推导与 `compile()` 校验器。
- 对象开放性保持现状：TypeBox `Type.Object` 未写 `additionalProperties` 时默认开放；pi-schema `obj()` 默认关闭。迁移中未显式关闭的对象改用 `open: true`，显式关闭的对象保持关闭。
- 校验错误结构由 TypeBox 的 `instancePath` 改为 pi-schema 的 `path`＋`keyword` 并适配调用点；错误消息文本随库变化，仅用于诊断，不改变接受／拒绝结果。
- 桥接模板不再依赖构建器：Pi 工具参数直接使用安装包生成的纯 JSON Schema，移除模板中的 typebox 导入。
- 历史研究、`validation/` 证据、`.knit/.runtime` 快照与历史日志中的 typebox 文本按原值保留，不回改。

## 完成条件

- `package.json`、`package-lock.json`、`src/`、`assets/templates/`、测试与构建脚本不再引用 typebox；`@earendil-works/pi-schema@1.5.0` 为唯一替换依赖。
- schema 定义、`Static` 类型推导、运行时校验和桥接 schema 生成正常工作；对外 CLI／桥接协议与校验行为保持兼容。
- 针对性回归覆盖：对象开放／关闭语义、协议版本检查与错误路径、桥接工具 schema 生成；`npm run typecheck`、`npm test`、`npm run pack:check` 通过并记录实际结果。
- 更新 `docs/design/TECHNOLOGY.md` 的现行技术选择；历史研究、执行日志与固定来源引用按原值保留。
- 本轮不提交、不推送、不归档。

## 输入引用

- 用户需求：将 `typebox` 换成 `pi-schema`；2026-11-03 要求直接实现。
- 包核实证据：`npm view @earendil-works/pi-schema version` → `1.5.0`；`npm view pi-schema` → 404 E404。
- 迁移范围：`src/contracts/` 12 个 schema 模块、`src/application/`（config、init-manifest、task-document、informal-check、restore、run-coordinator、stage）、`src/infrastructure/run-store.ts`、`src/worker/knit-worker.ts`、`src/cli/resume.ts`、`assets/templates/pi/extensions/knit.ts`、`scripts/build-bridge-schema.mjs`、`test/contracts.test.mjs`、`test/bridge-query.test.mjs`。
- 设计材料：`docs/design/TECHNOLOGY.md`、`docs/design/ARCHITECTURE.md`、`docs/design/OPERATIONS.md`。
- 验证入口：`npm run typecheck`、`npm test`、`npm run pack:check`；另加对象开放／关闭与错误路径的定向回归。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 当前位置

实施与自检完成；实施 run 已接收，阶段 deliver。任务按 `verification=self` 收束为业务完成，等待后续授权提交／归档。

## 关键经过

- 2026-11-03：核实 npm 上不存在 `pi-schema`，采用 Pi 仓库发布名 `@earendil-works/pi-schema@1.5.0`；记录包名、公开 API 与兼容取舍后，用户要求直接实施。
- 迁移 32 个文件：构建器与 `Static`、`Value.Check`／`Value.Errors` 调用点、桥接模板与生成链路、测试、TECHNOLOGY 现行选型。
- 发现该任务在 `metadata.db` 中没有绑定，`knit run implement` 报“任务缺少绑定”；按 `task new`／`ready` 应有字段重建最小绑定（repoRoot、relativePath、branch、冻结输入摘要 `21721e…`、规范摘要 `d4d82…`），并以 `node:sqlite` 只读核对后写入。
- 主会话先完成迁移草案并验证；为留下正式实施凭据，将工作区回退到干净 HEAD，run 内应用同一补丁并复核（结果 diff 与验证通过的补丁逐字节一致）。
- 接收后执行 `knit init --force` 刷新受管生成桥接 `.pi/extensions/knit.ts`（原文件仍 `import { Type } from "typebox"`，会在依赖移除后加载失败）；该文件属 init 管理产物，未进入 run scope，作为项目维护变更单独保留。

## 结果与验证

- `run-07e1f5b6cfeb`：implement completed，changedPaths 32 项，接收 reason=`implementation_accepted`。
- `npm run typecheck` 通过；`npm test` 275/275 通过（82.6s）；`npm run pack:check` 通过（主会话复跑，日志 `/tmp/knit-npm-test.log`、`/tmp/knit-pack-check.log`）。
- 定向回归：对象开放／关闭语义、协议错误 JSON Pointer 路径、桥接 schema 同源生成、模板无 typebox 断言。
- run 内另做新旧 92 个导出 schema 结构对比（仅 `Record` 表示等等价差异）与 2378 例校验器差分抽样，零分歧。
- 未覆盖：其它用户项目已生成的桥接需各自重新 init；`validation/` 历史夹具、历史文档与 `.knit/.runtime` 快照中的 typebox 原值按边界保留。

## 运行引用

- `run-07e1f5b6cfeb`（implement，completed，已接收）
- 迁移补丁：`/tmp/knit-typebox-migration.patch`（本机临时文件，未入库）

### 交付记录

<!-- knit:delivery:op-5b5f444b10c8 -->
- 操作: op-5b5f444b10c8
- 时间: 2026-11-03T14:41:36.218Z
- 分支: refs/heads/main
- 授权来源: 用户 2026-11-03 回复「可以继续」，授权对 k-34ae6cc85859 执行 deliver（本地提交与归档；不含推送/发布）
- 工作提交: 83b646220fc05bf338bb866ae62e2217893375fd
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-03-replace-typebox-with-pi-schema

<!-- knit:progress:end -->
