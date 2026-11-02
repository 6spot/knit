# 任务017 占用、取消与中断安全验证

环境：Node v24.21.0、Pi 1.4.0、模型 `magpie/auto/glm-5.3-flash`。真实项目夹具 `/tmp/knit-017-real`（临时 Git 仓库，未纳入当前工作区）；未提交、推送或初始化当前 Knit 工程的产品状态。

## 真实取消（`real-cancel/`）

1. 任务 `k-e9f828073a4a` 的输入要求模型通过 bash 执行 `sleep 120`；真实 Pi 子会话发起了该工具调用。
2. 观察到进程组：Pi `955649`，工具 `/bin/bash` `955713`（自建进程组），`sleep 120` `955715`。
3. 执行 `knit cancel --run <run> --terminate`，JSON 返回 `terminated:true`，耗时 567 ms；随后 `status` 为 `cancelled`，`result.state=cancelled`、`failureReason=agent_aborted`，`stage-process.state=exited`。
4. `process-after.txt` 确认 Pi、bash、sleep 均无残留；没有只凭 RPC ack 假报完成。
5. 事件、取消回执、状态、结果和进程表分别在 `cancel.json`、`status.json`、`result.json`、`events.jsonl`、`process-before.txt`、`process-after.txt`；工具调用原始记录摘录在 `tool-session.txt`。

## 取消后原生恢复（`real-recovery/`）

同一任务更新输入后，用 `run resume <旧 run>` 复用旧原生会话；新 run `run-9834a51dbd67` 完成，结果 `session.resumeAction=resume`、`nativeReadable=true`，实际写入 `done2.txt`。`resume.json`、`status.json`、`result.json` 为回执，`done2.txt` 为实际产物。

## 自动故障夹具（`automated/`）

- `sigkill-worker.txt`：`node --test --test-name-pattern "SIGKILL worker" test/stage.test.mjs`，1/1 通过。测试强杀 worker、确认旧 Pi 仍存活，`resume` 拒绝兜底；清理 Pi 及残留项目／Session 锁后，resume 才生成新 run 并完成。
- `locks-unlock.txt`：`node --test --test-name-pattern "locks/unlock" test/m1-cli.test.mjs`，1/1 通过。验证只读列举、错误 token 拒绝、alive 需 force、旧 token 不删除新占用。

## 边界与未实测项

- 取消宽限默认 5 秒；`--terminate` 处理已核实旧阶段进程树。SIGKILL 夹具用最小假 Pi 模拟不响应 stdin 关闭；真实模型取消见上。
- 未在真实 NFS／SMB 上执行；实现按已知远程文件系统类型阻塞，不做跨机协调。
- 锁异常时保留现场，需显式 `knit unlock --expect-token`；不自动强解未知 owner。
