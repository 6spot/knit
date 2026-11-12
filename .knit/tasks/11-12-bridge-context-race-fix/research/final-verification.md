# 最终主会话验证（2026-11-12）

## 范围与最终成果

只补修 F4 上下文竞态与 F2 受管 CLI shell 路径转义。保留已有未提交改动，未改旧关闭任务历史，未扩 F1/F3。最终源码、测试、设计及实施证据均保持在独立检查后的字节；本材料只记录后续验收事实。

## 独立检查

- F4 最新有效候选检查 run-fb487ecb56f4：completed/pass，接收 check_pass；create_new/no_previous_session；5 个行为场景与最终 bridge-query 23/23 通过，changedPaths/findings 均空。临时 build 的 255 个产物与当前 dist 一致，HEAD/index 未变。
- F2 run-f330854fb246：completed/pass，接收 check_pass；create_new/no_previous_session；4 场景、managed-entry 11/11、init 27/27；9 隔离安装的 27 条生成命令全部退出0，完整 TS Program 的127个 JS 与 dist 相同。后续夹具修复未改 F2 五项成果。

## 主会话探针及双全量

- 缓存普通轮次默认300ms的 F4 断言探针退出0：先缓存A后挂起实际读A的请求，核心选B，当前轮272ms内注入B而非A、无过期标记，竞态未复现。F2实际生成命令、版本及Node argv探针退出0，空格路径安全引用、CLI模式755。两探针Node v26.3.0，结果见 f4-race-result.json、f2-fallback-result.json、probe-executions.json；这不是10000ms单测冒充默认预算。
- 普通环境完整 npm test：2026-11-12 14:41:45至14:45:54 +08:00，Node v26.3.0，cwd=/Users/me/IdeaProjects/knit，非TTY，npm退出0；739 tests /739 pass/0 fail/0 cancelled/0 skipped，测试245689.119208ms。
- 真实 Rex 终端完整 npm test：14:56:02至15:00:01 +08:00，Node v26.3.0，同一cwd，TTY=/dev/ttys010，TERM_PROGRAM=rex，npm退出0；739/739，0 fail/cancelled/skipped，235146.174167ms。自有session session:01a1ce8a-c30c-750c-a4f0-f50bf4a00d39、block block:01a1ce8a-c30c-75dc-9b30-aad83820222d；Rex process.last_exit.exit_code另核对为0。
- 两次 npm 均实际执行typecheck/build。全部build、探针、专项/全量串行；只在测试子进程清 KNIT_*、REX_*、PI_KNIT_*，私有测试keys，未清主会话/worker关联环境，不调用真实模型作为测试。

## 失败处理与归因边界

初次普通全量738项仅736通过，快照半写JSON解析及观察器ENOTEMPTY的原始日志另存ordinary-attempt1.*，未覆盖。run-07e589756c90正式changes_requested，不以其单次22/22消除缺陷。用户明确授权新修复周期后，run-51484103ba1a仅改测试和实施README：同目录rename原子发布快照；假Pi shutdown显式等待排队扫描及夹具自有CLI，新增gate回归；其23/23及739/739是自检，最终独立检查和上述双npm另行完成。原ENOTEMPTY当时具体写入PID不能追认；不声称完整追溯现场。

## 受管入口、资源与Git

final-init-check退出0、stderr空；当前init计划8项及额外受管.gitignore的9个有效基线SHA全部匹配，manifest ready、overwriteCount=0。两桥cmp且SHA均519b5b1629115e29c134d6a34d9beed2115428e6045297596cd099f453e78792；安装cliEntry为实际realpath /Users/me/IdeaProjects/knit/dist/cli/knit.js、模式755。初次全manifest指纹尝试遇保留的已不存在workflow.md；后续明确区分不在当前计划的workflow.md/deliver.md保留记录，不将其当现行受管路径、不改manifest。

所有十项当前成果SHA、有效基线和安装身份见final-artifact-fingerprints.json。git diff --check通过，HEAD仍58a2dc25a518befe33bb82804fe2e55eb9b95bf3。新周期实施/独检相关controller及Pi PID26227/33485/52476/52868最终ps实测均退出。测试专用Rex session按唯一window/block与成功last_exit再次核对后关闭，列表确认不存在；用户其它Rex资源未控制。

## 证据位置与延期

本机完整日志/exit/metadata、探针及指纹目录：/tmp/knit-fix-verification-WTrUsU/。实施与独立报告见对应run result.json、signed check和本机记录；不复制原生对话或鉴权数据。本材料保存时尚未用正常close完成资格守卫，不能替代其当前input/scope/签名核验。

真实Pi/真实模型及完整真机、Node24与其它平台、发布/外部部署仍延期；当前会话需/reload或重启加载新桥接。worker正常收尾残留边界保留research/worker-settle-observation.md，未扩改F1。不提交、推送或归档。
