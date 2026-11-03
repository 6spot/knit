# 003 实现本机Pi CLI协议适配

- 里程碑：M0
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[002 建立最小协议、schema与内部端口](002-contracts-and-ports.md)
- 实际依赖：[001](001-engineering-baseline.md)、[002](002-contracts-and-ports.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

形成可复用的Pi进程／协议适配，不依赖SDK，证明模型、工具、取消和原生恢复的真实边界。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [DESIGN.md](../../design/DESIGN.md)：第5.4–5.6、9.2–9.4节。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第5–7节。
- [validation/pi-cli-1.4.0/README.md](../../../validation/pi-cli-1.4.0/README.md)：既有能力与四项限制。
- [validation/session-fallback/README.md](../../../validation/session-fallback/README.md)：文件续做证据与模型状态不可信边界。

## 实施范围

- 启动本机 pi --mode rpc，用增量UTF-8和LF分帧、请求ID与事件关联；接受响应不当终态。
- 解析明确provider/id，检查本地可用清单或set_model并核对实际选择；复用客户端鉴权，关闭未选自动资源。
- 支持必要状态／历史、prompt、clear_queue/abort与稳定终态；CLI强杀不代表所有子进程结束。
- 实现预分配原生ID、稳定会话目录、旧记录加载及身份检查；旧记录缺失／损坏／不兼容时同客户端新会话加载文件，保留来源。
- 明确opening/available、原生条目起止与增量用量；历史查询不得打开可写原会话触发修改。

## 交付物

- 生产可复用的src/adapters/pi最小实现
- 版本能力及真实／零模型测试证据

## 完成前必须验证

- 覆盖分片Unicode/U+2028/U+2029、截断帧、EOF、非法模型及缺失记录的误新建风险。
- 复用既有证据，仅对新实现跑必要真实模型冒烟：稳定结束、受控工具取消、旧记录恢复和新会话文件续做。
- 清理自有测试进程，未知终态如实失败／待核实，不偷偷换模型。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不写业务Task，不复制第二聊天库，不研究其它客户端。
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
- 实际修改：新增 src/adapters/pi/connection.ts（PiRpcConnection：spawn pi --mode rpc 独立进程组、LfFrameDecoder 增量分帧、请求 ID 关联、EOF 后未决请求以 PiConnectionClosedError 拒绝并携带真实退出码／信号、stderr 尾部诊断、进程组信号）、native-file.ts（checkNativeSessionFile 只读身份核实：首行 type:session 的 id/cwd，区分缺失／损坏／id 不符，不打开可写会话）、native-entries.ts（scanNativeEntries／readLeafEntryId／readEntryRange 条目起止定位，畸形行不参与定位）、runtime.ts（PiAgentRuntime：启动参数关闭扩展／MCP／技能／上下文文件、get_state 取回实际 sessionId／sessionFile、set_model 受校验核实模型否则报 set_model_rejected／model_mismatch 不静默替换、prompt 等 agent_settled 而非单个响应、clear_queue/abort、get_session_stats、getMessages 只读历史、dispose 优雅到 SIGTERM/SIGKILL 逐级、isolatedEnv 剔除主会话 PI_* 变量）、resume.ts（decideResume prefer 预检：记录存在且身份一致才 --session 恢复，否则预分配新原生 ID 新建并保留原因）、index.ts 统一出口；新增 test/pi-runtime.test.mjs 12 项测试。连接受阻时 stdout 结束先于 exit 事件，已加短暂等待让真实信号先落地。
- 实际验证命令与结果：`npm test` 通过 29/29（contracts 17、cli 5、pi-runtime 12，本机 Node24.21.0、pi 1.4.0）。真实模型冒烟（使用本机已配置模型 magpie/auto/glm-5.3-flash，经 set_model 核实，未静默替换）：① prompt 稳定结束于 agent_settled、get_last_assistant_text 与 get_session_stats 可读、条目范围可定位；② 受控 bash 子进程打印 nonce+PID 后 abort，agent_settled(aborted=true)，子进程经 ps 核实真实终止；③ 兜底新建（旧记录缺失）预分配新 ID 新建会话，模型实际读取夹具任务文件并返回标记，新原生记录落在稳定 --session-dir 且身份与预分配 ID 一致；④ 旧原生记录按原客户端 --session 恢复（零模型请求），原生 ID 一致且历史非空。零模型请求验证：非法模型启动被 set_model 拒绝（复现既有发现并拦截）、EOF/SIGKILL 后未决请求报连接关闭并携带真实信号、非 JSON／非对象帧归入 invalidFrames 不作响应或事件、缺失记录 decideResume 报 session_file_missing 不冒充可恢复、身份不符报 id_mismatch。测试结束无残留 pi --mode rpc 进程。
- 证据位置：test/pi-runtime.test.mjs、src/adapters/pi/、本记录；临时夹具在 /tmp/knit-pi-*（私有运行产物，不入库）。
- 未解决问题／决定：无阻塞。实现备注：原生会话文件名为 {timestamp}_{sessionId}.jsonl，恢复与登记以 get_state 返回的 sessionFile 和身份核实为准，不假设文件名格式；分片 Unicode／U+2028/U+2029 由 contracts 已验证的 LfFrameDecoder 覆盖并在归档实验复验过。历史查询使用 get_messages／get_state，未发现其触发可写会话追加；如后续发现需改走文件只读路径。
- 对下一项的交接：004 可直接开始；run 增量用量可按 get_session_stats 前后差值计算，原生条目起止由 readEntryRange 提供；MetadataStore 物理后端决定后，SessionRefPort／RunPort 等端口已有明确契约可实现。005 需要的宿主桥接仍属独立工作。

优先扫描下一编号（阻塞时可继续跳过）：[004 实证比较并确定唯一元数据仓储](004-metadata-storage-decision.md)。
