# 008 实现init与项目受管资料所有权

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[007 实现文件、占用与操作检查点基础](007-local-infrastructure.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[007](007-local-infrastructure.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

在空／既有项目中安全生成最小工作流和薄桥接资源。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第2、7、14节。
- [OPERATIONS.md](../../design/OPERATIONS.md)：第1节。
- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：InitializationService和安装映射。

## 实施范围

- 实现init --client pi、init --check、项目根归一与非Git初始化边界。
- 生成项目配置、workflow、四角色／runtime说明、规范索引与AGENTS受管入口，已有正文只补缺。
- 生成本机安装映射、preparing/ready/failed逐项清单，受管模板按旧基线更新，桥接最后发布。
- 桥接模板位于assets/templates/pi/extensions/knit.ts（原assets/pi布局随008实施统一为assets/templates），业务仍走核心；没有Pi也能准备资料，未信任遵循宿主规则。

## 交付物

- init用例、模板与CLI接线
- 所有权、重复执行与部分失败的验证

## 完成前必须验证

- 既有AGENTS／规范／人工改动不覆盖；--check不写；缺映射／未ready不能声称可调用。
- 在临时项目实测首次init和重试，确认无Git提交、模型调用或项目依赖安装。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不在Knit当前工程执行产品init；不复制本仓库AGENTS作为产品模板。
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
- 开始／结束时间：2026-11-02。
- 实际修改：新增 src/application/{config,init-manifest,templates,initialization}.ts（InitializationService 与配置校验）；新增 src/cli/{init,output}.ts 并接入 src/cli/knit.ts（init --client pi --dir --check --force，--json 协议输出）；新增 assets/templates/（.knit 七份项目资料模板 + pi/extensions/knit.ts 桥接模板），原 assets/pi/README.md 迁至 assets/templates/pi/README.md；新增 test/init.test.mjs；同步 ARCHITECTURE.md 第9节 assets 路径、OPERATIONS.md 第1节实现位置、README.md、src/adapters/pi/README.md、scripts/pack-check.mjs（模板资产白名单）。
- 实际验证命令与结果：`npm test` 87/87（init 11 + infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run pack:check` 通过（含模板资产、拒绝 .ts 源码漏包但放行模板）；临时 Git 项目与非 Git 目录真实 CLI 实测（dist/cli/knit.js，无 Pi、无模型、无 npm install）：
  - 首次 init：ready；12 项创建；清单 schemaVersion 1、逐项 created+baselineSha256；installation.json 含存在的 CLI 入口与包版本；.runtime 0700、清单 0600、项目资料 0644；.knit/.runtime 被 Git 忽略且未跟踪。
  - 人工改动后重跑：项目正文不覆盖、受管桥接 conflict 不覆盖、AGENTS 正文保留；清单 failed 保留逐项 conflict；--force 更新受管但项目正文仍不覆盖。
  - 重复执行幂等：不再创建，除 installation.json 更新外无变更；AGENTS 标记块唯一。
  - --check：不写 .knit/、不建锁目录（CLI 与服务两层验证）。
  - 子目录归一到仓库根；非 Git 目录 ready 且 gitWarning 提示正式执行条件。
  - 缺桥接+failed 清单重试后 bridgeReady 恢复 true；冲突时 bridgeReady=false（缺映射／未 ready 不声称可调用）。
  - CLI --json：protocolVersion 1、outcome completed/data.ready=true；未知客户端 invalid_request。
  - 零 Git 提交（rev-list 计数不变）、零暂存（status 只新增未跟踪文件）、零依赖安装。
- 实施中纠正的事实：createRequire 解析包根在 ESM+私有包下失败（Cannot find module '../package.json'）→ 改 import.meta.url + fileURLToPath 回溯；模板资产路径 .pi/… 与包内存放 pi/… 不一致 → readTemplate 统一映射；mkdir recursive:true 中间目录 mode 不可靠（007 已知问题，此处确认 .runtime 用 mkdirSync 0700 后清单 0600 单独原子写）；commander 15 注册子命令后裸调用以 missing command 退出（status 1）→ 无参数时不经 parseAsync 直接 outputHelp；pack-check 原白名单 assets/pi/README.md 与 .ts 禁令拦截模板 → 改 required 路径并放行 assets/templates/ 下模板 .ts；重复执行对与新模板内容一致的桥接重写（非幂等）→ 内容一致记 kept 不重写；git diff HEAD 不显示未暂存新文件 → 改 git status --porcelain 断言。
- 未解决问题／决定：① 桥接模板 .pi/extensions/knit.ts 是 TypeScript 形态（pi 项目扩展只加载 .ts/.js，005 实测），但未在真实受信任 Pi 会话加载验证——加载与 /reload 链路属 015（CLI-bridge M1 gate），本任务不预支；② 清单损坏时按无清单重新 preparing（不报错），严格性待 018 状态竞争任务复验；③ runtimeIgnoreWarning 对 tracked .runtime 只告警不阻塞（阻塞属正式执行前置检查，任务019/018 范围）。
- 对下一项的交接：009 任务文件操作可用 resolveProjectRoot + 项目锁（orderKeys）+ atomicWrite；配置读取用 parseConfig（unknown schemaVersion → version_conflict → 协议 incompatible_version）；init 服务重复执行安全，桥接 baseline 比对用 templateDigest；--json 输出走 src/cli/output.ts 的 jsonResponse/emit。

优先扫描下一编号（阻塞时可继续跳过）：[009 实现Task文件与输入草案操作](009-task-files-and-inputs.md)。
