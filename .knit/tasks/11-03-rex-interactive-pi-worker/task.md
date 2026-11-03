---
id: k-e91ce642ede0
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
verification: independent
createdAt: 2026-11-03T15:08:55.694Z
title: 集成 Rex 交互式 Pi Worker（浮窗、双向通信与恢复）
---

需求冻结（主会话完成本机 Rex 实证 + pi-rexagents 固定提交研究 + Pi 1.5 公开接口核对，方案见任务目录 design.md 与 research/rex-pi-capabilities.md）：

架构决策：
1. Rex 模式 = stage-runner 的另一种 runtime 呈现，不是第二套调度器；task/run/session 状态机、冻结、快照、锁、验收、completion 全复用。Local 链路零改动（--rex 开关才走新路径）。
2. 进程组织：knit core 现有校验/冻结/建 run 后 spawn `rex api call session.new_layer`（命令 pi --session-id 预分配 --session-dir --mode text + worker 扩展 + KNIT_RUN env），浮层默认 minimized 右下 bounds；run 目录 rex.json 记 {sessionId, blockId, layerId, label, socketPath}；label=`knit <runId>`。
3. 通信：worker 侧 Unix socket JSON-RPC（steer/stop/status，参考 transport.ts 帧协议）；worker 扩展 PI_KNIT_REX_WORKER 激活，session_start 校验 ctx.mode==="tui"+身份、owner 锁；steer=pi.sendUserMessage(deliverAs:"steer")，stop=ctx.abort()；before_agent_start/agent_settled/ui_prompt_start 映射状态；settle 从会话分支提取 assistant 消息写结果文件。
4. 事件驱动：host 侧 `rex api events` 订阅 + state.json 兜底，不用模型轮询；普通进度不通知主 Agent。
5. 恢复：重入按 label list_blocks 发现浮窗——进程活则重关联不重启；进程退先读结果文件再判；身份不符报错不冒认。
6. 真机验收维持延期：本机 Linux 无 GUI Rex，浮层 UI 行为本轮仅单元级验证（调用层记录/断言），验收场景表在用户指定 macOS 环境执行，关闭时记 blocked，不宣称通过。

实施三步（本任务内，逐项可验收）：S1 通信层 bridge.ts+state.ts；S2 worker 扩展 worker-extension.ts；S3 host 层 RexApi+rex-launcher.ts+CLI --rex 开关+测试。范围：新增 src/adapters/rex/ 与 src/application/rex-launcher.ts、stage-runner 的 Rex 分支、CLI 开关；不修改现有 RPC runtime 行为、completion、验收资格。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

实施与验证记录：

实施链路：run-299c3ffdc3f8（首轮，magpie/group/deepseek 429 限流失败于报告产出，实现已落盘）→ run-e67ff0817ee3（resume 恢复，同样 429 秒败）→ run-b21f5731c072（显式 magpie/auto/glm-5.3-flash 重新派发）completed，已接收 implementation_accepted。

落地内容（对照冻结方案 design.md S1/S2/S3）：S1 src/adapters/rex/bridge.ts（Unix socket JSON-RPC：status/subscribe/steer/stop，帧上限校验）+ state.ts（manifest/state/result 往返、owner 单实例锁、assistant 提取）；S2 worker-extension.ts（PI_KNIT_REX_WORKER 激活、TUI/身份校验、prompt 注入、settle 写结果、stop→abort 记 aborted）+ assets/templates/pi/extensions/knit-rex-worker.ts 双注册；S3 host.ts（RexApi 封装+能力探测）+ src/application/rex-launcher.ts（浮层创建、rex.json、恢复发现：进程退先读结果、身份不符拒绝冒认、无 bridge 兜底节流查询）+ stage-runner Rex 分支 + run-coordinator/contracts/run-store 的 presentation=local|rex 不可变字段（活动 run 呈现切换拒绝）+ CLI run implement/check --rex 开关。

验证（independent）：check run-41ef865d2079 结论 pass（magpie/auto/glm-5.3-flash），独立复跑 npm test 323/323 全绿、pack:check 通过、rex 测试 12/12，与 Pi 1.5 公开文档及本机 rex CLI 交叉核对扩展事件/ctx API/CLI 参数实有。检查发现 3 项轻微问题：①test/rex.test.mjs「兑底」错别字（应为兜底，仅文案）②launcher 未用 bridge subscribe 通道（状态依赖 state.json+rex events，功能等效，冗余协议面）③terminal.process 不在本机 74 方法清单（代码已按可选处理，与研究一致）。①②留作交付后独立小修候选，不阻塞。

真机验收（macOS+Rex+Pi 真实浮层交互）按任务定义与用户既定决策维持延期：本机 Linux 无 GUI Rex 客户端，浮层 UI 行为仅单元级验证；关闭后该部分记 blocked，不宣称完整通过。

### 交付记录

<!-- knit:delivery:op-d63f792e3c33 -->
- 操作: op-d63f792e3c33
- 时间: 2026-11-03T19:50:04.217Z
- 分支: refs/heads/main
- 授权来源: user:2026-11-03-message-full-authorization
- 工作提交: aa14572bb8e13ac1915dd1756c3c46bf7c569bc3
- 结果: 正常交付；检查 run-41ef865d2079 通过
- 归档目标: .knit/tasks/archive/2026-11/11-03-rex-interactive-pi-worker

<!-- knit:progress:end -->
