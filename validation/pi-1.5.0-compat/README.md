# Pi 1.5.0 兼容验证（任务052，2026-11-02）

环境：Linux aarch64 / Node v24.21.0 / pi 1.5.0（`/home/opc/.pi/agent/bin/pi --version`）/ 基线 1.4.0（validation/pi-cli-1.4.0）。模型：magpie/group/openai（本机已配置，真实模型轮共 3 次，其余零模型）。来源：安装包内 CHANGELOG.md（1.5.0，2026-11-02）与 docs/extensions.md、docs/cli-integration.md。

## 实际验证（脚本在本目录，可复跑）

- [rpc-probe.mjs](rpc-probe.mjs)：RPC 协议边界——get_state、set_model 校验、真实模型轮（read 工具读文件并回复标记 → marker-found）、agent_settled、abort → aborted、原生会话文件落盘。
- [bridge-probe.mjs](bridge-probe.mjs)：项目桥接加载——`knit init` 后 pi 1.5.0 自动加载项目扩展；`/knit-status` 命令被扩展拦截（prompt 响应 disposition=handled，无 agent_start，UI 通知经 extension_ui_request 下发）。
- [tools-probe.mjs](tools-probe.mjs)：真实桥接工具注册——模型确认 `knit_status/knit_material/knit_task/knit_context/knit_run/knit_deliver/knit_snapshot/knit_standards` 全部在工具列表；真实模型轮经 knit_status 工具调用成功（任务 015 语义在 1.5.0 保持）。

## 差异表

| 1.5.0 变化 | 来源 | Knit 使用点 | 影响 | 处理 | 验证 |
| --- | --- | --- | --- | --- | --- |
| 工具参数校验迁移到 pi-schema；纯 JSON Schema 工具获得与 TypeBox 相同的强制转换 | CHANGELOG 1.5.0 | 桥接 8 个工具均以 `Type.Unsafe(纯 JSON Schema)` 注册 | 兼容（Knit schema 不用 JSON Schema 之外的 TypeBox 特性；强制转换属放宽） | 无需改码 | tools-probe：模型确认全部工具可见；047/048 stub 行为不变 |
| pi.exec() 新增 maxBuffer／truncated，SIGKILL 补偿修复 | CHANGELOG 1.5.0 | 桥接用 spawnSync 直调 CLI，不经 pi.exec | 无关 | 无需改码 | bridge-probe |
| 已保存“不信任”决定对仅有 AGENTS.md 的项目生效 | CHANGELOG 1.5.0 | init 生成 AGENTS.md；扩展在项目 .pi/extensions 自动加载，信任影响上下文/包资源加载而非扩展本身 | 行为符合既有准入（不信任项目不获得上下文资源；扩展命令仍按宿主规则加载） | 无需改码；文档已有“按宿主项目信任规则加载” | bridge-probe（--approve 信任下加载；不信任路径由宿主管辖） |
| 会话写入失败修复（内存有条目、磁盘缺失） | CHANGELOG 1.5.0 | 选择条目自然落盘语义（§9.1） | 改善 | 无需改码 | rpc-probe nativeFilePersisted=true |
| ctx.ui.custom() 新增 blocked | CHANGELOG 1.5.0 | 桥接未用 custom() | 无关 | 无需改码 | — |
| Usage.cost.totalFromProvider（提供方账单 vs 估算）、responseModel | CHANGELOG 1.5.0 | 阶段用量归一（OPERATIONS §5） | 观察字段；可在后续增强用量区分，不改变业务摘要 | 暂缓（记录字段，不升级为业务状态） | — |
| 默认 OpenAI 模型目录变化、系统提示与扩展加载调整 | CHANGELOG 1.5.0 | Knit 显式传 provider/model（set_model 校验），不依赖宿主默认 | 无影响 | 无需改码 | rpc-probe setModel=ok |
| /model 排名、HTML 导出、WSL、pi install 符号链接、update Windows 修复、GPT-6.1 Terra、扩展更新日志 | CHANGELOG 1.5.0 | 与 Knit 边界无关或宿主侧 | 无关 | 无需改码 | — |
| before_agent_start／systemPromptOptions.sections（1.4.x 已有，非 1.5.0 新增） | docs/extensions.md | 047 每轮注入 | 已采用 | 047 已实现并经公开 API stub + 真实宿主加载验证 | bridge-probe + 047 用例 |

## 结论

- 需改且已改：无（协议、会话、取消、恢复、桥接加载与工具注册在 1.5.0 全部兼容）。
- 无需改：pi.exec／trust／ctx.ui.custom／默认模型变化均不在 Knit 使用路径或由宿主管辖。
- 有利且暂缓：Usage.cost.totalFromProvider（后续用量增强候选）、ctx.ui.custom() blocked（未来交互式询问候选）；均不进入首版业务。
- 旧版本声明：仅 1.4.0（历史验证）与 1.5.0（本报告）有证据；不承诺其余版本。
- 接口约束交接 044–051：注入用 `before_agent_start` + `systemPromptOptions.sections`（1.5.0 语义不变）；桥接命令/工具经公开 API，无 RPC 专用差异。
