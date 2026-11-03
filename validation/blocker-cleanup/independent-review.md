# 阻塞清理独立审查记录

范围：源码及现存日志只读复核，不执行构建、测试、真实项目或真实模型验收。执行者blocker-reviewer，配置模型magpie/codex/gpt-6.1-sol。曾有不可用模型／未找到Agent的失败启动，不计为已执行审查。

## 2026-11-03T13:14:23.798Z（1b9a5b39-8549-4992-a31b-7f9691ab1045）

发现 1 项可执行问题，未发现 058／059 新增的确定性正确性回归。

- **P2：任务资料的部分暂存状态会被覆盖，提交失败也不恢复。** [delivery-service.ts:158](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:158) 的计划只检查 `artifacts` 中的已暂存路径；`metadata` 不受保护。[delivery-service.ts:598](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:598) 随后调用 `commitSelected`，其中 [delivery-service.ts:837](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:837) 执行 `git add -A`，把任务资料的 index 内容替换为工作区全文。若 hook 拒绝提交，函数直接返回失败，原 index 不恢复。
  
  **复现轮廓：** 已完成任务目录内的 `plan.md`，暂存版本 A 后继续修改为 B；设置 pre-commit 拒绝提交；`deliver --plan` 仍显示 ready；执行 deliver，到 metadata 步骤失败后，index 中已变成 B，原暂存边界丢失。这属于任务 057 明确要求保护的用户 index，不是 README 中已声明的业务路径冲突限制。建议 metadata 也对部分暂存 fail closed，或在失败时精确恢复原 index。

058 的逐键 `ownerTokens`、嵌套句柄共享版本及部分心跳成功后的版本更新逻辑彼此一致。059 的固定 `LC_ALL=C` 解析、退出事件缓存、统一 boot identity，以及缺少启动信息时用 `ESRCH` 确认死亡，均能解释对应失败机制；`isRunSettled` 保留业务终态要求并增加实际退出等待，没有看到削弱原断言。

日志证据已更新：基线 **261／14 fail**，中间 **264／1 fail**；[最终日志:270](/Users/me/IdeaProjects/knit/validation/blocker-cleanup/059-full-final.log:270) 已结束，**265 pass、0 fail**，其中 SIGKILL 恢复场景通过。以上为源码与既有日志的只读审查，未执行测试、构建或模型。

## 2026-11-03T13:30:03.082Z（68065d68-d035-4e85-af52-5a6ef1659ac1）

发现 1 项具体遗漏，原 metadata 问题尚未完全闭环。

- **P2：删除型 checkpoint 重试仍可能覆盖用户暂存选择。** [delivery-service.ts:243](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:243) 用 `git diff --name-only` 判断工作区差异，但已从 index 删除、随后在工作区重建的文件属于 untracked，不会出现在该结果中。[delivery-service.ts:254](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:254) 又会因 checkpoint 与当前 index 均无该条目，得到 `undefined === undefined`，将其认作安全 checkpoint。后续 [delivery-service.ts:876](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:876) 的 `git add -A` 会重新暂存文件，覆盖用户保留的 staged deletion。
  
  复现轮廓：任务目录内已有受 Git 跟踪的 `notes.txt` → 删除该文件 → metadata 提交被 hook 拒绝，留下删除 checkpoint → 用户重建 `notes.txt`，保留 index 中的删除 → `--plan`／`--retry` 未识别冲突。再次拒绝提交可观察到 index 已从删除变为重建内容；允许提交则会提交重建内容。应将这种“index 缺项但工作区存在”的状态也判为冲突。

原先报告的**暂存 A／工作区 B**场景已修复：未知暂存会在创建 operation、修改任务及提交前拒绝；已有文件的 checkpoint 后续部分编辑也有保护。旧操作缺少充分证据时安全拒绝，不列为数据丢失问题。

`stage.ts` 的必需资料读取失败处理未发现新增具体问题；可选资料跳过仍属于已声明的 B005 范围。**058／059 先前审查结论仍有效**，本次遗漏位于 060 的 checkpoint 识别。

仅只读审查，未执行测试或修改文件。现有日志显示 targeted **46/46**、全量 **271/271** 通过，但新增测试尚未覆盖上述删除后重建场景。

## 最后复核

执行：2026-11-03T13:34:33.246Z（08dc470f-398a-4ba9-8434-d9f6f6bc3c36）。

本次窄范围只读复核通过，原“删除 checkpoint 后重建未跟踪路径绕过保护”问题已闭合，未发现本次变更新增的可复现问题。

- [delivery-service.ts:248](/Users/me/IdeaProjects/knit/src/application/delivery-service.ts:248)：当 index 快照缺少该路径时，新增 `lstatSync` 检查在 checkpoint 放行前识别工作区重建项；普通文件和悬空符号链接均会判为冲突。路径仍不存在时，保留原删除 checkpoint 的正常重试行为。
- [closeout.test.mjs:174](/Users/me/IdeaProjects/knit/test/closeout.test.mjs:174)：两种回归均覆盖预检冲突、直接重试拒绝，以及 index 删除、HEAD 和重建内容保持原样。原始日志显示修复前两例均失败于 `ready`／`conflict` 差异；[修复后日志](/Users/me/IdeaProjects/knit/validation/blocker-cleanup/060-targeted-deletion-fixed.log:1)确认相关 **48/48 通过**。
- 既有 **058／059 审查结论仍有效**；本次修改未触及其锁及进程修复。必需材料结论也仍成立：[stage.ts:73](/Users/me/IdeaProjects/knit/src/application/stage.ts:73)读取失败明确抛错并携带 `sourceId`、`path`，且发生在阶段 runtime 创建之前。

读取时，[060-full-final.log](/Users/me/IdeaProjects/knit/validation/blocker-cleanup/060-full-final.log)尚无最终统计，故本次不能确认预期的 **273 项全量通过**。未修改文件，未运行测试、构建或模型。

主Agent补充：独立审查结束后最终全量完成，060-full-final.log为273/273、0失败／0跳过，退出码0；最终pack:check通过。该全量事实由主Agent核验，不追溯归为审查者当时已经确认。
