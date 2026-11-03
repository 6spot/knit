# 遗留阻塞清理：058／059／060

范围：本地隔离开发检查与修复。真机安装／运行矩阵及真实模型验收依用户要求暂缓；未提交／推送、发布或操作其它项目。

## 058：B004 混合重入锁

- `058-before.log`：新增6项回归在旧实现上5项失败，暴露混合token／心跳版本错误。
- `058-targeted.log`：修复后14项针对性回归全过。
- `058-reentry.json`、`058-consequence.log`：历史47项主探针、8项后果探针全过。
- `058-infrastructure-first.log`：基础设施首轮34/37，三个进程身份／进程树失败保留原始事实，交059继续定位，未当成成功。

逐键凭据只存在运行时句柄，不改变owner文件协议。混合释放与心跳兼容旧单token调用；同实例重入句柄共享成功的心跳版本，外部改写／替换owner仍拒绝。失败回滚保持053语义。独立源码复核未发现058新增确定性回归。

## 059：并行测试与进程失败

| 证据 | 实际结果与用途 |
| --- | --- |
| `059-baseline-full.log` | 默认并行247/261，保留14项原始失败 |
| `059-infrastructure.log` | 39/40，保留外部setsid夹具失败 |
| `059-infrastructure-fixed.log` | 修正夹具后40/40 |
| `059-full-after.log` | 默认并行263/264，保留最后的SIGKILL恢复失败 |
| `059-recovery-targeted.log` | 最后修复后的进程／恢复针对性5/5 |
| `059-full-final.log` | 默认并行265/265，含typecheck与build |
| `059-pack-check.log` | pack:check通过 |

本轮机制及对应修复：

1. worker先发布completed，finally才释放锁。测试把业务终态误当退出，紧接着close碰到lock_busy。等待条件增加实际worker退出，并用IPC门控固定“已发布但仍持锁”的窗口；未扩大既有15秒截止或降低默认并行度。
2. ps回退以固定25字符读取lstart，且缺少固定语言环境，漏读日期列／进程树。纯解析器适配日期空白，调用ps固定LC_ALL=C，保留兼容的身份表示。
3. worker和协调器使用不同的非Linux启动标识，旧Pi已退出仍被判unknown。统一身份来源；无启动身份时仅ESRCH可确认PID不存在，防止缺少/proc被误当死亡。
4. NodeProcessPort.wait轮询/proc并返回伪造退出码，现于spawn时缓存exit/error，返回真实退出码并支持重复等待。
5. 夹具不再依赖/var与/private/var别名、外部setsid或/proc存在性。临时项目根规范化，进程树使用Node夹具，存活检查只将ESRCH视为死亡。

新建四项进程／门控回归。历史未保留详细诊断的其它超时不逐一推定根因；以后新失败仍按B002已确认口径调查，不能凭重跑转绿放行。

## 060：必需资料与任务资料index保护

- `060-before.log`：四项初始回归中三项失败，分别复现必需加载被跳过、plan漏报任务资料暂存，以及hook拒绝后index的A被工作区B覆盖。
- `060-targeted.log`：第一版资料／closeout／delivery回归通过。
- `060-targeted-final.log`：加入操作检查点重试及新增部分暂存保护后46/46。
- `060-full.log`：对应版本默认并行271/271；`060-pack-check.log`对应打包通过。
- 独立复核随后发现删除检查点后重建文件属于untracked、未被git diff报告；不将前述通过当作该遗漏已解决。
- `060-deletion-before.log`：普通文件与悬空符号链接两项回归均在修复前失败。
- `060-targeted-deletion-fixed.log`：补lstat检查后相关48/48。
- `060-full-final.log`：最后代码默认并行273/273，0失败／0跳过，包含typecheck与build；`.exit`为0。`060-pack-check-final.log`记录同一最终代码的pack:check通过。

必需资料读取失败明确返回io_error、sourceId与path；可选背景仍可省略。交付计划新增stagedMetadata，服务取得占用后在创建操作及修改Task前复核，提交步骤再次检查，未知用户暂存直接停止。重试只有在HEAD、路径、index blob均匹配未完成操作检查点且工作区没有新部分暂存时才可继续；已暂存删除又重建文件（包括悬空链接）也停止。相关测试验证index、HEAD、Task及操作记录，并保留正常hook失败重试能力。

独立审查的实际发现、修复复核与执行边界见[independent-review.md](independent-review.md)。打包日志、全量失败记录均保留，不覆盖旧失败。

最终静态核对：10份新增／修改Markdown的本地链接无缺失，git diff --check通过。Git index保持空，HEAD仍为8d721bba1c0a7425a095efd441b256496e5b0eec，临时审查Agent配置已清理；本轮改动保持未提交。
