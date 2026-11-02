# 任务024 开发者模式与 M3A 日常接续验收

环境：Node v24.21.0、Git 2.52.0、Pi 1.4.0；真实临时 Git 项目与真实原生会话；未修改当前工程产品状态。

## 开发诊断

- CLI `--dev` 仍输出白名单 JSON 到 stderr；写命令额外生成 `.knit/.runtime/diagnostics/<command>/<pid>-<time>.jsonl`（目录 0700、文件 0600），只写 stepKey／事件／ID／耗时／计数，不写正文、提示词、工具原文或凭据。
- 只读命令（`status`、`doctor`、`storage`、`init`、`list`、`history`、`resolve`、`show`）即使 `--dev` 也不建诊断目录。
- 日志写失败只忽略诊断，不吞业务错误；日志可删除，不参与回执或恢复。
- 桥接 `/knit dev on|off` 仅当前原生会话生效；`reload`／fork 默认关闭。CLI `--dev` 仅本次进程及其 worker，不继承会话开关。
- `--dev` 与普通调用的业务投影 deepEqual；不增加模型轮次或工具调用。

测试：`tests/dev-channel.txt`（2/2 pass，含私有 JSONL 权限、只读不建目录、业务投影等价）。

## M3A 联合验收

- adopt：`validation/m3a-adopt-tree/`，分支改绑、旧检查失效、活动 run／未核实 Git 拒绝、选择分支防误投。
- 树／多会话：原生有效路径选择与 `branch_changed`；桥接通知按发起分支过滤，observer guard 防 reload 重复计时器。
- 升级：`validation/m3a-init-upgrade/`，旧基线升级、人工冲突保留、版本降级拒绝、安装映射重写、真实 `/knit-reload` + `knit_status`。
- 查询：`validation/m3a-usage-history/`，原生助手条目去重用量、只读 status／doctor／storage、原生资料与基线统计。
- 全量：`npm test` **200/200**；`typecheck`、`build`、`pack:check` 通过。

## 边界

- 未做全事件矩阵或网络 debug；私有日志只保留白名单字段。
- 真实 Pi `/knit dev on/off` 的会话开关未重跑长模型链路；其命令入口与作用域由模板静态断言覆盖，真实 reload 已在 022 验证。
- 日志容量按每次调用独立片段增长，未实现自动轮换／gc；删除日志不影响恢复。
