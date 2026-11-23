---
title: 本仓库的提交文案
stages: [deliver]
---

- 用英文写提交文案。首行 `type: summary` 或 `type(scope): summary`，不超过 72 个字符。`type` 用 `feat`、`fix`、`docs`、`chore`、`refactor`、`test` 之一。
- 首行后空一行，再写非空正文，说明做了什么和为什么。
- 正文之后依次写尾注。`Task: <任务 ID>` 必填，有对应内容时再写 `Validation: <运行过的验证和结果>` 和 `Not verified: <没验证的内容>`。Knit 自动添加以 `Knit-` 开头的行。
