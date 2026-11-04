/** worktree 命令组：create／connect（任务 k-248eafc8fb31；WORKTREE.md 第6.2节）、handoff（任务 k-19b5cad5c106；第6.1节）、prepare（任务 k-e48b7df14115；第6.7节）。 */
import { Command } from "commander";
import { join } from "node:path";
import { SqliteMetadataStore } from "../infrastructure/sqlite-metadata-store.js";
import { WorktreeService } from "../application/worktree-manager.js";
import { WorktreeHandoffService } from "../application/worktree-handoff.js";
import { WorktreePrepareService } from "../application/worktree-prepare.js";
import { RunStore } from "../infrastructure/run-store.js";
import { executionRouteOf, resolveProjectStart, verifyWorktreeRegistration } from "../application/worktree-routing.js";
import { cliMainRoot } from "./root.js";
import { emit, jsonResponse, outcomeForError, reasonForError } from "./output.js";

const RUNTIME_DIR = ".knit/.runtime";

function openStore(dir: string): SqliteMetadataStore {
  return new SqliteMetadataStore(join(cliMainRoot(dir), RUNTIME_DIR, "metadata.db"));
}

function printWorktree(worktree: { layout: string; path: string; branch: string; baseline: string; relativePath?: string }): void {
  console.log(`布局: ${worktree.layout}`);
  console.log(`路径: ${worktree.path}`);
  if (worktree.relativePath !== undefined) console.log(`相对路径: ${worktree.relativePath}`);
  console.log(`分支: ${worktree.branch}`);
  console.log(`基线: ${worktree.baseline}`);
}

export function registerWorktreeCommands(program: Command): void {
  const jsonMode = () => program.opts().json || process.env.KNIT_JSON === "1";
  const worktree = program.command("worktree").description("任务执行 Worktree：创建、连接与本机绑定");

  const withService = async <T>(
    requestId: string,
    dir: string,
    fn: (service: WorktreeService) => Promise<T>,
    render: (result: T) => void,
  ): Promise<void> => {
    const store = openStore(dir);
    try {
      const service = new WorktreeService({ store });
      const result = await fn(service);
      if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
      else render(result);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
      if (jsonMode()) {
        emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
      } else {
        console.error(`knit: ${message}`);
      }
    } finally {
      store.close();
    }
  };

  worktree
    .command("create")
    .description("从主检出当前已提交 HEAD 建立任务 worktree 并登记绑定")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--path <dir>", "worktree 目录（默认 .knit/worktrees/<MM-DD>-<slug>/ 或全局备用）")
    .option("--branch <branch>", "完整 refs/heads/... 分支（默认 knit/<MM-DD>-<slug>）")
    .option("--global", "使用全局备用根 ~/.knit/worktrees/<project-key>/", false)
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const taskId = options.task;
      const root = cliMainRoot(options.dir);
      const requestId = `worktree-create-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, root, (service) =>
        service.create({
          dir: root,
          taskId,
          ...(options.path === undefined ? {} : { path: options.path }),
          ...(options.branch === undefined ? {} : { branch: options.branch }),
          global: options.global === true,
        }),
        (result) => {
          console.log(`${result.created ? "已创建" : "已登记（幂等命中）"}: ${result.taskId}`);
          printWorktree(result.worktree);
          if (result.gitignore?.updated) console.log(`忽略规则已追加: ${result.gitignore.file}`);
          if (result.naming !== null) {
            console.log(`命名占用: ${result.naming.requested} → ${result.naming.used}（序号 ${result.naming.sequence}）`);
          }
          if (result.worktree.layout === "global") {
            console.log("布局说明: 全局备用位置按 project-key 区分同名项目");
          }
        },
      );
    });

  worktree
    .command("connect")
    .description("核对并连接已有 worktree 目录：porcelain 登记、仓库归属与本地分支")
    .requiredOption("--task <taskId>", "任务 ID")
    .requiredOption("--path <dir>", "已有 worktree 目录")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const taskId = options.task;
      const root = cliMainRoot(options.dir);
      const requestId = `worktree-connect-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      await withService(requestId, root, (service) =>
        service.connect({ dir: root, taskId, path: options.path }),
        (result) => {
          console.log(`${result.registered ? "已连接并登记" : "已连接（幂等命中）"}: ${result.taskId}`);
          printWorktree(result.worktree);
        },
      );
    });

  worktree
    .command("handoff")
    .description("从主检出交接任务资料到已登记 worktree：快照、基线核对、应用、回执与绑定切换")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--to <dir>", "目标 worktree 目录（默认取已登记路径）")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const taskId = options.task;
      const root = cliMainRoot(options.dir);
      const requestId = `worktree-handoff-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const store = openStore(root);
      try {
        const service = new WorktreeHandoffService({ store, runs: new RunStore(root) });
        const result = await service.handoff({
          dir: root,
          taskId,
          ...(options.to === undefined ? {} : { to: options.to }),
        });
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          const modeLabel = result.mode === "no_op" ? "已一致（no-op）" : result.mode === "resumed" ? "已从断点续做" : "已交接";
          console.log(`${modeLabel}: ${result.taskId} → ${result.worktreePath}`);
          console.log(`操作: ${result.opId}  分支: ${result.branch}`);
          console.log(`文件: ${result.files}  删除项: ${result.deleted}  未跟踪: ${result.untracked}`);
          console.log(`目标资料: ${result.targetTaskDir}`);
          if (result.sourceDisposition === "moved_untracked") {
            console.log("源目录无跟踪文件，已整体移入 transfers/<opId>/source-original/ 备份");
          } else if (result.sourceDisposition === "kept_tracked") {
            console.log("旧副本保留在源目录（含 Git 跟踪文件），待交付/清理任务处置");
          }
          if (!result.bindingBranchSwitched) console.log("绑定分支未变化");
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        } else {
          console.error(`knit: ${message}`);
        }
      } finally {
        store.close();
      }
    });

  worktree
    .command("prepare")
    .description("准备已登记 worktree 的公共资料与环境：白名单复制（基线核对）+ postCreate 步骤 + 回执与绑定更新")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--rerun <stepName>", "续做未完成操作时显式重跑单个 postCreate 步骤")
    .option("--dir <dir>", "项目目录（默认当前目录）", ".")
    .action(async (options) => {
      const taskId = options.task;
      const root = cliMainRoot(options.dir);
      const requestId = `worktree-prepare-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const store = openStore(root);
      try {
        const service = new WorktreePrepareService({ store });
        const result = await service.prepare({
          dir: root,
          taskId,
          ...(options.rerun === undefined ? {} : { rerun: options.rerun }),
        });
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          const modeLabel = result.mode === "no_op" ? "已一致（no-op）" : result.mode === "resumed" ? "已从断点续做" : "已准备";
          console.log(`${modeLabel}: ${result.taskId} → ${result.worktreePath}`);
          console.log(`操作: ${result.opId || "（无）"}  分支: ${result.branch}`);
          console.log(`复制: ${result.copied}  跳过: ${result.skipped}`);
          for (const step of result.steps) {
            const label = step.outcome === "success" ? "成功" : step.outcome === "failed" ? "失败" : "未执行";
            console.log(`步骤 ${step.name}: ${label}（exit ${step.exit ?? "-"}）`);
          }
          if (result.finishedAt !== null) console.log(`完成: ${result.finishedAt}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        } else {
          console.error(`knit: ${message}`);
        }
      } finally {
        store.close();
      }
    });

  worktree
    .command("status")
    .description("只读报告任务的执行路由：state／dir／branch／layout／prepared／active／problem")
    .requiredOption("--task <taskId>", "任务 ID")
    .option("--dir <dir>", "起点目录（主检出或 worktree；默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `worktree-status-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const start = resolveProjectStart(options.dir);
      const store = openStore(start.mainRoot);
      try {
        const binding = await store.bindings.get(options.task);
        if (binding === null) throw new Error(`任务缺少绑定: ${options.task}`);
        const route = executionRouteOf(binding, start.mainRoot);
        const result = {
          taskId: options.task,
          mainRoot: start.mainRoot,
          startDir: start.executionDir,
          ...route,
        };
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          console.log(`任务: ${options.task}`);
          console.log(`主检出: ${result.mainRoot}`);
          console.log(`当前目录: ${result.startDir}`);
          console.log(`状态: ${result.state}`);
          console.log(`执行目录: ${result.dir}`);
          console.log(`分支: ${result.branch ?? "（无）"}`);
          console.log(`布局: ${result.layout}`);
          console.log(`已交接: ${result.active}  已准备: ${result.prepared}`);
          if (result.problem !== null) console.log(`问题: ${result.problem}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        } else {
          console.error(`knit: ${message}`);
        }
      } finally {
        store.close();
      }
    });

  worktree
    .command("list")
    .description("枚举全部 worktree 登记（跨目录可见；invalid 条目与原因一并显示）")
    .option("--dir <dir>", "起点目录（主检出或 worktree；默认当前目录）", ".")
    .action(async (options) => {
      const requestId = `worktree-list-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const start = resolveProjectStart(options.dir);
      const store = openStore(start.mainRoot);
      try {
        const entries = [];
        for (const binding of await store.bindings.list()) {
          const info = binding.worktree;
          if (info === undefined) continue;
          const verdict = verifyWorktreeRegistration(start.mainRoot, info);
          const active = info.active === true;
          entries.push({
            taskId: binding.taskId,
            state: verdict.ok ? (active ? "worktree" : "inactive") : "invalid",
            dir: info.path,
            branch: info.branch,
            layout: info.layout,
            prepared: typeof info.preparedAt === "string" && info.preparedAt !== "",
            active,
            problem: verdict.problem,
          });
        }
        entries.sort((a, b) => a.taskId.localeCompare(b.taskId));
        const result = { mainRoot: start.mainRoot, entries };
        if (jsonMode()) emit(jsonResponse(requestId, "completed", result));
        else {
          console.log(`主检出: ${result.mainRoot}`);
          if (entries.length === 0) console.log("（无 worktree 登记）");
          for (const entry of entries) {
            console.log(`${entry.taskId}  ${entry.state}  ${entry.dir}`);
            console.log(`  分支: ${entry.branch}  布局: ${entry.layout}  已交接: ${entry.active}  已准备: ${entry.prepared}`);
            if (entry.problem !== null) console.log(`  问题: ${entry.problem}`);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.exitCode = 1;
        if (jsonMode()) {
          emit(jsonResponse(requestId, outcomeForError(error), { error: message }, reasonForError(error)));
        } else {
          console.error(`knit: ${message}`);
        }
      } finally {
        store.close();
      }
    });
}
