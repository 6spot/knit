/**
 * Knit 的 Pi 桥接。由 knit init 生成，knit init --force 会把它恢复成模板。
 *
 * 只做转交：工具的每个动作对应一条 knit 命令，工具的结果就是命令的输出。
 * 只 import Node 自带的模块，只用去掉之后不影响运行的类型写法：Pi 去掉类型之后直接运行这个文件。
 */
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
  on(event: "before_agent_start", handler: (event: TurnStart, ctx: Context) => Promise<{ message: ContextMessage } | undefined>): void;
  on(event: "turn_end", handler: (event: { toolResults: unknown[]; entries: unknown[]; context?: { contextMessages: VisibleMessage[] } }, ctx: Context) => Promise<{ entries: unknown[] } | undefined>): void;
  on(event: "context_with_system", handler: (event: { messages: VisibleMessage[] }, ctx: Context) => Promise<{ messages: VisibleMessage[] } | undefined>): void;
  on(event: "tool_call", handler: (event: { toolName: string; input: Record<string, unknown> }, ctx: Context) => Promise<{ block: true; reason: string } | undefined>): void;
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
  sessionManager: {
    getBranch(): SessionEntry[];
    getSessionId(): string;
    buildSessionContext?(): { messages: VisibleMessage[] };
    buildSessionProjection?(): { messages: VisibleMessage[] };
  };
}

/** 只写用到的成员。用户、智能体的消息是 `message`；扩展发的是 `custom_message`，不是用户消息。 */
interface SessionEntry {
  type: string;
  id: string;
  customType?: string;
  data?: unknown;
  details?: unknown;
  message?: { role: string; content: string | { type: string; text?: string }[] };
}

const dynamicBlocks = ["status", "supplement", "pitfalls"] as const;
type BlockName = typeof dynamicBlocks[number];
type Blocks = Record<BlockName, string> & { discussion?: string };
type Digests = Partial<Record<BlockName, string>>;

interface VisibleMessage {
  role: string;
  timestamp?: number;
  sections?: Record<string, string | null>;
  customType?: string;
  details?: unknown;
}

interface ContextMessage {
  customType: "knit.context";
  display: false;
  content: string;
  details: { version: 1; digests: Digests };
}

interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

interface TaskParams {
  action: "new" | "use" | "ready" | "close" | "show" | "cancel" | "list";
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
  limit?: number;
  grep?: string;
}

interface RunParams {
  action: "start" | "status" | "cancel";
  taskId: string;
  model?: string;
  thinking?: string;
  instruction?: string;
  stage?: string;
  fresh?: boolean;
  runId?: string;
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
const PROJECTION = "knit.compaction-context";

interface SavedProjection {
  afterSummary: number;
  message: ContextMessage & { role: "custom"; timestamp: number };
}

// 与 src/application/host-command.ts 中的判定保持一致；模板须能独立运行。
export function canSkipHostCommand(command: string): boolean {
  return !/knit|[$`\\]/i.test(command.replace(/['"]/g, ""));
}

export default function knitBridge(pi: Pi): void {
  if (process.env.KNIT_PI_EXECUTOR === "1") return;
  // 正在等执行结束的 knit run wait，按任务 id 记。派发成功时才启动：这个函数可能在没有会话的调用里运行。
  const waiting = new Map<string, BatchWait>();

  pi.registerTool<TaskParams>({
    name: "knit_task",
    label: "Knit task",
    description:
      "管理 Knit 任务。new 建一份草稿（要有 title），返回任务标题、编号、task.md 的路径、draft 状态和当前会话是否选中了它；new 不改变当前的任务选择，创建失败时返回原因，选择不变。use 选中一个任务（之后每一轮都能看到它的状态、下一步及补充的环节规范；不带 taskId 是取消选中），ready 确认需求，close 把任务记为完成并写下结果（要有 result），对 done 任务仅传 paths 可补录改动文件，show 按 taskId 查看任务详情，cancel 按 taskId 取消并归档任务（要有非空 reason），list 列出任务，可用 archive 查看归档、grep 匹配 ID 或标题、limit 限制条数。task.md 的正文用普通的读写工具直接改。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["new", "use", "ready", "close", "show", "cancel", "list"] },
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
        limit: { type: "integer", minimum: 1 },
        grep: { type: "string" },
      },
      required: ["action"],
    },
    execute: (_toolCallId, params, _signal, _onUpdate, ctx) => task(pi, params, ctx),
  });

  pi.registerTool<RunParams>({
    name: "knit_run",
    label: "Knit run",
    description:
      "派发和查看执行者。start 派发任务的下一个环节，立即返回，执行者在后台做，结束时你会收到一条消息。并行审查全部结束后，按通知里的报告和结论裁决，用 instruction 把修改清单交给下一次 start，可用 stage 指定裁决目标环节；fresh 为 true 时强制新会话；status 看上一次或正在跑的执行和下一步；cancel 停掉正在跑的执行并记为失败，可用 runId 指定单个执行。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["start", "status", "cancel"] },
        taskId: { type: "string" },
        runId: { type: "string", description: "cancel 时指定要停止的执行" },
        model: { type: "string" },
        instruction: { type: "string", description: "start 时交给执行者的裁决或修改清单" },
        stage: { type: "string", description: "并行审查裁决时指定 start 的目标环节" },
        fresh: { type: "boolean", description: "start 时强制用完整交接新开会话" },
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
      "交付一个完成的任务：归档；项目在 Git 仓库里时再提交一次，不推送。派发过的任务在它的 Worktree 和任务分支上交付；项目配置 worktree.autoMerge 为 true 时，交付成功后自动合并进主检出的当前分支并清理 Worktree 和任务分支，否则由主会话按 knit deliver 输出给出的命令合并和清理。一次交付的授权同时覆盖合并和清理。自动合并或清理失败仍返回交付成功，须看输出；合并失败时由主会话把 Git 错误给用户看并问他怎么处理，不自己解决冲突或强行合并。preview 为真时只列出会做什么。真的交付要有用户的授权：authorization 写用户同意交付的那条消息的原话（整条，或者其中完整的一行），不要改写。message 是提交文案，在 Git 仓库里交付时要有。",
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

  // 叶子之后出现新的压缩条目时，请求需重新核对。无需补块的检查只记在内存里。
  const checkedLeaf = new Map<string, string>();
  const markChecked = (ctx: Context) => {
    const leaf = ctx.sessionManager.getBranch().at(-1);
    if (leaf) checkedLeaf.set(ctx.sessionManager.getSessionId(), leaf.id);
  };
  pi.on("before_agent_start", async (event, ctx) => {
    const blocks = await readBlocks(ctx);
    const visible = visibleMessages(ctx);
    const sections = event.systemPromptOptions?.sections;
    if (sections) {
      // Pi 每轮重建 sections。历史 system 消息保存的是 Pi 已包裹的 XML 段。
      const discussion = blocks.discussion ?? visible.findLast((m) => m.role === "system" && m.sections?.knit !== undefined)
        ?.sections?.knit?.replace(/^<knit>\n([\s\S]*)\n<\/knit>$/, "$1");
      if (discussion !== undefined) sections.knit = discussion;
    }
    const message = contextDelta(blocks, withSavedProjection(ctx, visible));
    markChecked(ctx);
    if (message) return { message };
  });

  pi.on("turn_end", async (event, ctx) => {
    if (!event.toolResults.length) return;
    const visible = event.context?.contextMessages ?? visibleMessages(ctx);
    const message = contextDelta(await readBlocks(ctx), withSavedProjection(ctx, visible));
    markChecked(ctx);
    if (message) return { entries: [...event.entries, { type: "custom_message", ...message }] };
  });

  pi.on("context_with_system", async ({ messages }, ctx) => {
    const summary = messages.findIndex((m) => m.role === "compactionSummary");
    if (summary < 0) return;
    const tail = compactionTail(ctx);
    if (!tail.length) return;
    const saved = savedProjection(tail);
    if (saved) return { messages: insertProjection(messages, summary, saved) };
    if (tail.some((entry) => entry.id === checkedLeaf.get(ctx.sessionManager.getSessionId()))) return;
    const message = contextDelta(await readBlocks(ctx), messages);
    if (!message) {
      markChecked(ctx);
      return;
    }
    const projection: SavedProjection = {
      afterSummary: messages.length - summary - 1,
      message: { ...message, role: "custom", timestamp: messages[summary]!.timestamp ?? 0 },
    };
    pi.appendEntry(PROJECTION, projection);
    return { messages: [...messages, projection.message] };
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "bash" || typeof event.input.command !== "string") return;
    if (canSkipHostCommand(event.input.command)) return;
    const check = (messages: { role: "user"; text: string }[], quotesOnly = false) => startKnit(["hook", "pi", "tool-call"], process.env,
      JSON.stringify({ name: "bash", input: event.input, sessionId: ctx.sessionManager.getSessionId(), messages, quotesOnly })).result;
    let checked = await check([], true);
    // 旧 CLI 忽略 quotesOnly，要求核对交付时才给它用户消息重试。
    if (checked.code !== 0 && checked.stderr.startsWith("无法核对交付授权。")) {
      const messages = ctx.sessionManager.getBranch().flatMap((entry) => {
        const text = userText(entry);
        return text === undefined ? [] : [{ role: "user" as const, text }];
      });
      checked = await check(messages);
    }
    if (checked.code !== 0) return { block: true, reason: checked.stderr.trimEnd() };
    const response = parseHookResult(checked.stdout);
    if (!response) return { block: true, reason: "Knit 命令检查返回了无效结果。" };
    const { quotes = [], command } = response;
    if (quotes.some((quote) => !quote || !userMessageSaying(ctx, quote))) {
      return { block: true, reason: "无法核对交付授权。请用 --authorization 引用当前会话中用户的整条消息或完整一行。只需预览时请用 knit deliver --preview <id>。" };
    }
    if (typeof command === "string") event.input.command = command;
  });

  // 会话重新加载或重开之后不接着等：结果在下一轮的上下文里能看到，也可以用 status 查。
  pi.on("session_shutdown", async () => {
    [...waiting.keys()].forEach((taskId) => stopWaiting(waiting, taskId));
  });
}

async function readBlocks(ctx: Context): Promise<Blocks> {
  const taskId = selectedTask(ctx);
  const result = await runKnit(["context", "--json", ...(taskId ? [taskId] : [])]);
  if (result.code !== 0) return { status: `Knit 上下文读不出来：\n${result.stderr.trimEnd()}`, supplement: "", pitfalls: "" };
  const blocks = parseBlocks(result.stdout);
  if (!blocks) return { status: "Knit 上下文读不出来：context --json 未返回有效的分块。", supplement: "", pitfalls: "" };
  return { ...blocks, status: taskId ? blocks.status : "没有选中 Knit 任务。用 knit_task 的 list 查看任务，use 选中。" };
}

function parseBlocks(stdout: string): Blocks | undefined {
  try {
    const blocks = JSON.parse(stdout);
    if (blocks && ["discussion", ...dynamicBlocks].every((name) => typeof blocks[name] === "string")) return blocks;
  } catch {
    return;
  }
}

function visibleMessages(ctx: Context): VisibleMessage[] {
  const manager = ctx.sessionManager;
  const projected = manager.buildSessionContext?.() ?? manager.buildSessionProjection?.();
  if (projected) return projected.messages;
  const branch = manager.getBranch();
  return branch.slice(branch.findLastIndex((entry) => entry.type === "compaction") + 1)
    .filter((entry) => entry.type === "custom_message").map((entry) => ({ ...entry, role: "custom" }));
}

function compactionTail(ctx: Context) {
  const branch = ctx.sessionManager.getBranch();
  const compact = branch.findLastIndex((entry) => entry.type === "compaction");
  return compact < 0 ? [] : branch.slice(compact);
}

function savedProjection(tail: SessionEntry[]): SavedProjection | undefined {
  return tail.findLast((entry) => entry.type === "custom" && entry.customType === PROJECTION)?.data as SavedProjection | undefined;
}

function insertProjection(messages: VisibleMessage[], summary: number, saved: SavedProjection) {
  return messages.toSpliced(summary + 1 + saved.afterSummary, 0, saved.message);
}

function withSavedProjection(ctx: Context, messages: VisibleMessage[]) {
  const summary = messages.findIndex((m) => m.role === "compactionSummary");
  if (summary < 0) return messages;
  const saved = savedProjection(compactionTail(ctx));
  return saved ? insertProjection(messages, summary, saved) : messages;
}

function contextDelta(blocks: Blocks, messages: VisibleMessage[]): ContextMessage | undefined {
  const previous: Digests = {};
  for (const message of messages) {
    if (message.role !== "custom" || message.customType !== "knit.context") continue;
    const details = message.details as Partial<ContextMessage["details"]> | undefined;
    if (details?.version === 1) Object.assign(previous, details.digests);
  }
  // 只记录这条消息实际提供的块。压缩可能保留状态增量，同时移除含规范正文的消息。
  const digests: Digests = {};
  const content = dynamicBlocks.flatMap((name) => {
    const text = blocks[name];
    if (!text && !previous[name]) return [];
    const digest = createHash("sha256").update(text).digest("hex");
    if (digest === previous[name]) return [];
    digests[name] = digest;
    return [text || (name === "pitfalls" ? "此前注入的避坑条目已不再适用。" : "此前注入的环节补充规范已不再适用。")];
  });
  if (!content.length) return;
  return { customType: "knit.context", display: false, details: { version: 1, digests }, content: ["[Knit 上下文]", ...content].join("\n\n") };
}

function parseHookResult(stdout: string): { quotes?: string[]; command?: string } | undefined {
  try {
    const result = JSON.parse(stdout);
    if (!result || (result.command === undefined && result.quotes === undefined)) return;
    if (result.command !== undefined && typeof result.command !== "string") return;
    if (result.quotes !== undefined && !(Array.isArray(result.quotes) && result.quotes.every((q: unknown) => typeof q === "string"))) return;
    return result;
  } catch {
    return;
  }
}

async function task(pi: Pi, params: TaskParams, ctx: Context): Promise<ToolResult> {
  const missing = (name: string) => failure(`knit_task 的 ${params.action} 要有 ${name}`);
  if (params.action === "list") return toResult(await runKnit(["task", "list", ...(params.archive ? ["--archive"] : []),
    ...(params.limit === undefined ? [] : [`--limit=${params.limit}`]),
    ...(params.grep === undefined ? [] : [`--grep=${params.grep}`]),
  ]));
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
        ...(params.dependsOn ?? []).map((id) => `--depends-on=${id}`),
      ], { ...process.env, KNIT_HOST: "pi", KNIT_HOST_SESSION: ctx.sessionManager.getSessionId() }),
    );
  }
  if (params.action === "use") return use(pi, params.taskId);
  if (!params.taskId) return missing("taskId");
  if (params.action === "show" || params.action === "ready") return toResult(await runKnit(["task", params.action, params.taskId]));
  if (params.action === "cancel") {
    if (!params.reason?.trim()) return missing("reason");
    return toResult(await runKnit(["task", "cancel", params.taskId, `--reason=${params.reason}`]));
  }
  if (params.result === undefined && !params.paths?.length) return missing("result 或 paths");
  return toResult(
    await runKnit([
      "task",
      "close",
      params.taskId,
      ...(params.result === undefined ? [] : [`--result=${params.result}`]),
      ...(params.paths ?? []).map((path) => `--paths=${path}`),
      // 补录时 CLI 需要区分没有传 reason 和显式传入空字符串。
      ...(params.result === undefined && params.reason === "" ? ["--reason="] : single("--reason", params.reason)),
    ]),
  );
}

interface BatchWait {
  child: ChildProcess;
  cancel?: Promise<CommandResult>;
}

async function run(pi: Pi, waiting: Map<string, BatchWait>, params: RunParams, ctx: Context): Promise<ToolResult> {
  if (!params.taskId) return failure(`knit_run 的 ${params.action} 要有 taskId`);
  const pending = runKnit(
    [
      "run", params.action, params.taskId,
      ...(params.action === "cancel" && params.runId !== undefined ? [`--run=${params.runId}`] : []),
      ...(params.action === "start" ? [
        ...single("--model", params.model),
        ...single("--thinking", params.thinking),
        ...single("--stage", params.stage),
        ...(params.instruction === undefined ? [] : [`--instruction=${params.instruction}`]),
        ...(params.fresh ? ["--fresh"] : []),
      ] : []),
    ],
    params.action === "start"
      ? { ...process.env, KNIT_SESSION_AGENT: "pi", PI_PROVIDER: ctx.model?.provider, PI_MODEL: ctx.model?.id, PI_REASONING_LEVEL: ctx.thinkingLevel }
      : process.env,
  );
  const batch = params.action === "cancel" && params.runId === undefined ? waiting.get(params.taskId) : undefined;
  if (batch) batch.cancel = pending;
  const result = await pending;
  if (batch && result.code === 0 && waiting.get(params.taskId) === batch) stopWaiting(waiting, params.taskId);
  if (params.action === "start" && result.code === 0) notifyWhenEnded(pi, waiting, params.taskId);
  return toResult(result);
}

/** run wait 等到整批成员入账，stdout 包含各自的报告路径和结果。每次派发只启动一个等待进程。 */
function notifyWhenEnded(pi: Pi, waiting: Map<string, BatchWait>, taskId: string): void {
  // 上一次执行刚结束、它的等待还没退出时：换成等这一次的。
  stopWaiting(waiting, taskId);
  const wait = startKnit(["run", "wait", taskId]);
  const batch: BatchWait = { child: wait.child };
  waiting.set(taskId, batch);
  void wait.result.then(async (ended) => {
    // 等待与整批取消可能同时结束，先让取消结果决定是否通知。
    if (batch.cancel) await batch.cancel;
    if (waiting.get(taskId) !== batch) return;
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
function stopWaiting(waiting: Map<string, BatchWait>, taskId: string): void {
  const batch = waiting.get(taskId);
  waiting.delete(taskId);
  batch?.child.kill();
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
    const text = userText(entry);
    return text !== undefined && (text.trim() === quote || text.split("\n").some((line) => line.trim() === quote));
  });
}

function userText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message?.role !== "user") return undefined;
  const content = entry.message.content;
  return typeof content === "string" ? content : content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
}

/** 运行 knit；给了提交文案时写进一个临时文件，用 --message-file 交给命令，做完删掉。 */
async function withMessageFile(args: string[], message: string | undefined): Promise<ToolResult> {
  if (!message?.trim()) return toResult(await runKnit(args));
  // 提交文案的文件不能放在项目里：放在项目里它自己就成了工作区的一处改动。
  const dir = await mkdtemp(join(tmpdir(), "knit-message-"));
  try {
    const path = join(dir, "message.txt");
    await writeFile(path, message);
    return toResult(await runKnit([...args, `--message-file=${path}`]));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
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
  const title = /^标题: (.+)$/m.exec(shown.stdout)?.[1];
  const label = title ? `${title}（${taskId}）` : taskId;
  return { content: [{ type: "text", text: `已选中 ${label}\n${shown.stdout.trimEnd()}` }], details: undefined };
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

/** 运行 PATH 上的 knit，不设超时。启动不了时不抛错，当作退出码 1。 */
function runKnit(args: string[], env = process.env): Promise<CommandResult> {
  return startKnit(args, env).result;
}

/** 启动 knit 并返回子进程，调用方可以不等它或者中途杀掉它。 */
function startKnit(args: string[], env = process.env, input?: string): { child: ChildProcess; result: Promise<CommandResult> } {
  const child = spawn("knit", input === undefined ? [...args, "--dir", ROOT] : args, { cwd: ROOT, env, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
  if (input !== undefined) {
    child.stdin?.on("error", () => {});
    child.stdin?.end(input);
  }
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout!.on("data", (chunk: Buffer) => stdout.push(chunk));
  child.stderr!.on("data", (chunk: Buffer) => stderr.push(chunk));
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
