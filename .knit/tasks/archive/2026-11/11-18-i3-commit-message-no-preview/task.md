---
id: k-1e6d12bf7814
title: I3 提交文案不用先给用户看
status: delivered
stage: null
verification: self
parent: k-19c962be9fb8
dependsOn: []
priority: P1
createdAt: 2026-11-18T08:05:55.351Z
---

## 目标与范围

`.knit/standards/delivery.md` 的「授权」一节有一条「提交前把提交文案给用户看一次」。用户 2026-11-18 决定去掉：提交文案不需要人确认，主会话在交付时写好直接提交。提交本身仍然要有用户的授权，这一点不变。

只改一个文件：`.knit/standards/delivery.md`。

- 把「提交前把提交文案给用户看一次。」这一条换成「提交文案由主会话在交付时写好，直接提交，不用先给用户看。」
- 这个文件的其它内容不动。

不能动的：

- 别的规范文件、代码、模板：交付命令和桥接工具本来就不要求把文案给用户看，没有要跟着改的地方（`grep -rn "给用户看" src assets` 没有结果）。

## 完成条件

- `grep -c "给用户看一次" .knit/standards/delivery.md` 输出 `0`。
- `grep -c "直接提交，不用先给用户看" .knit/standards/delivery.md` 输出 `1`。
- `knit standards list` 列出六份规范，`delivery.md` 一行没有告警。

## 待澄清

无。

## 相关资料

- `.knit/standards/delivery.md` — 要改的文件

## 结果

`.knit/standards/delivery.md`「授权」一节的「提交前把提交文案给用户看一次」换成「提交文案由主会话在交付时写好，直接提交，不用先给用户看」，其它内容没有动。三条完成条件都运行过：旧句子 grep 输出 0，新句子输出 1，`knit standards list` 列出六份规范、没有告警。
