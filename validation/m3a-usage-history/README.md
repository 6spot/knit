# 任务023 用量、历史与只读诊断验证

环境：Node v24.21.0、真实 Pi 1.4.0 原生 JSONL（`/tmp/knit-022-reload/project`）；查询不调用模型、不修改原生文件或数据库。

## 覆盖

- `tests/read-only-and-usage.txt`：history 摘要不复制正文、不修改文件；用量按唯一助手条目去重，`input` 含 `cacheRead`／`cacheWrite`；status/doctor/storage 只读且不改变数据库大小；storage 单列原生会话资料。
- `tests/history.json`：真实原生会话用量：2 个助手条目，input 13740（含 cacheRead 7296），output 38，费用 0.00103677322；未知字段不填零。
- `tests/attach.json`、`tests/storage.json`：真实 attach 与 storage 查询。
- `status --run` 人类输出新增用量行；未知 token 显示“未知”，不冒充 0。
- 历史摘要只输出条目类型／时间／引用；不复制 message 正文。

## 命令与结果

```text
node --test --test-name-pattern "history|status/doctor/storage" test/session.test.mjs test/m1-cli.test.mjs  2/2 pass
npm test                                                                                                   199/199 pass
```

## 边界

- 用量按原生助手条目 `id` 去重后求和，不累加会话恢复时的累计 `stats`；未解析原生未知格式，未知成本返回 null。
- storage 的 run 字节已包含快照；原生会话目录单列并计入总量，避免重复相加；不自动 gc。
- 未把原生历史复制成第二聊天库，不修改历史文件；真实活跃历史读取沿用已文档化 JSONL 格式。
