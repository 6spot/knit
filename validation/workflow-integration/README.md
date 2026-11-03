# 050 模板安装与升级集成验证（2026-11-02）

环境：Linux aarch64 / Node v24.21.0。方法：`npm pack` 真实包 → 隔离临时目录安装依赖 → 新项目 init 与旧模板项目升级，断言见 verify-050.mjs 输出标记。

结果（全部通过）：
- FRESH_INIT: completed / ready / 0 conflicts
- WORKFLOW_NEW: 新 workflow.md 含主会话识别与 plan.md 指引
- AGENTS_NEW: 受管块含任务规划资料与每轮上下文说明
- BRIDGE_NEW: 桥接含 before_agent_start 注入、knit_material 工具、buildTurnContext
- MATERIAL_SAVE: 任务规划资料接口在包内可用
- UPGRADE_KEEPS_CUSTOM: 升级保留项目自定义 workflow（只补缺不覆盖）
- OLD_TASK_OK / OLD_TASK_READY: 旧单文件任务继续，无 plan.md 也能 ready（简单任务不受阻）

旧单文件任务未强制拆分；升级冲突路径由既有 init 基线机制（039）覆盖。
