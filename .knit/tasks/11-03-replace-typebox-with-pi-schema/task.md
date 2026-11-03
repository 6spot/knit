---
id: k-34ae6cc85859
status: open
phase: discuss
outcome: null
branch: refs/heads/main
verification: self
createdAt: 2026-11-03T14:14:51.578Z
title: 将 typebox 替换为 pi-schema
---

# 将 typebox 替换为 pi-schema

## 目标与边界

将本仓库的 `typebox` 依赖替换为用户指定的 `pi-schema`，迁移相关导入、schema 定义、类型推导、运行时校验及构建生成链路中的使用点，保持既有业务规则和对外协议行为。

本轮授权仅创建任务、记录需求；保持讨论阶段，不启动实施，不安装或替换依赖。后续开始实施时核实 `pi-schema` 的准确发布包名、版本与公开 API；如有无法等价迁移的能力差异，先在本任务记录证据与待决定事项。

## 完成条件

- `package.json`、`package-lock.json` 及实际使用点完成迁移，移除本仓库对 `typebox` 的直接依赖和代码引用；历史研究、执行日志与固定来源引用按原值保留。
- schema 定义、类型推导、运行时校验和桥接 schema 生成正常工作，对外 CLI／桥接协议及校验行为保持兼容；必要变化有明确依据并获确认。
- 后续实施时执行 `npm test` 与 `npm run pack:check`，检查相关 schema／校验行为并如实记录结果。本轮创建任务不执行这些验证。
- 更新受影响的现行技术文档；业务完成不自动提交、推送或归档。

## 输入引用

- 用户需求：将 `typebox` 换成 `pi-schema`；现在只创建任务，不执行。
- `package.json`、`package-lock.json`。
- `src/` 中现有 `typebox` 使用点，以及相关测试、桥接 schema 生成脚本和模板。
- `docs/design/TECHNOLOGY.md`、`docs/design/ARCHITECTURE.md`、`docs/design/OPERATIONS.md`。
- 验证方式：`self`；实施范围确定后按实际风险补足具体回归场景。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
