# 场景任务资料交付阻塞（2026-11-12）

- 成果与验证提交 66f2d3f、58a2dc2 已在 origin/main，本轮不重复提交。
- 实际正常 deliver 拒绝 stale_input：原 task inputsDigest 与 standardsDigest 匹配，但 role:check/runtime:pi 冻结版本已改变，effectiveInputsDigest 不匹配。旧 run-bc7506733800 的 pass 仍只是原版本的历史凭据。
- 实际只读比较：旧 scope 共 37 个条目，后续已完成任务已合法更新其中 10 个路径：.pi/extensions/knit.ts、AGENTS.md、assets/templates/pi/extensions/knit.ts、docs/design/DESIGN.md、docs/design/OPERATIONS.md、docs/design/ROLE-CONTRACT.md、docs/README.md、src/application/stage-runner.ts、test/rex.test.mjs、test/scenarios.test.mjs。
- 正式只读检查的接收还要求未改动 scope 当前指纹匹配（run-acceptance.ts 的 scope_changed 守卫）。直接对现行分支派 check 会有已知的来源/指纹缺口；非正式 check --scope 不能替代正式 independent，主会话 task implement 也不能绕过。
- 不恢复旧规则，不改写 scope/检查/完成凭据，不用空写入制造来源，不回退或重写 Git 历史；保留原业务 completed 与原历史凭据。资料/归档须待正式来源/实施链能合法重建当前 scope 后再做独立检查。
- 在不自动修改生产源码的授权边界内将此项明确记为 blocked。其它已获授权、不依赖此缺口的交付和完整本机验收可继续；该阻塞不冒充已收尾。
