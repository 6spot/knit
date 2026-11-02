# 内部端口

只定义当前用例确需的内部能力契约；由源码固定装配，测试可注入 fake。不是插件 SDK 或动态注册平台。生产元数据后端由任务004选一个。

## 已定义契约（src/ports/）

- `index.ts`：SessionRefPort、BindingPort、OperationPort、RunPort、NativeEntryRangePort。
- `infrastructure.ts`：MetadataStore、AtomicFileWriter、LockStore、ProcessPort、GitPort、Clock 及 Session 查询等配套类型。

## application 层当前为固定装配

application 用例直接组合内部适配器（adapters/pi 的 PiAgentRuntime、local 适配器与 infrastructure 实现）。AgentRuntime、ClientAdapter、ExecutionHost 等接口未建，也没有对应的 ports 契约；不要按"已存在抽象"开发。当前显式注入点如下，测试用 fake／临时目录走同一装配路径：

- `StageRunner`：`runtimeFactory`（默认 `new PiAgentRuntime(...)`）、`piExecutable`，以及 `store`／`runs`／`locks` 等。
- `runInformalCheck`：`runtimeFactory`（默认同上）、`piExecutable`（由 CLI 组合根从 --pi-bin／KNIT_PI_BIN 传入，用例层不读环境变量）。
- `SessionService`：`checkFile`（默认 `checkNativeSessionFile`）。

出现第二实现（其他 runtime 或客户端）时，再把相应能力提升为端口并扩展源码装配表；首版不预建抽象。
