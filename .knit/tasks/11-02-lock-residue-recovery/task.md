---
id: k-baef5254f155
status: closed
phase: deliver
outcome: completed
branch: refs/heads/main
createdAt: 2026-11-02T08:48:51.957Z
title: 修复锁残留与 unlock 清除路径
---

# 修复锁残留与 unlock 清除路径

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

架构审查确认的锁治理缺陷（src/infrastructure/locks.ts）：

1.【中】无 owner 锁目录永久阻塞且无法用 unlock 清除：acquire 在 mkdir 成功、owner.json 写入失败（或进程在两步间死亡）时，catch 中的 release（219-226 行）对无 owner.json 的键直接 continue，目录残留；后续 acquire 对该目录 mkdir 得 EEXIST → lock_busy；unlock（274-276 行）在 owner 为 null 时无条件抛 lock_owner_unknown，连 --force 也不生效（344 行 release 跳过无 owner 目录）。唯一恢复手段是手工 rm -rf ~/.knit/locks/...。
2.【低】lock_busy flake：test/stage.test.mjs:179 附近存在依赖时序的偶发占用。

验收标准：
- acquire 回滚时对本 token 建立的空目录直接 rmdir，不留残留。
- unlock --force 允许清除「目录存在但 owner 不可核实」的残留（保留正常 token 校验路径不变）。
- 隔离夹具新增回归测试：模拟 owner.json 写入失败后，下一次 acquire 可成功、unlock --force 可清除。

<!-- knit:progress:end -->
