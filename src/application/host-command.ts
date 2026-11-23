import { basename } from "node:path";
import type { CallExpr, Word, WordPart } from "sh-syntax";
import { shellQuote } from "../infrastructure/process.js";

const quoteHint = "请直接运行 knit deliver <id> --authorization '用户同意交付的原话'，填写当前会话用户消息的整条或完整一行。只需预览时用 knit deliver --preview <id>，把 --preview 放在动态参数之前";

type HostCommand = { kind: "select" | "start" | "draft"; offset: number };

export interface WorkEffect {
  kind: "write" | "delegate" | "draft" | "ready" | "close";
  target?: string;
  replacement?: { from: string; to: string };
}

/** 只读取静态参数。命令替换由语法树单独遍历，变量和通配符不作为原话。 */
function literal(parts: WordPart[], quoted = false): string | null {
  const values = parts.map((part): string | null => {
    if (part.type === "SglQuoted" && !part.dollar) return part.value;
    if (part.type === "DblQuoted" && !part.dollar) return literal(part.parts, true);
    if (part.type !== "Lit") return null;
    if (!quoted && /[*?\[{}~]/.test(part.value)) return null;
    return part.value.replace(quoted ? /\\([$`"\\\n])/g : /\\([\s\S])/g, (_, char: string) => char === "\n" ? "" : char);
  });
  return values.includes(null) ? null : values.join("");
}

function executableIndex(args: (string | null)[], start = 0): number {
  const wrapper = basename(args[start] ?? "");
  if (!["env", "command", "exec"].includes(wrapper)) return start;
  for (let index = start + 1; index < args.length; index++) {
    const arg = args[index];
    if (wrapper === "command" && /^-[pvV]*[vV][pvV]*$/.test(arg ?? "")) return -1;
    if (["-u", "--unset", "-C", "--chdir"].includes(arg ?? "")) { index++; continue; }
    if (arg === null || arg === undefined || arg.startsWith("-") || /^[A-Za-z_]\w*=/.test(arg)) continue;
    return executableIndex(args, index);
  }
  return -1;
}

// shell 遇到脚本路径后，剩余选项都交给该脚本。
function shellScriptArgument(args: (string | null)[], i: number, commandString = false): number | null {
  const arg = args[i];
  if (arg === undefined) return -1;
  if (arg === null) return null;
  if (arg === "--" || arg === "-") return commandString ? i + 1 : -1;
  if (!/^[+-]/.test(arg)) return commandString ? i : -1;
  const hasValue = /^[+-][a-zA-Z]*[oO]$/.test(arg) || ["--rcfile", "--init-file", "--emulate"].includes(arg);
  return shellScriptArgument(args, i + (hasValue ? 2 : 1), commandString || /^-[a-zA-Z]*c[a-zA-Z]*$/.test(arg));
}

type Script = { kind: "script"; text: string; words: Word[] };
type CommandCheck = HostCommand | { kind: "delivery"; quote: string } | Script;

function inspectCall(call: CallExpr, source: string, index: (byte: number) => number): CommandCheck | null {
  const args = call.args.map((word) => literal(word.parts));
  const executable = executableIndex(args);
  const name = basename(args[executable] ?? "");
  if (name === "eval" || ["sh", "bash", "zsh", "dash", "ksh"].includes(name)) {
    const start = name === "eval" ? executable + 1 : shellScriptArgument(args, executable + 1);
    if (start === -1) return null;
    if (start !== null) {
      const end = name === "eval" ? args.length : start + 1;
      const body = args.slice(start, end);
      if (!body.includes(null)) return { kind: "script", text: body.join(" "), words: call.args.slice(start, end) };
    }
    return /knit[\s\S]*deliver/.test(source.slice(index(call.start), index(call.end))) ? { kind: "delivery", quote: "" } : null;
  }
  if (name !== "knit") return null;

  const words = call.args.slice(executable + 1).map((word, i) => ({
    raw: source.slice(index(word.start), index(word.end)), value: args[executable + 1 + i] ?? null,
  }));
  const { operands, flags, preview, uncertain } = knitArguments(words);
  if (operands[0] === null) return { kind: "delivery", quote: "" };
  if (operands[0] === "deliver") {
    if (preview) return null;
    return { kind: "delivery", quote: uncertain ? "" : flags.get("--authorization")?.trim() ?? "" };
  }
  const offset = index(call.args[executable]!.start);
  if (operands[0] === "task" && operands[1] === "new") return { kind: "draft", offset };
  if (operands[0] === "context" && (flags.has("--use") || flags.has("--unuse"))) return { kind: "select", offset };
  if (operands[0] !== "run" || operands[1] !== "start") return null;
  const explicit = call.assigns.some((assign) => assign.name?.value === "KNIT_SESSION_AGENT") ||
    call.args.slice(0, executable).some((word, i) => args[i]?.startsWith("KNIT_SESSION_AGENT=") ||
      source.slice(index(word.start), index(word.end)).startsWith("KNIT_SESSION_AGENT="));
  return explicit ? null : { kind: "start", offset };
}

function knitArguments(words: { raw: string; value: string | null }[]) {
  const flags = new Map<string, string | null>();
  const operands: (string | null)[] = [];
  const state = { uncertain: false, preview: false };
  // 带引号的标量路径可以含目录后缀，仍只占一个选项值。
  const scalar = /^"(?:[^"$`\\]|\\[\s\S]|\$(?:[a-zA-Z_]\w*|\{[a-zA-Z_]\w*\}))*"$/;
  for (let i = 0; i < words.length; i++) {
    const input = words[i]!;
    const word = input.value;
    if (word === "--") {
      operands.push(...words.slice(i + 1).map((arg) => arg.value));
      break;
    }
    const flag = word?.split("=", 1)[0] ?? /^"?(--[\w-]+)=/.exec(input.raw)?.[1];
    if (flag && ["--dir", "--authorization", "--message-file", "--use"].includes(flag)) {
      const arg = word === flag ? words[++i] : {
        raw: input.raw.startsWith(`${flag}=`) ? input.raw.slice(flag.length + 1) : input.raw,
        value: word?.slice(flag.length + 1) ?? null,
      };
      if (arg?.value === null && !scalar.test(arg.raw)) state.uncertain = true;
      flags.set(flag, arg?.value ?? null);
      continue;
    }
    if (word === null) state.uncertain = true;
    if (!word?.startsWith("--")) {
      operands.push(word);
      continue;
    }
    // 已识别的布尔开关不会被后面的动态参数撤销。
    if (word === "--preview" && !state.uncertain) state.preview = true;
    flags.set(word, null);
  }
  return { flags, operands, ...state };
}

function commandEffects(call: CallExpr): WorkEffect[] {
  const words = call.args.map((word) => literal(word.parts));
  if (!words.length) return [];
  const index = executableIndex(words);
  if (index < 0) return [];
  const name = basename(words[index] ?? "");
  const args = words.slice(index + 1);
  const last = args.at(-1) ?? undefined;
  if (name === "knit") {
    const [area, action, target] = knitArguments(args.map((value) => ({ value, raw: value ?? "" }))).operands;
    if (area === "task" && action === "new") return [{ kind: "draft" }];
    if (area === "run" && action === "start") return [{ kind: "delegate", target: target ?? undefined }];
    if (area === "task" && (action === "ready" || action === "close")) return [{ kind: action, target: target ?? undefined }];
    if (["context", "deliver", "task", "run", "standards", "workflow"].includes(area ?? "")) return [];
  }
  if (name === "sort" && !args.some((arg) => /^-o|^--output/.test(arg ?? ""))) return [];
  if (name === "uniq" && args.length <= 1) return [];
  if (["true", "false", ":", "pwd", "ls", "cat", "head", "tail", "wc", "diff", "stat", "echo", "printf", "cd", "test", "[", "which", "cut", "dirname", "basename"].includes(name)) return [];
  if (["rg", "grep"].includes(name) && !args.some((arg) => arg?.startsWith("--pre"))) return [];
  if (name === "git") {
    const action = args.find((arg, index) => arg !== "-C" && args[index - 1] !== "-C" && arg !== "--no-pager");
    if (["diff", "status", "show", "log", "ls-files", "rev-parse", "blame", "grep"].includes(action ?? "") && !args.some((arg) => arg?.startsWith("--output"))) return [];
  }
  if (name === "find" && !args.some((arg) => ["-exec", "-execdir", "-delete", "-fprint"].includes(arg ?? ""))) return [];
  if (name === "sed" && args[0] === "-n" && /^[\d,$]*p$/.test(args[1] ?? "")) return [];
  if (name === "cp" || (name === "sed" && args.some((arg) => arg?.startsWith("-i"))) || (["touch", "tee"].includes(name) && args.filter((arg) => !arg?.startsWith("-")).length === 1)) return [{ kind: "write", target: last }];
  return [{ kind: "write" }];
}

export async function checkHostCommand(command: string, userMessages: () => readonly string[],
  environment: Partial<Record<HostCommand["kind"], string | (() => string | undefined)>> = {}, effects?: WorkEffect[]) {
  const quotes: string[] = [];
  const { parse, createSourceIndex, walk } = await import("sh-syntax");
  async function inspect(source: string): Promise<string> {
    const tree = await parse(source).catch(() => null);
    if (tree === null) {
      if (effects) effects.push({ kind: "write" });
      if (/knit[\s\S]*deliver/.test(source)) quotes.push("");
      return source;
    }
    const nested: Script[] = [];
    const edits: { start: number; end: number; text: string }[] = [];
    const index = createSourceIndex(source);
    walk(tree, (node) => {
      if (effects && node.type === "Redirect" && node.word && [">", ">>", ">|", "&>", "&>>", "<>"].includes(source.slice(index(node.start), index(node.word.start)).trim().replace(/^\d+/, ""))) {
        effects.push({ kind: "write", target: literal(node.word.parts) ?? undefined });
      }
      if (node.type !== "CallExpr") return;
      const call = inspectCall(node, source, index);
      if (effects && call?.kind !== "script") effects.push(...commandEffects(node));
      if (call === null) return;
      if (call.kind === "script") { nested.push(call); return; }
      if (call.kind === "delivery") { quotes.push(call.quote); return; }
      const setting = environment[call.kind];
      const env = typeof setting === "function" ? setting() : setting;
      if (env) edits.push({ start: call.offset, end: call.offset, text: `env ${env} ` });
    });
    for (const script of nested) {
      const updated = await inspect(script.text);
      if (updated === script.text) continue;
      // eval 将各参数用空格拼成脚本。只替换参数本身，保留交错的重定向。
      script.words.forEach((word, i) => edits.push({
        start: index(word.start), end: index(word.end), text: i === 0 ? shellQuote(updated) : "",
      }));
    }
    return edits.sort((a, b) => b.start - a.start).reduce((text, edit) =>
      text.slice(0, edit.start) + edit.text + text.slice(edit.end), source);
  }
  const updated = await inspect(command);
  if (!quotes.length) return { command: updated, reason: null };
  const messages = userMessages();
  const matched = quotes.every((quote) => quote && messages.some((text) =>
    text.trim() === quote || text.split("\n").some((line) => line.trim() === quote)));
  return { command: updated, reason: matched ? null : `无法核对交付授权。${quoteHint}` };
}
