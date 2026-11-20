报告

## 做了哪些事

1. 在仓库根目录运行 `sleep 120` 并等它结束（07:53:09 开始，07:55:09 结束，未缩短等待）。
2. 新建 `drill-mid.txt`，内容只有一行 `mid`。

改动文件（取自 `git status --short`）：

```
?? drill-mid.txt
```

只新增了 `/Users/me/.knit/worktrees/knit-058bcf1b/11-21-drill-mid/drill-mid.txt`，其它文件未动。

## 场景验证

### Scenario: 查看文件

运行过的命令与输出：

```
$ cat drill-mid.txt
mid
---
$ git status --short
?? drill-mid.txt
$ git rev-parse --short HEAD
215593a
```

结果：`cat drill-mid.txt` 输出 `mid`，与完成条件一致。文件是新增的未跟踪文件，HEAD 仍为 `215593a`，与执行前一致。

## 未验证 / 说明

- 按要求没有跑测试、没有提交、没有切换或新建分支。
- 没有等待之外的可疑点；任务本身没有待澄清项。