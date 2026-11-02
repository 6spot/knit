# 任务021 分支接管、树选择与多会话观察验证

环境：Node v24.21.0、Git 2.52.0、临时真实 Git 仓库与真实 Pi 原生 JSONL 夹具；未调用真实付费模型，未操作当前工程产品状态。

## 覆盖

- `tests/task-adopt.txt`：分支从 `other` 改绑到当前 `main`；discuss／implement 保持，deliver 回 check；旧 `lastCheckRunId` 失效但历史检查文件保留；活动 run 与未核实交付操作拒绝 adopt 且不写 Task。
- `tests/cli-adopt.txt`：真实 CLI `task adopt --branch current`，分支改绑、旧检查失效字段和 Task 文件事实。
- `tests/session-selection.txt`：`task use/clear` 未落盘不生效、清除不复活；原生分支路径切换后旧选择不复活；选择分支与当前分支不一致时返回 `branch_changed`，`task use` 拒绝改绑。
- 桥接模板断言包含 `notice_skipped_branch`：观察通知携带 run 发起分支，分支变化时不把旧 run 结果投到当前上下文；通知去重与忙时 `followUp` 仍由既有测试覆盖。
- `status --run` 投影新增 `branch`，来自冻结请求而非当前默认分支。

## 命令与结果

```text
node --test --test-name-pattern "task adopt" test/task.test.mjs      2/2 pass
node --test --test-name-pattern "task adopt" test/m1-cli.test.mjs   1/1 pass
node --test --test-name-pattern "选择分支与当前分支|task use/clear" test/session.test.mjs  2/2 pass
npm test                                                             197/197 pass
```

## 边界

未新增完整树可视化命令、共享任务库或持久观察者状态机；fork 关系仍由原生 `parentSession` 与 Session 索引的既有接口承接，不自动把父会话历史复制到新树。真实 Pi reload／多会话通知沿用 015 的真实桥接证据，本项只补分支防误投与静态模板核对。
