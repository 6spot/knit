import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, rmdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import {
  commitDelivery,
  deliveryWorktree,
  insideGit,
  previewDelivery,
  recordedPaths,
  type DeliveryPreview,
} from "../application/delivery.js";
import { archiveDirOf, archiveTask, findTask, saveTask } from "../application/task-store.js";
import { gitSync } from "../infrastructure/process.js";
import { currentStatus } from "../domain/task-document.js";
import { fail, loadTask } from "./task.js";

interface DeliverOptions {
  readonly preview?: true;
  readonly authorization?: string;
  readonly messageFile?: string;
  readonly dir: string;
}

const indented = (text: string) => text.split("\n").map((line) => (line === "" ? "" : `  ${line}`));

function fileLines(taskDir: string, commit: DeliveryPreview["commit"]): string[] {
  if (commit === null) return ["提交: 这个项目不在 Git 仓库里，只归档，不提交"];
  const files = [
    ...commit.files.map((file) => {
      const marks = [
        ...(file.reviewed ? ["审查改过"] : []),
        ...(file.changedAfterReview ? ["审查通过之后又改过"] : []),
      ];
      return `  ${file.path}${marks.length === 0 ? "" : `（${marks.join("，")}）`}`;
    }),
    ...(commit.taskDir ? [`  ${taskDir}/（整个目录，移到归档的位置）`] : []),
  ];
  return files.length === 0 ? ["提交的文件: 没有，不会提交"] : ["提交的文件:", ...files];
}

function hintLines(preview: DeliveryPreview): string[] {
  const unchanged = preview.commit?.unchanged ?? [];
  const others = preview.commit?.others ?? 0;
  const changed = preview.commit?.files.filter((file) => file.changedAfterReview).length ?? 0;
  const hints = [
    ...(changed > 0 ? [`有 ${changed} 个文件在审查通过之后又改过（上面标出来的），这些改动审查没有看过`] : []),
    ...(unchanged.length > 0
      ? [`记录里有 ${unchanged.length} 个路径现在没有改动，不会被提交：${unchanged.join("、")}`]
      : []),
    ...(others > 0 ? [`工作区里还有 ${others} 处不属于这个任务的改动，不会被提交`] : []),
    ...(preview.openChildren.length > 0
      ? [`子任务还没有结束：${preview.openChildren.map((child) => `${child.id}（${child.status}）`).join("、")}`]
      : []),
  ];
  return hints.length === 0 ? [] : ["提示:", ...hints.map((hint) => `  - ${hint}`)];
}

export function registerDeliverCommand(program: Command): void {
  program
    .command("deliver <id>")
    .description("交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次")
    .option("--preview", "只列出会做什么，什么都不改")
    .option("--authorization <引用>", "用户是在哪条消息里同意交付的")
    .option("--message-file <文件>", "提交文案")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: DeliverOptions) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const status = currentStatus(loaded.document, loaded.record);
      if (status === "delivered" || status === "cancelled") return fail([`任务 ${id} 已经结束（${status}），不能交付`]);
      if (status !== "done") return fail([`任务 ${id} 还没有完成（${status}）；完成之后再交付：knit task close ${id}`]);
      if (options.preview === true) return showPreview(loaded, options.messageFile);

      const authorization = options.authorization?.trim() ?? "";
      if (authorization === "") {
        return fail(["交付要有用户的授权：加 --authorization <引用>，写明用户是在哪条消息里同意的"]);
      }
      const git = insideGit(loaded.root);
      if (git && options.messageFile === undefined) {
        return fail(["在 Git 仓库里交付要给提交文案：加 --message-file <文件>"]);
      }
      const message = git && options.messageFile !== undefined ? messageFrom(options.messageFile) : "";
      if (message === null) return;
      if (git && message === "") return fail([`提交文案是空的：${options.messageFile}`]);

      const conflicts = saveTask(
        loaded.root,
        loaded.stored,
        { ...loaded.document, frontmatter: { ...loaded.document.frontmatter, status: "delivered" } },
        { ...loaded.record, authorization },
      );
      if (conflicts.length > 0) return fail(conflicts);
      const worktree = deliveryWorktree(loaded.root, loaded.stored.dir);
      const workspace = worktree?.path ?? loaded.root;
      // 任务分支可能带着建分支时的旧任务目录：本次提交删除它，失败时原样放回。
      const previousTask = worktree !== null && existsSync(join(workspace, loaded.stored.dir))
        ? mkdtempSync(join(tmpdir(), "knit-delivery-"))
        : null;
      if (previousTask !== null) renameSync(join(workspace, loaded.stored.dir), join(previousTask, "task"));
      const newArchiveParents = worktree === null ? [] : [
        dirname(join(workspace, archiveDirOf(loaded.stored))),
        join(workspace, ".knit/tasks/archive"),
      ].filter((path) => !existsSync(path));
      const archiveDir = archiveTask(loaded.root, loaded.stored, workspace);
      if (!git) {
        return void process.stdout.write(
          `已交付 ${id}\n归档: ${archiveDir}\n提交: 这个项目不在 Git 仓库里，没有提交\n`,
        );
      }
      const commit = commitDelivery(workspace, {
        taskId: id,
        taskDir: loaded.stored.dir,
        archiveDir,
        recorded: recordedPaths(loaded.record),
        message,
      });
      if (commit.kind === "refused") {
        // 撤回到运行之前的样子：撤掉暂存，目录移回去，两个文件写回原来的内容。
        gitSync(["--literal-pathspecs", "reset", "-q", "--", ...commit.files], workspace);
        renameSync(join(workspace, archiveDir), join(loaded.root, loaded.stored.dir));
        if (previousTask !== null) {
          renameSync(join(previousTask, "task"), join(workspace, loaded.stored.dir));
          rmSync(previousTask, { recursive: true, force: true });
        }
        newArchiveParents.forEach((path) => {
          if (readdirSync(path).length === 0) rmdirSync(path);
        });
        const moved = findTask(loaded.root, id);
        if (moved !== null) saveTask(loaded.root, moved, loaded.document, loaded.record);
        return fail([
          commit.error.trimEnd(),
          `Git 没有接受这次提交，交付已经撤回：任务目录在 ${loaded.stored.dir}，状态是 done`,
        ]);
      }
      if (previousTask !== null) rmSync(previousTask, { recursive: true, force: true });
      const lines = [
        `已交付 ${id}`,
        `归档: ${worktree === null ? archiveDir : join(workspace, archiveDir)}`,
        `提交: ${commit.kind === "nothing" ? "没有要提交的文件" : commit.summary}`,
        ...(worktree === null ? [] : [
          `Worktree: ${worktree.path}（${worktree.branch}）`,
          ...(commit.kind === "committed" ? ["这个提交还没有合并进主检出的分支"] : []),
        ]),
        ...(commit.kind === "committed" && commit.extra.length + commit.missing.length > 0
          ? [
              "注意：提交里的文件和预期的不一样，提交保留",
              ...(commit.extra.length > 0 ? [`  多了: ${commit.extra.join("、")}`] : []),
              ...(commit.missing.length > 0 ? [`  少了: ${commit.missing.join("、")}`] : []),
            ]
          : []),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });
}

/** 提交文案，去掉首尾空白；文件读不到时报错并返回 null。 */
function messageFrom(file: string): string | null {
  if (statSync(file, { throwIfNoEntry: false })?.isFile() === true) return readFileSync(file, "utf8").trim();
  fail([`读不到提交文案：${file}`]);
  return null;
}

function showPreview(loaded: NonNullable<ReturnType<typeof loadTask>>, messageFile: string | undefined): void {
  const preview = previewDelivery(loaded.root, loaded.stored);
  // 不在 Git 仓库里时没有提交，也就不读文案。
  const message = preview.commit === null || messageFile === undefined ? undefined : messageFrom(messageFile);
  if (message === null) return;
  const lines = [
    `任务: ${loaded.document.frontmatter.title}（${loaded.document.frontmatter.id}）`,
    `归档: ${loaded.stored.dir} → ${preview.worktree === null ? preview.archiveDir : join(preview.worktree.path, preview.archiveDir)}`,
    ...(preview.worktree === null ? [] : [
      `Worktree: ${preview.worktree.path}（${preview.worktree.branch}）`,
      "提交在任务分支上，不会合并进主检出的分支",
    ]),
    ...fileLines(loaded.stored.dir, preview.commit),
    ...hintLines(preview),
    "结果:",
    ...indented(loaded.document.result ?? ""),
    ...(preview.commit === null
      ? []
      : message === undefined
        ? ["提交文案: 没有给；交付时加 --message-file <文件>"]
        : ["提交文案:", ...indented(message)]),
  ];
  process.stdout.write(lines.map((line) => `${line}\n`).join(""));
}
