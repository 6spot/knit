import { basename } from "node:path";
import type { CallExpr, Node, Word, WordPart } from "sh-syntax";
import { shellQuote } from "../infrastructure/process.js";

const quoteHint = "请直接运行 knit deliver <id> --authorization '用户同意交付的原话'，填写当前会话用户消息的整条或完整一行。只需预览时用 knit deliver --preview <id>。文案可以用单引号按原样传入，或用 --message-file <文件> 读取";

type HostCommand =
  | { kind: "session"; offset: number }
  | { kind: "start" | "validateEnv"; offset: number; explicit: boolean };

const escapes: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v", "\\": "\\", "'": "'", '"': '"' };

function ansiLiteral(text: string): string | null {
  const chars = [...text.matchAll(/[^\\]+|\\(x[\da-fA-F]{1,2}|u[\da-fA-F]{1,4}|U[\da-fA-F]{1,8}|[0-7]{1,3}|[\s\S]?)/g)].map(([raw, escape]: string[]) => {
    if (escape === undefined) return raw;
    if (escapes[escape] !== undefined) return escapes[escape];
    const unicode = /^[uU]/.test(escape);
    const value = /^[xuU]/.test(escape) ? parseInt(escape.slice(1), 16) : parseInt(escape, 8);
    // 非 ASCII 字节的含义由 shell 的 locale 决定，NUL 也不能进入 argv。
    return value > 0 && value <= (unicode ? 0x10ffff : 127) ? String.fromCodePoint(value) : null;
  });
  return chars.includes(null) ? null : chars.join("");
}

/** 只读取静态参数。命令替换由语法树单独遍历，变量和通配符不作为原话。 */
function literal(parts: WordPart[], quoted = false): string | null {
  const values = parts.map((part): string | null => {
    if (part.type === "SglQuoted") return part.dollar ? ansiLiteral(part.value) : part.value;
    if (part.type === "DblQuoted" && !part.dollar) return literal(part.parts, true);
    if (part.type !== "Lit") return null;
    if (!quoted && /[*?\[{}~]/.test(part.value)) return null;
    return part.value.replace(quoted ? /\\([$`"\\\n])/g : /\\([\s\S])/g, (_, char: string) => char === "\n" ? "" : char);
  });
  return values.includes(null) ? null : values.join("");
}

type Argument = { value: string | null; raw: string; word: Word; virtual?: boolean };
const wrapperOptions: Record<string, string[]> = {
  env: ["-u", "--unset", "-C", "--chdir", "-P", "-a", "--argv0"], command: [], exec: ["-a"], nohup: [],
  nice: ["-n", "--adjustment"], timeout: ["-s", "--signal", "-k", "--kill-after"], caffeinate: ["-t", "-w"],
};
const bundledWrapperOption: Partial<Record<string, RegExp>> = {
  env: /^-[iv0]+[uCPa]$/, exec: /^-[cl]+a$/, timeout: /^-[fpv]+[sk]$/, caffeinate: /^-[dimsu]+[tw]$/,
};

function executableIndex(args: Argument[], start = 0): { args: Argument[]; index: number } | null {
  const wrapper = basename(args[start]?.value ?? "");
  if (!Object.hasOwn(wrapperOptions, wrapper)) return { args, index: start };
  for (let i = start + 1; i < args.length; i++) {
    const arg = args[i]!.value;
    if (wrapper === "command" && /^-[pvV]*[vV][pvV]*$/.test(arg ?? "")) break;
    const splitOption = wrapper === "env" && arg?.match(/^(?:-[iv0]*S|--split-string(?:=|$))/)?.[0];
    if (splitOption && arg !== null) {
      const body = arg === splitOption && !arg.endsWith("=") ? args[++i]?.value : arg.slice(splitOption.length);
      const split = body === undefined || body === null ? null : splitEnvArguments(body, args[start]!.word);
      if (split === null) return null;
      return executableIndex([...args.slice(0, start + 1), ...split, ...args.slice(i + 1)], start);
    }
    if (wrapperOptions[wrapper]!.includes(arg ?? "") || bundledWrapperOption[wrapper]?.test(arg ?? "")) { i++; continue; }
    if (arg === "--") {
      if (wrapper === "env") {
        while (/^[A-Za-z_]\w*=/.test(args[i + 1]?.value ?? args[i + 1]?.raw ?? "")) i++;
      }
      return executableIndex(args, i + (wrapper === "timeout" ? 2 : 1));
    }
    if (arg?.startsWith("-") || (wrapper === "env" && /^[A-Za-z_]\w*=/.test(arg ?? args[i]!.raw))) continue;
    return executableIndex(args, i + (wrapper === "timeout" ? 1 : 0));
  }
  return { args, index: -1 };
}

// env 自己拆词。只展开普通字符与成对引号；其余 env 专有语法保守处理。
function splitEnvArguments(body: string, word: Word): Argument[] | null {
  const tokens = body.match(/[ \t]+|(?:[\p{L}\p{N}_./:=,@%+\-]|'[^'\\\n]*'|"[^"$\\\n]*")+/gu) ?? [];
  if (tokens.join("") !== body) return null;
  return tokens.filter((raw) => !/^[ \t]/.test(raw)).map((raw) => ({
    raw, value: raw.replace(/'([^']*)'|"([^"]*)"/g, (_, a: string | undefined, b: string) => a ?? b), word, virtual: true,
  }));
}

// shell 遇到脚本路径后，剩余选项都交给该脚本。
function shellScriptArgument(args: Argument[], i: number, commandString = false): number | null {
  const arg = args[i]?.value;
  if (arg === undefined) return -1;
  if (arg === null) return null;
  if (arg === "--" || arg === "-") return commandString ? i + 1 : -1;
  if (!/^[+-]/.test(arg)) return commandString ? i : -1;
  const hasValue = /^[+-][a-zA-Z]*[oO]$/.test(arg) || ["--rcfile", "--init-file", "--emulate"].includes(arg);
  return shellScriptArgument(args, i + (hasValue ? 2 : 1), commandString || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
}

type Edit = { start: number; end: number; text: string };
type Script = { kind: "script"; text: string; words: Word[] };
type CommandCheck = HostCommand | { kind: "delivery"; quote: string | null; edits?: Edit[] } | Script | ReturnType<typeof indirect>;

function indirect(context: string, mentionsKnit = context.includes("knit")) {
  return { kind: "indirect" as const, delivery: mentionsKnit && context.includes("deliver"), start: mentionsKnit && /run[\s\S]*start/.test(context) };
}

function inspectCall(call: CallExpr, source: string, context: string, index: (byte: number) => number): CommandCheck | null {
  const resolved = executableIndex(call.args.map((word) => ({ word, raw: source.slice(index(word.start), index(word.end)), value: literal(word.parts) })));
  if (resolved === null) return { kind: "indirect", delivery: true, start: true };
  const args = resolved.args;
  const executable = args[resolved.index];
  if (!executable) return null;
  if (executable.value === null) return indirect(context, source.replace(/['"]/g, "").includes("knit"));
  const name = basename(executable.value);
  const words = args.slice(resolved.index + 1);
  if (name === "source" || name === ".") return indirect(context);
  if (name === "eval" || ["sh", "bash", "zsh", "dash", "ksh"].includes(name)) {
    const start = name === "eval" ? Number(words[0]?.value === "--") : shellScriptArgument(words, 0);
    if (start === -1 || start === null) return indirect(context);
    const body = name === "eval" ? words.slice(start) : words.slice(start, start + 1);
    if (body.some((arg) => arg.value === null)) return indirect(context);
    return { kind: "script", text: body.map((arg) => arg.value).join(" "), words: body.some((arg) => arg.virtual) ? [] : body.map((arg) => arg.word) };
  }
  if (name !== "knit") return null;
  const values = words.map((arg) => arg.value);
  if (["--help", "-h"].includes(values.at(-1) ?? "") && (values.length === 2 && values[0] === "deliver" ||
      values.length === 3 && values[0] === "run" && values[1] === "start")) return null;
  // 唯一的任务参数只占一个 argv。若它成为选项，则 CLI 缺少任务 ID。
  if (values.length === 3 && values[0] === "deliver" && values[1] === null && quotedScalar.test(words[1]!.raw) && values[2] === "--preview") return null;
  const { operands, flags, preview, uncertain, directories } = knitArguments(words);
  if (operands[0] === null) return { kind: "delivery", quote: "" };
  if (operands[0] === "deliver") {
    return { kind: "delivery", quote: preview ? null : uncertain ? "" : flags.get("--authorization")?.trim() ?? "", edits: directories.map((arg) => ({
      start: index(arg.word.start), end: index(arg.word.end), text: `"${arg.raw}"`,
    })) };
  }
  const offset = index(executable.word.start);
  const select = operands[0] === "context" && (flags.has("--use") || flags.has("--unuse"));
  const newTask = operands[0] === "task" && operands[1] === "new";
  if (select || newTask) return { kind: "session", offset };
  const start = operands[0] === "run" && operands[1] === "start";
  const validateEnv = operands[0] === "workflow" && operands[1] === "validate" && flags.has("--env");
  if (!start && !validateEnv) return null;
  const explicit = call.assigns.some((assign) => assign.name?.value === "KNIT_SESSION_AGENT") ||
    args.slice(0, resolved.index).some((arg) => (arg.value ?? arg.raw).startsWith("KNIT_SESSION_AGENT="));
  return { kind: start ? "start" : "validateEnv", offset, explicit };
}

const quotedScalar = /^"(?:[^"$`\\]|\\[\s\S]|\$(?:[a-zA-Z_]\w*|\{[a-zA-Z_]\w*(?::-[\w ./-]*)?\}))*"$/;

function knitArguments(words: Argument[]) {
  const flags = new Map<string, string | null>();
  const operands: (string | null)[] = [];
  const directories: Argument[] = [];
  const state = { uncertain: false, preview: false };
  for (let i = 0; i < words.length; i++) {
    const input = words[i]!;
    const word = input.value;
    if (word === "--") {
      operands.push(...words.slice(i + 1).map((arg) => arg.value));
      break;
    }
    const flag = word?.split("=", 1)[0] ?? /^"?(--[\w-]+)=/.exec(input.raw)?.[1];
    if (flag && ["--dir", "--authorization", "--message", "--message-file", "--use"].includes(flag)) {
      const arg = word === flag ? words[++i] : { ...input,
        raw: input.raw.startsWith(`${flag}=`) ? input.raw.slice(flag.length + 1) : input.raw,
        value: word?.slice(flag.length + 1) ?? null,
      };
      if (arg?.value === null && !quotedScalar.test(arg.raw)) {
        // 裸目录变量可能展开成多个 argv。按单一路径传给 CLI 才能独立核对授权。
        const bareDirectory = flag === "--dir" && /^\$(?:[A-Za-z_]\w*|\{[A-Za-z_]\w*\})$/.test(arg.raw);
        if (bareDirectory) directories.push(word === flag ? arg : input);
        state.uncertain ||= !bareDirectory;
        if (flag === "--message") state.preview = false;
      }
      flags.set(flag, arg?.value ?? null);
      continue;
    }
    if (word === null) state.uncertain = true;
    if (!word?.startsWith("--")) {
      operands.push(word);
      continue;
    }
    if (word === "--preview" && !state.uncertain) state.preview = true;
    flags.set(word, null);
  }
  return { flags, operands, directories, ...state };
}

// 与 Pi 模板同步。仅展开、转义和 Knit 名称（含引号拼接）可能引入受检查的调用。
export function canSkipHostCommand(command: string): boolean {
  return !/knit|[$`\\]/i.test(command.replace(/['"]/g, ""));
}

async function inspectHost(command: string, environment: Partial<Record<HostCommand["kind"], string>> = {}) {
  if (canSkipHostCommand(command)) return { command, quotes: [], hasStart: false };
  const quotes: string[] = [];
  const starts: boolean[] = [];
  const { parse, createSourceIndex, walk, BinCmdOperator } = await import("sh-syntax");
  async function inspect(source: string): Promise<string> {
    const tree = await parse(source).catch(() => null);
    if (tree === null) {
      const check = indirect(source.replace(/['"]/g, ""));
      if (check.delivery) quotes.push("");
      if (check.start) starts.push(true);
      return source;
    }
    const nested: Script[] = [];
    const edits: Edit[] = [];
    const index = createSourceIndex(source);
    const pipelines = new WeakMap<Node, Node>();
    walk(tree, (node, parent) => {
      const enclosing = parent ? pipelines.get(parent) : undefined;
      if (node.type === "BinaryCmd" && (node.op === BinCmdOperator.Pipe || node.op === BinCmdOperator.PipeAll)) pipelines.set(node, enclosing ?? node);
      if (node.type === "Stmt" && enclosing) pipelines.set(node, enclosing);
      if (node.type !== "CallExpr") return;
      const scope = enclosing ?? parent ?? node;
      const call = inspectCall(node, source, source.slice(index(scope.start), index(scope.end)).replace(/['"]/g, ""), index);
      if (call === null) return;
      if (call.kind === "script") { nested.push(call); return; }
      if (call.kind === "indirect") {
        if (call.delivery) quotes.push("");
        if (call.start) starts.push(true);
        return;
      }
      if (call.kind === "delivery") {
        if (call.quote !== null) quotes.push(call.quote);
        if (call.edits) edits.push(...call.edits);
        return;
      }
      if (call.kind === "start") starts.push(true);
      if (call.kind !== "session" && call.explicit) return;
      const env = environment[call.kind];
      if (env) edits.push({ start: call.offset, end: call.offset, text: `env ${env} ` });
    });
    for (const script of nested) {
      const updated = await inspect(script.text);
      if (updated === script.text) continue;
      if (!script.words.length) { quotes.push(""); continue; }
      script.words.forEach((word, i) => edits.push({
        start: index(word.start), end: index(word.end), text: i === 0 ? shellQuote(updated) : "",
      }));
    }
    return edits.sort((a, b) => b.start - a.start).reduce((text, edit) =>
      text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
  }
  return { command: await inspect(command), quotes, hasStart: starts.length > 0 };
}

export async function inspectHostCommand(command: string, environment: Partial<Record<HostCommand["kind"], string>> = {}) {
  const { command: updated, quotes } = await inspectHost(command, environment);
  return { command: updated, quotes };
}

export async function checkHostCommand(command: string, userMessages: () => readonly string[],
  environment: Partial<Record<HostCommand["kind"], string>> = {},
  options: { readonly rejectStartReason?: string } = {}) {
  const { command: updated, quotes, hasStart } = await inspectHost(command, environment);
  if (hasStart && options.rejectStartReason) return { command: updated, reason: options.rejectStartReason };
  if (!quotes.length) return { command: updated, reason: null };
  const messages = userMessages();
  const matched = quotes.every((quote) => quote && messages.some((text) =>
    text.trim() === quote || text.split("\n").some((line) => line.trim() === quote)));
  return { command: updated, reason: matched ? null : `无法核对交付授权。${quoteHint}` };
}
