# 001 建立工程工具链与包边界

- 里程碑：M0
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：无；从本项开始
- 实际依赖：无；可直接开始。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

将目录骨架变为可在 Node24 下构建、测试和打包的最小 npm 工程，尚未实现业务命令。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第1–3、6节：版本、CLI/schema及构建边界。
- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：第2、9节：依赖方向与源码组织。

## 实施范围

- 创建 package.json、精确锁文件、tsconfig 与最小编译／资源复制方案；按既定版本使用 TypeScript、Commander、TypeBox、YAML。
- 提供真实的 typecheck/build/test/pack 检查；CLI 仅可实现 help/version，未实现业务不得回假成功。
- 明确包文件白名单、ESM/NodeNext、bin/worker定位和模板复制；研究、开发任务及私有历史不得进发布包。
- 优先核实本机已有 Node24；若环境缺失，使用隔离环境或如实记录阻塞，不以 Node25 结果冒充验收。

## 交付物

- 可构建的最小工程与锁文件
- 工具链／Node24与包内容的实际验证记录

## 完成前必须验证

- 在 Node24 记录版本，执行 typecheck、build 和实际存在的测试；没有测试时不制造伪测试套件。
- 检查 npm pack 的实际文件列表及编译入口；不得包含 validation 私有文件或本机路径。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不导入 Pi SDK/RpcClient，不安装用户项目依赖，不实现任务／运行状态机。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-01。
- 实际修改：新增 package.json（knit 0.1.0，ESM，bin=dist/cli/knit.js，files 白名单 assets/+dist/，脚本 typecheck/build/test/pack:check）、package-lock.json（lockfileVersion 3，锁 TS 6.0.3、Commander 15.0.0、TypeBox 1.3.27、YAML 2.9.0、@types/node 24、tsgo 换官方 tsc）、tsconfig.json（strict，NodeNext，verbatimModuleSyntax，types:["node"]）、tsconfig.build.json（outDir dist，declaration）、src/cli/knit.ts（仅 help/version，未知命令非零退出）、scripts/pack-check.mjs（npm pack --dry-run 白名单与禁止项检查）、test/cli.test.mjs（5 个真实进程测试）；更新 README.md 与 TECHNOLOGY.md 中已过时的环境描述。
- 实际验证命令与结果：`node --version` → v24.21.0（/usr/bin/node）；`npm run typecheck` 通过；`npm run build` 通过；`npm test` → 5/5 pass 0 fail（--version 输出 0.1.0、--help/无参数输出 Usage、未知命令与未知选项均非零退出）；`npm run pack:check` → 9 项 PASS，包内仅 README.md、package.json、assets/pi/README.md、dist/cli/knit.js，无 src/test/tasks/validation/设计文档/本机路径（.d.ts 声明允许，.ts 源码禁止），编译入口实际运行且 --version 输出 0.1.0。
- 证据位置：本记录与 package-lock.json、scripts/pack-check.mjs、test/cli.test.mjs；pack 实际文件列表由 pack-check 输出（共 4 文件）。
- 未解决问题／决定：无阻塞。Commander 对未知命令/选项输出英文 error: 消息并以非零退出码结束，满足不回假成功要求；本地化消息后续需要时再议。`node --test <目录>` 在本机 Node24.21.0 下不执行测试（pass 0 fail 1），测试脚本改用 glob `test/*.test.mjs`，已记录事实。
- 对下一项的交接：002 可直接开始；package.json/tsconfig/目录约定与测试运行方式已就绪，schema 依赖 typebox 已安装。

优先扫描下一编号（阻塞时可继续跳过）：[002 建立最小协议、schema与内部端口](002-contracts-and-ports.md)。
