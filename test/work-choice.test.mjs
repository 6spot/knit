import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadBridge } from "./helpers/bridge.mjs";
import { knit, project } from "./helpers/cli.mjs";
import { readyTask, runProject } from "./helpers/run.mjs";
import { parseTaskDocument, renderTaskDocument } from "../dist/domain/task-document.js";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const proposal = "要按这个范围，把避坑清单合并和按区传递一起落实到仓库里吗？";
const approval = "可以，记得我们系统内置的规范 也内置到系统里面，不需要复制进去给用户修改";
const tools = {
  pi: { read: "read", edit: "edit", write: "write", command: "bash", delegate: "subagent" },
  agy: { read: "view_file", edit: "replace_file_content", write: "write_to_file", command: "run_command", delegate: "invoke_subagent" },
  workbuddy: { read: "Read", edit: "Edit", write: "Write", command: "Bash", delegate: "Task" },
};

// Dispatch the tool only after the installed extension or hook admits it. A delegated
// worker writes a marker so an accidental dispatch is observable independently of the reply.
async function host(t, name, cwd = project(t), recordSearch = false) {
  const bridge = name === "pi" ? await loadBridge(t, cwd) : null;
  assert.equal(knit(cwd, "init", `--${name}`).code, 0);
  const home = process.env.KNIT_HOME;
  const bin = join(home, ".local/share/mise/shims");
  mkdirSync(bin, { recursive: true });
  symlinkSync(cli, join(bin, "knit"));
  symlinkSync(process.execPath, join(bin, "node"));
  const env = { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` };
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
  function shell(command) {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd, env, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trimEnd();
  }
  function hook(command, payload) {
    const result = spawnSync("/bin/sh", ["-c", command], { cwd, encoding: "utf8", env: { ...env, CODEBUDDY_PROJECT_DIR: cwd }, input: JSON.stringify(payload) });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout ? JSON.parse(result.stdout) : {};
  }
  async function resume() {
    if (bridge) {
      await bridge.reload();
      const event = { systemPromptOptions: { sections: {} } };
      await bridge.fire("before_agent_start", event);
      return event.systemPromptOptions.sections.knit;
    }
    const entry = hooks.SessionStart[0];
    const out = hook(entry.command ?? entry.hooks[0].command, agy ? { cwd, conversationId: "choice" } : { cwd, session_id: "choice" });
    return out.injectSteps?.[0].systemMessage.systemMessage ?? out.hookSpecificOutput?.additionalContext;
  }
  async function call(kind, value = "", replacement) {
    const tool = tools[name][kind] ?? kind;
    const input = kind === "command" ? (agy ? { CommandLine: value, Cwd: cwd } : { command: value })
      : ["edit", "write", "read"].includes(kind) ? (agy ? { TargetFile: join(cwd, value) } : bridge ? { path: value } : { file_path: join(cwd, value) }) : value;
    if (replacement) Object.assign(input, agy ? { TargetContent: replacement.from, ReplacementContent: replacement.to }
      : bridge ? { edits: [{ oldText: replacement.from, newText: replacement.to }] } : { old_string: replacement.from, new_string: replacement.to });
    const decision = () => {
      if (!new RegExp(group.matcher).test(tool)) return {};
      const payload = agy ? { conversationId: "choice", cwd, transcriptPath: transcript, toolCall: { name: tool, args: input } }
        : { session_id: "choice", cwd, transcript_path: transcript, tool_name: tool, tool_input: input };
      const out = hook(group.hooks[0].command, payload);
      const blocked = agy ? out.decision === "deny" : out.hookSpecificOutput?.permissionDecision === "deny";
      if (agy) assert.ok(["allow", "deny"].includes(out.decision));
      if (blocked && !agy && out.hookSpecificOutput.permissionDecisionReason.endsWith("任务吗？")) assert.equal(out.systemMessage, out.hookSpecificOutput.permissionDecisionReason);
      return { block: blocked, reason: out.reason ?? out.hookSpecificOutput?.permissionDecisionReason, command: out.overwrite?.CommandLine ?? out.hookSpecificOutput?.updatedInput?.command };
    };
    const result = bridge ? await bridge.fire("tool_call", { toolName: tool, input }) : decision();
    if (result?.block) {
      assert.equal(typeof result.reason, "string");
      if (result.reason.includes("任务吗？")) questions.push(result.reason);
      return { denied: result.reason };
    }
    calls.push(tool);
    if (kind === "command") {
      const output = shell(result?.command ?? (bridge ? input.command : value));
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
    if (kind === "delegate") return { output: shell("printf dispatched > worker") };
    if (replacement) {
      const path = join(cwd, value);
      const content = readFileSync(path, "utf8");
      assert.ok(content.includes(replacement.from));
      return { output: writeFileSync(path, content.replace(replacement.from, replacement.to)) };
    }
    if (kind === "edit" || kind === "write") return { output: writeFileSync(join(cwd, value), "edited") };
    return { output: (await bridge.tool(tool, input)).content[0].text };
  }
  return { cwd, say, call, calls, questions, bridge, resume,
    draft: () => bridge ? call("knit_task", { action: "new", title: "修复规范传递" }) : call("command", "knit task new --title 修复规范传递"),
    taskFiles: () => readdirSync(join(cwd, ".knit/tasks"), { recursive: true }).filter((file) => file.endsWith("task.md")),
  };
}

for (const name of Object.keys(tools)) {
  test(`${name} 回归：按内容定位的一处替换`, async (t) => {
    const h = await host(t, name);
    const replacement = { from: "这里可以管里任务。", to: "这里可以管理任务。" };
    writeFileSync(join(h.cwd, "README.md"), "这里可以管里任务。\n");
    h.say("user", "把项目简介里的「管里任务」改成「管理任务」。");
    assert.equal((await h.call("command", "rg -l 管里任务 .")).output, "./README.md");
    assert.equal((await h.call("read", "README.md")).output, "这里可以管里任务。\n");
    assert.equal((await h.call("edit", "README.md", replacement)).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "README.md"), "utf8"), "这里可以管理任务。\n");
    assert.deepEqual(h.questions, []);
  });

  test(`${name} 未写文件名的单点修改通过命令和编辑工具完成`, async (t) => {
    const h = await host(t, name);
    const file = join(h.cwd, "README.md");
    writeFileSync(file, "这里可以管里任务。\n");
    h.say("user", "把项目简介里的「管里任务」改成「管理任务」。");
    assert.equal((await h.call("command", "rg -l 管里任务 .")).output, "./README.md");
    assert.equal((await h.call("read", "README.md")).output, "这里可以管里任务。\n");
    assert.equal((await h.call("command", "printf '%s\\n' '这里可以管理任务。' > README.md")).denied, undefined);
    assert.equal(readFileSync(file, "utf8"), "这里可以管理任务。\n");
    h.say("user", "把项目简介末尾的句号改成感叹号。");
    assert.equal((await h.call("edit", "README.md", { from: "。", to: "！" })).denied, undefined);
    assert.equal(readFileSync(file, "utf8"), "这里可以管理任务！\n");
    assert.deepEqual(h.questions, []);
  });

  for (const [label, request] of [
    ["接下来修复", "接下来修复同步和缓存两个模块之间的数据丢失问题，需要独立审查。"],
    ["下一项工作", "下一项工作：修复同步和缓存之间的数据丢失问题，需要独立审查。"],
  ]) {
    test(`${name} 完成前一项工作后重新判断新的实施请求（${label}）`, async (t) => {
      const h = await host(t, name);
      h.say("user", "本次不建任务，把 README.md 的错字改好。");
      assert.equal((await h.call("edit", "README.md")).denied, undefined);
      h.say("assistant", "README.md 里的错字已经改好，校对完成。");
      h.say("user", request);
      assert.match((await h.call("delegate", { prompt: "修复同步问题" })).denied, /独立审查.*任务吗？/);
      assert.equal(existsSync(join(h.cwd, "worker")), false);
      assert.equal(h.questions.length, 1);
    });
  }

  for (const [label, request, reason] of [
    ["点名三个文件", "请把 README.md、USAGE.md 和 CHANGELOG.md 里的「管里任务」改成「管理任务」。", /多个文件/],
    ["分行列出三个文件", "请把以下三个文件中的「管里任务」改成「管理任务」。\n- README.md\n- USAGE.md\n- CHANGELOG.md", /多个文件/],
    ["点名三个模块", "请统一修改规范加载、项目初始化和执行者交接这三个模块的提示。", /三个模块/],
  ]) {
    test(`${name} 回归：${label}的首次替换`, async (t) => {
      const h = await host(t, name);
      const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
      for (const path of files) writeFileSync(join(h.cwd, path), "管里任务");
      h.say("user", request);
      const first = await h.call("edit", files[0], { from: "管里任务", to: "管理任务" });
      assert.match(first.denied, reason);
      assert.deepEqual(files.map((path) => readFileSync(join(h.cwd, path), "utf8")), files.map(() => "管里任务"));
      assert.deepEqual(h.calls, []);
      assert.equal(h.questions.length, 1);
    });
  }

  test(`${name} 讨论中用 git -C 核对项目状态`, async (t) => {
    const h = await host(t, name, runProject(t));
    writeFileSync(join(h.cwd, "README.md"), "项目简介");
    h.say("user", "有必要改项目简介吗？");
    assert.equal((await h.call("command", "git -C . status --short -- README.md")).output, "?? README.md");
    assert.deepEqual(h.questions, []);
  });

  for (const evidence of ["助手报告", "仅工具转录"]) {
    for (const count of [1, 3]) {
      for (const entry of ["edit", "command"]) {
        test(`${name} 项目同文替换，${evidence}，命中 ${count} 个文件，首次 ${entry}`, async (t) => {
          const h = await host(t, name, project(t), evidence === "仅工具转录");
          const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
          const original = files.map((_, i) => i < count ? "管里任务" : "仅作上下文");
          files.forEach((file, i) => writeFileSync(join(h.cwd, file), original[i]));
          const tasks = h.taskFiles();
          h.say("user", "请把项目中的所有「管里任务」改成「管理任务」。");
          const found = await h.call("command", "rg -l 管里任务 .");
          assert.deepEqual(found.output.split("\n").sort(), files.slice(0, count).map((path) => `./${path}`).sort());
          for (const [i, file] of files.entries()) assert.equal((await h.call("read", file)).output, original[i]);
          if (evidence === "助手报告") h.say("assistant", `搜索命中 ${files.slice(0, count).join("、")}。读到了相同的原文。`);
          if (evidence === "仅工具转录") {
            // 已有完整清单时，即便钩子无法再次运行 rg，也能判定范围。
            const bin = join(process.env.KNIT_HOME, ".local/share/mise/shims");
            writeFileSync(join(bin, "rg"), "#!/bin/sh\nexit 2\n", { mode: 0o755 });
            if (h.bridge) process.env.PATH = `${bin}:${process.env.PATH}`;
          }
          const before = h.calls.length;
          const first = entry === "edit" ? await h.call(entry, files[0], { from: "管里任务", to: "管理任务" })
            : await h.call(entry, "printf 管理任务 > README.md");
          if (count === 1) assert.equal(first.denied, undefined);
          if (count === 3) assert.match(first.denied, /修改多个文件.*任务吗？/);
          assert.deepEqual(h.calls.slice(before), count === 1 ? [tools[name][entry]] : []);
          assert.equal(h.questions.length, count === 1 ? 0 : 1);
          assert.deepEqual(files.map((path) => readFileSync(join(h.cwd, path), "utf8")), count === 1 ? ["管理任务", ...original.slice(1)] : original);
          assert.deepEqual(h.taskFiles(), tasks);
        });
      }
    }
  }

  for (const report of [false, true]) {
    for (const entry of ["edit", "command"]) {
      test(`${name} 相同的三处搜索命中，用户只授权改项目简介，${report ? "助手复述" : "仅工具转录"}，首次 ${entry}`, async (t) => {
        const h = await host(t, name, project(t), true);
        const files = ["README.md", "USAGE.md", "CHANGELOG.md"];
        files.forEach((path) => writeFileSync(join(h.cwd, path), "管里任务"));
        const tasks = h.taskFiles();
        h.say("user", "只把项目简介里的「管里任务」改成「管理任务」。");
        const found = await h.call("command", "rg -l 管里任务 .");
        assert.deepEqual(found.output.split("\n").sort(), files.map((path) => `./${path}`).sort());
        for (const file of files) assert.equal((await h.call("read", file)).output, "管里任务");
        if (report) h.say("assistant", `搜索在多个文件中命中 ${files.join("、")}，接下来更新项目简介。`);
        const before = h.calls.length;
        const first = entry === "edit" ? await h.call(entry, files[0], { from: "管里任务", to: "管理任务" })
          : await h.call(entry, "printf 管理任务 > README.md");
        assert.equal(first.denied, undefined);
        assert.deepEqual(h.calls.slice(before), [tools[name][entry]]);
        assert.deepEqual(files.map((path) => readFileSync(join(h.cwd, path), "utf8")), ["管理任务", "管里任务", "管里任务"]);
        assert.deepEqual(h.questions, []);
        assert.deepEqual(h.taskFiles(), tasks);
      });
    }
  }

  test(`${name} 回归：不建任务后澄清测试范围`, async (t) => {
    const h = await host(t, name);
    const before = h.taskFiles();
    h.say("assistant", proposal);
    h.say("user", approval);
    h.say("user", "不建任务，按刚才说的改");
    h.say("assistant", "测试要只覆盖第一种输入，还是两种输入都覆盖？");
    h.say("user", "两种输入都覆盖");
    h.say("user", "另一个输入也要测错误提示。");
    await h.resume();
    h.say("user", "继续");
    assert.equal((await h.call("delegate", { prompt: "覆盖两种输入" })).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "worker"), "utf8"), "dispatched");
    await h.call("command", "printf corrected > source");
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "corrected");
    assert.deepEqual(h.taskFiles(), before);
    assert.deepEqual(h.questions, []);
    h.say("assistant", "接下来换个话题，要跨模块修改登录校验，可以动手吗？");
    h.say("user", "可以");
    assert.match((await h.call("command", "printf login > source")).denied, /跨模块.*任务吗？/);
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "corrected");
  });

  test(`${name} 回归：草稿的测试范围澄清和另行确认`, async (t) => {
    const h = await host(t, name);
    // Use a valid requirement so the CLI would actually advance if the hook admitted ready.
    const reference = readyTask(h.cwd);
    const { requirement } = parseTaskDocument(readFileSync(join(h.cwd, reference.dir, "task.md"), "utf8")).document;
    h.say("user", "建一个修复任务");
    const receipt = (await h.draft()).output;
    const [created, path] = receipt.split("\n");
    const id = created.replace("已创建 ", "");
    const file = join(h.cwd, path);
    const document = parseTaskDocument(readFileSync(file, "utf8")).document;
    writeFileSync(file, renderTaskDocument({ ...document, requirement }));
    const ready = () => h.bridge ? h.call("knit_task", { action: "ready", taskId: id }) : h.call("command", `knit task ready ${id}`);
    h.say("assistant", "草稿里的测试范围，要覆盖哪种输入？");
    h.say("user", "两种输入都覆盖");
    await h.resume();
    h.say("user", "继续");
    assert.match((await ready()).denied, /停在 draft/);
    assert.match((await h.call("write", "source")).denied, /停在 draft/);
    assert.equal(existsSync(join(h.cwd, "source")), false);
    assert.equal((await h.draft()).output, receipt);
    assert.match(readFileSync(file, "utf8"), /^status: draft$/m);
    assert.equal(existsSync(file.replace(/task\.md$/, "record.json")), false);
    h.say("user", "两种输入都覆盖，等我确认需求再开始实施。");
    h.say("user", "执行者使用测试执行器。");
    assert.match((await ready()).denied, /停在 draft/);
    assert.match((await h.call("edit", "source")).denied, /停在 draft/);
    assert.equal(existsSync(join(h.cwd, "source")), false);
    assert.equal(existsSync(file.replace(/task\.md$/, "record.json")), false);
    h.say("assistant", "两种输入都已写进草稿，可以确认这份需求吗？");
    h.say("user", "可以");
    assert.equal((await ready()).denied, undefined);
    assert.match(readFileSync(file, "utf8"), /^status: ready$/m);
    assert.ok(existsSync(file.replace(/task\.md$/, "record.json")));
    assert.ok((await h.call("write", "source")).denied);
    assert.equal(existsSync(join(h.cwd, "source")), false);
    h.say("user", "现在开始实施这份需求。");
    assert.equal((await h.call("write", "source")).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "edited");
    assert.deepEqual(h.questions, []);
  });

  test(`${name} 回归：继续现有任务的答复只针对该任务`, async (t) => {
    const h = await host(t, name);
    const task = readyTask(h.cwd);
    h.say("user", "今天处理“加问候语”。");
    if (h.bridge) await h.call("knit_task", { action: "use", taskId: task.id });
    else await h.call("command", `knit context --use ${task.id}`);
    const before = h.taskFiles();
    h.say("assistant", "需求已经确认，要不要继续这个任务？");
    h.say("user", "可以");
    assert.ok((await h.draft()).denied);
    assert.deepEqual(h.taskFiles(), before);
    assert.equal((await h.call("delegate", { prompt: "实现问候语" })).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "worker"), "utf8"), "dispatched");
    assert.deepEqual(h.questions, []);
  });

  test(`${name} 回归：选中并要求实施的任务在恢复后派发`, async (t) => {
    const previous = process.env.KNIT_PI_BIN;
    t.after(() => { if (previous === undefined) delete process.env.KNIT_PI_BIN; else process.env.KNIT_PI_BIN = previous; });
    process.env.KNIT_PI_BIN = fileURLToPath(new URL("./helpers/fake-pi.mjs", import.meta.url));
    const h = await host(t, name, runProject(t));
    const task = readyTask(h.cwd);
    h.say("assistant", "现有任务的需求已经确认，接下来处理它吗？");
    h.say("user", "选中它，接下来就按这份需求实施。");
    if (h.bridge) await h.call("knit_task", { action: "use", taskId: task.id });
    else await h.call("command", `knit context --use ${task.id}`);
    h.say("assistant", "已选中“加问候语”，需要在入口和输出模块加上问候语。");
    assert.match(await h.resume(), new RegExp(`加问候语（${task.id}）[\\s\\S]*状态: ready`));
    h.say("user", "继续");
    assert.equal((await h.call("write", "greeting.txt")).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "greeting.txt"), "utf8"), "edited");
    const started = h.bridge ? await h.call("knit_run", { action: "start", taskId: task.id })
      : await h.call("command", `KNIT_SESSION_AGENT=pi knit run start ${task.id}`);
    assert.match(started.output, /已派发/);
    assert.equal(knit(h.cwd, "run", "wait", task.id, "--timeout", "30").code, 0);
    const record = JSON.parse(readFileSync(join(h.cwd, task.dir, "record.json"), "utf8"));
    assert.ok(record.runs.at(-1).endedAt);
    assert.deepEqual(h.questions, []);
  });

  test(`${name} 原话回放：读、跳过提问的调用、答复和恢复`, async (t) => {
    const h = await host(t, name);
    const tasks = () => h.taskFiles().map((file) => readFileSync(join(h.cwd, ".knit/tasks", file), "utf8"));
    const originalTasks = tasks();
    const before = knit(h.cwd, "task", "list").stdout;
    const unrelated = /k-[\da-f]+/.exec(before)[0];
    if (h.bridge) await h.bridge.tool("knit_task", { action: "use", taskId: unrelated });
    else await h.call("command", `knit context --use ${unrelated}`);
    h.calls.length = 0;
    writeFileSync(join(h.cwd, "source"), "original");
    h.say("user", "有必要合并吗？");
    assert.equal((await h.call("read", "source")).output, "original");
    assert.equal((await h.call("command", "cat source 2>/dev/null")).output, "original");
    assert.equal(h.questions.length, 0);
    h.say("assistant", proposal);
    h.say("user", approval);
    for (const [kind, value] of [["delegate", { prompt: "实现分区并迁移清单" }], ["edit", "source"], ["write", "source"], ["command", "mv source moved"], ["command", "printf changed > source"],
      ["command", "sh -c 'printf nested >> source'"], ["command", "node -e \"require('fs').writeFileSync('source','changed')\""]]) {
      assert.match((await h.call(kind, value)).denied, /任务吗？/);
    }
    assert.match((await h.draft()).denied, /任务吗？/);
    assert.match((await h.call("command", `knit run start ${unrelated}`)).denied, /任务吗？/);
    assert.deepEqual(tasks(), originalTasks);
    assert.deepEqual(readdirSync(join(h.cwd, ".knit/tasks"), { recursive: true }).filter((file) => file.endsWith("record.json")), []);
    assert.deepEqual(h.calls, [tools[name].read, tools[name].command]);
    assert.equal(existsSync(join(h.cwd, "worker")), false);
    assert.equal(existsSync(join(h.cwd, "moved")), false);
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "original");
    assert.equal(knit(h.cwd, "task", "list").stdout, before);
    if (h.bridge) assert.match(h.bridge.messages.find((entry) => entry.message.display).message.content, /任务吗？/);
    h.say("assistant", h.questions[0]);
    await h.bridge?.reload();
    h.say("user", "继续");
    assert.match((await h.call("command", "printf changed | tee source")).denied, /任务吗？/);
    h.say("user", "不建任务，按刚才说的改");
    const asked = h.questions.length;
    assert.equal((await h.call("delegate", { prompt: "实现分区" })).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "worker"), "utf8"), "dispatched");
    await h.bridge?.reload();
    h.say("user", "继续");
    await h.call("command", "printf changed > source");
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "changed");
    assert.equal(h.questions.length, asked);
    h.say("user", `另一个问题，与当前任务 ${unrelated} 无关，需要跨模块调整运行器和存储。`);
    assert.match((await h.call("write", "source")).denied, /跨模块.*任务吗？/);
    assert.equal(readFileSync(join(h.cwd, "source"), "utf8"), "changed");
    assert.equal(knit(h.cwd, "task", "list").stdout, before);
  });

  test(`${name} 未经选择先建草稿时给出本次询问，明确不建后不再提问`, async (t) => {
    const h = await host(t, name);
    const before = h.taskFiles();
    h.say("assistant", proposal);
    h.say("user", approval);
    const question = (await h.draft()).denied;
    assert.match(question, /多处改动.*任务吗？$/);
    if (h.bridge) assert.deepEqual(h.bridge.messages.filter(({ message }) => message.display).map(({ message }) => message.content), [question]);
    h.say("user", "不建任务，按刚才说的改");
    assert.match((await h.draft()).denied, /已选择本次不建/);
    assert.deepEqual(h.questions, [question]);
    assert.deepEqual(h.taskFiles(), before);
    assert.deepEqual(h.calls, []);
  });

  test(`${name} 明确建草稿，回报和落盘一致`, async (t) => {
    const h = await host(t, name);
    const before = h.taskFiles();
    h.say("assistant", proposal);
    h.say("user", approval);
    h.say("assistant", "这次会改到规范加载、初始化和执行者交接，要为它建一个 Knit 任务吗？");
    h.say("user", "建一个修复任务");
    const receipt = (await h.draft()).output;
    const [created, path] = receipt.split("\n");
    const id = created.replace("已创建 ", "");
    assert.ok(receipt.includes(`修复规范传递（${id}） · draft · 当前会话未选中新草稿`));
    assert.ok(receipt.includes(`[task.md](${path})`));
    assert.deepEqual(h.taskFiles().filter((file) => !before.includes(file)), [path.replace(".knit/tasks/", "")]);
    assert.match(readFileSync(join(h.cwd, path), "utf8"), /^status: draft$/m);
    assert.equal((await h.call("command", `printf '\\n合并清单并按区传递\\n' >> '${path}'`)).denied, undefined);
    assert.match(readFileSync(join(h.cwd, path), "utf8"), /合并清单并按区传递/);
    h.say("user", "继续");
    assert.equal((await h.draft()).output, receipt);
    assert.equal(h.taskFiles().length, before.length + 1);
    assert.match((await h.call("command", `knit task ready ${id}`)).denied, /停在 draft/);
    assert.match((await h.call("edit", "source")).denied, /停在 draft/);
    assert.equal(existsSync(join(h.cwd, "source")), false);
    assert.equal(existsSync(join(h.cwd, path.replace(/task\.md$/, "record.json"))), false);
    assert.equal(h.questions.length, 0);
  });

  test(`${name} 已授权单点小改直接完成，范围扩大在下一次写入前询问`, async (t) => {
    const h = await host(t, name);
    h.say("user", "请修正 README.md 的拼写，无需独立审查。");
    await h.call("edit", "README.md");
    assert.equal(readFileSync(join(h.cwd, "README.md"), "utf8"), "edited");
    h.say("user", "先查阅两个模块，最后只修改 README.md 的错字。");
    assert.equal((await h.call("command", "printf corrected > README.md")).denied, undefined);
    assert.equal(readFileSync(join(h.cwd, "README.md"), "utf8"), "corrected");
    assert.equal(h.questions.length, 0);
    h.say("assistant", "查证后发现需要跨模块修改加载和交接，README.md 也要更新。");
    h.say("user", "继续");
    assert.match((await h.call("command", "echo expanded > README.md")).denied, /跨模块.*任务吗？/);
    assert.equal(readFileSync(join(h.cwd, "README.md"), "utf8"), "corrected");
    assert.deepEqual(h.calls, [tools[name].edit, tools[name].command]);
  });
}
