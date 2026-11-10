# 实施与验证计划

本计划是 task.md 已确认范围的实施安排，不增加需求。承接总任务 k-2c0d10318898 的顺序与授权；verification=self，主会话核对产物与范围验证，最终由总任务做统一完整回归。

## 开始前

- 阅读 AGENTS.md、docs/README.md、.knit/workflow.yaml、task.md。
- 阅读当前 DESIGN §5.3、OPERATIONS 阶段执行／报告章节、ROLE-CONTRACT 中报告与失败语义。
- 入口：src/application/stage-runner.ts、src/application/stage.ts、src/domain/report.ts、src/adapters/pi/ 下公开 stdin-stdout runtime、Rex launcher、test/stage.test.mjs、test/fixtures/fake-pi.mjs。
- 如调整 Pi CLI/RPC 调用，先读安装的 Pi 文档中相关完整章节（README.md 和 docs/rpc.md；位于 /home/opc/.pi/agent/install/releases/1.5.0/node_modules/@earendil-works/pi-coding-agent/），只使用现有公开 CLI／stdin-stdout 协议；不引 SDK、RpcClient 或另建模型运行时。

## 实施要点

1. 在成功完成阶段工作后辨认可补报的解析／结构错误；缺 JSON、JSON 截断或阶段 schema 不合时，在同一原生会话最多补报一次，local 和 Rex 不分叉。
2. 补报轮只允许输出最终报告，不可再实施、调用工具或重跑验证；保留原工作区、归属与边界证据，不能用补报掩盖阶段执行失败、保护路径／HEAD 改动、占用丢失或取消。
3. 补报仍失败则保留 report_invalid 与原失败语义／诊断。不要把补报加入任务修复预算、阶段访问计数或独立状态机，也不自动多开完整实施轮。
4. 执行结果、原生 session 文件／entry range、usage 等应覆盖真正执行过的两轮而不丢失首轮证据；恢复与取消仍走既有路径。
5. 同步必要的产品说明与报告诊断；.knit/ 下配置、规范、阶段提示词均为阶段硬保护，不在 Worker 中修改。仅修改本任务所需源代码、模板、测试和产品文档。

## 范围验证

- 隔离 fake-Pi：首轮无 JSON／截断／schema 不合，第二轮有效报告成功并仅补一次。
- 首轮有效报告没有额外轮次；两轮均无效按原失败语义终止；首轮执行失败／取消／越界不补报。
- 明确验证第二轮无工具实施／测试副作用，第一次实际修改仍正确归属、路径与阶段计数不因补报改变。
- local 与 Rex 两条入口使用同一补报规则；保留会话、usage、取消和原生恢复的既有保证。
- npm run typecheck、npm run build、相关 stage/report/runtime/attribution 测试；全量 npm test 留待总任务最终 gate，避免每个子任务反复跑完整轮次。

## 交接

最终阶段报告如实列明改动路径、实际命令／结果、失败／未验证项。不得提交或推送，不关闭任务；由主会话接收、复核、记录与按既有授权交付。
