# 007 实现文件、占用与操作检查点基础

- 里程碑：M1
- 执行角色：实现 Agent
- 顺序参考（非硬依赖）：[006 实现纯领域状态与检查资格](006-domain-rules.md)
- 实际依赖：[002](002-contracts-and-ports.md)、[004](004-metadata-storage-decision.md)。

依赖按具体产物／接口核对，不要求前一编号或所列任务整项completed。缺实现时按明确暂定接口做独立部分；仍缺真实验证就blocked，不拦其它任务。 仓储未定不妨碍独立文件／路径／锁实现，不得暗选或双写后端。
- 唯一状态入口：[TASKS.md](../TASKS.md)

## 目标

提供后续用例使用的真实副作用基础，沿004选定仓储实现。

## 先读

先遵守根 [AGENTS.md](../../../AGENTS.md) 和 [TASKS.md](../TASKS.md)，再按需读取以下指定小节；不必把九份设计全文灌入上下文。

- [OPERATIONS.md](../../design/OPERATIONS.md)：第2–3节：锁、快照与恢复原则。
- [ARCHITECTURE.md](../../design/ARCHITECTURE.md)：第6–7、9节。
- [TECHNOLOGY.md](../../design/TECHNOLOGY.md)：第4–5节。

## 实施范围

- 实现路径规范化、身份／指纹、预期版本下原子发布、私有权限及必要文件操作。
- 实现同机共享锁根、项目键与原生ID键、固定锁顺序、owner token、进程开始时间与心跳；只读查询不建目录。
- 实现操作意图→真实效果→核验→检查点的基础重入协议；不持短锁等待模型或hook。
- 复用004仓储，CLI／worker固定装配；增加必要POSIX进程与Git argv基础，不自建进程接管平台。

## 交付物

- 可复用的infrastructure及必要操作服务
- 受控文件／锁／版本冲突验证

## 完成前必须验证

- 原子发布失败／版本变化不覆盖后来内容；多个锁失败按token释放本次锁。
- 同Session跨项目冲突、新会话锁顺序、PID复用／身份未知与只读无副作用有证据。
- 在下方写明实际命令、环境、结果与证据位置；未执行项如实写明。必需验证未过不能将本项标 completed。

## 边界

- 不因心跳超时强解，不宣称跨机／网络盘锁。
- 保留现有工作区和前置任务记录；不自动提交／推送当前仓库，不操作其它真实仓库，不初始化当前工程的产品 .knit/ 或 .pi/。
- 本文件是开发排程，不是Knit产品Task；文件任务不预定产品元数据后端。

## 阻塞时的伪代码交接

遇阻塞先保留已做工作，按 [BLOCKERS.md](../BLOCKERS.md) 记录后继续其它可做任务。未定部分可写伪代码／暂定接口供下游开发，但不能当真实实现或验收成功。

- 关联阻塞编号：无；发生后引用真实编号。
- 未实现部分与影响：尚无记录。
- 暂定输入／输出／错误边界：需要时据实填写。
- 伪代码与关键步骤：需要时填写，明确哪些只是设计。
- 解除阻塞后补做与真实验证：需要时填写。
- 使用该暂定接口的下游任务：需要时记录，便于后续回补。

## 执行记录

以下是事实记录，不另存一份任务状态；状态只改根 TASKS.md。

- 执行者／Session：ZCode（Pi session 01a1981c-6f75-749d-b9c2-7e5c897950a6）。
- 开始／结束时间：2026-11-01。
- 实际修改：新增 src/infrastructure/{errors,paths,fingerprint,atomic,locks,process,operations}.ts；新增 test/infrastructure.test.mjs；TASKS.md 007 状态。复用 004 仓储未改动（本任务无新增元数据字段需求，锁 owner 走文件非 SQLite）。
- 实际验证命令与结果：`npm test` 76/76（infrastructure 18 + domain 23 + contracts 17 + cli 5 + pi-runtime 12 + metadata 6）；`npm run pack:check` 通过；`node --test test/infrastructure.test.mjs` 18/18。全部验证为真实文件系统／真实子进程／真实 Git 仓库夹具（无 mock fs）：
  - 原子发布：预期版本不符抛 version_conflict 且后来内容保留；expectedSha256:null 建新文件遇已存在拒绝；rename 失败时临时清理、原文件保留、无 .knit-tmp 残留；文件 0600、逐段建目录 0700（recursive:true 的中间目录 mode 不可靠，已实测改为逐段创建）。
  - 锁：mkdir 抢占互斥（第二持有者 lock_busy）；多键中第二键失败时本次已取得的第一键按 token 释放、对手锁不受影响；只读 inspect 不建目录；owner.json 含协议/token/动作/boot_id/PID/starttime/心跳，心跳原子更新并在 owner 被外部改写时 version_conflict 拒绝；错误 token 不能心跳也不能释放他人锁；PID 复用由 /proc starttime 识别 not_alive，跨机 boot id 或损坏 owner 判 unknown 不冒充死亡；同 Session 跨项目共享 session 锁键（不同项目键仍冲突）；固定顺序 project→session、同类按 rawKey。
  - 路径：normalizeRoot 别名归同根；safeJoin 拒绝绝对路径／.. 越界／NUL／经父级符号链接逃逸；目录内等价改名不拒。
  - Git：argv 传参（含引号与 $VAR 的消息原文保留）、固定环境禁 pager、非零退出与 stderr 如实返回、缺失可执行返回 -1 不抛。
  - 进程：真实子进程 spawn/stdout 读尽/wait/killProcessGroup(SIGTERM) 后 /proc 确认终止；procStartTicks 为数字串、不存在进程返回 null。
  - 操作检查点（纯函数）：意图 planned→running→步骤核验（after 匹配 completed）→全步骤完成收束 completed；after 不匹配保留现场 needs_attention 不盲试；running 有未知效果不得 abandoned，明确撤回且无未知效果才 abandoned；completed/abandoned 不改回 running；已完成步骤幂等重入返回既有证据不重执行；幂等键定位。
- 实施中纠正的事实：mkdirSync recursive:true 中间目录 mode 未按 0700 落盘（实测 755）→ 改逐段创建；safeJoin 新文件分支曾丢相对尾段（返回根/文件名而非根/子目录/文件名）→ 用 relative(existing,target) 重建；心跳首版用 readWithVersion 自取当前指纹致永远自洽 → AcquiredLock 增加 ownerVersions（获取时版本），心跳前比对检测外部改写；进程参数名 relative 遮蔽 node:path 导入 → 重命名 relativePath；测试文件 readdirSync 漏导入。
- 未解决问题／决定：无阻塞。worker 心跳循环、快照 preparing/ready/failed 落盘与 Git 快照对象属 012（快照准备、local 启动与 worker 认领），本任务提供基础件不预设其实现；锁 owner 无跨机能力，不宣称网络盘互斥。
- 对下一项的交接：008 init 可用 atomicWrite/paths/fingerprint 做安装映射与所有权登记；012 快照用 listFiles/fileFacts 与 GitPort；锁调用方用 orderKeys 排序后传入 acquire，释放用返回的 AcquiredLock；LockManager 根可注入（测试用 mkdtemp），生产默认 ~/.knit/locks。

优先扫描下一编号（阻塞时可继续跳过）：[008 实现init与项目受管资料所有权](008-project-initialization.md)。
