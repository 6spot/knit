import { readFileSync, statSync } from "node:fs";
import type { Command } from "commander";
import { previewDelivery, type DeliveryPreview } from "../application/delivery.js";
import { currentStatus } from "../domain/task-document.js";
import { fail, loadTask } from "./task.js";

interface DeliverOptions {
  readonly preview?: true;
  readonly messageFile?: string;
  readonly dir: string;
}

const indented = (text: string) => text.split("\n").map((line) => (line === "" ? "" : `  ${line}`));

function fileLines(taskDir: string, commit: DeliveryPreview["commit"]): string[] {
  if (commit === null) return ["提交: 这个项目不在 Git 仓库里，只归档，不提交"];
  const files = [
    ...commit.files.map((file) => `  ${file.path}${file.reviewed ? "（审查改过）" : ""}`),
    ...(commit.taskDir ? [`  ${taskDir}/（整个目录，移到归档的位置）`] : []),
  ];
  return files.length === 0 ? ["提交的文件: 没有，不会提交"] : ["提交的文件:", ...files];
}

function hintLines(preview: DeliveryPreview): string[] {
  const unchanged = preview.commit?.unchanged ?? [];
  const others = preview.commit?.others ?? 0;
  const hints = [
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
    .option("--message-file <文件>", "提交文案")
    .option("--dir <目录>", "项目目录", process.cwd())
    .action((id: string, options: DeliverOptions) => {
      const loaded = loadTask(options.dir, id);
      if (loaded === null) return;
      const status = currentStatus(loaded.document, loaded.record);
      if (status === "delivered" || status === "cancelled") return fail([`任务 ${id} 已经结束（${status}），不能交付`]);
      if (status !== "done") return fail([`任务 ${id} 还没有完成（${status}）；完成之后再交付：knit task close ${id}`]);
      if (options.preview !== true) return fail(["knit deliver 现在只能预览：加 --preview"]);

      const preview = previewDelivery(loaded.root, loaded.stored);
      // 不在 Git 仓库里时没有提交，也就不读文案。
      const file = preview.commit === null ? undefined : options.messageFile;
      if (file !== undefined && statSync(file, { throwIfNoEntry: false })?.isFile() !== true) {
        return fail([`读不到提交文案：${file}`]);
      }
      const lines = [
        `任务: ${loaded.document.frontmatter.title}（${id}）`,
        `归档: ${loaded.stored.dir} → ${preview.archiveDir}`,
        ...fileLines(loaded.stored.dir, preview.commit),
        ...hintLines(preview),
        "结果:",
        ...indented(loaded.document.result ?? ""),
        ...(preview.commit === null
          ? []
          : file === undefined
            ? ["提交文案: 没有给；交付时加 --message-file <文件>"]
            : ["提交文案:", ...indented(readFileSync(file, "utf8").trim())]),
      ];
      process.stdout.write(lines.map((line) => `${line}\n`).join(""));
    });
}
