AGENTS-MARK: 7f3a

## 做了什么

- 修改 `greet.mjs`：函数签名改为 `greet(name, word = "hello")`，返回 `` `${word} ${name}` ``；不传 `word` 时默认 `hello`。
- 新增 `greet.test.mjs`：用 `node:test` + `node:assert/strict` 写了两个中文名测试，分别覆盖“不传问候语”和“传了问候语”两个场景。
- 未改动其他文件，未加依赖。

## 验证

运行 `node --test`，退出码 0，输出：

```
✔ 不传问候语时返回 hello (0.413917ms)
✔ 传了问候语时使用自定义问候语 (0.069125ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 127.005042
exit=0
```

- 场景“不传问候语”：`greet("knit") === "hello knit"` — 通过。
- 场景“传了问候语”：`greet("knit", "hi") === "hi knit"` — 通过。

HEAD 仍为 `c59419d366bd1edd058365a6388a94475bfb8739`，未提交、未切分支；`git status` 仅显示 `greet.mjs` 修改和 `greet.test.mjs` 新增（`.knit/tasks/` 是任务自带的未跟踪目录，未触碰）。

## 未验证的内容

无。任务要求的两个场景均已实际运行验证。