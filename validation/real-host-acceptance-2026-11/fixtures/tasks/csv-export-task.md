---
id: k-0aaa6a6779ac
status: closed
phase: deliver
outcome: completed
branch: refs/heads/master
verification: self
createdAt: 2026-11-04T20:38:47.296Z
title: 数据库记录导出 CSV 命令
---

## 目标

在本仓库从零新建一个 Node.js + SQLite 的小型 CLI，提供 `export-csv` 命令，把 SQLite 数据库中指定表的记录导出为 CSV 文件。样本表为 `records`。

## 已确认决定（2026-11-04，用户授权实施）

- 载体选 B：本仓库从零起小工具；运行时 Node.js；数据库 SQLite；样本表 `records`
- 命令形态：`export-csv --table=<表名> --output=<文件路径>`
- 记录范围：默认导出全表；`--where` 支持简单条件过滤；不做分页
- 写入方式：游标流式写入，不把整表读入内存
- CSV 格式：UTF-8、不带 BOM、RFC 4180 引号转义、首行表头
- `--bom`：输出 UTF-8 BOM（供 Excel）
- NULL：默认输出空字段（不加引号）；`--null-as <文本>` 覆盖
- 输出文件已存在：默认报错并以非零状态退出；`--force` 才覆盖
- 敏感字段：`--exclude <列名>` 显式排除，可重复；不做自动脱敏
- 用户可见错误信息全部中文，遵循 `.knit/standards/user-facing-messages.md`

## 完成条件

1. `npm test`（node --test）全部通过，覆盖：表头生成、引号/逗号/换行转义、NULL 默认与 `--null-as`、`--bom`、`--force` 与已存在报错、`--where` 过滤、`--exclude` 排除列、空表仅输出表头
2. 在样本 `records` 表上实际执行一次导出，产物 CSV 的行数、表头与单元格内容与库中数据一致
3. 全部用户可见错误信息为中文且不含无中文解释的英文句子，至少覆盖：缺少必需参数、表不存在、输出已存在、数据库打开失败
4. 退出码正确：成功为 0，参数错误/IO 错误/数据库错误为非 0

## 明确不做

- 不 git commit、不 git push
- 不做界面、不做分页、不做自动脱敏
- 不修改 `.knit/` 下任何文件

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

## 当前位置

实施完成，主会话已按 `self` 验证要求核对完成条件，任务处于交付阶段。未提交、未推送。

## 关键经过

- 用户选定载体 B（本仓库 Node.js + SQLite 小 CLI，样本表 `records`），并按草案默认方案授权实施。
- 首次派发 run-05def4634ab6 失败：`rex_start_failed:rex_launcher_error`。根因是项目内 `.pi/extensions/knit.ts` 写入的 request.json 含 `presentationSource`／`presentationFallbackReason` 两个字段，而本地已装 knit CLI 0.1.0 的 `RunRequestFileSchema` 禁止额外字段（用 `checkSchema` 实测：带该两字段 false，删去后 true）。该 run 未产出任何改动。
- 清理后以本地呈现方式重新派发：`env -u REX_SESSION -u REX_BLOCK knit run implement --task k-0aaa6a6779ac --provider magpie --model group/deepseek`，run-d26948de2d55 completed 并被接收（implementation_accepted）。

## 结果与验证

用户可见命令：`node bin/export-csv.js --db=<库> --table=<表> --output=<文件> [选项]`。

主会话实测（非仅采信 worker 报告）：

- `npm test`：30 个用例，30 通过，0 失败。
- 样本库 `data/records.db`（records 表，7 列 5 行）导出后，用独立 RFC4180 解析器回读比对：表头与列顺序一致，5 行、35 个单元格逐一相等，0 处不一致。
- `--bom` 产物首三字节为 `EF BB BF`；`--null-as=NULL` 生效；`--where "status='active'"` 得 3 行；`--exclude note --exclude email` 后剩 5 列；已存在文件报错退出码 3，加 `--force` 后成功退出码 0。
- 中文错误实测：缺参数（退出码 2）、表不存在（4）、数据库文件不存在（4）、排除列不存在（2）、`--help`（0）。均为中文，无整句英文。
- 大表实测：20 万行 0.97s／峰值 RSS 132MB；100 万行 3.36s／峰值 179MB，行数 1000001（含表头）正确。RSS 随行数近似持平，符合游标流式写入。

worker 自述未验证项（主会话未改判）：Windows 覆盖重命名兜底分支、真实 Excel 打开 BOM 产物、复杂 SQL 表达式、并发创建竞态。

## 运行引用

- 失败 run：run-05def4634ab6（rex launcher 失败，目录已归档至 /tmp/knit-run-archive）
- 实施 run：run-d26948de2d55（completed，implementation_accepted）

### 交付记录

<!-- knit:delivery:op-0491eed4c4f1 -->
- 操作: op-0491eed4c4f1
- 时间: 2026-11-04T20:51:05.450Z
- 分支: refs/heads/master
- 授权来源: user:本轮对话授权：先汇总实施与验证结果，确认无误后关闭任务、按流程提交业务产物与任务资料并归档，只提交不推送
- 工作提交: 7b4384b9e22d14b99cff9038afb6887e7b4ef451
- 结果: 正常交付；完成验证 self（无独立检查）
- 归档目标: .knit/tasks/archive/2026-11/11-04-csv-export

### 任务资料提交记录

<!-- knit:metadata-commit:op-0491eed4c4f1 -->
- 任务资料提交: a4d26f0d7ae05144752d4e5ff87ecbfac44870da
- 归档目标: .knit/tasks/archive/2026-11/11-04-csv-export

<!-- knit:progress:end -->
