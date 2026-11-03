# 源码边界

目录与模块职责按 [ARCHITECTURE.md](../docs/design/ARCHITECTURE.md#9-代码组织与协议) 组织。后续开发从 [AGENTS.md](../AGENTS.md) 和本仓库的 Knit 任务开始，既有实现事实见[开发历史](../docs/history/TASKS.md)。不预建空服务类或第二套框架。

依赖方向：入口／适配 → 核心用例与端口 → 纯领域规则。文件、Git、进程和原生客户端副作用留在适配与基础设施；主 Agent 负责语义授权，核心负责结构、版本和真实效果校验。
