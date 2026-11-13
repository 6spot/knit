---
id: k-7e4dbba9dca7
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: self
parent: null
priority: P1
dependsOn:
  - k-da46a698c3ab
  - k-50d398bff55f
  - k-731a13eab2f1
  - k-4255496e31a0
order: null
createdAt: 2026-11-11T14:10:07.507Z
title: macOS 验收缺陷收口（主任务）
---

## 目标
收口 macOS 真机验收（k-7bdf43be461e，证据 `validation/macos-acceptance-2026-11/`）发现的四条缺陷：按子任务逐项修复、复验，并更新平台声明与 B001，最终给出 macOS 支持结论。

## 范围
- 子任务：F1 浮层终态不关闭／worker 进程残留、F4 续接会话每轮上下文缺失、F2 受管入口命令与安装方式不一致、F3 材料中的 `--client` 旧用法
- 收口：README 与 docs 平台声明、TECHNOLOGY §6、BLOCKERS B001、validation 记录

## 完成条件
### Requirement: 缺陷子任务完成
#### Scenario: 四项缺陷修复并复验
- GIVEN 四条子任务均已关闭且留有复验证据
- WHEN 复核 `validation/macos-acceptance-2026-11/` 与真机三轮复跑
- THEN F1 在真机复验中浮层终态自动关闭且无残留 worker 进程
- AND F4 续接会话连续多轮都能拿到当轮上下文
- AND F2 全局安装的新项目能执行受管入口命令写回进度
- AND F3 仓库现行材料不再出现失效的 `--client` 用法

### Requirement: 平台声明与 B001 收口
#### Scenario: 文档结论与证据一致
- GIVEN 子任务全部完成
- WHEN 复核 README、docs/README、TECHNOLOGY §6 与 BLOCKERS B001
- THEN 声明 macOS 已验证范围（安装、init、start、真实宿主、阶段链路、中断恢复、真实模型对话）
- AND B001 更新为已实测，并注明剩余边界（Node 24 组合未跑、发布未做）

## 目标与边界
- 不重跑 Node 24 组合矩阵（用户决定沿用 Node 26.3.0 记录），组合差异在声明中写清。
- 只修缺陷、补测试与文档，不扩大业务功能范围。
- Git 提交、发布与部署另行授权。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

交付 op-d2b8f5b40d91 写入成果 8209aa1 后 needs_attention/hook_changed_selected。已实际验明 16 个 changedPaths 与原期望一致、所有 blob 匹配受验版本；expectedTree 漏记带尾 slash 目录的 10 个叶文件。无 hooks 改动，源文件全恢复/index 空。详情 research/delivery-directory-scope-blocker.md；不改凭据或检查点、不强制归档、不自动生产修复，资料/归档待正式恢复。

### 交付记录

<!-- knit:delivery:op-d2b8f5b40d91 -->
- 操作: op-d2b8f5b40d91
- 时间: 2026-11-13T21:28:39.555Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: 8209aa13598a3fcb4bf2ba5c2c88cdad711e72d4
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-11-macos-acceptance-fixes

### 任务资料提交记录

<!-- knit:metadata-commit:op-d2b8f5b40d91 -->
- 任务资料提交: c7d70becd9d6e9abd26a99725f27f24dda87c0b8
- 归档目标: .knit/tasks/archive/2026-11/11-11-macos-acceptance-fixes

<!-- knit:progress:end -->
