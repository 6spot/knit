import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { knit, project } from "./helpers/cli.mjs";
import { readyTask } from "./helpers/run.mjs";

const cli = fileURLToPath(new URL("../dist/cli/knit.js", import.meta.url));
const session = "ec33ebf9-0cba-4100-8142-c61503f6c587";

function hook(event, payload, env = process.env) {
  const called = spawnSync(process.execPath, [cli, "hook", "agy", event], { input: JSON.stringify(payload), encoding: "utf8", env });
  assert.equal(called.status, 0, called.stderr);
  return JSON.parse(called.stdout);
}

function preTool(payload, command, env) {
  return hook("PreToolUse", { ...payload, stepIdx: 19, toolCall: { name: "run_command", args: {
    CommandLine: command, Cwd: payload.cwd, WaitMsBeforeAsync: 5000,
  } } }, env);
}

test("普通目录的上级是 Knit 用户目录时，继续查找实际工作区", (t) => {
  const parent = project(t);
  const store = join(parent, ".knit");
  mkdirSync(join(store, "worktrees"));
  const cwd = join(parent, "ordinary");
  mkdirSync(cwd);
  const env = { ...process.env, KNIT_HOME: store };
  const payload = { cwd, conversationId: session, workspacePaths: [cwd] };
  for (const event of ["SessionStart", "PreInvocation"]) assert.deepEqual(hook(event, payload, env), {});
  const workspace = project(t);
  assert.equal(knit(workspace, "init").code, 0);
  const result = hook("PreInvocation", { ...payload, workspacePaths: [workspace] }, env);
  assert.match(result.injectSteps[0].systemMessage.systemMessage, /discussion\.md/);
  assert.equal(existsSync(join(workspace, ".knit/.runtime/host-sessions", `agy-${session}.json`)), true);
  assert.equal(existsSync(join(store, ".runtime")), false);
});

test("AGY 从 stdin 注入、按会话去重，选择和状态变化后刷新", (t) => {
  const root = project(t);
  const plain = process.env.KNIT_HOME;
  const payload = { conversationId: session, workspacePaths: [plain], cwd: plain };
  for (const event of ["SessionStart", "PreInvocation"]) assert.deepEqual(hook(event, payload), {});
  assert.equal(existsSync(join(plain, ".knit")), false);
  assert.equal(knit(root, "init").code, 0);
  const task = readyTask(root);
  const subdir = join(root, "subdir");
  mkdirSync(subdir);
  payload.workspacePaths = [subdir];
  const injected = (event = "PreInvocation") => hook(event, payload).injectSteps[0].systemMessage.systemMessage;
  const first = injected("SessionStart");
  assert.ok(first.includes('<standard path="knit:standards/discussion.md"'));
  assert.match(first, /没有选中 Knit 任务/);
  const states = join(root, ".knit/.runtime/host-sessions");
  const state = () => JSON.parse(readFileSync(join(states, `agy-${session}.json`), "utf8"));
  assert.deepEqual(state(), { taskId: null, lastDigest: createHash("sha256").update(first).digest("hex") });
  assert.deepEqual(hook("PreInvocation", payload), {});
  symlinkSync(cli, join(plain, "knit"));
  const select = (command) => {
    const modified = preTool(payload, `true && ${command}`);
    assert.equal(modified.decision, "allow");
    return spawnSync("/bin/sh", ["-c", modified.overwrite.CommandLine], { encoding: "utf8", cwd: subdir,
      env: { ...process.env, PATH: `${plain}:${process.env.PATH}` } });
  };
  assert.equal(select(`TASK_ID=${task.id} sh -c 'knit context --use="$TASK_ID"'`).status, 0);
  assert.equal(state().taskId, task.id);
  assert.equal(state().lastDigest, null);
  const selected = injected();
  assert.equal(selected, knit(root, "context", task.id).stdout.trimEnd());
  assert.match(selected, /^状态: ready$/m);
  assert.match(selected, /^下一步: .*knit run start /m);
  assert.ok(selected.includes(`目录: ${task.dir}`));
  assert.match(selected, /^规范（implement 环节）:/m);
  assert.deepEqual(hook("PreInvocation", payload), {});
  assert.equal(select("knit context --use missing").status, 1);
  assert.deepEqual(hook("PreInvocation", payload), {});
  assert.equal(knit(root, "task", "cancel", task.id, "--reason", "结束").code, 0);
  const ended = injected();
  assert.match(ended, /状态: cancelled/);
  assert.match(ended, /目录: .knit\/tasks\/archive\//);
  const archive = /^目录: (.*)$/m.exec(ended)[1];
  renameSync(join(root, archive, "task.md"), join(root, archive, "moved"));
  assert.match(injected(), /discussion.md[\s\S]*选中的 Knit 任务 .* 读不出来/);
  payload.conversationId = "another/session's id";
  assert.equal(injected(), first);
  assert.equal(select("sh -o errexit -c -- 'knit context --unuse'").status, 0);
  assert.equal(readdirSync(states).filter((name) => name.endsWith(".json")).length, 2);
  assert.equal(state().taskId, task.id);
  payload.conversationId = session;
  assert.equal(select("knit context --unuse").status, 0);
  assert.equal(injected(), first);
});

test("交付只接受本次调用的预览选项或转录中完整的用户原话", (t) => {
  const cwd = project(t);
  const payload = { cwd, conversationId: session, transcriptPath: join(cwd, "transcript.jsonl") };
  const row = (content, type = "USER_INPUT", source = "USER_EXPLICIT") => JSON.stringify({ step_index: 1, source, type, status: "DONE", content });
  const user = (text) => row(`<USER_REQUEST>\n${text}\n</USER_REQUEST>\n<ADDITIONAL_METADATA>\n元数据\n</ADDITIONAL_METADATA>`);
  writeFileSync(payload.transcriptPath, [user("先不要交付"), user("同意交付这个任务"), user("第一行\n  同意交付 A  "),
    row("模型原话", "PLANNER_RESPONSE", "MODEL")].join("\n"));
  for (const command of ["git status", "command -v knit deliver", "echo 'knit deliver id'", "knit deliver id --preview", "knit deliver id --authorization='同意交付这个任务'",
    'knit deliver --preview "$TASK_ID"', 'knit deliver id --dir "$PWD/sub dir" --preview',
    `knit deliver id --dir="$PWD/sub dir" --authorization '同意交付这个任务'`,
    "printf 中文 && env DEBUG=1 knit deliver --dir '目录 A' id --authorization ' 同意交付 A '",
    `bash show-arguments.sh -c 'knit context --unuse'`, `sh -c 'echo knit deliver'`,
    `knit deliver id --dir "$PWD" --authorization '同意交付这个任务'`,
    "A=1 knit deliver id --authorization '第一行\n  同意交付 A  '"]) assert.deepEqual(preTool(payload, command), { decision: "allow" }, command);
  for (const command of ["knit deliver id", "knit deliver id --authorization 交付", "knit deliver id --authorization 伪造",
    "knit deliver id --authorization 元数据", "knit deliver id --authorization 模型原话", "knit deliver id --authorization=$QUOTE",
    "knit deliver id --authorization 交付 --message-file '--preview'", "knit deliver id --preview && knit deliver other",
    "knit deliver id --authorization '同意交付这个任务' | env A=1 knit --dir '目录 A' deliver other",
    "echo $(knit deliver id)", `bash -lc 'knit deliver id'`, "knit deliver id --authorization '未闭合"]) {
    const result = preTool(payload, command);
    assert.equal(result.decision, "deny", command);
    assert.match(result.reason, /--authorization/);
  }
  payload.transcriptPath += ".missing";
  assert.deepEqual(preTool(payload, "knit deliver id --preview"), { decision: "allow" });
  assert.equal(preTool(payload, "knit deliver id --authorization 同意交付这个任务").decision, "deny");
});

test("run start 透传 AGY 默认执行者并保留显式选择", (t) => {
  const cwd = project(t);
  const payload = { cwd, conversationId: session };
  const env = { ...process.env, PATH: `${cwd}:${process.env.PATH}` };
  delete env.KNIT_SESSION_AGENT;
  writeFileSync(join(cwd, "knit"), '#!/bin/sh\nprintf "%s\\n" "$KNIT_SESSION_AGENT"\n', { mode: 0o755 });
  const command = ["printf '中文\\n'", "knit run start id", "KNIT_SESSION_AGENT=pi knit run start other",
    `sh -c 'knit run start nested && echo "\${KNIT_SESSION_AGENT-unset}"'`, `eval 'knit run' 'start joined'`].join(" && ");
  const modified = preTool(payload, command, env);
  assert.equal(modified.decision, "allow");
  const ran = spawnSync("/bin/sh", ["-c", modified.overwrite.CommandLine], { env, encoding: "utf8" });
  assert.equal(ran.status, 0, ran.stderr);
  assert.equal(ran.stdout, "中文\nantigravity\npi\nantigravity\nunset\nantigravity\n");
  assert.deepEqual(preTool(payload, "env KNIT_SESSION_AGENT=pi knit run start id", env), { decision: "allow" });
  assert.deepEqual(preTool(payload, "knit run start id", { ...env, KNIT_SESSION_AGENT: "pi" }), { decision: "allow" });
});
