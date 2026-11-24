---
id: k-82ba6435637f
title: 梳理本仓库根目录 AGENTS.md 的协作指引
status: delivered
stage: null
verification: self
parent: null
dependsOn:
  - k-8a5dff9d7ff2
priority: P2
createdAt: 2026-11-23T12:12:35.538Z
---

## 目标与范围

为接手 Knit 源码的协作者重写根目录 `AGENTS.md`。按以下四节组织，让读者能从实际开发问题找到源码、模板和验证依据。

1. 新增功能的取舍。保留现有产品约定和提问方式。
2. 架构与源码入口。用一次任务派发说明任务资料、下一步判断、执行和结果记录怎样衔接，交代 `src/` 六个目录的职责，并指出主会话宿主接入和工作流执行者各自的入口。详细协议由现行设计和接入说明承接。
3. 本仓库开发与验证约定。说明全局安装版的来源、模板与生成副本、强制刷新前的备份、处理 Knit 自身故障的方式，以及 macOS 在 Rex 和普通终端各跑一次 `npm test` 的要求。保留任务推进和控制复杂度的项目约定，通用操作流程沿用宿主规范。
4. 文档入口与写法。指向现行设计、Agent 接入规范和文档索引。简述设计正文的写法，平台验收与有日期的实验结果从对应记录查证。

本任务的产品改动仅为根目录 `AGENTS.md`。历史文档清理由 `k-636bdd45fc92` 单独处理。主会话直接改写、自检，在结果中记录主要删改的依据并逐个核对链接。

## 完成条件

### Requirement: 根文件提供维护 Knit 所需的项目知识

#### Scenario: 第一次接手 Knit 源码

- WHEN 协作者想弄清任务的下一步由哪里判断，或从哪里改客户端接入
- THEN 从根文件能找到相关部件和源码入口，其职责与当前实现一致

#### Scenario: 在本仓库修改和验证 Knit

- WHEN 协作者准备修改宿主桥接模板并在本仓库验证
- THEN 能判断应修改的源文件、当前会话使用的 Knit 版本来源，并找到适用的本地验证要求

#### Scenario: 复核原有内容的取舍

- WHEN 对照旧根文件、整理后的正文以及引用的资料
- THEN 能说明实质删改的理由，保留的链接均可定位，有效的项目约定仍有明确出处

## 待澄清

无。

## 相关资料

- `AGENTS.md` — 现有正文和本仓库特有的约定
- `src/cli/`、`src/application/`、`src/domain/`、`src/adapters/` — 核对命令、用例、任务进度判断和客户端接入的实际分工
- `docs/design/DESIGN.md`、`docs/README.md` — 现行设计、用 Knit 开发 Knit 的约定和文档索引
- `assets/standards/discussion.md`、`.knit/standards/development.md`、`validation/` — 核对通用协作流程、本仓库开发规则与有日期的验证记录
- `.knit/tasks/archive/2026-11/11-23-ask-before-task-implementation/task.md`、`.knit/tasks/archive/2026-11/11-18-h4-clean-agents-md/task.md` — 建任务行为的既有决定和上次整理根文件的取舍

## 结果

根 AGENTS.md 按四节重写。首节保留原文，架构以实际派发说明六个源码目录、nextStep 的输入、执行结果入账及宿主模板和执行者接口。保留安装版、模板刷新与备份、Knit 自身故障处理、风险取舍与 macOS 双终端测试等项目约定；旧档案清单及 Linux 等时点性结论改由现行文档索引和验证记录承接。对照当前派发准备、领域判断、执行结算和注册源码复核职责。四节标题、首节原文、六个目录和全部 14 个 Markdown 链接（含章节锚点）通过核对，主检出及历史清理后的布局均可定位，git diff --check 通过。此项只改根指引，采用文档及源码入口核验。
