# 042 在 Pi 命令中展示结构化查询结果

- 里程碑：审计修复（P3）
- 执行角色：开发 Agent
- 来源：2026-11-02 [设计与实现一致性复核](../../../validation/design-implementation-audit/README.md)，发现 F042。
- 受影响原任务：005、010、015、021、023。历史完成记录保留，本项承接新发现。
- 唯一状态入口：[TASKS.md](../TASKS.md)。

## 先读

先遵守 [AGENTS.md](../../../AGENTS.md)、[TASKS.md](../TASKS.md) 和 [BLOCKERS.md](../BLOCKERS.md)。本任务以 DESIGN §3 的当前任务选择与 §12 的查询入口；首版 Pi 桥接使用约定；具体显示按现有CLI数据契约 为验收依据；按需阅读对应章节。

## 已核实偏差

两个 slash 命令 handler 只读取 error、data.error、reasonCode 或 stderr，完全不渲染成功响应的 data。task list／status 成功时只能得到通用完成／无输出提示，无法从该入口读取实际任务或状态。

- 代码位置（审计基线）：assets/templates/pi/extensions/knit.ts:290–346；src/cli/status.ts、src/cli/output.ts。
- 证据等级：源码核实，需修复时宿主验证。
- 实际证据：桥接 handler、core JSON返回与通知分支源码核实；本轮未执行真实宿主显示验证。
- 最小场景：注册桥接到公开API测试替身，令 core 返回含任务数组或status对象的成功响应，调用 /knit task list、/knit status 与 /knit-status，记录通知。
- 证据文件：[审计记录目录](../../../validation/design-implementation-audit/README.md)。源码行号以基线为准；并发修改后按符号定位。

## 实施范围

- 按实际 query data 格式生成可读结果，显示任务ID／名称／阶段与相关阻塞，覆盖项目概览、按任务查询和当前任务查询。
- 成功响应的 data、失败 reason 和诊断分开处理；保留工具入口的结构化JSON。
- 普通输出不混入诊断细节，长列表采用宿主已有可读展示能力。

## 完成前必须验证

- API替身断言查询内容确实可见；空列表、损坏记录和失败响应有准确提示。
- 在生成并安装的真实 Pi 桥接做最小 /knit task list 与 status 冒烟；模型非必需。
- 优先复用 test/m1-cli.test.mjs、test/init.test.mjs 和已安装模板的公开 API 夹具，新增测试仅覆盖有业务后果的不变量。
- 运行受影响测试、类型检查及构建；记录命令、环境和结果。需要真实宿主的条目不可用替身冒充完成。
- 同步相关契约／规范中的实现与验证说明，不能通过删掉原要求宣称修复。

## 边界与交接

- Git／故障实验仅在隔离夹具执行；不提交、推送、发布或修改真实仓库历史。
- 保留其他执行者改动；现有产品任务 check-report-fence 不属于本项。
- 阻塞按 BLOCKERS.md 记录事实并继续独立工作；依赖按接口与产物判断，不把编号当硬依赖。
- 修复后交给 [043 独立复验](043-audit-independent-regression.md)；本任务文件不另存一份状态。

## 执行记录

- 2026-11-02：审计主执行者创建任务，记录上述偏差、证据与验收条件；尚未实施本项修复。
- 2026-11-02：开发 Agent 实施修复并验证完成。
  - `assets/templates/pi/extensions/knit.ts`：新增 `describeQuery`——按实际 query data 形状生成可读文本：task list（活跃／归档列表，归档超过 20 条折叠计数）、项目概览（任务与活跃运行）、按任务查询（`/knit status <id>` 与 `/knit-status`：状态／阶段／分支／待应用草案／运行列表）；其它成功对象给出键值摘要。`/knit` 与 `/knit-status` 成功响应优先展示结构化结果，失败 reason 与诊断分开（level warning），不回显诊断细节；写命令（如 task new）不受影响。
  - 测试：新增 `test/bridge-query.test.mjs`——公开 Extension API 替身（host stub）加载 tsc 编译后的安装版桥接模板（与安装布局同构，root 推导到测试项目），断言 `/knit task list`、`/knit status`、`/knit-status`、`/knit status <id>` 的通知内容确实可见（任务标题、活跃任务计数、运行列表、任务 ID），空归档列表显示（无），失败响应给出 warning 而非通用完成。这是最小宿主验证：真实宿主显示样式由宿主 ui 决定。
  - 验证：`npm run typecheck`、`npm run build`、`node --test test/*.test.mjs` 连续两轮 229 项全过（Linux + Node v24.21.0）。
  - 设计同步：DESIGN §3 当前任务选择与 §12 查询入口、首版 Pi 桥接使用约定不变；桥接只加展示，不新增工具入口或权限。
- 后续执行者须补充实际修改、验证、未解决事项和交接，不以任务创建视为修复完成。
