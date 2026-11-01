# 会话恢复失败后的文件续做实验

结果：通过。验证日期2026-11-01；使用本机Pi1.4.0及当前 `magpie / group/openai`，不导入SDK或安装依赖。此为隔离夹具，不是Knit产品实现。

用户已选择：优先打开原生会话；原记录无法恢复时，沿同一客户端自动新建会话，读取任务文件和当前现场继续，无需再次确认。新建事实与原因报告给主Agent。

## 实际过程

1. 保存未完成的解析函数、原测试、task.md和progress.md。语法校验及小时换算已完成，分钟／秒换算未完成；控制器先运行测试，确认失败。
2. 原会话记录路径明确不存在。启动前检测这一事实，不把缺失路径传给Pi，以免CLI的隐式新建被误称原生恢复。
3. 创建不同ID的新会话，查询确认初始历史为空，再发出同任务续做指令。
4. 原生工具记录证实读取task.md、progress.md、duration.py、test_duration.py；实际只修正分钟／秒换算因子。
5. 模型运行测试；控制器独立复跑3个测试方法通过，task.md及progress.md字节保持原样。
6. 原生记录实际保存，收到agent_settled后结束，进程已退出。

同一Task ID仍是fallback-fixture，阶段仍为implement，已有修复次数仍为1。新Session ID与来源／原因保存于[report.json](report.json)。阶段、次数和成果不会因为换会话而重置。

## 发现的状态边界

模型在最终总结中自行将phase写为complete、repair_rounds写为2；这些值不被控制器采纳，实际任务文件与控制器权威值仍为implement／1。初始校验错误地要求模型回显值作为状态保持的证据而失败，已改为检查真实任务文件、控制器值及代码／测试效果。旧报告和脚本保留在report-attempt1.json与scripts/attempts/，随后直接检查同一次调用的原生记录，没有重复请求模型。

模型总结只作为建议与执行信息。Knit核心根据既定流程改变任务状态，不能让新会话通过自报元数据重置／迁移生命周期。这个原则不需要新增恢复状态机。

## 资料

- [report.json](report.json)：来源、实际读取证据、状态边界、用量。
- [assistant-final.txt](assistant-final.txt)：模型原始总结，保留与控制器值的差异。
- [before-unittest.txt](before-unittest.txt)、[after-unittest.txt](after-unittest.txt)：控制器实际测试输出。
- [fixture/](fixture/)：前置任务、进度、修复前代码及after-*结果快照。
- [scripts/run_probe.py](scripts/run_probe.py)：一次性实验脚本，复跑须用新的目录，并保留其相邻pi-cli-1.4.0/scripts/pi_rpc_probe.py帮助代码。
- private-native/：原生完整记录，本机私有、Git忽略；.work/为忽略的执行现场。
- [CHECK.json](CHECK.json)：最终文件指纹、代码重放及私有资料校验。

新增原生已记录用量42,150 token（含缓存），Pi配置价格估算约$0.021321，非供应商账单。用量独立于之前已封存的CLI实验，不改写旧汇总。

本例动态验证“记录缺失→新会话→文件续做”。损坏／格式不兼容的触发分类、未结束旧执行的阻塞、新会话启动失败不循环重建，已写入设计，仍需产品实现后验收。新建会话不绕过模型不可用、未知工具状态或任务／目录归属不明。
