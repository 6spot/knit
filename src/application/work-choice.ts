import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";
import { sha256Text } from "../contracts/primitives.js";
import type { WorkEffect } from "./host-command.js";

export const workGuidance = "讨论、比较方案和只读查证直接进行。已授权且无需委派的单点小改直接处理。实施前、范围扩大或恢复会话时按讨论规范判断跨模块、多文件、查证量、独立审查及用户指定委派等条件。命中时若本次尚无建任务选择，说明命中的条件，直接问是否建 Knit 任务，等待答复再委派或写入。无关的已选任务不能代替本次选择。对实施问题的肯定只确认实施范围。澄清细节、恢复同一工作时沿用原选择，明确转入另一项工作时重新判断。已选中并获准实施的任务可继续执行。要建就创建草稿，仅同意草稿时停在 draft；不建就按已授权范围走宿主流程。";

export type WorkMessage = { role: "user" | "assistant"; text: string } |
  { role: "search"; command: string; cwd: string; text: string };

export function toolEffects(name: string, input: Record<string, unknown>): WorkEffect[] {
  if (name === "knit_task") {
    if (input.action === "new") return [{ kind: "draft" }];
    if (input.action !== "ready" && input.action !== "close") return [];
    return [{ kind: input.action, target: String(input.taskId) }];
  }
  if (name === "knit_run") return input.action === "start" ? [{ kind: "delegate", target: String(input.taskId) }] : [];
  if (/^(?:agent|task|subagent|spawn_agent|invoke_subagent|run_subagent|delegate_task|call_subagent)$/i.test(name)) return [{ kind: "delegate" }];
  if (!/^(?:edit|write|multiedit|notebookedit|apply_patch|write_file|edit_file|write_to_file|(?:multi_)?replace_file_content|sed_file)$/i.test(name)) return [];
  const target = input.path ?? input.file_path ?? input.TargetFile ?? input.AbsolutePath ?? input.Path ?? input.FilePath;
  const candidate: unknown = Array.isArray(input.edits) ? input.edits.length === 1 && input.edits[0] : input;
  const replacement = candidate && typeof candidate === "object" ? candidate as Record<string, unknown> : {};
  const from = replacement.oldText ?? replacement.old_string ?? replacement.TargetContent ?? replacement.Target;
  const to = replacement.newText ?? replacement.new_string ?? replacement.ReplacementContent ?? replacement.Replacement;
  return [{ kind: "write", target: typeof target === "string" ? target : undefined,
    replacement: typeof from === "string" && typeof to === "string" ? { from, to } : undefined }];
}

const newWork = /另(?:外)?一[项件个](?:事|工作|任务|问题|需求)|另开(?:一个)?任务|(?:换|切换|转)(?:到|入)?(?:一?个|一?[件项])(?:话题|问题|任务|工作)|(?:与|跟|和)(?:当前|刚才|之前).{0,24}无关/;
const asksCreate = /(?:创建|建立|新建|建成|建)\s*(?:一?[个份张])?\s*(?:Knit\s*)?[^，。？！?\s]{0,12}(?:任务|草稿)(?:吗|么|好不好)?[?？]$/i;
const assent = /^(?:可以|好[的啊]?|同意|是的?|行|yes)(?:[，,。.!！\s]|$)/i;
const decline = /^(?:这次|本次|先|就|请|我们|这项工作|还是|\s)*(?:不(?:需要|用|要)?(?:创建|建立|新建|建|使用|用)\s*(?:一个|这个)?\s*(?:Knit\s*)?任务|不用\s*Knit)/i;
const create = /^(?:这次|本次|请|先|只|仅|那就|那|就|帮我|可以[，,]\s*|\s)*(?:创建|建立|新建|建)\s*(?:一[个份张]|这[个份张])?[^？?，,。\n]{0,20}(?:任务|草稿)(?:[。.!！\s，,]|$)/i;

function taskChoice(reply: string, question: string) {
  if (/[?？]$/.test(reply)) return;
  const asked = asksCreate.test(question);
  if (reply.split(/[，,；;。\n]/).some((part) => decline.test(part.trim())) || (asked && /^(?:不用|不要|不建|否|no)[。.!！\s]*$/i.test(reply))) return "host";
  if (create.test(reply) || /(?:^|[，,；;。\n])\s*把[^？?，,。\n]{1,30}建成任务/.test(reply) || (asked && assent.test(reply))) return "draft";
}

/** Keep the choice anchored to the user's decision, including across later clarifications. */
export function workTurn(transcript: readonly WorkMessage[]) {
  const messages = transcript.filter((message) => message.role !== "search");
  const boundary = messages.findLastIndex((message, index) => {
    if (message.role === "assistant") return newWork.test(message.text) && messages[index + 1]?.role === "user" && assent.test(messages[index + 1]!.text.trim());
    if (newWork.test(message.text)) return true;
    const previous = messages[index - 1];
    return previous?.role === "assistant" && /(?:已(?:经)?(?:完成|改好|修好|修复)|(?:修改|修复|校对|工作|任务)完成)/.test(previous.text) &&
      /^(?:接下来|下面|下一项(?:工作|任务|需求)?|下一件事)[，,：:\s]*(?:是|要)?(?:请|帮我)?(?:修复|新增|实现|修改|开发|重构|调整|处理)/.test(message.text.trim()) &&
      !/刚才|上述|同一|上面|原来/.test(message.text);
  });
  const start = Math.max(0, boundary);
  const work = messages.slice(start);
  const replies = work.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const previous = work[index - 1];
    const question = previous?.role === "assistant" ? previous.text.trim().split(/(?<=[。！？?!])\s*/).at(-1) ?? "" : "";
    const reply = message.text.trim();
    return [{ message, reply, proposal: assent.test(reply) ? question : "", choice: taskChoice(reply, question), index: start + index }];
  });
  const decisions = replies.filter((turn) => turn.choice);
  const decision = decisions.at(-1);
  const previous = decisions.findLast((turn) => turn.choice !== decision?.choice);
  const anchor = decisions.find((turn) => turn.index > (previous?.index ?? -1));
  const key = sha256Text(JSON.stringify(messages.slice(0, (anchor?.index ?? start) + 1).filter((message) => message.role === "user").map((message) => message.text)));
  return { work, replies, decision, key, transcript };
}

const fileNames = /[\w./-]+\.[a-z][\w-]*/gi;

function delegationReason(scope: string, targetCount: number): string | undefined {
  const changeVerb = /改|更新|替换|修[正复]|删除|添加/;
  const readFinding = /搜[索到了]|检索|命中|查[阅看到过了]|读[取到过了]/;
  const requiredScope = scope.replace(/(?:无需|不用|不需要|不涉及|并未|不必)(?:独立(?:审查|复核)|跨模块|委派|多文件)/gi, "")
    .replace(/[^。；？！\n]+/g, (sentence) => {
      if (!readFinding.test(sentence)) return sentence;
      // “三处都要改”把搜索清单纳入修改范围，单纯报告命中则只保留实际修改的子句。
      if (/(?:都|均|全部|逐[一个]|一并)(?:要|需(?:要)?|得|应(?:该)?)?(?:改|修[改正复]|更新|替换|删除|添加)/.test(sentence)) return sentence;
      const clauses = sentence.split(/(?<=[,，])(?![ \t]*[\w./-]+\.[a-z][\w-]*)/i);
      return clauses.map((part) => readFinding.test(part) && !changeVerb.test(part)
        ? part.replace(fileNames, "").replace(/多(?:个)?文件/g, "") : part).join("");
    });
  const named = /独立(?:审查|复核)|跨(?:越|多个|两个|两|2个)?模块|多文件|多个文件|多个模块|(?:委派|派给|交给)(?:子\s*)?(?:Agent|执行者)|(?:修改|改动|更新|改)\s*(?:[3-9]|[1-9]\d+|[三四五六七八九十])\s*个文件/i.exec(requiredScope);
  if (named) return named[0];
  const read = /(?:读|查阅)\s*(\d+)\s*(行|个文件)/.exec(scope);
  if (read && Number(read[1]) >= (read[2] === "行" ? 1500 : 8)) return read[0];
  // 换行列出的文件属于引出清单的那条修改指令。
  const changes = requiredScope.replace(/[。:：]?[ \t]*\r?\n[ \t]*[-*+]\s+/g, " ").split(/[。；？！\n]/)
    .filter((clause) => changeVerb.test(clause));
  const paths = new Set(changes.flatMap((clause) => clause.match(fileNames) ?? []));
  if (paths.size >= 3) return `修改多个文件（${[...paths].join("、")}）`;
  const modules = changes.flatMap((clause) => clause.split(/[，,]/)).filter((part) => changeVerb.test(part))
    .join("\n").match(/(?:[2-9]|[1-9]\d+|[两二三四五六七八九十])\s*个模块/)?.[0];
  if (modules) return `修改${modules}`;
  if (targetCount >= 3) return "修改多个文件";
  const combined = /(?:把|将)?([^，。？?\n]{1,60}(?:和|及|与)[^，。？?\n]{1,60})(?:一起|一并|同时)(?:落实|实施|修改)/.exec(scope);
  return combined ? `多处改动，需要一起落实「${combined[1]}」` : undefined;
}

const quotedReplacement = /[「“"]([^」”"\n]+)[」”"]\s*(?:都|统一)?(?:改|换|替换|修正)(?:成|为)\s*[「“"]([^」”"\n]+)[」”"]/;

function projectReplacementScope(root: string, turn: ReturnType<typeof workTurn>) {
  const request = turn.replies.findLast(({ proposal, reply }) => /改|替换|换成|修正/.test(proposal + reply));
  if (!request) return;
  const instruction = `${request.proposal}\n${request.reply}`;
  const replacement = quotedReplacement.exec(instruction);
  if (!replacement || !/(?:项目|仓库)(?:范围)?(?:中|内|里)?的?(?:所有|全部|每一处)?[，,\s]*(?:把|将)?\s*$/.test(instruction.slice(0, replacement.index))) return;
  const history = turn.transcript.slice(turn.transcript.indexOf(request.message) + 1);
  const from = replacement[1]!;
  const files = recordedSearchFiles(history, root, from) ?? searchProjectFiles(root, from);
  if (!files) return "无法核对项目中这处原文的文件范围。请先用 rg -l 查明本次替换的文件，再继续实施。";
  if (files.length >= 3) return `这次涉及修改多个文件（${files.slice(0, 3).join("、")}），要为它建一个 Knit 任务吗？`;
}

function recordedSearchFiles(history: readonly WorkMessage[], root: string, from: string) {
  // 常规 rg -l 的参数无歧义时复用清单。其余 shell 写法直接按原文字面查证。
  const search = history.findLast((message) => {
    if (message.role !== "search" || resolve(message.cwd) !== root) return false;
    const args = /^rg\s+(?:-l|--files-with-matches)\s+(?:(-F|--fixed-strings)\s+)?(?:--\s+)?(?:'([^']+)'|"([^"$`\\]+)"|([\p{L}\p{N}_./-]+))\s+\.\s*$/u.exec(message.command.trim());
    return args && (args[2] ?? args[3] ?? args[4]) === from && (args[1] || !/[.*+?^${}()|[\]\\]/.test(from)) &&
      message.text.trimEnd().split(/\r?\n/).every((path) => path.startsWith("./"));
  });
  return search && [...new Set(search.text.trimEnd().split(/\r?\n/).map((path) => path.slice(2)))];
}

function searchProjectFiles(root: string, from: string) {
  const scan = spawnSync("rg", ["--no-config", "-l", "-0", "-F", "--", from, "."], { cwd: root, encoding: "utf8" });
  if (scan.status === 0 || scan.status === 1) return scan.stdout.split("\0").filter(Boolean).map((path) => path.slice(2));
}

function singleEdit(root: string, effect: WorkEffect, instructions: string, scope: string, singleTarget: boolean) {
  if (!effect.target || !/改|修|更[新正]|替?换|添加|删除|写|edit|fix|change|update/i.test(instructions)) return false;
  const path = relative(root, resolve(root, effect.target));
  if (singleTarget && path && !instructions.match(fileNames)) return true;
  if (path && (instructions.includes(path) || scope.split("\n").some((line) => line.includes(path) && /只(?:需)?(?:改|修改|更新)|单点小改/.test(line)))) return true;
  if (/(?:只|仅)(?:需|要)?(?:把|将)?[^\n。？]{0,50}(?:错字|错别字|拼写|标题|文案)/.test(instructions)) return true;
  const pair = effect.replacement;
  if (!pair?.from || !pair.to) return false;
  return instructions.split("\n").some((line) => {
    const from = line.indexOf(pair.from);
    if (from >= 0 && line.indexOf(pair.to, from + pair.from.length) >= 0) return true;
    // Editors can include a whole line of unchanged context around the requested replacement.
    const quoted = quotedReplacement.exec(line);
    return quoted && pair.from.includes(quoted[1]!) && pair.from.replace(quoted[1]!, () => quoted[2]!) === pair.to;
  });
}

export function workQuestion(root: string, effects: readonly WorkEffect[], turn: ReturnType<typeof workTurn>,
  selected: { id: string; title: string } | null, draft?: { id: string; file: string }): string | null {
  const instructions = turn.replies.flatMap(({ reply, proposal }) => [proposal, reply]).filter(Boolean).join("\n");
  const scope = turn.work.map((message) => message.text).join("\n");
  const targets = new Set(effects.filter((effect) => effect.kind === "write" && effect.target !== "/dev/null").map((effect) => effect.target));
  const required = delegationReason(scope, targets.size);
  const last = turn.replies.findLast(({ reply }) => !/^(?:请)?(?:继续|接着做|continue)[。.!！\s]*$/i.test(reply))?.reply ?? "";
  const discussion = /[?？]$|只(?:是)?讨论|先别(?:改|做)|不要(?:改|实施|动手)/.test(last);
  const existing = selected && turn.replies.some(({ reply, proposal }) => !newWork.test(reply) && [reply, proposal].some((text) =>
    !asksCreate.test(text) && (text.includes(selected.id) || text.includes(selected.title) || /(?:选中|选上)(?:它|这[个项]任务)|(?:沿用|继续|实施|执行|处理|完成)(?:这[个份]|当前|选中的)\s*(?:Knit\s*)?任务/.test(text))));
  const choice = turn.decision?.choice;
  const later = turn.replies.filter(({ index, reply }) => index > (turn.decision?.index ?? -1) && !/[?？]$/.test(reply))
    .flatMap(({ reply, proposal }) => [reply, /先不|暂不|不要|还没|别(?:动手|实施|确认)/.test(reply) ? "" : proposal.split(/[，,；;\n]/).at(-1) ?? ""])
    .flatMap((text) => text.split(/[，,；;。！!\n]/)).map((clause) => clause.trim()
      .replace(/^(?:(?:我(?:们)?|请|现在|已经?|可以|同意|先|只|要不要|是否)\s*)+/, ""));
  // 只采纳用户直接发出的指令，或用户肯定答复所针对的问句。
  const confirmed = later.some((clause) => /^(?:确认(?:这份|这个|当前|本次)?需求|需求(?:已经|已)?确认)(?:了|吧|吗)?[？?.]?$/.test(clause));
  const implement = later.some((clause) => /^(?:开始|继续|确认需求并(?:开始)?|按.{1,12})(?:实施|动手|执行)(?!之?[前后]|时|再)/.test(clause) ||
    /^(?:实施|动手|执行)(?:这[个项]任务|这份需求)?(?:了|吧|吗)?[？?.]?$/.test(clause));
  for (const effect of effects) {
    if (effect.kind === "write" && effect.target === "/dev/null") continue;
    if (effect.kind === "draft") {
      if (choice === "host") return "用户已选择本次不建 Knit 任务，按已授权范围继续。";
      if (choice === "draft") continue;
      if (existing) return "用户选择继续当前任务。请沿用已选中的任务。";
      return `${required ? `这次涉及${required}，` : ""}要为这次工作建一个 Knit 任务吗？`;
    }
    if (choice === "draft") {
      if (effect.kind === "write" && effect.target && draft?.file === relative(root, resolve(root, effect.target))) continue;
      if (draft && effect.kind === "ready" && effect.target === draft.id && (confirmed || implement)) continue;
      if (draft && implement && (effect.kind === "write" || effect.target === draft.id)) continue;
      return "用户同意了建草稿。写好本次草稿后停在 draft，回报标题、编号、task.md 链接及选中状态。";
    }
    if (discussion) return "当前仍在讨论。可以继续只读查证，等待用户授权实施。";
    if (choice === "host" || (existing && (effect.kind === "write" || !effect.target || effect.target === selected?.id))) continue;
    if (effect.kind !== "write" && effect.target && turn.replies.some(({ reply }) =>
      !newWork.test(reply) && reply.includes(effect.target!) && /确认|执行|实施|派发|启动|开始|完成|关闭|ready|start|close/i.test(reply))) continue;
    if (effect.kind === "write" && !required) {
      const discovered = projectReplacementScope(root, turn);
      if (discovered) return discovered;
      if (singleEdit(root, effect, instructions, scope, targets.size === 1)) continue;
      return "先只读核对本次已授权的实施范围。单点小改可以直接处理；达到委派条件时，说明具体条件并询问是否建 Knit 任务。";
    }
    return `${required ? `这次涉及${required}` : "这次准备委派执行者"}，要为它建一个 Knit 任务吗？`;
  }
  return null;
}
