# 完成后的本次 worker 资源观察（不扩大F2补修范围）

- 2026-11-12，run-3f9e6879f487 正常 completed，核心 automatic acceptance 为 implementation_accepted；controller worker PID60928 已结束。
- 主会话随后按实际ps核对：阶段Pi PID68100、启动10:29:00仍在Rex中存活。不是仅依据stage-process.json的running观察字段。
- 本run rex.json 的 layer/block 与真实session.inspect一致；浮层 layer:01a1cd96-46e0-7426-bb24-e5ed0a8cdfe3 中只有label `knit run-3f9e6879f487` 的一个块。与F4曾观察的关联ID不一致情形不同，不能将本次残留归因于该现象。
- 主会话核对归属后只关闭该自有浮层；随后的ps显示68100已结束，未关闭其他用户资源。原生运行资料仍留本机；未复制对话或鉴权数据。
- 这是另一个需要单独追踪的收尾边界证据，尚未做根因诊断，不能说F1已覆盖所有终态。按本轮仅F2/F4的授权，不扩改F1或重写旧关闭任务历史。后续若用户选择补修，再取证登记。
