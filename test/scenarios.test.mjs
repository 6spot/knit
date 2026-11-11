import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scenarioStateOf, inputsDigestOf, SCENARIO_FORMAT_EXAMPLE } from "../dist/contracts/task-inputs.js";
import { checkScenarioReport, isRetryableReportFailure, validateReportForStage, uncoveredScopePaths } from "../dist/domain/report.js";
import { DEFAULT_WORKFLOW_YAML, parseWorkflow } from "../dist/domain/workflow.js";
import { buildUserPrompt, buildReportRetryPrompt, reportTemplateOf, scenariosOfPlan } from "../dist/application/stage.js";
import { agentsManagedBlock } from "../dist/application/templates.js";
import { TaskService } from "../dist/application/task-service.js";
import { SqliteMetadataStore } from "../dist/infrastructure/sqlite-metadata-store.js";
import { LockManager } from "../dist/infrastructure/locks.js";
import { RunCoordinator } from "../dist/application/run-coordinator.js";
import { RunAcceptanceService } from "../dist/application/run-acceptance.js";
import { RunStore } from "../dist/infrastructure/run-store.js";
import { isRunSettled } from "./helpers/run-settled.mjs";

const ROOT = join(import.meta.dirname, "..");
const CLI = join(ROOT, "dist/cli/knit.js");
const TEMPLATES = join(ROOT, "assets/templates/.knit");
const FAKE_PI = join(import.meta.dirname, "fixtures/fake-pi.mjs");
const scenario = (name, steps = "- WHEN 执行操作\n- THEN 得到结果") => `#### Scenario: ${name}\n${steps}\n`;
const THREE = `## 完成条件\n\n### Requirement: 第一需求\n${scenario("第一场景")}${scenario("第二场景")}\n### Requirement: 第二需求\n${scenario("第三场景")}`;
const refs = scenarioStateOf(THREE).scenarios;
const PASS = refs.map(({ id }) => `${id} pass：隔离测试已核对`);
const stage = { id: "check", name: "检查", tools: ["read", "exec"], report: { verdict: ["pass", "changes_requested", "blocked"], coverage: "string[]", scenarios: "string[]" }, onVerdict: { changes_requested: "implement", blocked: "check" } };
const report = (extra = {}) => ({ summary: "核对", verdict: "pass", coverage: ["app.txt"], scenarios: PASS, ...extra });

test("R1.S1–S4 解析：编号与两级名称、加粗等价、围栏及输入区边界、自由列表", () => {
  assert.deepEqual(refs.map(({ id, requirement, name }) => [id, requirement, name]), [["R1.S1", "第一需求", "第一场景"], ["R1.S2", "第一需求", "第二场景"], ["R2.S1", "第二需求", "第三场景"]]);
  assert.deepEqual(scenarioStateOf(THREE).issues, []);
  const plain = `## 完成条件\n### Requirement: 需求\n${scenario("场景", "- GIVEN 条件\n- WHEN 操作\n- THEN 结果\n- AND 补充")}`;
  assert.deepEqual(scenarioStateOf(plain.replace(/- (GIVEN|WHEN|THEN|AND)/g, "- **$1**")), scenarioStateOf(plain));
  for (const fence of ["```", "~~~~"]) {
    const fenced = `${fence}markdown\n## 完成条件\n### Requirement：错字\n${fence}\n${THREE}\n${fence}markdown\n### Requirement: 示例\n#### Scenario: 无步骤\n## 输入引用\n${fence}\n## 输入引用\n### Requirement: 外部\n`;
    assert.deepEqual(scenarioStateOf(fenced), scenarioStateOf(THREE));
  }
  assert.deepEqual(scenarioStateOf("## 完成条件\n- 普通列表\n说明\n"), { scenarios: [], issues: [] });
  assert.deepEqual(scenarioStateOf(`${THREE}\n<!-- knit:progress:start -->\n${THREE}\n<!-- knit:progress:end -->`), scenarioStateOf(THREE));
  assert.deepEqual(scenarioStateOf(THREE.replaceAll("\n", "\r\n")), scenarioStateOf(THREE));
});

test("R2.S1–S4 结构错误：空需求、缺步骤、空名与重名、近似标题与游离场景", () => {
  const cases = [
    ["### Requirement: 空需求", "requirement_without_scenario", /空需求/],
    [`### Requirement: 需求\n${scenario("只有 WHEN", "- WHEN 操作")}`, "scenario_missing_step", /只有 WHEN.*THEN/],
    [`### Requirement: 需求\n${scenario("只有 THEN", "- THEN 结果")}`, "scenario_missing_step", /只有 THEN.*WHEN/],
    ["### Requirement:   ", "name_empty", /Requirement.*为空/],
    ["### Requirement: 需求\n#### Scenario:   ", "name_empty", /Scenario.*为空/],
    [`### Requirement: 需求\n${scenario("场景")}### Requirement: 需求\n${scenario("场景")}`, "name_duplicate", /Requirement.*重复/],
    [`### Requirement: 需求\n${scenario("重复")}${scenario("重复")}`, "name_duplicate", /Scenario.*重复/],
    ["### Requirement：全角冒号", "heading_malformed", /全角冒号/],
    ["### Requirement: 需求\n#### scenario: 小写", "heading_malformed", /小写/],
    [scenario("游离"), "scenario_orphan", /游离/],
  ];
  for (const [body, kind, message] of cases) {
    const state = scenarioStateOf(`## 完成条件\n${body}`);
    assert.equal(state.issues.length, 1, body);
    assert.equal(state.issues[0].kind, kind, body);
    assert.match(state.issues[0].message, message);
  }
  for (const steps of ["- WHEN\n- THEN", "  - WHEN 操作\n- then 结果", "- **WHEN**   \n- THEN 结果"]) {
    assert.match(scenarioStateOf(`## 完成条件\n### Requirement: 需求\n${scenario("空或非顶格步骤", steps)}`).issues[0].message, /缺少/);
  }
  assert.equal(scenarioStateOf(THREE.replace("第三场景", "第一场景")).issues.length, 0, "跨 Requirement 场景名可重复");
});

test("R4.S1–S3 提示：字段声明、有无场景、编号清单与补报格式", () => {
  const plan = { role: "check", sections: [{ sourceId: "task", kind: "task-inputs", path: "task.md" }] };
  const context = { taskId: "t", runId: "r", branch: null, snapshotDir: null, scope: [], previousImplement: null };
  assert.deepEqual(scenariosOfPlan(plan, { task: THREE }), refs);
  const prompt = buildUserPrompt(plan, stage, { task: THREE }, context);
  for (const ref of refs) assert.ok(prompt.includes(`${ref.id} ${ref.requirement}／${ref.name}`));
  assert.match(prompt, /pass／fail／not_verified/);
  assert.match(prompt, /<编号> <结论>：<证据>/);
  assert.equal(JSON.parse(reportTemplateOf(stage, refs)).scenarios.length, 3);
  const noField = { ...stage, report: { verdict: stage.report.verdict } };
  assert.match(buildUserPrompt(plan, noField, { task: THREE }, context), /R2.S1 第二需求／第三场景/);
  assert.equal(JSON.parse(reportTemplateOf(noField, refs)).scenarios, undefined);
  assert.doesNotMatch(buildUserPrompt(plan, noField, { task: THREE }, context), /scenarios 字段/);
  const free = buildUserPrompt(plan, stage, { task: "## 完成条件\n- 自由列表" }, context);
  assert.doesNotMatch(free, /完成条件含 \d+ 个行为场景|"scenarios"|scenarios 字段/);
});

test("R5.S1–S8、R6.S1–S2 共用报告守卫：覆盖、一致性、格式、适用性、路径与补报", () => {
  assert.equal(checkScenarioReport(stage, report(), refs).ok, true);
  assert.equal(checkScenarioReport(stage, report({ scenarios: [PASS[0], PASS[2]] }), refs).reason, "check_scenarios_incomplete:R1.S2");
  assert.equal(checkScenarioReport(stage, report({ scenarios: undefined }), refs).reason, "check_scenarios_incomplete:R1.S1,R1.S2,R2.S1");
  for (const verdict of ["fail", "not_verified"]) {
    assert.equal(checkScenarioReport(stage, report({ scenarios: [PASS[0], PASS[1], `R2.S1 ${verdict}: 实际原因`] }), refs).reason, "check_scenarios_inconsistent:R2.S1");
  }
  for (const entries of [["R1.S1 unknown: 证据"], ["R9.S1 pass: 证据"], [PASS[0], PASS[0]], ["R1.S1 pass：   "], ["R1.S1 pass 证据"], [1], null]) {
    const value = report({ scenarios: entries });
    assert.equal(validateReportForStage(stage, value, [], { scenarios: refs }).ok, true, "场景形状交共用核对");
    assert.equal(checkScenarioReport(stage, value, refs).reason, "report_field_value:scenarios", JSON.stringify(entries));
  }
  for (const verdict of ["changes_requested", "blocked"]) {
    assert.equal(checkScenarioReport(stage, report({ verdict, scenarios: [PASS[0], PASS[1], "R2.S1 not_verified：环境限制"] }), refs).ok, true);
    assert.match(checkScenarioReport(stage, report({ verdict, scenarios: [] }), refs).reason, /^check_scenarios_incomplete:/);
  }
  assert.equal(checkScenarioReport({ ...stage, report: { scenarios: "string[]" } }, { summary: "非结论阶段" }, refs).reason, "check_scenarios_incomplete:R1.S1,R1.S2,R2.S1", "核对按字段声明生效，不要求枚举结论");
  assert.equal(checkScenarioReport({ ...stage, report: {} }, report({ scenarios: null }), refs).ok, true);
  assert.equal(checkScenarioReport(stage, report({ scenarios: null }), []).ok, true);
  assert.deepEqual(uncoveredScopePaths(stage, report({ coverage: [] }), ["src/a.ts"]), ["src/a.ts"]);
  for (const reason of ["check_scenarios_incomplete:R1.S2", "check_scenarios_inconsistent:R2.S1", "report_field_value:scenarios"]) assert.equal(isRetryableReportFailure(reason), true);
  const check = checkScenarioReport(stage, report({ scenarios: [PASS[0], PASS[2]] }), refs);
  const retry = buildReportRetryPrompt(stage, { reason: check.reason, detail: check.detail }, refs);
  assert.match(retry, /R1.S2（第一需求／第二场景）/);
  assert.match(retry, /<编号> <结论>：<证据>/);
  assert.match(retry, /不要修改任何文件/);
});

function project() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "knit-scenarios-")));
  const git = (...args) => execFileSync("git", args, { cwd: dir });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  cpSync(TEMPLATES, join(dir, ".knit"), { recursive: true });
  writeFileSync(join(dir, ".gitignore"), ".knit/.runtime/\n.locks/\n.fake*\n");
  writeFileSync(join(dir, "app.txt"), "initial\n");
  git("add", ".");
  git("commit", "-q", "-m", "fixture");
  const store = new SqliteMetadataStore(join(dir, ".knit/.runtime/metadata.db"));
  const locks = new LockManager({ root: join(dir, ".locks") });
  const tasks = new TaskService({ store, locks });
  const coordinator = new RunCoordinator({ store, lockRoot: join(dir, ".locks"), confirmTimeoutMs: 8000 });
  const acceptance = new RunAcceptanceService({ store, locks });
  return { dir, store, tasks, coordinator, acceptance, cleanup() { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}
async function taskWith(s, body, verification = "independent") {
  const task = await s.tasks.newTask({ dir: s.dir, title: "场景任务", verification });
  await s.tasks.update({ dir: s.dir, taskId: task.taskId, kind: "clarify", reason: "准备合格输入", content: `## 目标与边界\n核对产出\n${body}\n## 输入引用\n测试入口\n` });
  return task;
}

test("R3.S1–S5 ready：拒绝不冻结、数量与示例、self／none 自由列表、澄清门不变", async () => {
  const s = project();
  try {
    for (const [body, verification, reason] of [["## 完成条件\n### Requirement: 需求\n" + scenario("缺 THEN", "- WHEN 操作"), "independent", "scenarios_invalid"], ["## 完成条件\n- 自由列表", "independent", "scenarios_required"], ["## 完成条件\n### Requirement: 空需求", "self", "scenarios_invalid"], ["## 完成条件\n### Requirement: 空需求", "none", "scenarios_invalid"]]) {
      const task = await taskWith(s, body, verification);
      const before = readFileSync(join(s.dir, ".knit", task.relativePath), "utf8");
      const binding = await s.store.bindings.get(task.taskId);
      await assert.rejects(s.tasks.ready({ dir: s.dir, taskId: task.taskId }), (error) => error.guardReason === reason && error.message.includes(SCENARIO_FORMAT_EXAMPLE));
      assert.equal(readFileSync(join(s.dir, ".knit", task.relativePath), "utf8"), before);
      assert.deepEqual(await s.store.bindings.get(task.taskId), binding);
      assert.match(before, /^stage: start$/m);
      assert.equal(existsSync(join(s.dir, ".knit/.runtime/runs")), false);
    }
    for (const verification of ["self", "none"]) {
      const task = await taskWith(s, "## 完成条件\n- 自由列表", verification);
      assert.equal((await s.tasks.ready({ dir: s.dir, taskId: task.taskId })).scenarios, 0);
    }
    const trailing = await taskWith(s, "## 完成条件\n- 自由列表", "self");
    const trailingFile = join(s.dir, ".knit", trailing.relativePath);
    writeFileSync(trailingFile, `${readFileSync(trailingFile, "utf8")}\n## 完成条件\n### Requirement: 尾部无场景\n`);
    // 第一个完成条件区段到下一个二级标题为止，不从尾部第二个区段补充场景。
    assert.equal((await s.tasks.ready({ dir: s.dir, taskId: trailing.taskId })).scenarios, 0);
    const tailOnly = await s.tasks.newTask({ dir: s.dir, title: "尾部输入", verification: "self" });
    const tailFile = join(s.dir, ".knit", tailOnly.relativePath);
    const tailRaw = readFileSync(tailFile, "utf8").replace("## 完成条件", "## 自由说明");
    writeFileSync(tailFile, `${tailRaw}\n## 完成条件\n### Requirement: 尾部无场景\n`);
    await assert.rejects(s.tasks.ready({ dir: s.dir, taskId: tailOnly.taskId }), (error) => error.guardReason === "scenarios_invalid");
    const task = await taskWith(s, THREE);
    const cli = spawnSync(process.execPath, [CLI, "task", "ready", task.taskId, "--dir", s.dir], { encoding: "utf8" });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, /行为场景: 3 个/);
    const blocking = await taskWith(s, `${THREE}\n## 待澄清\n- [blocking] 需用户决定`);
    await assert.rejects(s.tasks.ready({ dir: s.dir, taskId: blocking.taskId }), (error) => error.guardReason === "clarify_blocking" && /1 项/.test(error.message));
    const many = await taskWith(s, "## 完成条件\n### Requirement: 一\n### Requirement: 二\n### Requirement: 三\n### Requirement: 四\n");
    await assert.rejects(s.tasks.ready({ dir: s.dir, taskId: many.taskId }), (error) => /另有 1 处/.test(error.message) && !error.message.includes("Requirement「四」"));
  } finally { s.cleanup(); }
});

const prepare = (s, taskId, phase, extra = {}) => s.coordinator.prepare({ dir: s.dir, taskId, phase, initiator: { client: "cli", knitSessionId: null, nativeSessionId: null, cwd: s.dir }, model: { runtime: "pi", provider: "fake", model: "fake-model" }, ...extra });
async function run(s, taskId, phase, action, extra = {}) {
  const prepared = await prepare(s, taskId, phase, extra);
  const actionPath = join(s.dir, ".fake-action.json");
  writeFileSync(actionPath, JSON.stringify(action));
  process.env.KNIT_PI_BIN = FAKE_PI;
  process.env.KNIT_FAKE_ACTION = actionPath;
  await s.coordinator.start({ dir: s.dir, runId: prepared.request.runId });
  const deadline = Date.now() + 20_000;
  for (;;) {
    const status = await s.coordinator.status({ dir: s.dir, runId: prepared.request.runId });
    if (isRunSettled(status)) return { prepared, status };
    if (Date.now() > deadline) throw new Error("run 未收敛");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}
async function implemented(s) {
  const task = await taskWith(s, THREE);
  await s.tasks.ready({ dir: s.dir, taskId: task.taskId });
  const impl = await run(s, task.taskId, "implement", { writes: [{ path: "app.txt", content: "implemented\n" }], report: { summary: "产出", changedPaths: ["app.txt"] } }, { newRepairCycle: true });
  assert.equal(impl.status.state, "completed", impl.status.result?.failureReason);
  return task;
}

test("R5 接收守卫：缺项、非法字段、伪 pass、路径覆盖、修改结论和冻结输入一致", async () => {
  const cases = [
    [report({ scenarios: [PASS[0], PASS[2]] }), "check_scenarios_incomplete:R1.S2"],
    [report({ scenarios: undefined }), "check_scenarios_incomplete:R1.S1,R1.S2,R2.S1"],
    [report({ scenarios: null }), "report_field_value:scenarios"],
    [report({ scenarios: [PASS[0], PASS[1], "R2.S1 fail：实际失败"] }), "check_scenarios_inconsistent:R2.S1"],
    [report({ coverage: [] }), "check_scope_incomplete:app.txt"],
    [report({ verdict: "changes_requested", scenarios: [PASS[0], PASS[1], "R2.S1 fail：实际失败"] }), null],
    [report(), "stale_input"],
  ];
  // 每个不可变结果使用独立仓库／run，不覆盖已有 result 或伪造运行状态。
  for (const [value, reason] of cases) {
    const s = project();
    try {
      const task = await implemented(s);
      const prepared = await prepare(s, task.taskId, "check");
      await s.coordinator.start({ dir: s.dir, runId: prepared.request.runId, prepareOnly: true });
      const runs = new RunStore(s.dir);
      const frozen = runs.readInputs(prepared.request.runId);
      const file = join(s.dir, ".knit", task.relativePath);
      const raw = readFileSync(file, "utf8");
      assert.equal(frozen.inputsDigest, inputsDigestOf(raw));
      runs.writeResult(prepared.request.runId, { schemaVersion: 1, runId: prepared.request.runId, taskId: task.taskId, phase: "check", state: "completed", report: value, reportSummary: value.summary, nativeEntries: { startEntryId: null, leafEntryId: null }, usage: { inputTokens: null, outputTokens: null }, session: null, actualChangedPaths: [], acceptanceOperationId: prepared.request.acceptanceOperationId, recordedAt: new Date().toISOString(), failureReason: null });
      if (reason === "stale_input") writeFileSync(file, raw.replace("第二场景", "输入已改变"));
      const result = await s.acceptance.accept({ dir: s.dir, runId: prepared.request.runId });
      if (reason === null) {
        assert.equal(result.accepted, true, result.reason);
        assert.equal(s.tasks.list({ dir: s.dir }).active[0].stage, "implement");
      } else {
        assert.equal(result.reason, reason);
        assert.equal(result.accepted, false);
        if (reason === "stale_input") {
          writeFileSync(file, raw);
          assert.equal((await s.acceptance.accept({ dir: s.dir, runId: prepared.request.runId })).accepted, true);
        }
      }
    } finally { s.cleanup(); }
  }
});

test("R6.S2 worker 同会话补报：缺编号与名称、格式指引、最终全覆盖 pass", async () => {
  const s = project();
  try {
    const task = await implemented(s);
    const promptLog = join(s.dir, ".fake-prompts.jsonl");
    process.env.KNIT_FAKE_PROMPT_LOG = promptLog;
    const { prepared, status } = await run(s, task.taskId, "check", { prompts: [{ report: report({ scenarios: [PASS[0], PASS[2]] }) }, { report: report() }] });
    assert.equal(status.state, "completed", status.result?.failureReason);
    assert.equal(status.result.reportRetries, 1);
    assert.deepEqual(status.result.report.scenarios, PASS);
    const events = readFileSync(join(s.dir, ".knit/.runtime/runs", prepared.request.runId, "events.jsonl"), "utf8");
    assert.match(events, /check_scenarios_incomplete:R1.S2/);
    const prompts = readFileSync(promptLog, "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /R2.S1 第二需求／第三场景/);
    assert.match(prompts[1], /R1.S2（第一需求／第二场景）/);
    assert.match(prompts[1], /<编号> <结论>：<证据>/);
  } finally { delete process.env.KNIT_FAKE_PROMPT_LOG; s.cleanup(); }
});

test("R7–R10 模板、受管块、桥接、文档与固定来源", () => {
  assert.equal(readFileSync(join(TEMPLATES, "workflow.yaml"), "utf8"), DEFAULT_WORKFLOW_YAML);
  assert.equal(parseWorkflow(DEFAULT_WORKFLOW_YAML).workflow.stages.find((item) => item.id === "check").report.scenarios, "string[]");
  const managed = agentsManagedBlock("npx --no-install knit");
  const agents = readFileSync(join(ROOT, "AGENTS.md"), "utf8");
  assert.equal(agents.slice(agents.indexOf("<!-- knit:managed-begin -->")), managed);
  assert.match(managed, /验收写成场景.*independent 任务必须写场景/);
  const s = project();
  try {
    const created = spawnSync(process.execPath, [CLI, "--json", "task", "new", "--title", "模板测试", "--dir", s.dir], { encoding: "utf8" });
    assert.equal(created.status, 0, created.stderr);
    const data = JSON.parse(created.stdout).data;
    const body = readFileSync(join(s.dir, ".knit", data.relativePath), "utf8");
    assert.deepEqual([...body.matchAll(/^## (目标与边界|完成条件|待澄清|输入引用)$/gm)].map((match) => match[1]), ["目标与边界", "完成条件", "待澄清", "输入引用"]);
    assert.match(body, /Requirement: 名称.*Scenario: 名称.*WHEN.*THEN.*independent.*必须写场景/);
  } finally { s.cleanup(); }
  const bridge = readFileSync(join(ROOT, "assets/templates/pi/extensions/knit.ts"), "utf8");
  assert.equal(bridge, readFileSync(join(ROOT, ".pi/extensions/knit.ts"), "utf8"));
  assert.match(bridge, /需求澄清：.*验收写成场景.*independent 任务必须写场景/);
  assert.match(readFileSync(join(TEMPLATES, "agents/implement.md"), "utf8"), /validation.*按编号|按编号.*validation/);
  assert.match(readFileSync(join(TEMPLATES, "agents/check.md"), "utf8"), /逐场景核对 WHEN 与 THEN/);
  for (const name of ["DESIGN", "STATES", "OPERATIONS", "ROLE-CONTRACT"]) {
    const text = readFileSync(join(ROOT, `docs/design/${name}.md`), "utf8");
    for (const code of ["scenarios_invalid", "scenarios_required", "report_field_value:scenarios", "check_scenarios_incomplete", "check_scenarios_inconsistent"]) assert.ok(text.includes(code), `${name}: ${code}`);
  }
  assert.match(readFileSync(join(ROOT, "docs/research/RESEARCH.md"), "utf8"), /a959be77cf045ea3156dc5089c9e2f1d6ce9ce70/);
});
