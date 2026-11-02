# 元数据存储实证比较（任务004）

结果：通过，选定 SQLite 为唯一生产元数据权威。验证日期 2026-11-01；Node v24.21.0（内置 `node:sqlite`，无 ExperimentalWarning），pi 未参与本实验。此为隔离夹具与验证报告，不是 Knit 产品实现的产品级文档。

## 选型结论

- 生产实现：`src/infrastructure/sqlite-metadata-store.ts`（实现 002 的 `MetadataStore` 端口），单文件库 + WAL，sessions/bindings/operations 三表记录 JSON 正文，`BEGIN IMMEDIATE` 短事务覆盖关联更新。
- 文件版实现仅保留在本目录 [fixture/file-store.mjs](fixture/file-store.mjs) 作比较夹具，不参与产品、不双写。
- 选型理由：同路径 8 场景比较中，SQLite 以内置模块满足全部真实写路径，且故障恢复显著更简单——文件方案持有者崩溃后需根级锁过期接管（本夹具实测须等待过期窗口），SQLite 写锁随进程死亡即时释放、WAL 自动恢复；不引入外部驱动或 ORM。

## node:sqlite 能力核实（Node v24.21.0 实测）

| 能力 | 结果 |
| --- | --- |
| 稳定性 | 加载无 ExperimentalWarning |
| WAL | `PRAGMA journal_mode=WAL` 生效（`:memory:` 下显示 memory 属预期） |
| 事务 | BEGIN IMMEDIATE / COMMIT / ROLLBACK 正常；崩溃（SIGKILL / exit）后未提交数据回滚、库可重开 |
| 并发 | 第二连接写竞争在 busy timeout 内等待；超时报 `ERR_SQLITE_ERROR database is locked`，不静默 |
| 只读 | `readOnly: true` 可读，写入报 `attempt to write a readonly database` |
| 打包 | 编译产物进 dist，零新增 npm 依赖；pack 白名单检查通过 |

## 同路径比较（共享场景脚本对两实现各执行一遍）

夹具：[fixture/](fixture/)；共享场景 [fixture/scenarios.mjs](fixture/scenarios.mjs)，驱动 [fixture/run-comparison.mjs](fixture/run-comparison.mjs)。两实现共用同一契约套件、同一校验器（src/contracts 真实 schema）与同一对手进程注入方式。

| 场景 | 文件版 | SQLite 版 |
| --- | --- | --- |
| 关联写入（Session/binding/operation 同事务）+ 重复接收不多计 | PASS | PASS |
| 两进程竞争同一 binding 乐观版本（拒绝方重读重试） | PASS | PASS |
| 取消／完成竞争（恰好一方裁定终态） | PASS | PASS |
| Git 回执丢失（意图先落盘、恢复补记一次、不重复执行） | PASS | PASS |
| 只读查询目录快照不变 | PASS | PASS |
| 崩溃后恢复可收敛 | PASS | PASS |
| schema 合法／非法双向校验 | PASS | PASS |
| 原生条目范围登记与读取（可空端点） | PASS | PASS |

实测时长：file 3058ms / sqlite 986ms（性能只作辅助，不作选型依据）。

## 产品级验证（test/metadata.test.mjs，6/6 通过）

生产 `SqliteMetadataStore` 以 dist 产物实测：关联事务同提交同回滚、幂等追加不重复计数、两进程各 20 次并发追加得到 40 条且无丢失/重复、SIGKILL 未提交事务回滚后可写、busy 冲突如实报错且释放后可写、连续只读后主库与 WAL 字节不变。

## 范围与边界

- 本实验不含 run 证据、快照、Task Markdown、Git 与原生历史；它们按各自路径核验，不入库。
- 版本列（乐观检查）是本次比较专用附加结构；产品 binding 投影按 DESIGN 6/7 节实现时再定稿。
- 夹具锁的过期窗口在测试中调短（`KNIT_FIXTURE_LOCK_STALE_MS`）；默认 15s 只属于文件夹具，不代表产品行为。
