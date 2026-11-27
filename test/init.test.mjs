import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { CORE_TEMPLATES, initProject } from "../dist/application/init.js";
import { loadConfig, loadStandards } from "../dist/application/project-config.js";
import { createTask, scanTasks } from "../dist/application/task-store.js";
import { HOST_SPECS } from "../dist/contracts/host.js";
import { parseTaskDocument } from "../dist/domain/task.js";
import { parseWorkflow } from "../dist/domain/workflow.js";
import { knit, project } from "./helpers/cli.mjs";
import { gitProject } from "./helpers/git.mjs";
import { writeArchiveHistory } from "./helpers/run.mjs";

const hostGuide = "请按客户端运行 knit init --pi / knit init --agy / knit init --qoder / knit init --workbuddy 安装主会话桥接。Pi、Antigravity 可运行 knit workflow validate --env 检查派发环境；Qoder、WorkBuddy 使用宿主自身工具与原生子 Agent。";
const targets = CORE_TEMPLATES.map((item) => item.target);
const draft = { title: "试一下", slug: "task", priority: "P2", verification: "self", parent: null, dependsOn: [] };
const template = (name) => readFileSync(new URL(`../assets/templates/${name}`, import.meta.url), "utf8");
const listed = (title, paths) => [title, ...paths.map((path) => `  ${path}`)];
/** `.knit/tasks/` 下进行中的任务的 task.md，相对项目根。 */
const taskFiles = (dir) =>
  readdirSync(join(dir, ".knit", "tasks"))
    .filter((name) => name !== "archive")
    .map((name) => `.knit/tasks/${name}/task.md`);

/** 一个空的临时目录，不在 Git 仓库里。 */
function emptyDir(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test("每个宿主都有可安装的模板，init 帮助列出对应选项", (t) => {
  const help = knit(emptyDir(t), "init", "--help");
  assert.equal(help.code, 0, help.stderr);
  const options = new Map([...help.stdout.matchAll(/^  --([\w-]+) +([^\n]+)$/gm)].map((match) => [match[1], match[2]]));
  for (const host of HOST_SPECS) {
    assert.equal(options.get(host.id), host.optionDescription);
    for (const path of host.templates) assert.ok(statSync(new URL(`../assets/templates/${path}`, import.meta.url)).isFile(), path);
  }
});

test("在空目录里初始化", (t) => {
  const dir = emptyDir(t);
  const result = knit(dir, "init");
  assert.equal(result.code, 0, result.stderr);
  const [taskFile] = taskFiles(dir);
  const task = readFileSync(join(dir, taskFile), "utf8");
  const frontmatter = parseTaskDocument(task).document.frontmatter;
  assert.equal(
    result.stdout,
    `${[
      ...listed("已生成:", targets),
      hostGuide,
      `初始化任务: 完善项目的开发规范（${frontmatter.id}，${taskFile}）`,
    ].join("\n")}\n`,
  );
  assert.deepEqual(readdirSync(dir), [".knit"]);
  for (const item of CORE_TEMPLATES) assert.equal(readFileSync(join(dir, item.target), "utf8"), template(item.template));
  assert.deepEqual(readdirSync(join(dir, ".knit", "standards")), []);
  assert.deepEqual(loadStandards(dir).map(({ path, title, stages }) => [path, title, stages]), [
    ["knit:standards/delivery.md", "交付规范", ["deliver"]],
    ["knit:standards/discussion.md", "讨论规范", ["discuss"]],
    ["knit:standards/task-splitting.md", "任务拆分规范", ["discuss"]],
    ["knit:standards/task-writing.md", "任务编写规范", ["discuss"]],
  ]);
  assert.equal(readdirSync(join(dir, ".knit", "tasks")).length, 1);
  assert.match(taskFile, /^\.knit\/tasks\/\d\d-\d\d-bootstrap-standards\/task\.md$/);
  assert.equal(frontmatter.verification, "self");
  assert.deepEqual(scanTasks(dir).map(({ id, document }) => [id, document.frontmatter.priority, document.frontmatter.status, document.frontmatter.title]),
    [[frontmatter.id, "P1", "draft", "完善项目的开发规范"]]);
  // 开头字段之后空一行，就是模板，一个字不差。
  assert.equal(task.endsWith(`createdAt: ${frontmatter.createdAt}\n---\n\n${template("tasks/bootstrap-standards.md")}`), true);
  assert.equal(existsSync(join(dir, "AGENTS.md")), false);

  assert.deepEqual(parseWorkflow(readFileSync(join(dir, ".knit/workflow.yaml"), "utf8")).validation.issues, []);
  assert.deepEqual(createTask(dir, draft).problems, []);
});

for (const flags of [["--agy"], ["--pi", "--agy"]]) {
  test(`空目录初始化 ${flags.join(" ")}`, (t) => {
    const dir = emptyDir(t);
    const result = knit(dir, "init", ...flags);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(!result.stdout.includes(hostGuide));
    const pi = flags.includes("--pi");
    assert.deepEqual(readdirSync(dir).sort(), pi ? [".agents", ".knit", ".pi"] : [".agents", ".knit"]);
    if (pi) assert.equal(readFileSync(join(dir, ".pi/extensions/knit.ts"), "utf8"), template("pi/extensions/knit.ts"));

    const agents = join(dir, ".agents");
    const paths = readdirSync(agents, { recursive: true, withFileTypes: true })
      .filter((entry) => entry.isFile())
      .map((entry) => join(entry.parentPath, entry.name).slice(agents.length + 1)).sort();
    assert.deepEqual(paths, ["plugins/knit/hooks.json", "plugins/knit/plugin.json", "plugins/knit/rules/AGENTS.md"]);
    for (const path of paths) assert.equal(readFileSync(join(agents, path), "utf8"), template(`agents/${path}`));
    assert.equal(JSON.parse(readFileSync(join(agents, "plugins/knit/plugin.json"))).name, "knit");
    const command = (event) => ({ type: "command", command: `knit hook agy ${event}` });
    assert.deepEqual(JSON.parse(readFileSync(join(agents, "plugins/knit/hooks.json"))), { knit: {
      SessionStart: [command("SessionStart")],
      PreInvocation: [command("PreInvocation")],
      PreToolUse: [{ matcher: "run_command", hooks: [command("PreToolUse")] }],
    } });
  });
}

test("桌面端保留已有设置，显式补装时提示接入钩子", (t) => {
  for (const host of ["workbuddy", "qoder"]) {
    const dir = emptyDir(t);
    mkdirSync(join(dir, `.${host}`));
    const target = `.${host}/settings.json`;
    const own = Buffer.from('{ "permissions": {} }\r\n');
    writeFileSync(join(dir, target), own);
    const result = knit(dir, "init", `--${host}`);
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(readFileSync(join(dir, target)), own);
    const lines = result.stdout.trimEnd().split("\n");
    assert.ok(lines.includes(`警告：${target} 保留了已有配置。请手工合入缺少的 SessionStart、UserPromptSubmit、PreToolUse 钩子，或运行 knit init --force --${host} 备份后恢复模板。`));
    assert.ok(lines.includes(hostGuide));
    assert.match(lines.at(-1), /^初始化任务: 完善项目的开发规范/);
    assert.doesNotMatch(knit(dir, "init").stdout, /警告/);
    const settings = JSON.parse(template(target.slice(1)));
    writeFileSync(join(dir, target), JSON.stringify({ hooks: { SessionStart: settings.hooks.SessionStart } }));
    const partial = knit(dir, "init", `--${host}`);
    assert.equal(partial.code, 0, partial.stderr);
    assert.match(partial.stdout, /缺少的 UserPromptSubmit、PreToolUse 钩子/);
    writeFileSync(join(dir, target), template(target.slice(1)));
    const again = knit(dir, "init", `--${host}`);
    assert.equal(again.code, 0, again.stderr);
    assert.doesNotMatch(again.stdout, /警告|workflow validate --env/);
  }
});

test("WorkBuddy 可单独或组合安装，强制恢复仅处理启用的桥接", (t) => {
  for (const flags of [["--workbuddy"], ["--pi", "--agy", "--workbuddy"]]) {
    const dir = emptyDir(t);
    assert.equal(knit(dir, "init", ...flags).code, 0);
    assert.deepEqual(readdirSync(dir).sort(), flags.includes("--pi") ? [".agents", ".knit", ".pi", ".workbuddy"] : [".knit", ".workbuddy"]);
    const settings = ".workbuddy/settings.json";
    const launcher = ".workbuddy/knit-hook.sh";
    assert.equal(readFileSync(join(dir, settings), "utf8"), template(settings.slice(1)));
    writeFileSync(join(dir, launcher), "custom script");
    rmSync(join(dir, settings));
    initProject(dir);
    assert.equal(existsSync(join(dir, settings)), false);
    const restored = initProject(dir, true);
    assert.equal(readFileSync(join(dir, restored.backupDir, launcher), "utf8"), "custom script");
    assert.equal(readFileSync(join(dir, launcher), "utf8"), template(launcher.slice(1)));
    assert.equal(readFileSync(join(dir, settings), "utf8"), template(settings.slice(1)));
  }
  const dir = emptyDir(t);
  mkdirSync(join(dir, ".workbuddy"));
  const settings = join(dir, ".workbuddy/settings.json");
  const ownSettings = JSON.stringify({ permissions: { deny: ["Read(./.workbuddy/knit-hook.sh)"] } });
  writeFileSync(settings, ownSettings);
  initProject(dir, true);
  assert.equal(readFileSync(settings, "utf8"), ownSettings);
  assert.deepEqual(readdirSync(join(dir, ".workbuddy")), ["settings.json"]);
  initProject(dir, true, { workbuddy: true });
  assert.equal(readFileSync(settings, "utf8"), template("workbuddy/settings.json"));

  const launcher = join(dir, ".workbuddy/knit-hook.sh");
  rmSync(launcher);
  initProject(dir, true);
  assert.equal(readFileSync(launcher, "utf8"), template("workbuddy/knit-hook.sh"));
});

test("Qoder 在 Git 项目中单独或组合安装，重复安装保留项目文件", (t) => {
  for (const flags of [["--qoder"], ["--pi", "--agy", "--workbuddy", "--qoder"]]) {
    const root = gitProject(t);
    const installed = knit(root, "init", ...flags);
    assert.equal(installed.code, 0, installed.stderr);
    for (const name of ["qoder/settings.json", "qoder/knit-hook.sh"]) {
      assert.equal(readFileSync(join(root, `.${name}`), "utf8"), template(name));
      writeFileSync(join(root, `.${name}`), "project copy");
    }
    if (flags.length > 1) {
      for (const path of [".pi/extensions/knit.ts", ".agents/plugins/knit/hooks.json", ".workbuddy/knit-hook.sh"]) assert.ok(existsSync(join(root, path)));
    }
    assert.equal(knit(root, "init", "--qoder").code, 0);
    for (const name of ["settings.json", "knit-hook.sh"]) assert.equal(readFileSync(join(root, ".qoder", name), "utf8"), "project copy");
    const restored = initProject(root, true);
    for (const name of ["qoder/settings.json", "qoder/knit-hook.sh"]) {
      assert.equal(readFileSync(join(root, restored.backupDir, `.${name}`), "utf8"), "project copy");
      assert.equal(readFileSync(join(root, `.${name}`), "utf8"), template(name));
    }
  }
});

test("Qoder 的 force 只识别本宿主三个事件的启动命令，并备份自定义设置", (t) => {
  const root = gitProject(t);
  mkdirSync(join(root, ".qoder"));
  const settings = join(root, ".qoder/settings.json");
  const launcher = join(root, ".qoder/knit-hook.sh");
  const group = (command) => [{ hooks: [{ type: "command", command }] }];
  const own = JSON.stringify({ permissions: { deny: ["Read(./.qoder/knit-hook.sh)"] }, hooks: {
    Stop: group("sh .qoder/knit-hook.sh"), SessionStart: group("sh .workbuddy/knit-hook.sh"),
  } });
  writeFileSync(settings, own);
  assert.equal(knit(root, "init", "--force").code, 0);
  assert.equal(readFileSync(settings, "utf8"), own);
  assert.equal(existsSync(launcher), false);
  const explicit = knit(root, "init", "--force", "--qoder");
  assert.equal(explicit.code, 0, explicit.stderr);
  const backup = /^备份: (.+)\/$/m.exec(explicit.stdout)[1];
  assert.equal(readFileSync(join(root, backup, ".qoder/settings.json"), "utf8"), own);
  assert.equal(readFileSync(settings, "utf8"), template("qoder/settings.json"));
  for (const event of ["SessionStart", "UserPromptSubmit", "PreToolUse"]) {
    rmSync(launcher);
    const custom = JSON.stringify({ hooks: { [event]: group('sh "./.qoder/knit-hook.sh"') } });
    writeFileSync(settings, custom);
    const restored = initProject(root, true);
    assert.equal(readFileSync(join(root, restored.backupDir, ".qoder/settings.json"), "utf8"), custom);
    assert.equal(readFileSync(settings, "utf8"), template("qoder/settings.json"));
    assert.equal(readFileSync(launcher, "utf8"), template("qoder/knit-hook.sh"));
  }
});

test("已有的文件不动，缺的补上", (t) => {
  const dir = emptyDir(t);
  initProject(dir);
  appendFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自己加的\n");
  rmSync(join(dir, ".knit", "agents", "review.md"));
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "项目自己写的\n");
  const contents = () => [...targets, ".knit/standards/a.md"].map((path) => readFileSync(join(dir, path), "utf8"));

  const second = knit(dir, "init");
  assert.equal(second.code, 0, second.stderr);
  assert.equal(
    second.stdout,
    `${[
      ...listed("已生成:", [".knit/agents/review.md"]),
      ...listed("已有，没有动:", targets.filter((target) => target !== ".knit/agents/review.md")),
      hostGuide,
    ].join("\n")}\n`,
  );
  assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), `${template("workflow.yaml")}# 项目自己加的\n`);
  assert.equal(readFileSync(join(dir, ".knit", "standards", "a.md"), "utf8"), "项目自己写的\n");
  assert.equal(readFileSync(join(dir, ".knit", "agents", "review.md"), "utf8"), template("agents/review.md"));

  const before = contents();
  assert.deepEqual(initProject(dir), { created: [], restored: [], kept: targets, backupDir: null, task: null });
  assert.deepEqual(contents(), before);
});

test("项目里已经有任务时不建初始化任务，归档的也算", (t) => {
  const dir = emptyDir(t);
  initProject(dir);
  const [taskFile] = taskFiles(dir);
  const document = parseTaskDocument(readFileSync(join(dir, taskFile), "utf8")).document;
  const id = document.frontmatter.id;
  const again = () =>
    [false, true].forEach((force) => assert.deepEqual(initProject(dir, force),
      { created: [], restored: [], kept: targets, backupDir: null, task: null }));

  again();
  assert.deepEqual(taskFiles(dir), [taskFile]);

  assert.equal(knit(dir, "task", "cancel", id, "--reason", "不需要").code, 0);
  again();
  assert.deepEqual(taskFiles(dir), []);
  assert.equal(knit(dir, "task", "list").stdout, "没有任务\n");
  assert.equal(knit(dir, "task", "list", "--archive").stdout, `P1  ${id}  cancelled  完善项目的开发规范\n`);

  const [first, second] = writeArchiveHistory(dir, document);
  // 第一份 task.md 可读但写坏了：不读对应记录，也不到后面继续读。
  for (const path of [join(first, "record.json"), join(second, "task.md")]) {
    rmSync(path);
    mkdirSync(path);
  }
  again();
  assert.deepEqual(knit(dir, "init"), { code: 0, stdout: `${[...listed("已有，没有动:", targets), hostGuide].join("\n")}\n`, stderr: "" });
  assert.deepEqual(taskFiles(dir), []);
});

test("初始化任务的正文通得过确认", (t) => {
  const dir = emptyDir(t);
  initProject(dir);
  const id = parseTaskDocument(readFileSync(join(dir, taskFiles(dir)[0]), "utf8")).document.frontmatter.id;
  assert.deepEqual(knit(dir, "task", "ready", id), { code: 0, stdout: `已确认 完善项目的开发规范（${id}）：0 个场景\n`, stderr: "" });
  assert.equal(knit(dir, "task", "list").stdout, `P1  ${id}  ready  完善项目的开发规范\n`);
});

/** 一个初始化过的临时项目，不在 Git 仓库里。 */
function initialized(t) {
  const dir = mkdtempSync(join(tmpdir(), "knit-next-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  initProject(dir);
  return dir;
}

/** 目录下所有文件的相对路径，排过序。 */
const filesUnder = (dir) =>
  readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name).slice(dir.length + 1))
    .sort();

test("改过的先备份再恢复", (t) => {
  const dir = initialized(t);
  const changed = [".knit/workflow.yaml", ".knit/agents/implement.md"];
  appendFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自己加的\n");
  writeFileSync(join(dir, ".knit", "agents", "implement.md"), "项目自己改的\n");
  rmSync(join(dir, ".knit", "agents", "review.md"));

  const result = knit(dir, "init", "--force");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(readdirSync(dir), [".knit"]);
  for (const item of CORE_TEMPLATES) assert.equal(readFileSync(join(dir, item.target), "utf8"), template(item.template));

  const backups = readdirSync(join(dir, ".knit", ".runtime", "backups"));
  assert.equal(backups.length, 1);
  assert.match(backups[0], /^\d{8}-\d{6}-\d{3}$/);
  const backupDir = join(dir, ".knit", ".runtime", "backups", backups[0]);
  assert.deepEqual(filesUnder(backupDir), [...changed].sort());
  assert.equal(readFileSync(join(backupDir, ".knit", "workflow.yaml"), "utf8"), `${template("workflow.yaml")}# 项目自己加的\n`);
  assert.equal(readFileSync(join(backupDir, ".knit", "agents", "implement.md"), "utf8"), "项目自己改的\n");

  assert.equal(
    result.stdout,
    `${[
      ...listed("已生成:", [".knit/agents/review.md"]),
      ...listed("已恢复成模板:", changed),
      `备份: .knit/.runtime/backups/${backups[0]}/`,
      ...listed("已有，没有动:", targets.filter((target) => target !== ".knit/agents/review.md" && !changed.includes(target))),
      hostGuide,
    ].join("\n")}\n`,
  );

  assert.deepEqual(initProject(dir, true), { created: [], restored: [], kept: targets, backupDir: null, task: null });
  assert.deepEqual(readdirSync(join(dir, ".knit", ".runtime", "backups")), backups);
});

test("其它宿主文件不启用桥接，显式补装后按已有副本恢复整个插件", (t) => {
  const dir = initialized(t);
  const plugin = ".agents/plugins/knit";
  mkdirSync(join(dir, ".agents/plugins/other"), { recursive: true });
  mkdirSync(join(dir, ".pi/extensions"), { recursive: true });
  initProject(dir, true);
  assert.equal(existsSync(join(dir, plugin)), false);
  assert.equal(existsSync(join(dir, ".pi/extensions/knit.ts")), false);

  initProject(dir, false, { agy: true });
  const rules = `${plugin}/rules/AGENTS.md`;
  writeFileSync(join(dir, rules), "项目的插件说明\n");
  rmSync(join(dir, plugin, "plugin.json"));
  rmSync(join(dir, plugin, "hooks.json"));
  initProject(dir);
  assert.equal(existsSync(join(dir, plugin, "hooks.json")), false);

  const restored = knit(dir, "init", "--force", "--pi");
  assert.equal(restored.code, 0, restored.stderr);
  for (const path of ["plugin.json", "hooks.json", "rules/AGENTS.md"]) {
    assert.equal(readFileSync(join(dir, plugin, path), "utf8"), template(`${plugin.slice(1)}/${path}`));
  }
  assert.equal(readFileSync(join(dir, ".pi/extensions/knit.ts"), "utf8"), template("pi/extensions/knit.ts"));
  const backup = join(dir, restored.stdout.match(/^备份: (.+)\/$/m)[1]);
  assert.deepEqual(filesUnder(backup), [rules]);
  assert.equal(readFileSync(join(backup, rules), "utf8"), "项目的插件说明\n");
});

test("配置、规范和任务不动", (t) => {
  const dir = initialized(t);
  writeFileSync(join(dir, ".knit", "config.json"), '{ "handoff": { "fileBytes": 100 } }\n');
  appendFileSync(join(dir, ".knit", ".gitignore"), "notes/\n");
  writeFileSync(join(dir, ".knit", "standards", "a.md"), "项目自己写的\n");
  assert.deepEqual(createTask(dir, draft).problems, []);
  const own = [
    ".knit/config.json",
    ".knit/.gitignore",
    ".knit/standards/a.md",
    ...filesUnder(join(dir, ".knit", "tasks")).map((path) => `.knit/tasks/${path}`),
  ];
  assert.equal(own.length > 3, true);
  const contents = () => own.map((path) => readFileSync(join(dir, path), "utf8"));
  const before = contents();

  const result = knit(dir, "init", "--force");
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(contents(), before);
  assert.deepEqual(filesUnder(join(dir, ".knit", "standards")), ["a.md"]);
  assert.equal(existsSync(join(dir, ".knit", ".runtime", "backups")), false);
  assert.doesNotMatch(result.stdout, /已恢复成模板:|备份:/);
});

test("已有的同名规范不覆盖", (t) => {
  const dir = initialized(t);
  const path = ".knit/standards/discussion.md";
  writeFileSync(join(dir, path), "项目自己改过的讨论规范。\n");

  for (const args of [["init"], ["init", "--force"]]) {
    const result = knit(dir, ...args);
    assert.equal(result.code, 0, result.stderr);
    assert.ok(result.stdout.startsWith(`${listed("已有，没有动:", targets).join("\n")}\n`));
    assert.match(result.stdout, /旧版通用规范副本.*迁入另名的项目规范/);
    assert.ok(result.stdout.includes(path));
    assert.equal(readFileSync(join(dir, path), "utf8"), "项目自己改过的讨论规范。\n");
  }
  assert.equal(existsSync(join(dir, ".knit", ".runtime", "backups")), false);
});

test("流程模板通过校验", () => {
  const { workflow, validation } = parseWorkflow(template("workflow.yaml"));
  assert.deepEqual(validation.issues, []);
  assert.deepEqual(
    workflow.stages.map((stage) => [stage.id, stage.model, stage.prompt, stage.resume]),
    [
      ["implement", null, ".knit/agents/implement.md", true],
      ["review", null, ".knit/agents/review.md", true],
    ],
  );
  const review = workflow.stages[1];
  assert.deepEqual(review.report, { verdict: ["pass", "changes_requested", "blocked"] });
  assert.deepEqual(review.onVerdict, { changes_requested: "implement", blocked: "review" });
  assert.notEqual(template("agents/implement.md").trim(), "");
  assert.notEqual(template("agents/review.md").trim(), "");
});

test("配置模板等于缺省值", (t) => {
  const dir = project(t);
  const defaults = loadConfig(dir);
  writeFileSync(join(dir, ".knit", "config.json"), template("config.json"));
  const loaded = loadConfig(dir);
  assert.deepEqual(loaded.problems, []);
  assert.deepEqual(loaded, defaults);
});

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

const cli = new URL("../dist/cli/knit.js", import.meta.url).pathname;

/** 运行 knit，`closed` 那一路输出在它写之前就关掉；返回退出码和另一路输出的内容。 */
async function withClosedPipe(args, closed) {
  const child = spawn(process.execPath, [cli, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  child[closed].destroy();
  const other = child[closed === "stdout" ? "stderr" : "stdout"];
  let text = "";
  other.setEncoding("utf8").on("data", (chunk) => (text += chunk));
  const [code] = await once(child, "close");
  return { code, text };
}

test("--version 输出根目录 package.json 的版本且退出码为 0", () => {
  const r = spawnSync(process.execPath, [cli, "--version"], { encoding: "utf8" });
  assert.equal(r.status, 0);
  assert.equal(r.stdout.trim(), pkg.version);
});

test("输出接在已经关掉的管道上时不报错，退出码照旧", async (t) => {
  const dir = project(t);

  // 像 `knit task list | grep -q …`：命令成功，标准输出没有人读了。
  assert.deepEqual(await withClosedPipe(["task", "list", "--dir", dir], "stdout"), { code: 0, text: "" });
  // 命令失败、标准错误没有人读了：退出码还是 1。
  assert.deepEqual(await withClosedPipe(["task", "show", "k-nope", "--dir", dir], "stderr"), { code: 1, text: "" });
});
