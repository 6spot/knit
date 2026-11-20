/**
 * Knit 的 Pi 桥接。由 knit init 生成，knit init --force 会把它恢复成模板。
 *
 * 只做转交：工具的每个动作对应一条 knit 命令，工具的结果就是命令的输出。
 * 只 import Node 自带的模块，只用去掉之后不影响运行的类型写法：Pi 去掉类型之后直接运行这个文件。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
    execute(toolCallId: string, params: Params, signal: unknown, onUpdate: unknown, ctx: Context): Promise<ToolResult>;
  }): void;
  /** 写一条扩展自己的会话记录，不进模型的上下文。 */
  appendEntry(customType: string, data: unknown): void;
  on(event: "before_agent_start", handler: (event: TurnStart, ctx: Context) => Promise<void>): void;
  on(event: "session_shutdown", handler: () => Promise<void>): void;
  /** 这条消息进模型的上下文。followUp：智能体正在做事时等它这一轮做完再送到；triggerTurn：空闲时立即触发一轮。 */
  sendMessage(
    message: { customType: string; content: string; display: boolean },
    options: { deliverAs: "followUp"; triggerTurn: boolean },
  ): void;
}

/** `sections` 是按名字存的几段系统提示，可以直接改；内容没变的段 Pi 不会重发。 */
interface TurnStart {
  systemPromptOptions?: { sections?: Record<string, string> };
}

interface Context {
  model?: { provider: string; id: string };
  thinkingLevel?: string;
  /** 当前分支上的全部会话记录，从最早到最新；压缩之前的也在。 */
  sessionManager: { getBranch(): SessionEntry[] };
}

/** 只写用到的成员。用户、智能体的消息是 `message`；扩展发的是 `custom_message`，不是用户消息。 */
interface SessionEntry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  message?: { role: string; content: string | { type: string; text?: string }[] };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TaskParams {
  action: "new" | "use" | "ready" | "close" | "list";
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

interface RunParams {
  action: "start" | "status" | "cancel";
  taskId: string;
  model?: string;
  thinking?: string;
}

interface DeliverParams {
  taskId: string;
  preview?: boolean;
  authorization?: string;
  message?: string;
}

// 这个文件在 .pi/extensions/ 里，往上三级是项目根。
const ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const SELECTION = "knit.selection";

export default function knitBridge(pi: Pi): void {
  // 正在等执行结束的 knit run wait，按任务 id 记。派发成功时才启动：这个函数可能在没有会话的调用里运行。
  const waiting = new Map<string, ChildProcess>();

  pi.registerTool<TaskParams>({
    name: "knit_task",
    label: "Knit task",
    description:
      "管理 Knit 任务。new 创建任务（要有 title），use 选中一个任务（之后每一轮都能看到它的状态和当前环节的规范；不带 taskId 是取消选中；新建的任务不会自动选中），ready 确认需求，close 把任务记为完成并写下结果（要有 result），list 列出任务。task.md 的正文用普通的读写工具直接改。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["new", "use", "ready", "close", "list"] },
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
    execute: (_toolCallId, params) => task(pi, params),
  });

  pi.registerTool<RunParams>({
    name: "knit_run",
    label: "Knit run",
    description:
      "派发和查看执行者。start 派发任务的下一个环节，立即返回，执行者在后台做，结束时你会收到一条消息；status 看上一次或正在跑的执行和下一步；cancel 停掉正在跑的执行并记为失败。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel"] },
        taskId: { type: "string" },
        model: { type: "string" },
        thinking: { type: "string", enum: ["off", "minimal", "low", "medium", "high", "xhigh", "max"] },
      },
      required: ["action", "taskId"],
    },
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => run(pi, waiting, params, ctx),
  });

  pi.registerTool<DeliverParams>({
    name: "knit_deliver",
    label: "Knit deliver",
    description:
      "交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次，不推送。派发过的任务在它的 Worktree 和任务分支上交付，不自动合并或清理；主会话接着按交付规范用 Git 做。preview 为真时只列出会做什么。真的交付要有用户的授权：authorization 写用户同意交付的那条消息的原话（整条，或者其中完整的一行），不要改写。message 是提交文案，在 Git 仓库里交付时要有。",
    parameters: {
      type: "object",
      properties: {
        taskId: { type: "string" },
        preview: { type: "boolean" },
        authorization: { type: "string" },
        message: { type: "string" },
      },
      required: ["taskId"],
    },
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => deliver(params, ctx),
  });

  // 每一轮都把选中任务的状态、下一步和当前环节的规范写进系统提示里自己的那一段。
  // 放系统提示而不是消息：Pi 压缩会话时保留系统提示。不缓存，每一轮运行一次命令。
  pi.on("before_agent_start", async (event, ctx) => {
    const sections = event.systemPromptOptions?.sections;
    if (sections === undefined) return;
    const taskId = selectedTask(ctx);
    if (taskId === null) {
      sections.knit = "没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中一个。";
      return;
    }
    const context = await runKnit(["context", taskId]);
    sections.knit =
      context.code === 0
        ? context.stdout.trimEnd()
        : `选中的 Knit 任务 ${taskId} 读不出来：\n${context.stderr.trimEnd()}`;
  });

  // 会话重新加载或重开之后不接着等：结果在下一轮的系统提示里能看到，也可以用 status 查。
  pi.on("session_shutdown", async () => {
    [...waiting.keys()].forEach((taskId) => stopWaiting(waiting, taskId));
  });
}

async function task(pi: Pi, params: TaskParams): Promise<ToolResult> {
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
  if (params.action === "use") return use(pi, params.taskId);
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

/** cancel 最多要等十秒左右，等它做完。 */
async function run(pi: Pi, waiting: Map<string, ChildProcess>, params: RunParams, ctx: Context): Promise<ToolResult> {
  if (!params.taskId) return failure(`knit_run 的 ${params.action} 要有 taskId`);
  // 主会话自己取消的，不需要再收一条通知。
  if (params.action === "cancel") stopWaiting(waiting, params.taskId);
  const result = await runKnit(
    [
      "run", params.action, params.taskId,
      ...(params.action === "start" ? [...single("--model", params.model), ...single("--thinking", params.thinking)] : []),
    ],
    params.action === "start"
      ? { ...process.env, PI_PROVIDER: ctx.model?.provider, PI_MODEL: ctx.model?.id, PI_REASONING_LEVEL: ctx.thinkingLevel }
      : process.env,
  );
  if (params.action === "start" && result.code === 0) notifyWhenEnded(pi, waiting, params.taskId);
  return toResult(result);
}

/** 在后台等这个任务的执行结束，结束时给主会话发一条消息并触发一轮。 */
function notifyWhenEnded(pi: Pi, waiting: Map<string, ChildProcess>, taskId: string): void {
  // 上一次执行刚结束、它的等待还没退出时：换成等这一次的。
  stopWaiting(waiting, taskId);
  const wait = startKnit(["run", "wait", taskId]);
  waiting.set(taskId, wait.child);
  void wait.result.then((ended) => {
    // 被 stopWaiting 去掉的不发消息。
    if (waiting.get(taskId) !== wait.child) return;
    waiting.delete(taskId);
    pi.sendMessage(
      {
        customType: "knit.run-ended",
        content:
          ended.code === 0
            ? `Knit 的执行结束了：\n${ended.stdout.trimEnd()}`
            : `等不到 ${taskId} 的执行结束：\n${ended.stderr.trimEnd()}`,
        display: true,
      },
      { deliverAs: "followUp", triggerTurn: true },
    );
  });
}

/** 先从表里去掉再杀：它退出时已经不在表里，不会发消息。 */
function stopWaiting(waiting: Map<string, ChildProcess>, taskId: string): void {
  const child = waiting.get(taskId);
  waiting.delete(taskId);
  child?.kill();
}

/** 预览什么都不改，不需要授权；真的交付要在这个会话里找到用户的原话。 */
async function deliver(params: DeliverParams, ctx: Context): Promise<ToolResult> {
  if (!params.taskId) return failure("knit_deliver 要有 taskId");
  if (params.preview === true) return withMessageFile(["deliver", params.taskId, "--preview"], params.message);
  const quote = params.authorization?.trim() ?? "";
  if (quote === "") return failure("交付要有用户的授权：authorization 写用户同意交付的那条消息的原话");
  const said = userMessageSaying(ctx, quote);
  if (said === undefined) {
    return failure(
      `在这个会话里找不到用户说过这句话：${quote}；authorization 要写用户同意交付的那条消息的原话（整条，或者其中完整的一行）`,
    );
  }
  // 命令行只要求有引用、不核对，核对在上面做完了；记下的是哪一条消息加原话，事后能查。
  return withMessageFile(["deliver", params.taskId, `--authorization=user:${said.id} ${quote}`], params.message);
}

/**
 * 最后一条说过这句话的用户消息：整条消息，或者其中完整的一行（都去掉首尾空白再比）。
 * 只是一行里的一部分不算：用户说“先不要交付”时，引不出“交付”来当授权。
 * 只证明用户说过这句话，不判断是不是针对这个任务说的。
 */
function userMessageSaying(ctx: Context, quote: string): SessionEntry | undefined {
  return ctx.sessionManager.getBranch().findLast((entry) => {
    if (entry.type !== "message" || entry.message?.role !== "user") return false;
    const content = entry.message.content;
    const text =
      typeof content === "string"
        ? content
        : content
            .filter((block) => block.type === "text")
            .map((block) => block.text ?? "")
            .join("\n");
    return text.trim() === quote || text.split("\n").some((line) => line.trim() === quote);
  });
}

/** 运行 knit；给了提交文案时写进一个临时文件，用 --message-file 交给命令，做完删掉。 */
async function withMessageFile(args: string[], message: string | undefined): Promise<ToolResult> {
  if (!message?.trim()) return toResult(await runKnit(args));
  // 提交文案的文件不能放在项目里：放在项目里它自己就成了工作区的一处改动。
  const dir = await mkdtemp(join(tmpdir(), "knit-message-"));
  await writeFile(join(dir, "message.txt"), message);
  // runKnit 不抛错，所以不管命令成败都会走到删除。
  const result = await runKnit([...args, `--message-file=${join(dir, "message.txt")}`]);
  await rm(dir, { recursive: true, force: true });
  return toResult(result);
}

/** 选中的任务只决定每轮显示哪个任务；写在会话记录里，会话重开之后还在。不带 `taskId` 是取消选中。 */
async function use(pi: Pi, taskId: string | undefined): Promise<ToolResult> {
  if (!taskId) {
    pi.appendEntry(SELECTION, { taskId: null });
    return { content: [{ type: "text", text: "已取消选中" }], details: undefined };
  }
  const shown = await runKnit(["task", "show", taskId]);
  if (shown.code !== 0) return toResult(shown);
  pi.appendEntry(SELECTION, { taskId });
  return { content: [{ type: "text", text: `已选中 ${taskId}\n${shown.stdout.trimEnd()}` }], details: undefined };
}

/** 最后一条选择记录里的任务；没有选过或者取消了是 null。 */
function selectedTask(ctx: Context): string | null {
  const last = ctx.sessionManager.getBranch().findLast((entry) => entry.type === "custom" && entry.customType === SELECTION);
  return (last?.data as { taskId: string | null } | undefined)?.taskId ?? null;
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
function runKnit(args: string[], env = process.env): Promise<CommandResult> {
  return startKnit(args, env).result;
}

/** 启动 knit 并返回子进程，调用方可以不等它或者中途杀掉它。 */
function startKnit(args: string[], env = process.env): { child: ChildProcess; result: Promise<CommandResult> } {
  const child = spawn("knit", [...args, "--dir", ROOT], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
  const result = new Promise<CommandResult>((resolve) => {
    // 启动不了时 error 在 close 之前发出，后一次 resolve 不起作用。
    child.on("error", (error) =>
      resolve({ code: 1, stdout: "", stderr: `运行不了 knit 命令（${error.message}）；确认 knit 已经安装并且在 PATH 上` }),
    );
    child.on("close", (code) =>
      resolve({ code: code ?? 1, stdout: Buffer.concat(stdout).toString("utf8"), stderr: Buffer.concat(stderr).toString("utf8") }),
    );
  });
  return { child, result };
}

/** 工具的结果就是命令的输出：成功是标准输出，失败是标准错误（空的就用标准输出）。 */
function toResult(result: CommandResult): ToolResult {
  if (result.code === 0) return { content: [{ type: "text", text: result.stdout.trimEnd() }], details: undefined };
  return failure(result.stderr.trimEnd() || result.stdout.trimEnd());
}

function failure(text: string): ToolResult {
  return { content: [{ type: "text", text }], details: undefined, isError: true };
}
