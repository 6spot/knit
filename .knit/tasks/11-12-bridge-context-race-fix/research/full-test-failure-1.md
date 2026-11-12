# 补修后首次全量失败：桥接夹具竞态（2026-11-12）

主会话在普通执行环境运行原npm test脚本：typecheck/build成功，738项，pass736/fail2，npm退出1，测试235463ms。日志在本机 `/tmp/knit-fix-verification-WTrUsU/ordinary-attempt1.log`，退出码和Node/终端元数据同名前缀保留。不覆盖这次失败。

## 证据

1. `test/bridge-query.test.mjs:918` 的新增场景「读A后切B，B先缓存、A最后回包再失败」，`waitForContextSnapshot` 在914行JSON.parse报Unexpected end of JSON input。文件存在不等于JSON已写完；请取证producer的写入顺序，优先用原子发布而非固定sleep/放宽预算。
2. 既有「观察器：run list查询失败不推进扫描时间，恢复后从原时间点继续查」（1399行），finally的rmSync（1449行）报ENOTEMPTY。尚未归因；请查假Pi exec/观察器/上下文在途任务是否退出与夹具清理时序。不是已确认的产品故障，不能只称偶发后反复跑到绿。

## 补修约束与复验

- 首选只改 `test/bridge-query.test.mjs` 的夹具可靠性和必要的F4阶段验证记录，不覆盖其它既有修改。F2范围、现有受管基线、配置、workflow、阶段提示词与标准保持不动；不要根目录init/force或改manifest。若诊断证明涉及产品逻辑，先明确证据与F4关联；不扩成F1/Rex终态修复。
- 优先原子写快照及明确追踪/等待夹具拥有的在途exec完成。不能用吞JSON异常、增加固定sleep、放宽300ms/2s/10s产品预算、屏蔽失败或单纯反复重跑解决。清理不能删除或终止用户其它资源。
- 构建与测试串行；宿主控制变量只在测试子进程清除KNIT_*/REX_*/PI_KNIT_*，私有KNIT_KEYS_ROOT；不要清除worker自身控制环境。无真实模型验收，不创建Git提交。
- 完成诊断/修复后顺序验证最终bridge-query整组及有代表性的全量负载。主会话之后重新独立检查F4当前最终范围，并从头执行普通/Rex两次全量；此前独验通过不代表这两处已通过全量。
- F4补修前的复查探针没有成功cache，配置值300不等于首轮使用300；主会话现在已先成功缓存A后重现旧A回包，cached300ms断言probe退出0，证据为新临时目录中的f4-race-result.json。原失败探针不改写。
