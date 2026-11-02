---
id: k-f1bbbf8530e7
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T11:30:19.711Z
title: 构建后保留 dist/cli/knit.js 执行位
---

# 构建后保留 dist/cli/knit.js 执行位

## 目标与边界

<!-- 待讨论确认：目的、范围、约束与必要设计 -->

## 完成条件

<!-- 可验证结果与必需验收 -->

## 输入引用

<!-- 适用规范、设计材料、代码范围与验证入口 -->

<!-- knit:progress:start -->
## 当前位置

任务已创建，待讨论。

## 关键经过

## 结果与验证

## 运行引用

讨论结论（2026-11-02，用户授权完成剩余任务）：

根因：build 脚本 `rm -rf dist && tsc -p tsconfig.build.json && node scripts/build-bridge-schema.mjs`——tsc 产物不保留源文件执行位，dist/cli/knit.js（含 shebang，npm link 指向它）每次 build 后 chmod 失效，`knit` 命令报 Permission denied。

方向：在 scripts/build-bridge-schema.mjs 末尾（或独立收尾步骤）对 dist/cli/knit.js 恢复 0o755；不引入额外依赖。验证：build 后 node -e 检查 mode & 0o111，pack-check 或现有测试可加一条断言。

验收标准：npm run build 后 dist/cli/knit.js 可直接执行（无需手工 chmod）；有自动化断言防回归。

<!-- knit:progress:end -->
