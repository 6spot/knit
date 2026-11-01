# 验证清单

状态“通过”指实际测试已完成；“限制已复现”表示原生行为存在边界，需要后续实现明确处理。“产品待验收”不算本轮 CLI 测试失败。全部模型请求沿本机已选配置，无 SDK 导入或额外安装。

| 编号 | 场景 | 结果 | 直接证据 |
| --- | --- | --- | --- |
| C01 | stdin/stdout RPC 状态、消息、entries、tree 查询 | 通过；零模型请求 | [控制面复测](03-edge-cases/control-repeat.json) |
| C02 | JSONL 中 U+2028/U+2029 会话名 | 通过，按 LF 分帧正常往返 | [原始补测](03-edge-cases/results-attempt1.json) |
| C03 | 非法 RPC 模型、无效 entries 游标 | 拒绝，模型状态保持 | [原始补测](03-edge-cases/results-attempt1.json) |
| C04 | 未知 provider 启动 | 拒绝，退出 1，无模型请求 | [控制面复测](03-edge-cases/control-repeat.json) |
| C05 | 已知 provider 的未登记 model 启动 | 限制已复现：可合成描述符；清单与 set_model 均拒绝 | [模型选择](03-edge-cases/model-selection.json) |
| C06 | 当前配置模型的本地清单／set_model／真实请求 | 通过，无降级 | [模型选择](03-edge-cases/model-selection.json)、[闭环](02-full-loop/report.json) |
| C07 | 不存在的原生会话路径 | 限制已复现：成功但换成空 Session | [控制面复测](03-edge-cases/control-repeat.json) |
| C08 | 无模型答复的空会话持久化 | 原始测试未落盘，不当作可恢复 | [首次控制面](01-control-plane/report.json) |
| C09 | 显式 RPC bash 执行／abort_bash | 通过，已核对受控子进程结束 | [控制面复测](03-edge-cases/control-repeat.json) |
| C10 | idle abort、清队列、stdin EOF | 通过，正常退出 0 | [首次控制面](01-control-plane/report.json)、[控制面复测](03-edge-cases/control-repeat.json) |
| W01 | 实施代码和测试 | 通过 | [实施报告](02-full-loop/implementation-final.txt) |
| W02 | 新会话独立检查实际代码和运行测试 | 通过；3 个测试方法、929 个边界断言 | [检查报告](02-full-loop/check-final.txt)、[工具证据](02-full-loop/analysis.json) |
| W03 | 源码不被检查修改、控制器复跑测试 | 通过 | [原报告](02-full-loop/report.json)、[测试输出](02-full-loop/controller-unittest.txt) |
| W04 | 新进程恢复原实施 Session 且禁工具回忆 | 通过，ID 一致，有真实历史 | [恢复报告](02-full-loop/resume-final.txt) |
| W05 | 模型正在执行工具时 abort | 通过，本次受控 Python 子进程结束 | [修正后补测](03-edge-cases/results-rerun.json) |
| W06 | 活动任务 follow_up 后 clear_queue，再取消 | 通过，已清消息没有被执行 | [修正后补测](03-edge-cases/results-rerun.json) |
| W07 | 正常取消后新进程恢复 | 通过，同一 Session 继续回答 | [修正后补测](03-edge-cases/results-rerun.json) |
| W08 | CLI SIGKILL、检查点和原生记录 | 通过；限制已复现：工具子进程仍存活，核实清理后恢复 | [中断测试](03-edge-cases/results-attempt1.json) |
| W09 | agent_settled 作为稳定结束 | 正常、取消、恢复和 follow-up 均实际等待 | [事件证据](03-edge-cases/events)、[首次事件](02-full-loop/implementation-events.jsonl) |
| R01 | 系统附加约束与模型工具集合 | 原生记录确实包含约束和工具增删；恢复禁工具 | [提示结构证据](03-edge-cases/system-prompt-evidence.json) |
| R02 | 禁止自动上下文／扩展加载 | 原生提示未注入 Knit 根规则，扩展 canary 未加载 | [提示结构证据](03-edge-cases/system-prompt-evidence.json)、[控制面复测](03-edge-cases/control-repeat.json) |
| H01 | 受信项目 `.pi/extensions/*.ts` 自动发现 | 通过；未信任与显式加载的条件不混淆 | [修正后补测](03-edge-cases/results-rerun.json) |
| H02 | 宿主公开 reload API | 通过，v1→v2，零模型调用 | [修正后补测](03-edge-cases/results-rerun.json) |
| H03 | 真实交互 CLI `/reload` | 通过，新版本命令已执行 | [交互报告](03-edge-cases/interactive.json) |
| H04 | RPC 宿主轮外被动投递和主动唤醒 | 通过，被动不启动模型，主动实际启动 | [通知补测](03-edge-cases/results-attempt1.json) |
| H05 | 工具运行中投 follow-up | 通过，原任务答复后处理排队消息 | [通知补测](03-edge-cases/results-attempt1.json) |
| H06 | 投递回调前切换 Session | 通过，当前新会话未收到旧通知；夹具有来源守卫和资源清理 | [通知补测](03-edge-cases/results-attempt1.json) |
| H07 | 真实交互宿主的轮外投递／唤醒 | 通过，真实请求和原生历史均核实 | [交互报告](03-edge-cases/interactive.json) |
| G01 | 代码与归档分别限定路径提交 | 通过，实际 commit 路径已核对 | [提交证据](02-full-loop/analysis.json) |
| G02 | 无关路径同时有 staged 与 unstaged 内容 | 通过，两者保留；归档附差异和 index 内容 | [原报告](02-full-loop/report.json)、[index.diff](02-full-loop/index.diff)、[worktree.diff](02-full-loop/worktree.diff) |
| G03 | pre-commit 拒绝 | HEAD 不变，无关内容保留 | [Git 实验](03-edge-cases/git/results.json) |
| G04 | pre-commit 添加额外路径 | 限制已复现，实际 commit 含额外路径，不能信任 --only 隔离 | [Git 实验](03-edge-cases/git/results.json) |
| G05 | commit 成功后执行进程退出，回执丢失 | 通过，核验 Git 后补检查点，未重复提交 | [Git 实验](03-edge-cases/git/results.json) |
| G06 | archive 移动完成但检查点丢失 | 通过，核验目标后继续，没有二次移动 | [Git 实验](03-edge-cases/git/results.json) |
| U01 | 原始累计统计与增量去重 | 通过，恢复不重复相加 | [首次用量](02-full-loop/analysis.json)、[全部用量](USAGE.json) |
| A01 | 报告／源码／bundle／原生记录归档 | [最终完整性报告](ARCHIVE-CHECK.json)；私有原生记录 Git 忽略 | [文件指纹](MANIFEST.json)、[路径映射](PATHS.json) |

## 当前方式的能力边界

| 边界 | 结论 |
| --- | --- |
| 外部 CLI 附着任意已有交互 Pi | 公开 CLI／RPC 无该入口；不能把 --session 当作附着运行进程 |
| 宿主薄扩展使用公开 API | 本机真实交互模式已验证；这是宿主提供的接口，不是 Knit 引入 SDK 运行时 |
| 任意未知工具／daemon／远端副作用终止 | 未作通用保证，受控 bash 取消结果不能外推 |
| 操作系统沙箱 | CLI 工具清单和提示约束不构成沙箱 |
| 任意外部并发修改 | 不在一次隔离实验中证明；产品实现须检测／阻塞并发 |

## 实现后才有对象可验收的项目

任务状态、输入失效、正式检查资格、规范候选审阅与生效、init 所有权、授权与分支绑定、锁／接管、存储对比、worker 完成到宿主的实际传输和去重协议、Node24 产品打包。当前没有这些 Knit 实现，不以本轮夹具代替产品验收。
