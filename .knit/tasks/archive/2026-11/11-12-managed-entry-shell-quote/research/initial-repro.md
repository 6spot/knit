# 初始复现（2026-11-12 主会话）

隔离复制完整 dist，链接对应 assets/node_modules/package.json；用受限或版本不匹配的 PATH 强制走当前 CLI 绝对路径回退。执行 init 后，提取 AGENTS 中实际生成的入口命令并交给 /bin/sh 执行 --version。

- 普通安装目录：生成命令执行成功，版本 0.1.0。
- 名称包含 `installation with spaces` 的目录：生成命令未转义，shell 将路径截在 installation 处，退出 127。
- 使用当前 Node 的绝对路径以 argv 运行同一份 CLI：成功，版本 0.1.0。
- 原始 CLI 文件有执行权限 0755；不是权限、包缺失或版本错误。
- macOS /tmp 与 /private/tmp 别名由既有 realpath 规范化处理，断言应比较 canonical path，而不是误认转义变化。

补修需对实际生成的命令做执行回归，不能只断言包含引号；命令表示与 installation.cliEntry 的原始文件路径分开。
