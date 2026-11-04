---
id: k-094319db2793
status: open
phase: deliver
outcome: null
branch: refs/heads/master
verification: independent
parent: null
priority: P2
dependsOn: []
order: 10
createdAt: 2026-11-04T20:54:52.485Z
title: 金额格式化命令
---

需求：新增 `bin/amount.js`，命令行接受一个数字参数，输出带千分位、两位小数的金额（例如 1234.5 → `1,234.50`）。非数字或缺参数时报错并以非零退出码结束；项目规则要求所有面向用户的错误信息必须用中文。附最小测试（node --test）覆盖正常值与两类错误。实现只改必要文件，不提交 Git。

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

<!-- knit:progress:end -->
