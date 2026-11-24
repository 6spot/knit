import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { initProject } from "../dist/application/init.js";
import { checkSessionTool, createSessionDraft, selectHostTask } from "../dist/application/host-hook.js";
import { toolEffects, workQuestion, workTurn } from "../dist/application/work-choice.js";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task.js";
import { loadBridge } from "./helpers/bridge.mjs";
import { project } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const exec = promisify(execFile);
const systemPath = process.env.PATH;
const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const proposal = "要按这个范围，把避坑清单合并和按区传递一起落实到仓库里吗？";
const approval = "可以，记得我们系统内置的规范 也内置到系统里面，不需要复制进去给用户修改";
const tools = {
  pi: { read: "read", edit: "edit", write: "write", command: "bash", delegate: "subagent" },
  agy: { read: "view_file", edit: "replace_file_content", write: "write_to_file", command: "run_command", delegate: "invoke_subagent" },
  workbuddy: { read: "Read", edit: "Edit", write: "Write", command: "Bash", delegate: "Task" },
};

const rgShim = `#!/bin/sh
nul=0
while [ $# -gt 0 ]; do
  case "$1" in
    -0) nul=1; shift ;;
    --) shift; break ;;
    -*) shift ;;
    *) break ;;
  esac
done
pat="$1"
found=0
for f in *.md; do
  [ -f "$f" ] || continue
  if grep -qF -- "$pat" "$f"; then
    found=1
    if [ "$nul" -eq 1 ]; then printf './%s\\0' "$f"; else printf './%s\\n' "$f"; fi
  fi
done
[ "$found" -eq 1 ]
`;

function installFakeRg(dir, mode = "ok") {
  writeFileSync(join(dir, "rg"), mode === "fail" ? "#!/bin/sh\nexit 2\n" : rgShim, { mode: 0o755 });
}

function withFakeRg(t, mode = "ok") {
  const bin = mkdtempSync(join(tmpdir(), "knit-rg-"));
  const previous = process.env.PATH ?? "";
  installFakeRg(bin, mode);
  process.env.PATH = `${bin}${delimiter}${previous}`;
  t.after(() => {
    process.env.PATH = previous;
    rmSync(bin, { recursive: true, force: true });
  });
  return bin;
}

function workRoot(t) {
  const cwd = project(t);
  writeFileSync(join(cwd, ".knit/workflow.yaml"), "version: 1\nstages:\n  - id: implement\n");
  return cwd;
}

const session = { host: "pi", sessionId: "memory" };
const user = (text) => ({ role: "user", text });
const assistant = (text) => ({ role: "assistant", text });
const search = (cwd, command, text) => ({ role: "search", command, cwd, text });

function check(cwd, transcript, name, input = {}, command, activeSession = session) {
  return checkSessionTool(cwd, activeSession, name, input, command, () => transcript);
}

test("toolEffects 跨宿主映射读写、委派与 Knit 工具", () => {
  assert.deepEqual(toolEffects("edit", { path: "README.md", edits: [{ oldText: "a", newText: "b" }] }),
    [{ kind: "write", target: "README.md", replacement: { from: "a", to: "b" } }]);
  assert.deepEqual(toolEffects("replace_file_content", { TargetFile: "/repo/README.md", TargetContent: "a", ReplacementContent: "b" }),
    [{ kind: "write", target: "/repo/README.md", replacement: { from: "a", to: "b" } }]);
  assert.deepEqual(toolEffects("Edit", { file_path: "/repo/README.md", old_string: "a", new_string: "b" }),
    [{ kind: "write", target: "/repo/README.md", replacement: { from: "a", to: "b" } }]);
  assert.deepEqual(toolEffects("write_to_file", { TargetFile: "/repo/a.txt" }), [{ kind: "write", target: "/repo/a.txt", replacement: undefined }]);
  assert.deepEqual(toolEffects("subagent", {}), [{ kind: "delegate" }]);
  assert.deepEqual(toolEffects("invoke_subagent", {}), [{ kind: "delegate" }]);
  assert.deepEqual(toolEffects("Task", {}), [{ kind: "delegate" }]);
  assert.deepEqual(toolEffects("knit_task", { action: "new" }), [{ kind: "draft" }]);
  assert.deepEqual(toolEffects("knit_task", { action: "ready", taskId: "k-1" }), [{ kind: "ready", target: "k-1" }]);
  assert.deepEqual(toolEffects("knit_run", { action: "start", taskId: "k-1" }), [{ kind: "delegate", target: "k-1" }]);
  assert.deepEqual(toolEffects("read", { path: "README.md" }), []);
});

test("内存矩阵：按内容定位与未写文件名的单点修改直通", async (t) => {
  const cwd = workRoot(t);
  const firstTurn = [user("把项目简介里的「管里任务」改成「管理任务」。")];
  assert.equal(workQuestion(cwd, toolEffects("edit", {
    path: "README.md", edits: [{ oldText: "这里可以管里任务。", newText: "这里可以管理任务。" }],
  }), workTurn(firstTurn), null), null);
  assert.equal((await check(cwd, firstTurn, "bash", {}, "printf '%s\\n' '这里可以管理任务。' > README.md")).reason, null);

  const followUp = [...firstTurn, user("把项目简介末尾的句号改成感叹号。")];
  assert.equal(workQuestion(cwd, toolEffects("edit", {
    path: "README.md", edits: [{ oldText: "。", newText: "！" }],
  }), workTurn(followUp), null), null);
});

for (const [label, request] of [
  ["接下来修复", "接下来修复同步和缓存两个模块之间的数据丢失问题，需要独立审查。"],
  ["下一项工作", "下一项工作：修复同步和缓存之间的数据丢失问题，需要独立审查。"],
]) {
  test(`内存矩阵：完成前一项工作后重新判断新的实施请求（${label}）`, (t) => {
    const cwd = workRoot(t);
    const before = [user("本次不建任务，把 README.md 的错字改好。")];
    assert.equal(workQuestion(cwd, toolEffects("edit", { path: "README.md" }), workTurn(before), null), null);
    const after = [...before, assistant("README.md 里的错字已经改好，校对完成。"), user(request)];
    assert.match(workQuestion(cwd, toolEffects("subagent", {}), workTurn(after), null), /独立审查.*任务吗？/);
  });
}

for (const [label, request, reason] of [
  ["点名三个文件", "请把 README.md、USAGE.md 和 CHANGELOG.md 里的「管里任务」改成「管理任务」。", /多个文件/],
  ["分行列出三个文件", "请把以下三个文件中的「管里任务」改成「管理任务」。\n- README.md\n- USAGE.md\n- CHANGELOG.md", /多个文件/],
  ["点名三个模块", "请统一修改规范加载、项目初始化和执行者交接这三个模块的提示。", /三个模块/],
]) {
  test(`内存矩阵：${label}的首次替换先询问建任务`, (t) => {
    const cwd = workRoot(t);
    const question = workQuestion(cwd, toolEffects("edit", {
      path: "README.md", edits: [{ oldText: "管里任务", newText: "管理任务" }],
    }), workTurn([user(request)]), null);
    assert.match(question, reason);
    assert.match(question, /任务吗？$/);
  });
}

test("内存矩阵：讨论中用 git -C 核对项目状态不触发拦截", async (t) => {
  const cwd = workRoot(t);
  const result = await check(cwd, [user("有必要改项目简介吗？")], "bash", {}, "git -C . status --short -- README.md");
  assert.equal(result.reason, null);
});

for (const evidence of ["助手报告", "仅工具转录"]) {
  for (const count of [1, 3]) {
    for (const entry of ["edit", "command"]) {
      test(`内存矩阵：项目同文替换，${evidence}，命中 ${count} 个文件，首次 ${entry}`, async (t) => {
        const cwd = workRoot(t);
        const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
        files.forEach((file, i) => writeFileSync(join(cwd, file), i < count ? "管里任务" : "仅作上下文"));
        withFakeRg(t, evidence === "仅工具转录" ? "fail" : "ok");
        const matched = files.slice(0, count);
        const transcript = [
          user("请把项目中的所有「管里任务」改成「管理任务」。"),
          ...(evidence === "仅工具转录"
            ? [search(cwd, "rg -l 管里任务 .", matched.map((path) => `./${path}`).join("\n"))]
            : [assistant(`搜索命中 ${matched.join("、")}。读到了相同的原文。`)]),
        ];
        const result = entry === "edit"
          ? await check(cwd, transcript, "edit", { path: files[0], edits: [{ oldText: "管里任务", newText: "管理任务" }] })
          : await check(cwd, transcript, "bash", {}, "printf 管理任务 > README.md");
        if (count === 1) assert.equal(result.reason, null);
        if (count === 3) assert.match(result.reason, /修改多个文件.*任务吗？/);
      });
    }
  }
}

test("内存矩阵：项目同文替换无搜索转录且 rg 不可用时提示先查证范围", (t) => {
  const cwd = workRoot(t);
  withFakeRg(t, "fail");
  const transcript = [user("请把项目中的所有「管里任务」改成「管理任务」。")];
  const question = workQuestion(cwd, toolEffects("edit", {
    path: "README.md", edits: [{ oldText: "管里任务", newText: "管理任务" }],
  }), workTurn(transcript), null);
  assert.match(question, /无法核对项目中这处原文的文件范围/);
});

for (const report of [false, true]) {
  for (const entry of ["edit", "command"]) {
    test(`内存矩阵：三处搜索命中但只授权改项目简介，${report ? "助手复述" : "仅工具转录"}，首次 ${entry}`, async (t) => {
      const cwd = workRoot(t);
      const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
      const transcript = [
        user("只把项目简介里的「管里任务」改成「管理任务」。"),
        search(cwd, "rg -l 管里任务 .", files.map((path) => `./${path}`).join("\n")),
        ...(report ? [assistant(`搜索在多个文件中命中 ${files.join("、")}，接下来更新项目简介。`)] : []),
      ];
      const result = entry === "edit"
        ? await check(cwd, transcript, "edit", { path: files[0], edits: [{ oldText: "管里任务", newText: "管理任务" }] })
        : await check(cwd, transcript, "bash", {}, "printf 管理任务 > README.md");
      assert.equal(result.reason, null);
    });
  }
}

test("内存矩阵：不建任务后澄清与恢复沿用选择，换话题重判", async (t) => {
  const cwd = workRoot(t);
  const transcript = [
    assistant(proposal),
    user(approval),
    user("不建任务，按刚才说的改"),
    assistant("测试要只覆盖第一种输入，还是两种输入都覆盖？"),
    user("两种输入都覆盖"),
    user("另一个输入也要测错误提示。"),
    user("继续"),
  ];
  assert.equal((await check(cwd, transcript, "subagent", { prompt: "覆盖两种输入" })).reason, null);
  assert.equal((await check(cwd, transcript, "bash", {}, "printf corrected > source")).reason, null);

  const switched = [
    ...transcript,
    assistant("接下来换个话题，要跨模块修改登录校验，可以动手吗？"),
    user("可以"),
  ];
  assert.match((await check(cwd, switched, "bash", {}, "printf login > source")).reason, /跨模块.*任务吗？/);
});

test("内存矩阵：草稿澄清、幂等创建、另行确认与放行实施", async (t) => {
  const cwd = workRoot(t);
  const base = [user("建一个修复任务")];
  const choiceKey = workTurn(base).key;
  const created = createSessionDraft(cwd, session, choiceKey, {
    title: "修复规范传递", slug: "fix", verification: "self", priority: "P2", parent: null, dependsOn: [],
  });
  assert.deepEqual(created.problems, []);
  const { id, file } = created.created;

  const clarified = [
    ...base,
    assistant("草稿里的测试范围，要覆盖哪种输入？"),
    user("两种输入都覆盖"),
    user("继续"),
  ];
  assert.equal(workTurn(clarified).key, choiceKey);
  assert.equal(createSessionDraft(cwd, session, workTurn(clarified).key, {
    title: "修复规范传递", slug: "fix", verification: "self", priority: "P2", parent: null, dependsOn: [],
  }).created.id, id);
  assert.equal((await check(cwd, clarified, "bash", {}, `printf '\\n合并清单并按区传递\\n' >> '${file}'`)).reason, null);
  assert.match((await check(cwd, clarified, "knit_task", { action: "ready", taskId: id })).reason, /停在 draft/);
  assert.match((await check(cwd, clarified, "write", { path: "source" })).reason, /停在 draft/);

  const deferred = [
    ...clarified,
    user("两种输入都覆盖，等我确认需求再开始实施。"),
    user("执行者使用测试执行器。"),
  ];
  assert.match((await check(cwd, deferred, "knit_task", { action: "ready", taskId: id })).reason, /停在 draft/);
  assert.match((await check(cwd, deferred, "edit", { path: "source" })).reason, /停在 draft/);

  const confirmed = [
    ...deferred,
    assistant("两种输入都已写进草稿，可以确认这份需求吗？"),
    user("可以"),
  ];
  assert.equal((await check(cwd, confirmed, "knit_task", { action: "ready", taskId: id })).reason, null);
  assert.match((await check(cwd, confirmed, "write", { path: "source" })).reason, /停在 draft/);

  const implementing = [...confirmed, user("现在开始实施这份需求。")];
  assert.equal((await check(cwd, implementing, "write", { path: "source" })).reason, null);
});

test("内存矩阵：继续现有任务与选中实施的任务沿用原任务", async (t) => {
  const cwd = workRoot(t);
  const task = readyTask(cwd);
  assert.deepEqual(selectHostTask(cwd, session, task.id), []);

  const continueTask = [
    user("今天处理“加问候语”。"),
    assistant("需求已经确认，要不要继续这个任务？"),
    user("可以"),
  ];
  assert.match((await check(cwd, continueTask, "knit_task", { action: "new" })).reason, /沿用已选中的任务/);
  assert.equal((await check(cwd, continueTask, "subagent", { prompt: "实现问候语" })).reason, null);

  const selectedImplement = [
    assistant("现有任务的需求已经确认，接下来处理它吗？"),
    user("选中它，接下来就按这份需求实施。"),
    assistant("已选中“加问候语”，需要在入口和输出模块加上问候语。"),
    user("继续"),
  ];
  assert.equal((await check(cwd, selectedImplement, "write", { path: "greeting.txt" })).reason, null);
  assert.equal((await check(cwd, selectedImplement, "knit_run", { action: "start", taskId: task.id })).reason, null);
  assert.equal((await check(cwd, selectedImplement, "bash", {}, `KNIT_SESSION_AGENT=pi knit run start ${task.id}`)).reason, null);
});

test("内存矩阵：原话回放——讨论只读、无关已选任务、全形态拦截、答复恢复与换题", async (t) => {
  const cwd = workRoot(t);
  const unrelated = readyTask(cwd);
  assert.deepEqual(selectHostTask(cwd, session, unrelated.id), []);

  const discussion = [user("有必要合并吗？")];
  assert.equal((await check(cwd, discussion, "read", { path: "source" })).reason, null);
  assert.equal((await check(cwd, discussion, "bash", {}, "cat source 2>/dev/null")).reason, null);

  const agreed = [...discussion, assistant(proposal), user(approval)];
  for (const [name, input, command] of [
    ["subagent", { prompt: "实现分区并迁移清单" }],
    ["edit", { path: "source" }],
    ["write", { path: "source" }],
    ["bash", {}, "mv source moved"],
    ["bash", {}, "printf changed > source"],
    ["bash", {}, "sh -c 'printf nested >> source'"],
    ["bash", {}, "node -e \"require('fs').writeFileSync('source','changed')\""],
    ["knit_task", { action: "new" }],
    ["bash", {}, `knit run start ${unrelated.id}`],
  ]) {
    const denied = (await check(cwd, agreed, name, input, command)).reason;
    assert.match(denied, /任务吗？/, `${name} ${command ?? ""}`);
  }

  const question = (await check(cwd, agreed, "knit_task", { action: "new" })).reason;
  assert.match(question, /多处改动.*任务吗？$/);
  const afterAsk = [...agreed, assistant(question), user("继续")];
  assert.match((await check(cwd, afterAsk, "bash", {}, "printf changed | tee source")).reason, /任务吗？/);

  const declined = [...afterAsk, user("不建任务，按刚才说的改")];
  assert.match((await check(cwd, declined, "knit_task", { action: "new" })).reason, /已选择本次不建/);
  assert.equal((await check(cwd, declined, "subagent", { prompt: "实现分区" })).reason, null);
  assert.equal((await check(cwd, [...declined, user("继续")], "bash", {}, "printf changed > source")).reason, null);

  const newTopic = [...declined, user(`另一个问题，与当前任务 ${unrelated.id} 无关，需要跨模块调整运行器和存储。`)];
  assert.match((await check(cwd, newTopic, "write", { path: "source" })).reason, /跨模块.*任务吗？/);
});

test("内存矩阵：单点小改直通，范围扩大在下一次写入前询问", async (t) => {
  const cwd = workRoot(t);
  const single = [user("请修正 README.md 的拼写，无需独立审查。")];
  assert.equal((await check(cwd, single, "edit", { path: "README.md" })).reason, null);
  const inspected = [...single, user("先查阅两个模块，最后只修改 README.md 的错字。")];
  assert.equal((await check(cwd, inspected, "bash", {}, "printf corrected > README.md")).reason, null);
  const expanded = [...inspected, assistant("查证后发现需要跨模块修改加载和交接，README.md 也要更新。"), user("继续")];
  assert.match((await check(cwd, expanded, "bash", {}, "echo expanded > README.md")).reason, /跨模块.*任务吗？/);
});

// Dispatch the tool only after the installed extension or hook admits it. A delegated
// worker writes a marker so an accidental dispatch is observable independently of the reply.
async function host(t, name, cwd, recordSearch = false) {
  const bridge = name === "pi" ? await loadBridge(t, cwd) : null;
  if (!bridge) initProject(cwd, false, { [name]: true });
  const home = mkdtempSync(join(tmpdir(), "knit-choice-host-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const bin = join(home, ".local/share/mise/shims");
  mkdirSync(bin, { recursive: true });
  symlinkSync(cli, join(bin, "knit"));
  symlinkSync(process.execPath, join(bin, "node"));
  installFakeRg(bin, "ok");
  const env = { ...process.env, HOME: home, PATH: `${bin}${delimiter}${systemPath}` };
  // 只有 Pi 桥接在当前进程找命令。loadBridge 在用例结束时恢复原来的 PATH。
  if (bridge) process.env.PATH = `${bin}${delimiter}${process.env.PATH}`;
  const transcript = join(home, `${name}.jsonl`);
  const agy = name === "agy";
  const settings = bridge ? null : JSON.parse(readFileSync(join(cwd, agy ? ".agents/plugins/knit/hooks.json" : ".workbuddy/settings.json")));
  const hooks = settings?.knit ?? settings?.hooks;
  const group = hooks?.PreToolUse[0];
  const rows = [];
  const calls = [];
  const questions = [];
  function say(role, text) {
    if (bridge) bridge.entries.push({ type: "message", id: `${role}-${bridge.entries.length}`, message: { role, content: text } });
    rows.push(agy ? { type: role === "user" ? "USER_INPUT" : "PLANNER_RESPONSE", source: role === "user" ? "USER_EXPLICIT" : "MODEL", content: text }
      : { type: "message", role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] });
    writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n"));
  }
  async function shell(command) {
    const { stdout } = await exec("/bin/sh", ["-c", command], { cwd, env });
    return stdout.trimEnd();
  }
  async function hook(command, payload) {
    const execution = exec("/bin/sh", ["-c", command], { cwd, env: { ...env, CODEBUDDY_PROJECT_DIR: cwd } });
    execution.child.stdin.end(JSON.stringify(payload));
    const { stdout } = await execution;
    return stdout ? JSON.parse(stdout) : {};
  }
  async function resume() {
    if (bridge) {
      await bridge.reload();
      const event = { systemPromptOptions: { sections: {} } };
      await bridge.fire("before_agent_start", event);
      return event.systemPromptOptions.sections.knit;
    }
    const entry = hooks.SessionStart[0];
    const out = await hook(entry.command ?? entry.hooks[0].command, agy ? { cwd, conversationId: "choice" } : { cwd, session_id: "choice" });
    return out.injectSteps?.[0].systemMessage.systemMessage ?? out.hookSpecificOutput?.additionalContext;
  }
  async function call(kind, value = "", replacement) {
    const tool = tools[name][kind] ?? kind;
    const input = kind === "command" ? (agy ? { CommandLine: value, Cwd: cwd } : { command: value })
      : ["edit", "write", "read"].includes(kind) ? (agy ? { TargetFile: join(cwd, value) } : bridge ? { path: value } : { file_path: join(cwd, value) }) : value;
    if (replacement) Object.assign(input, agy ? { TargetContent: replacement.from, ReplacementContent: replacement.to }
      : bridge ? { edits: [{ oldText: replacement.from, newText: replacement.to }] } : { old_string: replacement.from, new_string: replacement.to });
    const decision = async () => {
      if (!new RegExp(group.matcher).test(tool)) return {};
      const payload = agy ? { conversationId: "choice", cwd, transcriptPath: transcript, toolCall: { name: tool, args: input } }
        : { session_id: "choice", cwd, transcript_path: transcript, tool_name: tool, tool_input: input };
      const out = await hook(group.hooks[0].command, payload);
      const blocked = agy ? out.decision === "deny" : out.hookSpecificOutput?.permissionDecision === "deny";
      if (agy) assert.ok(["allow", "deny"].includes(out.decision));
      if (blocked && !agy && out.hookSpecificOutput.permissionDecisionReason.endsWith("任务吗？")) assert.equal(out.systemMessage, out.hookSpecificOutput.permissionDecisionReason);
      return { block: blocked, reason: out.reason ?? out.hookSpecificOutput?.permissionDecisionReason, command: out.overwrite?.CommandLine ?? out.hookSpecificOutput?.updatedInput?.command };
    };
    const result = bridge ? await bridge.fire("tool_call", { toolName: tool, input }) : await decision();
    if (result?.block) {
      assert.equal(typeof result.reason, "string");
      if (result.reason.includes("任务吗？")) questions.push(result.reason);
      return { denied: result.reason };
    }
    calls.push(tool);
    if (kind === "command") {
      const output = await shell(result?.command ?? (bridge ? input.command : value));
      if (recordSearch && value.startsWith("rg ")) {
        const id = `search-${calls.length}`;
        if (bridge) bridge.entries.push(
          { type: "message", message: { role: "assistant", content: [{ type: "toolCall", id, name: tool, arguments: input }] } },
          { type: "message", message: { role: "toolResult", toolCallId: id, toolName: tool, content: [{ type: "text", text: output }] } });
        if (agy) rows.push(
          { type: "PLANNER_RESPONSE", source: "MODEL", tool_calls: [{ name: tool, args: input }] },
          { type: "GENERIC", source: "MODEL", status: "DONE", content: `Command exited with code 0.\n\nCommand output:\n${output}` });
        if (name === "workbuddy") rows.push(
          { type: "function_call", name: tool, callId: id, arguments: JSON.stringify(input), cwd },
          { type: "function_call_result", name: tool, callId: id, status: "completed", output: { type: "text", text: `Stdout: ${output}\nStderr: (empty)\nExit Code: 0\nSignal: (none)` } });
        writeFileSync(transcript, rows.map((row) => JSON.stringify(row)).join("\n"));
      }
      return { output };
    }
    if (kind === "read") return { output: readFileSync(join(cwd, value), "utf8") };
    if (kind === "delegate") return { output: await shell("printf dispatched > worker") };
    if (replacement) {
      const path = join(cwd, value);
      const content = readFileSync(path, "utf8");
      assert.ok(content.includes(replacement.from));
      return { output: writeFileSync(path, content.replace(replacement.from, replacement.to)) };
    }
    if (kind === "edit" || kind === "write") return { output: writeFileSync(join(cwd, value), "edited") };
    return { output: (await bridge.tool(tool, input)).content[0].text };
  }
  return { cwd, bin, say, call, calls, questions, bridge, resume,
    draft: () => bridge ? call("knit_task", { action: "new", title: "修复规范传递" }) : call("command", "knit task new --title 修复规范传递"),
    taskFiles: () => readdirSync(join(cwd, ".knit/tasks"), { recursive: true }).filter((file) => file.endsWith("task.md")),
  };
}

test("三宿主工作选择协议", { concurrency: 3 }, async (suite) => {
  await Promise.all(Object.keys(tools).map((name) => hostChecks(name, suite)));
});

async function hostChecks(name, suite) {
  await suite.test(`${name} 协议冒烟：转录搜索读取、拒绝文案与不建后恢复`, async (t) => {
    const h = await host(t, name, project(suite), true);
    const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
    files.forEach((file) => writeFileSync(join(h.cwd, file), "管里任务"));
    writeFileSync(join(h.cwd, "source"), "original");

    // 转录搜索证据：禁用 rg 后仍从宿主转录提取三处命中并拦截。
    h.say("user", "请把项目中的所有「管里任务」改成「管理任务」。");
    const found = await h.call("command", "rg -l 管里任务 .");
    assert.deepEqual(found.output.split("\n").sort(), files.map((path) => `./${path}`).sort());
    installFakeRg(h.bin, "fail");
    assert.match((await h.call("edit", files[0], { from: "管里任务", to: "管理任务" })).denied, /修改多个文件.*任务吗？/);
    assert.equal(readFileSync(join(h.cwd, files[0]), "utf8"), "管里任务");

    // 换话题进入讨论与委派协议检查：只读放行、拒绝文案核对、不建后恢复沿用、换题重判。
    h.say("user", "换个话题，有必要合并吗？");
    assert.equal((await h.call("read", "source")).output, "original");
    h.say("assistant", proposal);
    h.say("user", approval);
    assert.match((await h.call("delegate", { prompt: "实现分区" })).denied, /任务吗？/);
    assert.equal(existsSync(join(h.cwd, "worker")), false);
    if (h.bridge) assert.match(h.bridge.messages.find((entry) => entry.message.display).message.content, /任务吗？/);

    h.say("user", "不建任务，按刚才说的改");
    await h.resume();
    h.say("user", "继续");
    assert.equal((await h.call("delegate", { prompt: "实现分区" })).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "worker"), "utf8"), "dispatched");

    h.say("assistant", "接下来换个话题，要跨模块修改登录校验，可以动手吗？");
    h.say("user", "可以");
    assert.match((await h.call("command", "printf login > source")).denied, /跨模块.*任务吗？/);
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "original");
  });

  await suite.test(`${name} 协议冒烟：草稿回执、幂等复投与停在 draft`, async (t) => {
    const h = await host(t, name, project(suite));
    const reference = readyTask(h.cwd);
    const { requirement } = parseTaskDocument(readFileSync(join(h.cwd, reference.dir, "task.md"), "utf8")).document;
    const before = h.taskFiles();

    h.say("assistant", "这次会改到规范加载、初始化和执行者交接，要为它建一个 Knit 任务吗？");
    h.say("user", "建一个修复任务");
    const receipt = (await h.draft()).output;
    const [created, path] = receipt.split("\n");
    const id = created.replace("已创建 ", "");
    const file = join(h.cwd, path);
    assert.ok(receipt.includes(`修复规范传递（${id}） · draft · 当前会话未选中新草稿`));
    assert.ok(receipt.includes(`[task.md](${path})`));
    assert.equal((await h.call("command", `printf '\\n合并清单并按区传递\\n' >> '${path}'`)).denied, undefined);
    const document = parseTaskDocument(readFileSync(file, "utf8")).document;
    writeFileSync(file, renderTaskDocument({ ...document, requirement }));

    await h.resume();
    h.say("user", "继续");
    assert.equal((await h.draft()).output, receipt);
    assert.equal(h.taskFiles().length, before.length + 1);
    const ready = () => h.bridge ? h.call("knit_task", { action: "ready", taskId: id }) : h.call("command", `knit task ready ${id}`);
    assert.match((await ready()).denied, /停在 draft/);
    assert.match((await h.call("write", "source")).denied, /停在 draft/);
    assert.equal(existsSync(join(h.cwd, "source")), false);

    h.say("assistant", "两种输入都已写进草稿，可以确认这份需求吗？");
    h.say("user", "可以");
    assert.equal((await ready()).denied, undefined);
    assert.match(readFileSync(file, "utf8"), /^status: ready$/m);
    assert.ok(existsSync(file.replace(/task\.md$/, "record.json")));
  });
}
