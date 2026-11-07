---
id: k-eb2e23ce4f41
status: open
stage: start
outcome: null
branch: refs/heads/main
verification: self
parent: k-2c0d10318898
priority: P0
dependsOn: []
order: 20
createdAt: 2026-11-07T11:44:05.198Z
title: tools 语义定稿：空数组全部禁用，all 或不写全部放开
---

# tools 语义定稿：空数组全部禁用，all 或不写全部放开

## 目标与边界

### 背景与问题

提交 e3ff45c 把 `tools: []` 改成"全部放开"。语义翻转后，原本写 `[]` 想禁用工具的配置会被静默扩权，且"空数组 = 全部"违反直觉。

用户决定：**空数组 = 全部禁用；`all` 或不写 `tools` = 全部放开；非空列表 = 白名单。**

### 交付范围

1. `src/domain/workflow.ts`：schema 接受标量 `tools: all`；`normalizeStage` 中不写或 `all` → `null`（全部放开），`[]` → 空能力（全部禁用），非空列表 → 白名单。列表里混入 `all`（如 `[all, read]`）报 `invalid_tools` 并带 YAML 行号。
2. `src/application/context-planner.ts` `toolPolicyFor`：空能力生成 allow 为空、deny 覆盖 write／edit／bash，mode=read；`src/adapters/pi/runtime.ts` 启动参数为 `--no-tools`，并保持 offline 与禁用扩展／MCP／技能。
3. `knit workflow set-tools`（CLI 与桥接 `knit_workflow`）：支持设为 `all`、设为空数组（禁用），`--clear` 删除字段（等同全部放开）。
4. 同步文案：`workflow.ts` 内置注释模板、`src/application/templates.ts`、`.knit/agents/runtimes/pi.md`（当前未提交改动写的是"不写或空数组 = 全部放开"，需改正）、`docs/design/ROLE-CONTRACT.md`、DESIGN 第 7 节相关表述。
5. 测试：回滚 e3ff45c 中"空数组等同不限制"的断言，补齐四种写法的解析、启动参数与 set-tools 测试。

### 非目标

- 不新增或改名能力项（read／write／exec／task／external／network）。
- 不改已冻结在途 run 的 `stageDefinition`：旧 run 按冻结定义执行。
- 不改本仓库 `.knit/workflow.yaml` 当前的显式白名单。

## 关键决定

用户 2026-11-07 确认按推荐项执行。

- 只接受标量 `tools: all`（大小写不敏感，`ALL` 等同），不接受单元素列表 `[all]`，以免和白名单形式混淆
- 不做旧配置迁移提示：e3ff45c 仅在本地提交、未发布

## 完成条件

- 解析：不写 → null；`all` → null；`[]` → 空能力；`[read, exec]` → 白名单；`[all, read]` → `invalid_tools`（带行号）。
- 空能力阶段的 Pi 启动参数含 `--no-tools`；`all`／不写时不传 `--tools`／`--no-tools`。
- `workflow set-tools` 三种操作的结果与 `workflow show` 回显一致。
- 文档与模板中不再出现"空数组 = 全部放开"；`npm test` 除已知 macOS 环境失败外通过。

## 输入引用

- 审计：中等问题 2；提交 e3ff45c。
- `src/domain/workflow.ts:110,523`、`src/application/context-planner.ts:91-117`、`src/adapters/pi/runtime.ts:85-151`。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
