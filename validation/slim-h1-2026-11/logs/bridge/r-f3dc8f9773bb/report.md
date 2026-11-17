AGENTS-MARK: 7f3a

## 做了什么

- `greet.mjs`：函数签名改为 `greet(name, word = "hello")`，返回值改为 `${word} ${name}`；不传 `word` 时行为与原来一致。
- `greet.test.mjs`（新增）：用 `node:test` + `node:assert/strict` 覆盖两个场景，测试名用中文。
- 未改动其他文件，未加依赖，未提交、未切换分支。

## 场景验证

运行 `node --test`（项目无 `package.json`，Node 自动发现 `*.test.mjs`），实际输出：

```
✔ 不传问候语时使用 hello (0.380791ms)
✔ 传了问候语时使用自定义问候语 (0.05725ms)
ℹ tests 2
ℹ suites 0
ℹ pass 2
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 56.074667
```

退出码 `0`，`fail 0` 符合要求。

- **不传问候语**：`greet("knit")` 断言等于 `hello knit`，通过。
- **传了问候语**：`greet("knit", "hi")` 断言等于 `hi knit`，通过。

## 边界与环境

- `git rev-parse HEAD` 为 `e43072f231dba037397a09954a8ce50fbb753eb3`，与开始时一致；`git status` 仅显示 `M greet.mjs`、新增 `greet.test.mjs` 及任务目录 `.knit/tasks/`（非本次创建）。
- 没有未验证的完成条件；需求范围内无待澄清项。