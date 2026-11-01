# Knit 技术选型

本文件记录首版技术决定与取舍，配合 [架构](ARCHITECTURE.md)、[状态契约](STATES.md) 和 [产品范围](DESIGN.md#151-首版闭环)。当前未初始化工程或安装这些项目依赖；版本事实与来源见 [技术核查](RESEARCH.md#1712-技术约束核查)。

## 1. 选择结果

| 层面 | 首版选择 | 原因与约束 |
| --- | --- | --- |
| 运行时 | Node.js 24 LTS 的维护补丁版 | 稳定长期基线，满足 Pi SDK Node >=22.19；M0 固定具体补丁，Node 25 本机实验不算该基线验收 |
| 语言与模块 | TypeScript 6.0.3，strict，ESM／NodeNext | 与当前 TypeBox 1.x 类型约束对齐；领域与协议可静态穷尽检查 |
| 打包形态 | 单 npm 包，bin 为 knit，CLI 与 worker 两个内部入口 | 不拆多包、守护进程或服务；运行所需代码随自身安装 |
| 构建 | tsc 输出 JS 和声明，模板作为包资源 | 不打包 Pi SDK，保留原生／可选依赖与运行时解析；不要求用户项目装编译器 |
| 包管理 | npm + package-lock，CI 用 npm ci | 单包足够，锁定可复现依赖，不增加 workspace 管理工具 |
| CLI | Commander 15.0.0 | 子命令、参数、help 和错误输出复用成熟实现；不自行写整套参数解析器 |
| 协议／schema | typebox 1.3.27 | 与选定 Pi SDK 一致；同源类型、JSON schema 和运行时校验，不混入 0.34.x 的旧 API |
| Markdown 数据 | YAML 2.9.0 Document + 受管区解析 | 保留未知业务字段与注释；只编辑明确区域，不引整套 Markdown 渲染框架 |
| 本机存储 | M0 对比文件仓储与 SQLite 后选一种 | 重点比较 Session/binding/operation 的事务与恢复成本；Markdown、原生历史与大产物仍按各自边界保存 |
| 状态实现 | 判别联合、纯决定函数、显式效果执行器 | 以持久事实为准；文档状态表与转移测试逐项对应 |
| Git | 原生 Git CLI，argv，不经 shell 拼接路径 | 保留 index、hook、过滤器和真实树语义；不使用 JS 重实现 Git |
| Pi 阶段执行 | @earendil-works/pi-coding-agent 1.4.0 | 已核查公开 SDK 与可取得的发布包；精确依赖，不从全局安装目录导入 SDK |
| 进程／文件 | Node child_process、fs、crypto、os | 集中封装、可替换；原子写、进程身份与锁规则见下文 |
| 测试 | node:test、node:assert/strict、fake runtime、临时仓库 | 通过端口注入时钟／进程／故障，不依赖真实模型或全局模块 mock |
| 支持目标 | 首版完整写入验收为 macOS 与 Linux | 进程组、身份和本地文件系统分别验证；其他平台未验证不宣称具备写入保护 |

SDK 与 schema 采用上述精确版本，其他直接依赖在 M0 建立 lockfile 时固定补丁。升级先跑契约与原生恢复测试，不盲随 latest。SDK 主会话／阶段记录兼容性以实际验证为准，不能仅凭同一主版本推定。

## 2. 替代方案与待验证选择

| 备选 | 取舍 |
| --- | --- |
| SQLite／文件仓储 | 不提前排除 SQLite；内部关联数据可用短事务减少恢复分支，Git／Markdown 外部效果仍需日志。M0 以真实写路径比较，ORM 不在首版 |
| XState 等状态机运行时 | 能表达状态图，但本版用持久文件、纯规则和效果日志即可满足；避免同时维护解释器实例和磁盘状态。不是否定该工具能力 |
| Bun/Deno | Pi 依赖 Node 生态和公开接口，首版不引入第二运行时兼容矩阵 |
| bundler／单文件二进制 | SDK 有可选原生依赖和动态资源，首版不用打包优化改变其解析语义 |
| HTTP/RPC 服务、Web/TUI 前端 | 日常界面已有 Pi；短 CLI 与独立 worker 足够，不增加端口和服务生命周期 |
| 公共插件 SDK／动态模块安装 | 需求是内部可替换模块，额外协议和授信平台无首版价值 |
| Vitest/Vite 测试栈 | 可以使用，但 Node runner 加注入端口已能覆盖本项目，不为测试再维护构建框架 |
| 通用 Markdown AST | 目前只需 YAML、明确记录区和受管入口；将来需要复杂结构变换再增加解析器 |

## 3. 类型、校验与错误

领域类型使用判别联合并穷尽匹配。命令／文件先由同源 schema 检验，再进入状态守卫，不能把 TypeScript 编译通过当作外部 JSON 已可信。

使用 typebox 包的锁定版本导出，M0 验证 Compile 与 JSON 序列化 schema；不照抄旧 @sinclair/typebox 0.34 或未来文档的子路径。桥接内嵌同源 JSON schema，仅用宿主公开类型／基础 API，不解析用户项目 node_modules 中的 Knit 依赖。核心重新校验，不能只信任原生工具验证。

配置 schema 拒绝未知执行选项和任意代码路径；Task 允许已约定的扩展业务字段，但不允许重复 YAML 键、自定义可执行标签或不受限别名展开。解析错误时只读报告，不能写回损坏文档。保留原有正文／注释是目标，不能声称 YAML 重序列化可做到字节完全不变。

JSON 协议区分 invalid_request、incompatible_version、busy、needs_context、stale_input、needs_review、unknown_run、external_effect_unknown、io_error 等原因。outcome 与 reasonCode 分离；退出码不是阶段或任务完成证明。

## 4. 文件、占用与日志

以下原子写规则用于项目文件、运行产物和文件仓储候选；SQLite 若入选由数据库事务提交内部元数据，不额外伪装成分文件写入。

受控写入采用锁内读取预期版本、准备新内容、写临时文件、同步文件、原子 rename、同步目录，再记录核验结果。临时内容在本机私有 runtime 中，同文件系统才发布；跨文件系统不降级为无保护 copy。源码工具的普通写入不因此获得原子保证，由快照和阶段核实覆盖。

原子 rename 仅解决单文件可见性，多文件一致性由操作意图和恢复检查点解决。原文件既非 before 也非 after 时停止；不能用重新渲染覆盖后来输入。记录区写入使用稳定 Task 键短锁，输入／代码／Git 用执行占用。锁目录要求本地文件系统。

文件字节 SHA-256 用于冲突／快照；版本化业务摘要区分输入与记录。clarify/change 由主 Agent 声明，不做 NLP 判定。开发诊断标志、耗时与事件不纳业务摘要。Git 内容用其树／blob OID 核实，不拿工作区 CRLF 字节冒充 Git 树。

JSONL 仅作脱敏进度，尾部半行可忽略，不当作权威状态。完整对话和工具原文留在原生 Session，避免复制成第二套聊天日志。机器路径、请求和快照保持私有权限，Git 只收项目资料与生成桥接。

## 5. Git 与进程适配

以 Git 2.30+ 的已有基础命令为目标，M0 验证所用选项，当前仅在本机 Git 2.54.0 做过部分行为实验。命令统一使用参数数组、项目 cwd、固定必要环境，解析 NUL 分隔结果；不从分支名或文件路径拼 shell 字符串。不会因最低目标声明而声称旧版本全测试通过。

保留项目 hook，不默认 --no-verify。准备目标路径／树后提交并核实真实结果；hook 改变内容、额外路径或用户 index 时记录真实效果并进入 needs_attention，不自动 amend/reset。诊断禁用外部 diff/textconv、pager 与 fsmonitor hook。

local 使用独立 worker 与可追踪的进程组；观察命令结束不杀 worker。进程身份含机器／启动标识、PID 开始时间和本次实例信息，旧 PID 不足以判断存活。用公开 BashOperations 包装受控 shell，持续记录工具开始／结束与 PGID，取消后等待实际终态。无法证明旧工具结束就不能重启写入阶段。

实际进程不匹配或网络盘条件不足时只读诊断并给出恢复入口，不隐藏降低保护。Knit 不提供系统沙箱，也不承诺回滚数据库、远程服务或自行 daemonize 的进程。

Pi 阶段以公开 prompt 完成／agent_settled 及工具终态为稳定边界，不能在 SDK 自动重试之间的 agent_end 就发布结果。工具追踪使用 toolCallId 和隔离的异步上下文（可用 Node AsyncLocalStorage），不能用全局 currentTool 指针混淆并行调用。

## 6. 构建与交付验证

预期工程命令为 typecheck、build、test、pack 检查，在建立 package.json 时落实；当前仓库没有这些脚本，不能提前宣称已运行。

- M0 在 Node24 验证 SDK/schema、原生落盘边界及存储候选；无模型的真实元数据写路径对比完成后才定物理布局。
- M1 用同一模块契约、fake 和临时仓库跑闭环，包含基本本地包安装、--dev 输出等价测试及真实 Pi 冒烟。fake 仅测试装配，不是生产配置值。
- M2 注入进程中断、磁盘／原子写失败、取消、hook 与 index 冲突，断言恢复不重复副作用。
- M3A 补日常 adopt、会话树、提醒、升级和查询；M3B 做平台、安装升级矩阵及发布回归。关键取消／恢复／数据故障仍归 M2，不推到发布末期。
- npm pack 检查包含编译入口、模板和协议资源，排除测试私有资料、原生历史与运行目录；在临时项目执行 init/start/CLI 的安装冒烟。

CI 规划 macOS/Linux、Node24 同补丁组合，M1 要求完成基本打包安装，M3B 完成发布矩阵。Node26 为后续兼容验证，本机 Node25 不能替代 LTS 验收。

## 7. 已核查与未验证

已核查发布包元数据、公共类型与源码：Pi SDK 1.4.0 的 ESM、Node 要求、TypeBox、sendMessage、registerTool、createBashTool/BashOperations；查询 TypeScript 6.0.3 与 SDK 发布版本。无模型的小实验确认 TypeBox 1.3.27 可以校验 JSON 往返后的 schema、拒绝错误动作和额外字段。

本机 Node 为 25.5.0，该实验不证明 Node24 上完整 SDK／进程／桥接链路已通过。TS 编译、打包、SDK 恢复和所有真实运行保护仍须按里程碑完成。工具存在与接口类型可用，不等于 Knit 已实现。

## 8. M0 存储对比与开发诊断

采用同一小型仓储契约和临时数据，对原子文件实现与 SQLite 实现执行相同脚本，不写两套完整产品。SQLite 先核实 Node24 内置 node:sqlite 的公开 API／稳定性、事务与锁行为；若不满足再评估驱动的安装成本，不引 ORM。此实验尚未执行。

| 真实写路径 | 验证重点 |
| --- | --- |
| 接收检查结果 | 同时更新 Session 关联、binding 最新检查／范围和修复计数、operation 完成信息，重复接收不多计 |
| 两进程竞争与取消完成 | 短事务／CAS、owner token、忙冲突、终态只裁定一次，不持事务等模型／工具 |
| Git 成功后元数据未完成 | 临时 Git 提交后中断，核实实际 OID 和 Task 文件再恢复，不重复 commit |
| 纯只读查询 | 不触发模型、项目脚本、修复或开发日志落盘 |

记录实现与恢复分支的复杂度、原子性、诊断可读性、跨进程失败处理、安装维护成本；性能只作辅助。若 SQLite 显著减少复杂度且满足平台与只读要求就采用，否则保文件方案并记录理由。M0 结束必须定一个生产实现，不能把双写方案推给后续。

两种方案复用 --dev 的稳定 stepKey、reasonCode、摘要和 I/O／事务统计，比较前去掉时间、随机 ID 和 token 指纹。诊断只观察，不注入模型或参与业务守卫；私有 JSONL 不作第二套状态库，格式见 [OPERATIONS](OPERATIONS.md#6-开发者模式)。
