// 场景二：主会话（真的 Pi，rpc 模式）通过桥接走完一个任务。本脚本当用户，一条一条发消息。
// 做完之后重开这个会话问一句话，看选中的任务还在不在（「另外记下的」第 3 项）。
import { execFileSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, globSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { cleanEnv, startPi } from "./rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// 模型写成 provider/模型，第一个 / 之前是 provider；日志目录可以从外面指定。
const model = process.env.KNIT_H1_MODEL || "magpie/group/deepseek";
const [provider, ...modelName] = model.split("/");
const base = execFileSync(join(here, "setup.sh"), ["bridge"], { encoding: "utf8" }).trim();
const proj = join(base, "proj");
const logs = join(process.env.KNIT_H1_LOGS || join(here, "logs"), "bridge");
mkdirSync(logs, { recursive: true });
const env = cleanEnv({ PATH: `${join(base, "bin")}:${process.env.PATH}` });
// --no-context-files：不然会话记录里会带上用户主目录下 AGENTS.md 的全文，而这些记录要存进仓库。
const ARGS = [
  "--approve", "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
  "--provider", provider, "--model", modelName.join("/"),
  "--session-dir", join(base, "sessions"),
  "--tools", "read,write,edit,bash,ls,grep,find,knit_task,knit_run,knit_deliver",
];
const SUBJECT = "feat: let greet take a greeting word";
const APPROVAL = "可以交付";

const problems = [];
function check(ok, what) {
  console.log(`  ${ok ? "符合" : "不符合"}：${what}`);
  if (!ok) problems.push(what);
}
const textOf = (content) =>
  typeof content === "string" ? content : (content ?? []).filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
const short = (value, max = 160) => {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length > max ? `${text.slice(0, max)}…` : text;
};
const git = (...args) => execFileSync("git", args, { cwd: proj, encoding: "utf8" }).trim();
/** 任务的 record.json：归档之前和之后位置不同。 */
function readRecord() {
  const [file] = globSync(".knit/tasks/{*,archive/*/*}/record.json", { cwd: proj });
  return file === undefined ? null : JSON.parse(readFileSync(join(proj, file), "utf8"));
}
const endedRuns = () => (readRecord()?.runs ?? []).filter((run) => run.endedAt !== null);

const pi = startPi({ cwd: proj, env, args: ARGS, log: join(logs, "events.jsonl") });
const entries = async () => (await pi.call("get_entries")).data.entries;
const notices = (list) => list.filter((entry) => entry.type === "custom_message" && entry.customType === "knit.run-ended");

/** 发一条用户消息，等这一轮结束。 */
async function say(message, timeoutMs = 300_000) {
  const from = pi.events.length;
  const started = Date.now();
  console.log(`\n用户：${short(message.split("\n")[0], 200)}`);
  const accepted = await pi.call("prompt", { message });
  if (!accepted.success) throw new Error(`消息没有被接受：${JSON.stringify(accepted)}`);
  const settled = await pi.waitEvent((event) => event.type === "agent_settled", from, timeoutMs, "这一轮结束");
  const reply = (await pi.call("get_last_assistant_text")).data?.text ?? "";
  console.log(`主会话（${((Date.now() - started) / 1000).toFixed(1)}s，aborted=${pi.events[settled].aborted}）：${short(reply, 500)}`);
}

let sessionFile = null;
let taskId = null;
try {
  sessionFile = (await pi.call("get_state")).data.sessionFile;
  console.log(`会话文件: ${sessionFile}`);

  await say("用 knit_task 工具新建一个任务：标题是「greet 支持自定义问候语」，slug 是 greet-word，verification 是 independent。建好之后用 knit_task 的 use 选中它，然后告诉我任务的 id。");
  const [taskFile] = globSync(".knit/tasks/*/task.md", { cwd: proj });
  taskId = taskFile === undefined ? null : /^id: (k-[0-9a-f]{12})$/m.exec(readFileSync(join(proj, taskFile), "utf8"))?.[1] ?? null;
  console.log(`任务: ${taskId}（${taskFile}）`);
  if (taskId === null) throw new Error("第一条消息之后没有建出任务");

  await say(
    [
      "把下面这段需求正文写进这个任务的 task.md：文件开头两条 --- 之间的元数据原样保留，元数据后面的内容整个换成这段正文。写好之后用 knit_task 的 ready 确认需求，把确认的结果告诉我。",
      "",
      "<正文>",
      readFileSync(join(here, "task-body.md"), "utf8").trimEnd(),
      "</正文>",
    ].join("\n"),
  );

  await say("用 knit_run 的 start 派发这个任务。派发之后不要轮询，也不要自己动手实现：执行结束时你会收到一条消息。收到之后，如果下一步还是派发，就接着用 knit_run 派发；下一步是核对的时候停下来告诉我。");
  // 之后脚本不再说话：等审查通过、每次执行的结束消息都到了、主会话停下来。连着两次看到才算。
  const waitStarted = Date.now();
  for (let quiet = 0; quiet < 2; ) {
    if (Date.now() - waitStarted > 900_000) throw new Error("等了 15 分钟：执行没有走到审查通过，或者主会话没有停下来");
    await sleep(1000);
    const runs = endedRuns();
    const list = await entries();
    const state = (await pi.call("get_state")).data;
    const lastNotice = list.findLastIndex((entry) => entry.type === "custom_message" && entry.customType === "knit.run-ended");
    const answered = list.slice(lastNotice + 1).some((entry) => entry.type === "message" && entry.message.role === "assistant");
    const done =
      runs.at(-1)?.verdict === "pass" && notices(list).length >= runs.length && answered && !state.isStreaming && state.pendingMessageCount === 0;
    quiet = done ? quiet + 1 : 0;
  }
  console.log(`\n（脚本没有说话）等了 ${((Date.now() - waitStarted) / 1000).toFixed(1)}s，主会话停下来了：${short((await pi.call("get_last_assistant_text")).data?.text ?? "", 500)}`);

  await say(`核对执行者的成果：看改动的文件，运行 node --test。没有问题就用 knit_task 的 close 把任务记为完成，result 写清做成了什么、怎么验证的。然后用 knit_deliver 预览交付（preview 为 true），message 写 ${SUBJECT}。先不要真的交付，把预览的内容告诉我。`);
  const beforeDelivery = { head: git("rev-parse", "HEAD"), status: execFileSync(join(base, "bin", "knit"), ["task", "show", taskId, "--dir", proj], { encoding: "utf8" }).match(/^状态: (.*)$/m)?.[1] };
  console.log(`预览之后：任务状态 ${beforeDelivery.status}，HEAD ${beforeDelivery.head.slice(0, 7)}`);

  await say(APPROVAL);

  // ---- 核对 ----
  const list = await entries();
  const record = readRecord();
  console.log("\n执行:");
  for (const run of record.runs) {
    console.log(`  ${run.id} ${run.stage} 用时 ${((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 1000).toFixed(1)}s 失败 ${run.failure} 结论 ${run.verdict} 改动 ${run.changedPaths.join(",")}`);
  }
  console.log("\n模型调用的工具:");
  const calls = list.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "assistant" ? entry.message.content.filter((block) => block.type === "toolCall") : [],
  );
  for (const call of calls) console.log(`  ${call.name} ${short(call.arguments, 200)}`);
  console.log("\n系统提示里 knit 那一段（每次变化）:");
  const knitSections = list.flatMap((entry) =>
    entry.type === "message" && entry.message.role === "system" && typeof entry.message.sections?.knit === "string" ? [entry.message.sections.knit] : [],
  );
  for (const section of knitSections) console.log(`  ${short(section.replaceAll("\n", " ⏎ "), 260)}`);
  console.log("\n执行结束的消息:");
  for (const notice of notices(list)) console.log(`  ${notice.id} ${short(textOf(notice.content).replaceAll("\n", " ⏎ "), 260)}`);

  console.log("\n完成条件:");
  const used = new Set(calls.map((call) => call.name));
  check(["knit_task", "knit_run", "knit_deliver"].every((name) => used.has(name)), "模型调用过 knit_task、knit_run 和 knit_deliver");
  check(knitSections.some((section) => section.includes(taskId)), "会话记录里系统提示的 knit 那一段出现过这个任务的 id");
  // 另外记下的：规范按环节给主会话。实现、审查环节的规范在执行者跑的时候给，收尾环节的在核对和交付的时候给。
  const stageOf = (section) => /^状态: (.*)$/m.exec(section)?.[1] ?? "没有选中";
  console.log("  （每一段里的规范：" + knitSections.map((section) => `${stageOf(section)} → ${[...section.matchAll(/<standard[^>]*>/g)].map((match) => match[0]).join("") || "没有"}`).join("；") + "）");
  const atDone = knitSections.find((section) => stageOf(section) === "done") ?? "";
  check(atDone.includes("提交文案的标题用英文") && !atDone.includes("测试的名字用中文写"), "任务是 done 的时候，knit 那一段里有收尾环节的规范，没有实现环节的");
  // 第三条和第四条用户消息之间：没有别的用户消息，每条结束消息后面都有主会话的回应。
  const users = list.flatMap((entry, index) => (entry.type === "message" && entry.message.role === "user" ? [index] : []));
  check(users.length === 5, `会话记录里正好五条用户消息（实际 ${users.length} 条）`);
  const between = list.slice(users[2] + 1, users[3]);
  const noticeAt = between.flatMap((entry, index) => (entry.type === "custom_message" && entry.customType === "knit.run-ended" ? [index] : []));
  const eachAnswered = noticeAt.every((at, i) =>
    between.slice(at + 1, noticeAt[i + 1] ?? between.length).some((entry) => entry.type === "message" && entry.message.role === "assistant"),
  );
  check(
    noticeAt.length === record.runs.length && noticeAt.length >= 2 && eachAnswered,
    `每次执行结束之后，没有新的用户消息，主会话也开始了一轮（${record.runs.length} 次执行，${noticeAt.length} 条结束消息，每条后面都有回应：${eachAnswered}）`,
  );
  // 事件里看：这几轮是由结束消息开始的。一轮开头可能先补发系统提示，跳过它看第一条别的消息。
  const starts = pi.events.flatMap((event, index) => (event.type === "agent_start" ? [index] : []));
  const startedByNotice = starts.filter((at) => {
    const first = pi.events.slice(at + 1).find((event) => event.type === "message_start" && event.message?.role !== "system");
    return first?.message?.customType === "knit.run-ended";
  }).length;
  check(startedByNotice === record.runs.length, `这几轮由 knit.run-ended 消息开始（事件里一共 ${starts.length} 轮，其中 ${startedByNotice} 轮是）`);
  const head = git("rev-parse", "HEAD");
  const files = git("show", "--name-only", "--format=", "HEAD").split("\n");
  console.log(`\n提交: ${git("log", "-1", "--format=%h %s")}\n${files.map((file) => `  ${file}`).join("\n")}`);
  check(
    head !== beforeDelivery.head && beforeDelivery.status === "done" && git("rev-list", "--count", `${beforeDelivery.head}..HEAD`) === "1",
    "说「可以交付」之前任务是 done、没有提交；之后产生一次提交",
  );
  check(
    git("log", "-1", "--format=%s") === SUBJECT && git("log", "-1", "--format=%B").trim().endsWith(`Knit-Task: ${taskId}`) && ["greet.mjs", "greet.test.mjs"].every((file) => files.includes(file)),
    "提交的标题是给的文案，最后一行是 Knit-Task: <id>，里面有 greet.mjs 和 greet.test.mjs",
  );
  const approval = list.findLast((entry) => entry.type === "message" && entry.message.role === "user" && textOf(entry.message.content).trim() === APPROVAL);
  console.log(`授权: record.json 里是 ${JSON.stringify(record.authorization)}；「${APPROVAL}」那条用户消息的条目 id 是 ${approval?.id}`);
  check(record.authorization === `user:${approval?.id} ${APPROVAL}`, "record.json 里的授权是 user:<条目 id> 可以交付，条目 id 是那条用户消息的");
} catch (error) {
  problems.push(`脚本中断：${error.message}`);
  console.log(`\n脚本中断：${error.stack}`);
} finally {
  const done = await pi.stop();
  console.log(`\nPi 退出: ${JSON.stringify(done)}；标准错误: ${JSON.stringify(pi.stderr().slice(-600))}`);
}

// ---- 另外记下的第 3 项：重开会话，选中的任务还在不在 ----
if (sessionFile !== null && taskId !== null && existsSync(sessionFile)) {
  const again = startPi({ cwd: proj, env, args: [...ARGS, "--session", sessionFile], log: join(logs, "events-reopen.jsonl") });
  try {
    const before = (await again.call("get_entries")).data.entries.length;
    const from = again.events.length;
    await again.call("prompt", { message: "不要调用工具，只按系统提示里 Knit 那一段回答：现在选中的 Knit 任务的 id 和状态是什么？" });
    await again.waitEvent((event) => event.type === "agent_settled", from, 180_000, "重开之后的这一轮结束");
    const added = (await again.call("get_entries")).data.entries.slice(before);
    const section = added.find((entry) => entry.type === "message" && entry.message.role === "system" && typeof entry.message.sections?.knit === "string")?.message.sections.knit;
    const reply = (await again.call("get_last_assistant_text")).data?.text ?? "";
    console.log(`\n重开会话之后：\n  系统提示里补发的 knit 那一段: ${section === undefined ? "没有补发" : short(section.replaceAll("\n", " ⏎ "), 260)}\n  主会话的回答: ${short(reply, 300)}`);
    console.log(`  回答里有任务 id: ${reply.includes(taskId)}`);
  } catch (error) {
    console.log(`\n重开会话这一项没有做完：${error.message}`);
  } finally {
    await again.stop();
  }
}

// 留给记录用的文件。
if (sessionFile !== null && existsSync(sessionFile)) copyFileSync(sessionFile, join(logs, "session.jsonl"));
const [recordFile] = globSync(".knit/tasks/{*,archive/*/*}/record.json", { cwd: proj });
if (recordFile !== undefined) copyFileSync(join(proj, recordFile), join(logs, "record.json"));
for (const run of globSync(".knit/.runtime/runs/*", { cwd: proj })) {
  for (const name of ["report.md", "message.md", "system.md"]) {
    if (existsSync(join(proj, run, name))) cpSync(join(proj, run, name), join(logs, basename(run), name));
  }
}

console.log(problems.length === 0 ? "\n场景二通过" : `\n场景二没有通过：\n${problems.map((problem) => `  - ${problem}`).join("\n")}`);
process.exit(problems.length === 0 ? 0 : 1);
