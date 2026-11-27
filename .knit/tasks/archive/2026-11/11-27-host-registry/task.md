---
id: k-945f16c37cb3
title: 主会话宿主注册表收口
status: delivered
stage: null
verification: independent
parent: null
dependsOn: []
priority: P2
createdAt: 2026-11-27T06:28:48.896Z
---

## 目标与范围

### 目标与背景

当前接入一个新的主会话宿主（如近期接入 Qoder）需要手工在 5 处分散修改胶水清单：`src/application/init.ts`（`HOST_BRIDGES` 与 `--force` 识别）、`src/cli/project.ts`（`knit init --<host>` 选项）、`src/cli/knit.ts`（`knit hook <host>` 路由）、`src/adapters/antigravity/isolation.ts`（`WORKSPACE_CONTROL` 宿主目录写保护）和 `scripts/pack-check.mjs`（打包白名单）。

本任务引入纯数据的主会话宿主契约注册表 `src/contracts/host.ts`（导出 `HOST_SPECS` 及派生类型），让上述 5 处全部自动派生自同一份清单。以后再接入新的主会话宿主时，源码侧只需新增平台适配器、对应模板，并在 `src/contracts/host.ts` 增加一条声明，同时不改变任何对外命令、钩子协议、隔离行为或常规 CLI 冷启动性能。

### 实现思路与边界

1. **新增单源契约 `src/contracts/host.ts`**：
   - 保持 `contracts/` 层纯数据、零运行时副作用、不依赖上层模块，维护单向依赖方向（`contracts/` → `application/` / `adapters/` → `cli/`）。
   - `HOST_SPECS` 登记当前 4 个主会话宿主（`pi`、`agy`、`workbuddy`、`qoder`），每条包含：
     - `id`：宿主标识（如 `"pi"`、`"agy"`、`"workbuddy"`、`"qoder"`）与派生的 `HostId` / `HostOptions` 类型；
     - `optionDescription`：`knit init --<id>` 的 CLI 选项说明；
     - `templates`：相对 `assets/templates/` 的模板路径列表（按顺序决定生成顺序，且目标路径统一为 `.<template>`）；
     - `controlDirs`：需要由 Antigravity 工作树隔离写保护的宿主目录（如 `.pi`、`.workbuddy`、`.qoder`；`.agents` 仍包含在 `CUSTOMIZATION_DIRS` 中，与 `controlDirs` 合并去重）；
     - `sharedSettings`（可选）：像 `workbuddy`、`qoder` 这类与项目共用 `settings.json` 的 `--force` 桥接识别声明（目标设置文件、启动脚本路径、参与识别的事件列表）；
     - `hook`（可选）：由 `knit hook <id> <event>` 动态路由的命令型钩子声明（相对 `adapters/` 的编译模块路径如 `qoder/host-hook.js`、导出函数名、CLI `hidden` 开关、`omitNull` 是否在返回 `null` 时静默不输出）。
2. **5 处消费方改为从 `HOST_SPECS` 自动派生**：
   - `src/application/init.ts`：移除手写 `HOST_BRIDGES` 与硬编码路径判断，改读 `HOST_SPECS` 及其 `sharedSettings`。
   - `src/cli/project.ts`：按 `HOST_SPECS` 循环注册 `knit init --<id>` 选项，移除手写的宿主选项枚举和类型重复。
   - `src/cli/knit.ts`：按 `HOST_SPECS` 中声明了 `hook` 的宿主循环注册 `knit hook <id> <event>`，仍采用运行时 `await import(...)` 懒加载以保护常规 CLI 冷启动；`pi tool-call` 特殊协议分支继续保留。
   - `src/adapters/antigravity/isolation.ts`：`WORKSPACE_CONTROL` 从 `HOST_SPECS` 的 `controlDirs` 自动汇总并去重，确保与原有写保护目录集合完全等价，且未来新增宿主自动生效。
   - `scripts/pack-check.mjs`：从构建产物 `dist/contracts/host.js` 导入 `HOST_SPECS`，自动派生需要校验的 `assets/templates/...` 与 `dist/adapters/...` 路径，替代手写逐个宿主的白名单项。
3. **测试与文档**：
   - 在既有测试文件中补充注册表完整性校验：核对 `HOST_SPECS` 中所有模板文件实际存在、所有 `hook` 声明可动态导入并解析到导出函数、`WORKSPACE_CONTROL` 完整包含所有 `controlDirs`、`knit init --help` 列出全部宿主选项。
   - 同步更新 `docs/AGENT-INTEGRATION.md` 的主会话接入步骤，写明只需新增适配器、模板并在 `src/contracts/host.ts` 登记即可自动接入 5 处链路。

### 范围内外与延后项

- **范围内**：`src/contracts/host.ts`、上述 5 处消费方改造、注册表完整性及既有回归测试、`docs/AGENT-INTEGRATION.md` 更新。
- **范围外**：
  - 不改变 Pi、Antigravity、WorkBuddy、Qoder 任一宿主的对外命令参数、钩子协议、输出格式或沙箱隔离策略；
  - 不合并各宿主模板文件，不改动工作流执行者注册表 `src/adapters/agents.ts`。
- **延后项（不作为本任务完成条件）**：
  - `npm run pack:install` 升级本机全局 `knit` 与真实 `Qoder.app` 窗口端到端验收，留待本重构任务审查并交付后另行授权执行。

## 完成条件

### Requirement: 单源主会话宿主契约注册表
主会话宿主元数据集中在 `src/contracts/host.ts` 的 `HOST_SPECS` 一处声明，且不引入逆向或循环依赖。

#### Scenario: 5 处消费方全部自动派生自 HOST_SPECS
- GIVEN `src/contracts/host.ts` 声明 `pi`、`agy`、`workbuddy`、`qoder` 四个主会话宿主
- WHEN 检查 `src/application/init.ts`、`src/cli/project.ts`、`src/cli/knit.ts`、`src/adapters/antigravity/isolation.ts` 与 `scripts/pack-check.mjs`
- THEN `init.ts` 不再维护独立的 `HOST_BRIDGES` 列表或硬编码 `.workbuddy`/`.qoder` 识别分支，改为消费 `HOST_SPECS`
- AND `cli/project.ts` 按 `HOST_SPECS` 注册 `knit init --<id>` 选项，输出帮助与原行为一致
- AND `cli/knit.ts` 按 `HOST_SPECS` 注册 `agy`、`workbuddy`、`qoder` 钩子命令并保持 `await import(...)` 懒加载，`pi tool-call` 行为不变
- AND `isolation.ts` 的 `WORKSPACE_CONTROL` 自动汇总 `HOST_SPECS` 的 `controlDirs`，最终受保护路径集合与重构前等价
- AND `scripts/pack-check.mjs` 从 `dist/contracts/host.js` 自动派生各宿主的模板和编译钩子产物校验项

### Requirement: 注册表完整性与零回归验证
自动化测试验证注册表声明与实际模板、编译产物和写保护一致，且既有功能无回归。

#### Scenario: 注册表一致性单测覆盖
- GIVEN 编译后的 `dist/contracts/host.js` 与 `dist/adapters/antigravity/isolation.js`
- WHEN 运行宿主钩子、初始化与隔离相关测试
- THEN 测试核对 `HOST_SPECS` 中每条 `templates` 在 `assets/templates/` 中真实存在
- AND 每条 `hook` 声明的编译模块都能动态导入且导出对应函数
- AND `WORKSPACE_CONTROL` 包含 `HOST_SPECS` 声明的全部 `controlDirs`

#### Scenario: 文档更新与全量构建测试通过
- GIVEN 完成上述源码、测试与 `docs/AGENT-INTEGRATION.md` 更新
- WHEN 运行 `npm run typecheck`、`npm run build`、`npm run pack:check`、`git diff --check` 与全量 `npm test`
- THEN 所有检查与测试全部通过，无新增失败或对外行为回归
- AND 改动仅保留在任务工作树/分支中等待独立审查与交付，不执行 `npm run pack:install` 或手工提交主分支

## 待澄清

## 相关资料

- [src/application/init.ts](src/application/init.ts)
- [src/cli/project.ts](src/cli/project.ts)
- [src/cli/knit.ts](src/cli/knit.ts)
- [src/adapters/antigravity/isolation.ts](src/adapters/antigravity/isolation.ts)
- [scripts/pack-check.mjs](scripts/pack-check.mjs)
- [src/adapters/agents.ts](src/adapters/agents.ts)
- [docs/AGENT-INTEGRATION.md](docs/AGENT-INTEGRATION.md)
- [test/init.test.mjs](test/init.test.mjs)
- [test/host-hook.test.mjs](test/host-hook.test.mjs)
- [test/antigravity.test.mjs](test/antigravity.test.mjs)

## 结果

新增单源主会话宿主契约注册表 src/contracts/host.ts（HOST_SPECS），将 init、cli/project、cli/knit、antigravity/isolation 与 pack-check 五处消费方统一改为自动派生并保持懒加载与对外行为零回归，补充注册表完整性测试并更新 docs/AGENT-INTEGRATION.md；独立审查（r-bceb7a9b5b9a）一次通过，typecheck/build/pack:check 与全量 npm test（550/550）全部通过。
