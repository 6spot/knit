# 002 建立最小协议、schema与内部端口

- 里程碑：M0
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[001 建立工程工具链与包边界](001-engineering-baseline.md)
- 实际依赖：[001](001-engineering-baseline.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

建立后续能力实验和业务用例共享的协议边界，避免各入口自造参数与状态。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：第2–4、9节：分层、端口、JSON协议。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第3–4节：schema、版本和传输。
- [STATES.md](../../design/STATES.md)：第1节与对象字段定义。

## 实施范围

- 定义 protocolVersion/requestId/outcome/reasonCode、必要运行请求／结果、原生身份和元数据最小结构；由schema推导外部类型。
- 建立当前确需的 MetadataStore、Pi runtime、local host、文件／锁、Git／进程／时钟端口；不预建空服务和公共插件注册器。
- 统一错误与版本处理、stdout单JSON和事件流边界；最小DiagnosticSink只提供脱敏stderr入口，不建设日志平台。
- 给状态／业务摘要／原生条目范围留下当前设计要求的字段，允许未知观察值而非填零或伪成功。

## 交付物

- 被后续实现实际使用的schema、类型与最小端口
- 协议样例及非法输入／未知版本的验证记录

## 完成前必须验证

- 校验合法请求、额外字段、错误模式组合、非法枚举与未知版本；不能只证明TS编译通过。
- 核对JSON序列化往返后schema仍可用于核心校验；宿主工具接受性留给005实际测试。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不创造额外状态机或第二套权威JSON镜像。
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
- 实际修改：新增 src/contracts/protocol.ts（PROTOCOL_VERSION=1、CliResponse、ProtocolEvent、outcome/reasonCode schema）、run.ts（RunRequest/PrepareResult/Result/Status、RunState、launch planned/starting/confirmed/failed、原生条目范围与用量可空字段）、session.ts（pi 客户端原生身份、opening/available/missing/incompatible、SessionRecord）、metadata.ts（TaskBinding、确定性操作 planned/running/needs_attention/completed/abandoned）、errors.ts（10 个原因码到 outcome／处理分类的映射）、validate.ts（版本核实先于结构校验）、frames.ts（增量 UTF-8、仅按 LF 切帧的 LfFrameDecoder）；新增 src/ports/index.ts（SessionRef/Binding/Operation/Run/NativeEntryRange 端口）与 infrastructure.ts（AtomicFileWriter、LockStore、ProcessPort、GitPort、Clock、MetadataStore 短事务契约）；新增 test/contracts.test.mjs 12 项校验测试。package.json 将四个运行依赖固定为精确版本（^ 范围曾使 typebox 实装 1.4.3，已重装回 1.3.27）。
- 实际验证命令与结果：`npm test`（typecheck + build + node:test）通过，17/17 pass 0 fail，覆盖：合法响应／请求／Session／binding schema、额外字段与缺字段拒绝、非法枚举（outcome、reasonCode、phase=discuss、RunState=starting、SessionStatus=closed）、终态结果拒绝非终态状态、未知／非当前版本报 incompatible_version、错误组合映射（invalid_request/incompatible_version/internal_error→error，busy/io_error→blocked，needs_context/stale_input/needs_review/unknown_run/external_effect_unknown→needs_attention）、JSON 序列化往返后 schema 仍可用、LF 帧解码不受 U+2028/U+2029 影响、多字节 UTF-8 跨块不乱码、尾部半行不作完整帧。
- 证据位置：test/contracts.test.mjs、src/contracts/、src/ports/；本记录。
- 未解决问题／决定：无阻塞。宿主工具对内嵌 schema 的接受性按任务边界留给 005 实测；MetadataStore 物理后端（原子文件 vs SQLite）留待任务004实证比较，当前只有端口契约。typebox 1.3.27 的 Value.Errors 错误对象 path 属性非必有，validate.ts 已按可选处理。
- 对下一项的交接：003 可直接开始；run/launch/session schema 与端口契约已就绪，Pi 适配仅需实现 AgentRuntime 相关端口，帧解码与版本校验可直接复用。

优先扫描下一编号（阻塞时可继续跳过）：[003 实现本机Pi CLI协议适配](003-pi-cli-runtime.md)。
