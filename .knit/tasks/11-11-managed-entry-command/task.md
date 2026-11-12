---
id: k-731a13eab2f1
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: k-7e4dbba9dca7
priority: P2
dependsOn: []
order: null
createdAt: 2026-11-11T14:10:09.013Z
title: 统一受管入口命令与安装方式
---

## 目标
修复 F2：init 生成的受管入口让 Agent 执行 `npx --no-install knit ...`，而 README 的安装方式把 Knit 装在 npm 全局位置；新项目里该命令失败，worker 无法用 `knit task record` 写回进度。

## 现状与证据
- 临时项目 `AGENTS.md` 受管块与桥接提示写 `npx --no-install knit task list` 等命令。
- README 安装脚本安装到 npm 全局；项目内没有 `node_modules/knit` 时 `npx --no-install` 报 `could not determine executable to run`。
- 真机验收中 worker 报告 `knit task record` 未执行，进度由主会话补写。证据 `validation/macos-acceptance-2026-11/README.md` F2。

## 范围
- 统一入口约定：受管块、桥接提示、阶段提示词与文档中的写法保持一致。
- 交付前核对：全局安装 + 新项目 init 后，受管入口命令可直接执行。

## 完成条件
### Requirement: 入口命令在新项目可用
#### Scenario: 全局安装后的新项目
- GIVEN 按 README 把 Knit 安装到全局
- WHEN 在临时项目 init 后按受管入口写任务记录
- THEN 命令成功执行，不依赖项目内 `node_modules`

### Requirement: 模板与文档一致
#### Scenario: 仓库内写法统一
- GIVEN 仓库模板、提示词与文档
- WHEN 搜索 `npx --no-install knit`
- THEN 只在确有项目内依赖的场景使用，其余已统一替换

## 目标与边界
- 已定入口解析方式（Agent 建议，待用户确认）：init 时若 `knit` 在 PATH 可执行且 `knit --version` 与本 CLI 一致，受管块与提示写 `knit`；否则回退为当前 CLI 的绝对路径；不再写 `npx --no-install knit`。
- 不改任务资料写入接口的语义与授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-021c78ed8cb5 -->
- 操作: op-021c78ed8cb5
- 时间: 2026-11-12T17:30:56.906Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 30efe9c0433d4d22a33530af89602bbabe098c24
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-11-managed-entry-command

<!-- knit:progress:end -->
