---
id: k-aa8a516e1edb
status: closed
stage: deliver
outcome: completed
branch: refs/heads/main
verification: independent
parent: null
priority: P2
dependsOn: []
order: 20
createdAt: 2026-11-12T01:25:17.778Z
title: 补修受管入口：安全转义含空格的 CLI 路径
---

## 目标
修复受管入口的 CLI 绝对路径回退：安装路径含空格或 shell 特殊字符时，生成的命令应将路径作为一个字面量参数执行，不被截断或执行额外命令。
用户于 2026-11-12 明确要求修复本轮复查发现的 F4、F2，并选择新建两个补修任务；本任务范围与实施已获授权，在 F4 后推进。

## 证据与关联
- 原任务 k-731a13eab2f1（11-11-managed-entry-command）保持原 closed/completed 历史。
- src/application/initialization.ts:574 返回裸 cliEntry，受管块直接拼命令。
- 隔离安装目录含空格时，按 AGENTS 生成的命令执行退出 127（路径在 installation 处截断）；同一 CLI 经 Node 执行正常。普通无空格安装路径正常。
- 初始探针保留在 /tmp/knit-repair-check-c7s7GE/f2-fallback-probe.mjs 和 f2-fallback-result.json；新增仓库测试应可移植，不固定开发机路径。

## 范围
- src/application/initialization.ts 及必要的受管命令渲染小 helper；沿用已有合适的 shell 转义实现，不另建执行层。
- test/managed-entry.test.mjs；必要的 init 回归仅修改与本修复直接相关断言。
- docs/design/ROLE-CONTRACT.md 第 5 节及对应初始化描述若需同步，说明命令表示须安全转义，实际 cliEntry 仍是原文件路径，不扩其他规则。
- validation/managed-entry-quote-fix-2026-11-12/：隔离复现、执行生成指令的结果与验证说明。

## 约束与非目标
- 保留既有未提交改动，不重写原任务历史。
- PATH 首个 knit 的版本核对、匹配时写 knit、缺失／不匹配回退本 CLI、既有探测预算均保持；不引入 npx 或自动安装、不改变 CLI 选择与信任规则。
- 命令显示／shell token 与文件路径身份分开：installation.cliEntry、进程 argv、路径比较和恢复记录仍保存未加 shell 引号的实际路径，按已有 realpath 规则核对别名。
- 修支持平台的可执行命令表示；不新增 Windows 或其它未验证平台的兼容承诺。
- 不修改 .knit/ 下配置、工作流、提示词、规范或运行凭据。Git、模型与 shell 副作用测试仅在隔离夹具，不提交／推送／发布，不控制用户现存终端。
- 使用 independent 检查；完整真机／真实 Pi、Node24组合和发布矩阵不纳入本轮必过验收。

## 完成条件
### Requirement: 回退命令按字面量路径执行
#### Scenario: 安装路径含空格
- GIVEN 隔离 CLI 安装路径含空格且 PATH 的 knit 缺失或版本不一致
- WHEN init 生成 AGENTS 受管入口并在 shell 中执行该生成命令
- THEN shell 正确找到当前 CLI，版本与 task list 等只读调用成功，不出现 127 路径截断
- AND 测试实际执行生成命令，不仅检查引号或字符串存在

#### Scenario: 路径含引号和 shell 特殊字符
- GIVEN 支持平台的隔离安装路径包含单引号、美元符号或其他会参与 shell 解析的字符
- WHEN 在 shell 中执行受管回退入口
- THEN 路径作为一个字面量 token 解析、CLI 正常执行
- AND 不触发路径内容中的额外命令或变量展开，不写范围外文件

### Requirement: 路径身份和已有选择规则不变
#### Scenario: cliEntry 保持实际路径
- WHEN init 保存安装记录并读取受管入口命令
- THEN installation.cliEntry 仍是按既有规则规范化的实际可读文件路径，没有命令引号或转义片段
- AND 命令渲染不污染 argv、路径比较、绑定或恢复身份

#### Scenario: 版本选择与普通路径回归
- GIVEN PATH 首个 knit 分别为版本匹配、不匹配和缺失，且 CLI 普通路径不含需转义字符
- WHEN 解析／生成受管入口
- THEN 匹配时仍写 knit，不匹配或缺失仍回退当前 CLI，安全普通路径保持可执行且现行测试通过
- AND 不写 npx 入口、不安装包、不选择后面的同名命令偷换版本

## 验证安排
- 实施：typecheck、build、managed-entry 与相关 init 隔离回归，使用当前 Node 绝对解释器处理受限 PATH，记录真实命令与结果。
- 正式独立检查覆盖全部 Rn.Sm，执行生成指令并核对路径身份／副作用，而不只看字符串断言。
- 两项汇总后由主会话在普通及真实 Rex 终端各跑一次 npm test；不虚构其它平台或完整真机通过。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

### 交付记录

<!-- knit:delivery:op-2def36100f2a -->
- 操作: op-2def36100f2a
- 时间: 2026-11-12T17:46:14.875Z
- 分支: refs/heads/main
- 授权来源: user:sha256:022d9ea53babe7e8033f06eee04f16b45c91d3186198d2f54e989836fe25d3cc
- 调用: bridge
- 工作提交: a6b2d027ef3f986c70da7a7b599d33ea6409cae6
- 结果: 正常交付；检查 run-f330854fb246 通过；验证 independent
- 归档目标: .knit/tasks/archive/2026-11/11-12-managed-entry-shell-quote

<!-- knit:progress:end -->
