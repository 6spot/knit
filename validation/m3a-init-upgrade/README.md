# 任务022 初始化升级、安装映射与桥接 reload 验证

环境：Node v24.21.0、Pi 1.4.0、真实临时 Git 项目；真实模型仅用于 `/knit-reload` 后一次 `knit_status` 冒烟（provider `magpie`，model `auto/glm-5.3-flash`）。

## 覆盖

- `tests/init-upgrade.txt`：受管桥接上次基线可升级；人工改写仍 conflict 不覆盖；清单版本高于当前安装包拒绝降级；安装映射旧机器绝对路径由 init 重写。
- `tests/bridge-observer.txt`：桥接 schema 同源与模板 observer guard 断言。
- `tests/init-first.json`：真实 CLI 首次 init。
- `tests/check-old-baseline.json`：把桥接改成旧受管内容、同步清单 baseline 后，`init --check` 识别为可更新。
- `tests/init-upgraded.json`：真实 CLI 升级后桥接恢复当前模板。
- `reload/reload.txt`：当前模板在真实 Pi RPC 中执行 `/knit-reload` 返回 `handled`；原生 Session ID／文件不变，随后 `knit_status` 工具成功返回 `completed`。
- `reload/init.json`：reload 夹具的 init 输出。

## 命令与结果

```text
node --test --test-name-pattern "上次受管基线|安装映射移动" test/init.test.mjs   2/2 pass
node --test --test-name-pattern "桥接 schema" test/m1-cli.test.mjs              1/1 pass
node dist/cli/knit.js init --check --json --dir /tmp/knit-022-e2e              ready（旧基线可更新）
node dist/cli/knit.js init --json --client pi --dir /tmp/knit-022-e2e           ready
npm test                                                                        199/199 pass
```

## 边界

- 真实 reload 验证的是当前模板在当前 Pi 版本上的命令处理与工具续用；未在 Pi 进程内直接计数定时器，observer guard 由模板静态断言与 `session_shutdown`／reload 生命周期实现保证。
- 未安装旧版 Knit 包做跨版本二进制升级矩阵；用清单旧 baseline 模拟受管旧内容。
- 项目资料仍只补缺，不自动合并项目自定义正文；未知来源冲突需显式 `--force`。
