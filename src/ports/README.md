# 内部端口

只定义当前用例确需的 MetadataStore、文件／锁、Git、进程／时钟、ClientAdapter、AgentRuntime 和 ExecutionHost 契约。由源码固定装配，测试可注入 fake；不是插件 SDK 或动态注册平台。生产元数据后端由任务004选一个。
