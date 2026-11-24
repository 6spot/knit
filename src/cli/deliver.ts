import { join } from "node:path";
import type { Command } from "commander";
import { deliverTask, type DeliveryOptions, type DeliveryPreview, type DeliveryResult } from "../application/delivery.js";
import { fail, integrationLines, knitRoot } from "./shared.js";

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
    .action((id: string, options: DeliveryOptions & { dir: string }) => {
      const root = knitRoot(options.dir);
      if (root === null) return;
      const result = deliverTask(root, id, options);
      if (result.kind === "refused") return fail(result.problems);
      if (result.kind === "rolledBack") {
        if (result.reason === "move") throw result.error;
        return fail([result.error.trimEnd(), `Git 没有接受这次提交，交付已经撤回：任务目录在 ${result.taskDir}，状态是 done`]);
      }
      const lines = result.kind === "preview" ? previewLines(id, result) : deliveredLines(root, id, result);
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}

function deliveredLines(root: string, id: string, result: Extract<DeliveryResult, { kind: "delivered" }>): string[] {
  const { worktree, commit, integration } = result;
  return [
    `已交付 ${id}`,
    `归档: ${worktree === null ? result.archiveDir : join(result.archiveRoot, result.archiveDir)}`,
    `提交: ${commit === null ? "这个项目不在 Git 仓库里，没有提交" : commit.kind === "nothing" ? "没有要提交的文件" : commit.summary}`,
    ...(worktree === null ? [] : [
      `Worktree: ${worktree.path}（${worktree.branch}）`,
      ...(commit?.kind === "committed" && integration === null ? ["这个提交还没有合并进主检出的分支"] : []),
    ]),
    ...(commit?.kind === "committed" && commit.extra.length + commit.missing.length > 0
      ? [
          "注意：提交里的文件和预期的不一样，提交保留",
          ...(commit.extra.length > 0 ? [`  多了: ${commit.extra.join("、")}`] : []),
          ...(commit.missing.length > 0 ? [`  少了: ${commit.missing.join("、")}`] : []),
        ]
      : []),
    ...(integration === null ? [] : integrationLines(root, integration)),
  ];
}

function previewLines(id: string, result: Extract<DeliveryResult, { kind: "preview" }>): string[] {
  const { preview, message, mergeBranch } = result;
  return [
    `任务: ${result.title}（${id}）`,
    `归档: ${result.taskDir} → ${preview.worktree === null ? preview.archiveDir : join(preview.archiveRoot, preview.archiveDir)}`,
    ...(preview.worktree === null ? [] : [
      `Worktree: ${preview.worktree.path}（${preview.worktree.branch}）`,
      ...(mergeBranch === null
        ? ["提交在任务分支上，不会合并进主检出的分支"]
        : [
            `提交在任务分支上；交付之后会合并进主检出的分支 ${mergeBranch}`,
            `合并成功之后删除 Worktree: ${preview.worktree.path}`,
            `删除分支: ${preview.worktree.branch}`,
          ]),
    ]),
    ...fileLines(result.taskDir, preview.commit),
    ...hintLines(preview),
    "结果:",
    ...indented(result.result ?? ""),
    ...(preview.commit === null
      ? []
      : message === undefined
        ? ["提交文案: 没有给；交付时加 --message-file <文件>"]
        : ["提交文案:", ...indented(message)]),
  ];
}
