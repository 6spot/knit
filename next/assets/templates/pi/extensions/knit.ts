/**
 * Knit 的 Pi 桥接。由 knit init 生成，knit init --force 会把它恢复成模板。
 *
 * 只做转交：工具的每个动作对应一条 knit 命令，工具的结果就是命令的输出。
 * 只 import Node 自带的模块，只用去掉之后不影响运行的类型写法：Pi 去掉类型之后直接运行这个文件。
 */
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

interface ToolResult {
  content: { type: "text"; text: string }[];
  details: undefined;
  isError?: true;
}

interface Pi {
  registerTool<Params>(tool: {
    name: string;
    label: string;
    description: string;
    parameters: object;
    execute(toolCallId: string, params: Params): Promise<ToolResult>;
  }): void;
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TaskParams {
  action: "new" | "ready" | "close" | "list";
  taskId?: string;
  title?: string;
  slug?: string;
  verification?: string;
  priority?: string;
  parent?: string;
  dependsOn?: string[];
  result?: string;
  paths?: string[];
  reason?: string;
  archive?: boolean;
}

// 这个文件在 .pi/extensions/ 里，往上三级是项目根。
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

export default function knitBridge(pi: Pi): void {
  pi.registerTool<TaskParams>({
    name: "knit_task",
    label: "Knit task",
    description:
      "管理 Knit 任务。new 创建任务（要有 title），ready 确认需求，close 把任务记为完成并写下结果（要有 result），list 列出任务。task.md 的正文用普通的读写工具直接改。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["new", "ready", "close", "list"] },
        taskId: { type: "string" },
        title: { type: "string" },
        slug: { type: "string" },
        verification: { type: "string", enum: ["none", "self", "independent"] },
        priority: { type: "string", enum: ["P0", "P1", "P2", "P3"] },
        parent: { type: "string" },
        dependsOn: { type: "array", items: { type: "string" } },
        result: { type: "string" },
        paths: { type: "array", items: { type: "string" } },
        reason: { type: "string" },
        archive: { type: "boolean" },
      },
      required: ["action"],
    },
    execute: (_toolCallId, params) => task(params),
  });
}

async function task(params: TaskParams): Promise<ToolResult> {
  const missing = (name: string) => failure(`knit_task 的 ${params.action} 要有 ${name}`);
  if (params.action === "list") return toResult(await runKnit(["task", "list", ...(params.archive ? ["--archive"] : [])]));
  if (params.action === "new") {
    if (!params.title) return missing("title");
    return toResult(
      await runKnit([
        "task",
        "new",
        `--title=${params.title}`,
        ...single("--slug", params.slug),
        ...single("--verification", params.verification),
        ...single("--priority", params.priority),
        ...single("--parent", params.parent),
        ...several("--depends-on", params.dependsOn),
      ]),
    );
  }
  if (!params.taskId) return missing("taskId");
  if (params.action === "ready") return toResult(await runKnit(["task", "ready", params.taskId]));
  if (!params.result) return missing("result");
  return toResult(
    await runKnit([
      "task",
      "close",
      params.taskId,
      `--result=${params.result}`,
      ...several("--paths", params.paths),
      ...single("--reason", params.reason),
    ]),
  );
}

/** 写成 `--选项=值` 的一个参数：值以 `-` 开头时不会被当成别的选项。没有给就不出现。 */
function single(option: string, value: string | undefined): string[] {
  return value ? [`${option}=${value}`] : [];
}

/** 空数组和没有给一样。 */
function several(option: string, values: string[] | undefined): string[] {
  return values?.length ? [option, ...values] : [];
}

/** 运行 PATH 上的 knit，不设超时。启动不了时不抛错，当作退出码 1。 */
function runKnit(args: string[]): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("knit", [...args, "--dir", ROOT], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    // 启动不了时 error 在 close 之前发出，后一次 resolve 不起作用。
    child.on("error", (error) =>
      resolve({ code: 1, stdout: "", stderr: `运行不了 knit 命令（${error.message}）；确认 knit 已经安装并且在 PATH 上` }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
}

/** 工具的结果就是命令的输出：成功是标准输出，失败是标准错误（空的就用标准输出）。 */
function toResult(result: CommandResult): ToolResult {
  if (result.code === 0) return { content: [{ type: "text", text: result.stdout.trimEnd() }], details: undefined };
  return failure(result.stderr.trimEnd() || result.stdout.trimEnd());
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}
