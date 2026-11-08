import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, defaultConfig } from "../dist/application/config.js";
import { resolveProjectRoot, InitializationService } from "../dist/application/initialization.js";
import { AGENTS_MANAGED_MARKER_BEGIN, AGENTS_MANAGED_MARKER_END, agentsManagedBlock, templateDigest } from "../dist/application/templates.js";
import { DEFAULT_WORKFLOW_YAML } from "../dist/domain/workflow.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function freshProject(prefix) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `knit-008-${prefix}-`)));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "t@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
  writeFileSync(join(dir, "README.md"), "# demo\n");
  return dir;
}

function init(service, dir, extra = {}) {
  return service.execute({ dir, client: "pi", ...extra });
}

test("init：首次初始化 ready，逐项清单与私有权限", async () => {
  const dir = freshProject("first");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    const result = await init(service, dir);
    assert.equal(result.ready, true);
    assert.equal(result.bridgeReady, true);
    assert.equal(result.manifestState, "ready");
    assert.ok(result.created.includes(".knit/workflow.yaml"));
    assert.equal(result.created.includes(".knit/workflow.md"), false, "不再生成已删除的 workflow.md");
    assert.ok(result.created.includes(".knit/agents/implement.md"));
    assert.equal(result.created.includes(".knit/agents/deliver.md"), false, "不生成交付辅助角色文件");
    assert.equal(existsSync(join(dir, ".knit", "agents", "deliver.md")), false);
    assert.ok(result.created.includes(".pi/extensions/knit.ts"));
    assert.ok(result.created.includes("AGENTS.md"));
    // 清单 ready、逐项 created
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifest.state, "ready");
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.items.every((item) => item.state === "created"));
    assert.equal(manifest.items.some((item) => item.path === ".knit/agents/deliver.md"), false, "清单不含交付辅助角色");
    // 安装映射：CLI 入口存在、包版本
    const installation = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "installation.json"), "utf8"));
    assert.ok(existsSync(installation.cliEntry), `CLI 入口 ${installation.cliEntry}`);
    assert.equal(installation.packageVersion, JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version);
    // 权限：运行目录 0700、清单 0600；项目资料 0644
    assert.equal(statSync(join(dir, ".knit", ".runtime")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, ".knit", ".runtime", "init-manifest.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".knit", "workflow.yaml")).mode & 0o777, 0o644);
    // 运行目录被忽略且未跟踪
    execFileSync("git", ["check-ignore", "-q", ".knit/.runtime"], { cwd: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：AGENTS 受管块含需求澄清协议与复杂拆分提示（k-efc748322ccf、k-9197494d2657）", async () => {
  const dir = freshProject("clarify-gate");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /先取证再提问/, "取证优先");
    assert.match(agents, /任务历史（含归档任务、run 记录与提交说明）/, "取证包含任务历史");
    assert.match(agents, /目标与成功判据、范围与非目标、验收与证据/, "缺口维度概览");
    assert.match(agents, /每问给出要定的决定、为什么重要、推荐项与选另一项的代价/, "每问四要素");
    assert.match(agents, /一轮最多 3 个/, "一轮提问上限");
    assert.match(agents, /冲突时先指出冲突、影响与替代方案/, "冲突须给替代方案");
    assert.match(agents, /\[blocking\]/, "blocking 标记");
    assert.match(agents, /\[assumed\]/, "assumed 假设标记");
    assert.match(agents, /待澄清/, "待澄清区段");
    assert.match(agents, /blocking.*未清零时.*task ready.*拒绝/, "blocking 阻止 ready");
    assert.match(agents, /不得以“完整方案＋是否正确”作为唯一确认/, "禁止一次性总确认");
    assert.match(agents, /想法登记/, "想法登记路径");
    assert.match(agents, /（Agent 建议，待确认）/, "Agent 建议标注");
    assert.match(agents, /复杂需求先拆分/, "复杂需求拆分提示");
    assert.match(agents, /创建同意不等于实施授权/, "创建同意与实施授权分开");
    assert.match(agents, /任务创建同意不等于需求确认或实施授权/, "discuss 段同步澄清含义");
    assert.match(agents, /派发分层：动手前先判断可委派/, "初始化输出含派发分层");
    assert.match(agents, /W1 独立检查.*W2 改动面.*W3 摸底成本.*W4 用户指定/, "W1–W4 完整");
    assert.match(agents, /没有任务就没有 Knit worker/, "无任务不派 Knit worker");
    assert.match(agents, /不以时长、步骤数、阶段数或是否需要恢复作判据/, "阈值不含时长／步骤／阶段／恢复");
    const bridge = readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8");
    assert.ok(bridge.includes("派发分层：动手前先判断可委派"), "初始化桥接含同一派发分层");
    assert.match(bridge, /复杂但不建任务时不派 Knit run/, "初始化桥接无任务边界");
    assert.match(agents, /历史查询：需求澄清取证时可直接用/, "澄清取证可主动检索历史");
    assert.match(agents, /普通对话仅在用户明确表达/, "普通对话仍按意愿检索");
    assert.match(agents, /knit task search/, "历史检索入口");
    assert.match(agents, /相关记录不等于证明因果/, "相关性与因果边界");
    assert.match(agents, /新事项先问是否建任务/, "先问任务选择");
    assert.match(agents, /暂不创建时继续讨论/, "暂不创建可继续讨论");
    assert.match(agents, /明确不创建时同一事项持续有效/, "拒绝创建持续有效");
    assert.match(agents, /不能用“你做吧”代替/, "实施前补问任务选择");
    assert.match(agents, /用户明确“按这个做”等可同时确认范围与授权实施/, "明确实施可合并确认");
    assert.match(agents, /收敛时给最终摘要（目标、范围内外、验收、关键决定、风险与延期、资料状态）/, "收敛摘要结构");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：workflow.yaml 模板与内置默认流程逐字一致，且不再生成 workflow.md", async () => {
  const dir = freshProject("workflow-template");
  try {
    const asset = readFileSync(join(import.meta.dirname, "..", "assets", "templates", ".knit", "workflow.yaml"), "utf8");
    assert.equal(asset, DEFAULT_WORKFLOW_YAML, "发布模板与内置默认流程同源");
    assert.match(asset, /^# Knit 流程配置/m);
    assert.match(asset, /能力白名单；不写或写 all = 全部放开，\[\] = 全部禁用/);
    assert.doesNotMatch(asset, /空数组 = 全部放开/);
    assert.match(asset, /read\s+只读：read／grep／find／ls/);
    assert.match(asset, /write\s+改文件：write／edit/);
    assert.match(asset, /exec\s+执行命令：bash/);
    assert.match(asset, /task\s+任务／上下文工具（knit_\*）/);
    assert.match(asset, /external\s+放开项目扩展、MCP 与技能/);
    assert.match(asset, /network\s+放开网络/);
    assert.match(asset, /常见错误/);
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    assert.ok(existsSync(join(dir, ".knit", "workflow.yaml")));
    assert.equal(existsSync(join(dir, ".knit", "workflow.md")), false, "workflow.md 不再生成");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：模板已移除文件只报告不删除，不阻断 ready", async () => {
  const dir = freshProject("orphans");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    writeFileSync(join(dir, ".knit", "workflow.md"), "# 旧工作流\n");
    writeFileSync(join(dir, ".knit", "agents", "deliver.md"), "# 旧交付辅助角色\n");
    const manifestPath = join(dir, ".knit", ".runtime", "init-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.items.push(
      { path: ".knit/workflow.md", ownership: "project", state: "kept" },
      { path: ".knit/agents/deliver.md", ownership: "project", state: "kept" },
    );
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    const plan = service.check(dir);
    assert.deepEqual(plan.orphans.map((item) => item.path), [".knit/agents/deliver.md", ".knit/workflow.md"]);
    assert.ok(plan.orphans.every((item) => item.exists), "只报告仍存在的文件");

    const result = await init(service, dir);
    assert.equal(result.ready, true, "孤儿报告不阻断 ready");
    assert.deepEqual(result.orphans.map((item) => item.path), [".knit/agents/deliver.md", ".knit/workflow.md"]);
    assert.ok(existsSync(join(dir, ".knit", "workflow.md")), "默认不删除");
    assert.ok(existsSync(join(dir, ".knit", "agents", "deliver.md")), "默认不删除旧角色文件");
    const forced = await init(service, dir, { force: true });
    assert.equal(forced.ready, true);
    assert.deepEqual(forced.orphans.map((item) => item.path), [".knit/agents/deliver.md", ".knit/workflow.md"]);
    assert.ok(existsSync(join(dir, ".knit", "workflow.md")), "--force 也不删除模板已移除文件");
    assert.ok(existsSync(join(dir, ".knit", "agents", "deliver.md")), "--force 也不删除旧角色文件");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：阶段提示词覆盖停止条件、报告字段与工具边界（k-20bdb1709d7e）", async () => {
  const dir = freshProject("role-contract");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const implement = readFileSync(join(dir, ".knit", "agents", "implement.md"), "utf8");
    assert.match(implement, /StageReportSchema/, "实施报告字段指向 schema");
    assert.match(implement, /summary/);
    assert.match(implement, /changedPaths/, "实施报告必须列实际路径");
    assert.match(implement, /unverified/);
    assert.match(implement, /阻塞/, "实施停止条件");
    assert.match(implement, /不修改 `\.knit\/` 下规范、配置、流程与提示词/, "实施保护路径");
    assert.match(implement, /优先经 `knit_task`／`knit_material`/, "任务资料优先走接口");
    assert.match(implement, /不判越界但无法归因/, "直接编辑的语义");
    assert.match(implement, /不 git commit／push／rebase/, "实施禁止 Git 操作");
    assert.match(implement, /由主会话通过核心材料接口写回/, "接口不可用时交回主会话");
    assert.doesNotMatch(implement, /直接更新 plan\.md/, "不指示阶段绕过接口改计划");
    const check = readFileSync(join(dir, ".knit", "agents", "check.md"), "utf8");
    assert.match(check, /StageReportSchema/);
    assert.match(check, /verdict/);
    assert.match(check, /coverage/);
    assert.match(check, /selfVerified/);
    assert.match(check, /findings/);
    assert.match(check, /unverified/);
    assert.match(check, /可直接修改必要文件/, "检查可在范围内修复");
    assert.match(check, /不修改 `\.knit\/` 下规范、配置、流程与提示词/, "检查保护路径");
    assert.match(check, /changes_requested|blocked/, "检查交回结论");
    const runtime = readFileSync(join(dir, ".knit", "agents", "runtimes", "pi.md"), "utf8");
    assert.match(runtime, /--no-extensions/);
    assert.match(runtime, /工具范围由该阶段 `tools` 能力白名单决定/);
    assert.match(runtime, /changedPaths/);
    assert.match(runtime, /停止条件/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：无 Pi 依赖、无 Git 提交、无依赖安装", async () => {
  const dir = freshProject("nogit-call");
  try {
    const revCount = () => execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir }).toString().trim();
    // 空仓库无 HEAD：先打一个基线提交再核对 init 不加提交
    writeFileSync(join(dir, "base.txt"), "base\n");
    execFileSync("git", ["add", "base.txt"], { cwd: dir });
    execFileSync("git", ["commit", "-q", "-m", "base"], { cwd: dir });
    const before = revCount();
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    assert.equal(revCount(), before, "不执行 Git 提交");
    const porcelain = execFileSync("git", ["status", "--porcelain"], { cwd: dir }).toString().trim().split("\n");
    assert.ok(
      porcelain.every((line) => line.startsWith("??") && ["README.md", "AGENTS.md", ".knit/", ".pi/"].some((p) => line.endsWith(p))),
      `init 只新增未跟踪文件，不暂存：${porcelain.join(" | ")}`,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：项目资料默认沿用，受管冲突不覆盖，--force 覆盖并备份", async () => {
  const dir = freshProject("conflict");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    // 人工修改项目正文、受管桥接、AGENTS 正文
    const customWorkflow = "# 项目自定义流程\nversion: 1\nstages:\n  - id: implement\n";
    writeFileSync(join(dir, ".knit", "workflow.yaml"), customWorkflow);
    writeFileSync(join(dir, ".pi", "extensions", "knit.ts"), "// 人工改动\n");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    writeFileSync(join(dir, "AGENTS.md"), `${agents}人工补充规则\n`);
    const result = await init(service, dir);
    assert.equal(result.ready, false);
    assert.deepEqual(result.conflicts, [".pi/extensions/knit.ts"]);
    assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), customWorkflow, "默认沿用项目配置");
    assert.equal(readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8"), "// 人工改动\n", "受管冲突不覆盖");
    assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").endsWith("人工补充规则\n"), "AGENTS 正文保留");
    // 清单 failed，逐项 conflict
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifest.state, "failed");
    const bridgeItem = manifest.items.find((item) => item.path === ".pi/extensions/knit.ts");
    assert.equal(bridgeItem.state, "conflict");
    // --force 覆盖项目模板与受管内容，并备份项目原文件
    const forced = await init(service, dir, { force: true });
    assert.equal(forced.ready, true);
    assert.ok(readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8").includes("Knit 项目薄桥接"));
    assert.deepEqual(forced.overwritten, [".knit/workflow.yaml"], "force 覆盖项目模板文件");
    assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), readFileSync(join(import.meta.dirname, "..", "assets", "templates", ".knit", "workflow.yaml"), "utf8"));
    assert.ok(forced.backupRoot, "覆盖时返回备份根");
    assert.equal(readFileSync(join(forced.backupRoot, ".knit", "workflow.yaml"), "utf8"), customWorkflow, "备份内容为原文");
    // 受管 AGENTS 块与基线一致时人工改动不受影响
    assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").endsWith("人工补充规则\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --force：覆盖项目模板并备份原文，--check 只预览", async () => {
  const dir = freshProject("force-overwrite");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const workflowPath = join(dir, ".knit", "workflow.yaml");
    const configPath = join(dir, ".knit", "config.json");
    const promptPath = join(dir, ".knit", "agents", "implement.md");
    const customWorkflow = "# 项目自定义流程\nversion: 1\n";
    const customConfig = JSON.stringify({ schemaVersion: 1, custom: true }, null, 2) + "\n";
    const customPrompt = "# 项目自定义实施提示\n";
    writeFileSync(workflowPath, customWorkflow);
    writeFileSync(configPath, customConfig);
    writeFileSync(promptPath, customPrompt);
    writeFileSync(join(dir, ".knit", "notes.md"), "用户自建文件\n");

    const cliPreview = JSON.parse(execFileSync(process.execPath, [CLI, "init", "--json", "--check", "--force", "--dir", dir], { encoding: "utf8" }));
    assert.equal(cliPreview.data.force, true);
    assert.equal(cliPreview.data.overwriteCount, 3, "CLI --check --force 只输出覆盖预览");
    assert.ok(!existsSync(join(dir, ".knit", ".runtime", "init-backup")), "CLI --check 不创建备份目录");

    const plan = service.check(dir, { force: true });
    assert.equal(plan.force, true);
    assert.equal(plan.overwriteCount, 3, "预览三个与模板不同的项目文件");
    assert.deepEqual(
      plan.items.filter((item) => item.overwrite).map((item) => item.path).sort(),
      [".knit/agents/implement.md", ".knit/config.json", ".knit/workflow.yaml"],
    );
    assert.ok(plan.items.filter((item) => item.overwrite).every((item) => item.action === "update"));
    assert.ok(plan.items.filter((item) => item.overwrite).every((item) => item.reason.includes("--force")));
    assert.ok(!existsSync(join(dir, ".knit", ".runtime", "init-backup")), "--check 不创建备份目录");
    assert.equal(readFileSync(workflowPath, "utf8"), customWorkflow, "--check 不写文件");

    const result = await init(service, dir, { force: true });
    assert.equal(result.ready, true, "覆盖成功不降级");
    assert.equal(result.overwriteCount, 3);
    assert.deepEqual(result.overwritten.sort(), [".knit/agents/implement.md", ".knit/config.json", ".knit/workflow.yaml"]);
    assert.deepEqual(result.backups.map((item) => item.path).sort(), result.overwritten);
    assert.ok(result.backupRoot);
    assert.equal(statSync(result.backupRoot).mode & 0o777, 0o700, "备份根目录 0700");
    assert.equal(readFileSync(join(result.backupRoot, ".knit", "workflow.yaml"), "utf8"), customWorkflow, "备份为原文");
    assert.equal(readFileSync(join(result.backupRoot, ".knit", "config.json"), "utf8"), customConfig);
    assert.equal(readFileSync(join(result.backupRoot, ".knit", "agents", "implement.md"), "utf8"), customPrompt);
    assert.equal(readFileSync(workflowPath, "utf8"), readFileSync(join(import.meta.dirname, "..", "assets", "templates", ".knit", "workflow.yaml"), "utf8"));
    assert.equal(readFileSync(configPath, "utf8"), JSON.stringify(defaultConfig(), null, 2) + "\n");
    assert.equal(readFileSync(promptPath, "utf8"), readFileSync(join(import.meta.dirname, "..", "assets", "templates", ".knit", "agents", "implement.md"), "utf8"));
    assert.equal(readFileSync(join(dir, ".knit", "notes.md"), "utf8"), "用户自建文件\n", "不删除用户自建非模板文件");
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifest.state, "ready");
    assert.equal(manifest.overwriteCount, 3, "清单记录覆盖计数");
    assert.equal(manifest.backupRoot, result.backupRoot, "清单记录备份根");
    assert.deepEqual(manifest.backups.map((item) => item.path).sort(), result.overwritten);
    assert.equal(manifest.items.find((item) => item.path === ".knit/workflow.yaml").state, "updated");
    assert.equal(manifest.items.find((item) => item.path === ".knit/workflow.yaml").backupPath, join(result.backupRoot, ".knit", "workflow.yaml"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --force：内容已一致时不重写、不建备份", async () => {
  const dir = freshProject("force-identical");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const workflowPath = join(dir, ".knit", "workflow.yaml");
    const configPath = join(dir, ".knit", "config.json");
    const before = { workflow: statSync(workflowPath).ino, config: statSync(configPath).ino };
    const result = await init(service, dir, { force: true });
    assert.equal(result.ready, true);
    assert.equal(result.overwriteCount, 0);
    assert.deepEqual(result.overwritten, []);
    assert.equal(result.backupRoot, null, "无覆盖不返回备份根");
    assert.deepEqual(result.backups, []);
    assert.deepEqual(result.alreadyCurrent.sort(), [
      ".knit/agents/check.md",
      ".knit/agents/implement.md",
      ".knit/agents/runtimes/pi.md",
      ".knit/config.json",
      ".knit/standards/index.md",
      ".knit/workflow.yaml",
    ]);
    assert.equal(statSync(workflowPath).ino, before.workflow, "已一致不重写");
    assert.equal(statSync(configPath).ino, before.config, "已一致不重写");
    assert.ok(!existsSync(join(dir, ".knit", ".runtime", "init-backup")), "未发生覆盖不创建备份目录");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：重复执行幂等，AGENTS 标记块只追加一次", async () => {
  const dir = freshProject("repeat");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const once = readFileSync(join(dir, "AGENTS.md"), "utf8");
    const second = await init(service, dir);
    assert.equal(second.ready, true);
    assert.ok(second.created.length === 0, "重复执行不再创建");
    assert.deepEqual(
      second.updated.filter((path) => path !== ".knit/.runtime/installation.json"),
      [],
      "除安装映射外无更新",
    );
    assert.equal(readFileSync(join(dir, "AGENTS.md"), "utf8"), once, "AGENTS.md 不变");
    assert.equal(once.split(AGENTS_MANAGED_MARKER_BEGIN).length - 1, 1, "标记块唯一");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：旧项目修改受管块报告差异，--force 显式更新，项目正文保留", async () => {
  const dir = freshProject("agents-conflict");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const agentsPath = join(dir, "AGENTS.md");
    const original = readFileSync(agentsPath, "utf8");
    const modified = `项目自定义规则\n\n${original.replace("本块由 Knit 生成并按基线维护", "人工改写的受管块说明")}`;
    writeFileSync(agentsPath, modified);
    const conflict = await init(service, dir);
    assert.equal(conflict.ready, false);
    assert.ok(conflict.conflicts.includes("AGENTS.md"), "受管块差异可见");
    assert.equal(readFileSync(agentsPath, "utf8"), modified, "不静默覆盖人工块");
    const forced = await init(service, dir, { force: true });
    assert.equal(forced.ready, true, forced.conflicts.join(","));
    const updated = readFileSync(agentsPath, "utf8");
    assert.ok(updated.startsWith("项目自定义规则\n"), "受管块外正文保留");
    assert.equal(updated.slice(updated.indexOf(AGENTS_MANAGED_MARKER_BEGIN)), agentsManagedBlock("npx --no-install knit"), "force 更新为当前基线");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init --check：只读不写，不建锁目录与运行目录", async () => {
  const dir = freshProject("check");
  try {
    const locksRoot = join(dir, ".locks-root");
    const service = new InitializationService({ locksRoot });
    const plan = service.check(dir);
    assert.equal(plan.isGitRepo, true);
    assert.ok(plan.items.some((item) => item.path === "AGENTS.md" && item.action === "create"));
    assert.ok(!existsSync(join(dir, ".knit")), "--check 不写 .knit/");
    assert.ok(!existsSync(locksRoot), "--check 不建锁目录");
    // CLI 形态同样只读
    execFileSync(process.execPath, [CLI, "init", "--check", "--dir", dir], { env: { ...process.env, KNIT_LOCKS_ROOT: locksRoot } });
    assert.ok(!existsSync(join(dir, ".knit")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：子目录归一到仓库根；非 Git 目录可准备资料并提示 Git 条件", async () => {
  const dir = freshProject("subdir");
  try {
    mkdirSync(join(dir, "packages", "app"), { recursive: true });
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    const result = await init(service, join(dir, "packages", "app"));
    assert.equal(result.root, dir, "子目录归一到仓库根");
    assert.ok(existsSync(join(dir, ".knit", "workflow.yaml")));
    // 非 Git 目录
    const plain = mkdtempSync(join(tmpdir(), "knit-008-plain-"));
    try {
      const plainResult = await init(service, plain);
      assert.equal(plainResult.root, plain);
      assert.ok(plainResult.gitWarning?.includes("Git"), "非 Git 提示正式执行条件");
      assert.equal(plainResult.ready, true, "无 Pi 也能准备资料");
    } finally {
      rmSync(plain, { recursive: true, force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：上次受管基线可升级，人工改动仍冲突；更新版本不降级", async () => {
  const dir = freshProject("baseline-upgrade");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const bridge = join(dir, ".pi", "extensions", "knit.ts");
    const oldBody = "// 上一版受管桥接基线\n";
    writeFileSync(bridge, oldBody);
    const manifestPath = join(dir, ".knit", ".runtime", "init-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.items.find((entry) => entry.path === ".pi/extensions/knit.ts");
    item.baselineSha256 = sha256Text(oldBody);
    item.currentSha256 = sha256Text(oldBody);
    item.state = "kept";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    const upgraded = await init(service, dir);
    assert.equal(upgraded.ready, true, upgraded.conflicts.join(","));
    assert.ok(readFileSync(bridge, "utf8").includes("Knit 项目薄桥接"));
    const plan = service.check(dir);
    assert.equal(plan.items.find((entry) => entry.path === ".pi/extensions/knit.ts").action, "keep");
    // 人工改写后不再按旧基线覆盖
    writeFileSync(bridge, "// 用户自定义\n");
    const conflict = await init(service, dir);
    assert.equal(conflict.ready, false);
    assert.deepEqual(conflict.conflicts, [".pi/extensions/knit.ts"]);
    // 更新版本清单不能由旧安装包降级
    const newer = JSON.parse(readFileSync(manifestPath, "utf8"));
    newer.templateVersion = "999.0.0";
    writeFileSync(manifestPath, JSON.stringify(newer, null, 2) + "\n");
    await assert.rejects(
      () => init(service, dir),
      (error) => error.code === "version_conflict",
    );
    assert.equal(readFileSync(bridge, "utf8"), "// 用户自定义\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：升级中断重试保留旧受管基线，桥接不判未知来源（任务039）", async () => {
  const dir = freshProject("upgrade-interrupted");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    // 模拟旧版本基线：上次清单记录旧桥接基线，桥接文件为旧版。
    const bridge = join(dir, ".pi", "extensions", "knit.ts");
    const oldBody = "// 上一版受管桥接基线\n";
    writeFileSync(bridge, oldBody);
    const manifestPath = join(dir, ".knit", ".runtime", "init-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.items.find((entry) => entry.path === ".pi/extensions/knit.ts");
    item.baselineSha256 = sha256Text(oldBody);
    item.currentSha256 = sha256Text(oldBody);
    item.state = "kept";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");

    // 中断点：preparing 已发布（修复后 preparing 合并保留旧基线项），桥接候选未发布。
    const interrupted = JSON.parse(readFileSync(manifestPath, "utf8"));
    interrupted.state = "preparing";
    writeFileSync(manifestPath, JSON.stringify(interrupted, null, 2) + "\n");
    assert.ok(
      interrupted.items.some((entry) => entry.path === ".pi/extensions/knit.ts" && entry.baselineSha256 === sha256Text(oldBody)),
      "preparing 中断不丢失旧桥接基线",
    );

    const retried = await init(service, dir);
    assert.equal(retried.ready, true, retried.conflicts.join(","));
    assert.deepEqual(retried.conflicts, []);
    assert.ok(readFileSync(bridge, "utf8").includes("Knit 项目薄桥接"));
    const finalManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(finalManifest.state, "ready");
    assert.ok(finalManifest.items.some((entry) => entry.path === ".pi/extensions/knit.ts"));

    // 对照：人工改过的桥接仍按冲突处理，不隐式覆盖。
    writeFileSync(bridge, "// 用户自定义\n");
    const conflict = await init(service, dir);
    assert.equal(conflict.ready, false);
    assert.deepEqual(conflict.conflicts, [".pi/extensions/knit.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：清单项被外部清空后（旧缺陷遗留）重试准确报告真实冲突，不冒充升级成功（任务039）", async () => {
  const dir = freshProject("upgrade-emptied");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const bridge = join(dir, ".pi", "extensions", "knit.ts");
    const oldBody = "// 上一版受管桥接基线\n";
    writeFileSync(bridge, oldBody);
    const manifestPath = join(dir, ".knit", ".runtime", "init-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const item = manifest.items.find((entry) => entry.path === ".pi/extensions/knit.ts");
    item.baselineSha256 = sha256Text(oldBody);
    item.currentSha256 = sha256Text(oldBody);
    item.state = "kept";
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    // 旧缺陷遗留：清单被清空，基线无处恢复。
    const interrupted = JSON.parse(readFileSync(manifestPath, "utf8"));
    interrupted.state = "preparing";
    interrupted.items = [];
    writeFileSync(manifestPath, JSON.stringify(interrupted, null, 2) + "\n");
    const retried = await init(service, dir);
    assert.equal(retried.ready, false, "无基线依据不能宣称升级完成");
    assert.deepEqual(retried.conflicts, [".pi/extensions/knit.ts"]);
    // 但本次执行后新基线已建立：再次重试按新基线升级。
    writeFileSync(bridge, "// 上一版受管桥接基线\n");
    const after = JSON.parse(readFileSync(manifestPath, "utf8"));
    const bridgeItem = after.items.find((entry) => entry.path === ".pi/extensions/knit.ts");
    bridgeItem.baselineSha256 = sha256Text("// 上一版受管桥接基线\n");
    writeFileSync(manifestPath, JSON.stringify(after, null, 2) + "\n");
    const upgraded = await init(service, dir);
    assert.equal(upgraded.ready, true, upgraded.conflicts.join(","));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：安装映射移动／换机器后由 init 重写，不把本机绝对路径写进桥接", async () => {
  const dir = freshProject("installation-move");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const installationPath = join(dir, ".knit", ".runtime", "installation.json");
    const installation = JSON.parse(readFileSync(installationPath, "utf8"));
    installation.cliEntry = "/nonexistent/old-machine/knit.js";
    writeFileSync(installationPath, JSON.stringify(installation, null, 2) + "\n");
    const result = await init(service, dir);
    assert.equal(result.ready, true);
    const repaired = JSON.parse(readFileSync(installationPath, "utf8"));
    assert.notEqual(repaired.cliEntry, "/nonexistent/old-machine/knit.js");
    assert.ok(existsSync(repaired.cliEntry));
    const bridge = readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8");
    assert.equal(bridge.includes(dir), false, "桥接不嵌项目或安装机绝对路径");
    assert.equal(bridge.includes("/nonexistent/old-machine"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("init：缺映射／未 ready 不能声称可调用（bridgeReady 为 false）", async () => {
  const dir = freshProject("notready");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    // 删除安装映射后模拟失败清单：bridgeReady 只在 ready 且文件存在
    const manifestPath = join(dir, ".knit", ".runtime", "init-manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.state = "failed";
    writeFileSync(manifestPath, JSON.stringify(manifest));
    rmSync(join(dir, ".pi", "extensions", "knit.ts"));
    const rerun = await init(service, dir);
    assert.equal(rerun.ready, true, "重试补齐后 ready");
    assert.equal(rerun.bridgeReady, true);
    // 受管冲突时 bridgeReady false
    writeFileSync(join(dir, ".pi", "extensions", "knit.ts"), "// 改动\n");
    const conflict = await init(service, dir);
    assert.equal(conflict.ready, false);
    assert.equal(conflict.bridgeReady, false, "未 ready 不能声称桥接可调用");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("config：默认配置解析与未知版本阻塞", () => {
  const config = parseConfig(JSON.stringify(defaultConfig()));
  assert.equal(config.schemaVersion, 1);
  assert.equal(config.limits.heartbeatStaleMs > config.limits.heartbeatIntervalMs, true);
  assert.throws(
    () => parseConfig(JSON.stringify({ ...defaultConfig(), schemaVersion: 2 })),
    (error) => error.code === "version_conflict",
    "未知 schemaVersion 阻塞写入",
  );
  assert.throws(() => parseConfig("{broken"), (error) => error.code === "io_error");
  // 心跳可疑阈值必须大于间隔
  const bad = defaultConfig();
  bad.limits.heartbeatStaleMs = bad.limits.heartbeatIntervalMs;
  assert.throws(() => parseConfig(JSON.stringify(bad)), (error) => error.code === "io_error");
});

test("模板：仓库 AGENTS.md 受管块与当前基线逐字一致", () => {
  const content = readFileSync(join(import.meta.dirname, "..", "AGENTS.md"), "utf8");
  const begin = content.indexOf(AGENTS_MANAGED_MARKER_BEGIN);
  const end = content.indexOf(AGENTS_MANAGED_MARKER_END);
  assert.ok(begin !== -1 && end > begin, "仓库 AGENTS.md 含受管块标记");
  const currentBlock = `${content.slice(begin, end + AGENTS_MANAGED_MARKER_END.length)}\n`;
  assert.equal(currentBlock, agentsManagedBlock("npx --no-install knit"), "受管块不漂移");
});

test("模板：受管基线指纹稳定，AGENTS 块含标记与入口", () => {
  const digest = templateDigest(".pi/extensions/knit.ts");
  assert.equal(digest, templateDigest(".pi/extensions/knit.ts"), "指纹稳定");
  const block = agentsManagedBlock("knit");
  assert.ok(block.startsWith(AGENTS_MANAGED_MARKER_BEGIN));
  assert.ok(block.trimEnd().endsWith(AGENTS_MANAGED_MARKER_END));
  assert.ok(block.includes(".knit/workflow.yaml"));
  assert.equal(block.includes(".knit/workflow.md"), false, "受管块不再引用已删除的 workflow.md");
  assert.ok(block.includes("knit task list"));
  assert.ok(block.includes("主会话入口"));
  assert.ok(block.includes("规范沉淀："));
  assert.ok(block.includes("交付：主会话"));
  assert.ok(block.includes("创建任务不等于需求确认或实施授权"));
  assert.equal((block.match(/历史查询：/g) ?? []).length, 1, "受管块历史查询只出现一次");
  assert.equal((block.match(/需求澄清门：/g) ?? []).length, 1, "受管块需求澄清协议只出现一次");
  assert.ok(block.includes("不得以“完整方案＋是否正确”作为唯一确认"));
  assert.ok(block.includes("「待澄清」区段"));
});

test("模板：阶段契约文档覆盖职责、停止条件、报告与 Trellis／GSD 来源", () => {
  const doc = readFileSync(join(import.meta.dirname, "..", "docs", "design", "ROLE-CONTRACT.md"), "utf8");
  assert.match(doc, /职责/);
  assert.match(doc, /停止条件/);
  assert.match(doc, /StageReportSchema/);
  assert.match(doc, /工具事实/);
  assert.match(doc, /f089cb3286071199e84118dee86b6d76aab032f1/);
  assert.match(doc, /1ec5c812b79dc1cc487d0873d18b03449b11c106/);
  assert.match(doc, /Trellis 来源映射/);
  assert.match(doc, /GSD 来源映射/);
});

test("模板：派发分层标准与两个桥接逐字一致（k-ae990e2f36dc）", () => {
  const root = join(import.meta.dirname, "..");
  const block = agentsManagedBlock("npx --no-install knit");
  const line = block.split("\n").find((entry) => entry.startsWith("- 派发分层："));
  assert.ok(line, "受管块含派发分层条目");
  const guidance = line.slice(2);
  for (const phrase of [
    "W1 独立检查",
    "W2 改动面",
    "W3 摸底成本",
    "W4 用户指定",
    "其余主会话直接做",
    "没有任务就没有 Knit worker",
    "该派但无任务时先向用户提议建任务，不代建",
    "复杂但不建任务时用宿主通用子 Agent",
    "independent 不得用主会话自检或 run check --scope 代替",
    "也不得用 task implement 绕开 W1",
  ]) {
    assert.ok(guidance.includes(phrase), `受管块含：${phrase}`);
  }
  assert.match(guidance, /不以时长、步骤数、阶段数或是否需要恢复作判据/, "阈值边界与任务要求一致");
  const bridges = [
    readFileSync(join(root, ".pi", "extensions", "knit.ts"), "utf8"),
    readFileSync(join(root, "assets", "templates", "pi", "extensions", "knit.ts"), "utf8"),
  ];
  assert.equal(bridges[0], bridges[1], "两份桥接保持一致");
  for (const bridge of bridges) {
    assert.ok(bridge.includes(guidance), "桥接提示词与受管块逐字一致");
    assert.match(bridge, /复杂但不建任务时不派 Knit run/, "无任务分支补充 Knit run 边界");
  }
});

test("文档：DESIGN §4.2 与 ROLE-CONTRACT 派发分层同口径（k-ae990e2f36dc）", () => {
  const root = join(import.meta.dirname, "..");
  const design = readFileSync(join(root, "docs", "design", "DESIGN.md"), "utf8");
  const section = design.slice(design.indexOf("### 4.2"), design.indexOf("### 4.3"));
  assert.match(section, /派发分层由主会话在动手前判断/);
  assert.match(section, /W1 独立检查/);
  assert.match(section, /W2 改动面/);
  assert.match(section, /W3 摸底成本/);
  assert.match(section, /W4 用户指定/);
  assert.match(section, /不以墙钟时长、步骤数量、阶段数量或是否需要恢复作判据/, "阈值边界与提示词一致");
  assert.match(section, /\| 工作 \| 无任务 \| 有任务 \|/, "含任务与派发矩阵");
  assert.match(section, /没有任务就没有 Knit worker/);
  assert.match(section, /independent` 不得用主会话自检或 `run check --scope` 代替/, "独立检查不可替代");
  assert.match(section, /不得用 `task implement` 绕开 W1/, "task implement 不绕开 W1");
  const role = readFileSync(join(root, "docs", "design", "ROLE-CONTRACT.md"), "utf8");
  assert.match(role, /主会话派发分层/);
  assert.match(role, /W1–W4 判断是否派 Knit worker/);
  assert.match(role, /worker 仍只在任务内派发/);
  assert.match(role, /没有任务就没有 Knit worker/);
});

test("CLI：init --json 输出协议响应；--pi 与无开关等价，未注册客户端开关被拒绝", async () => {
  const withFlag = freshProject("cli-pi");
  const defaultFlag = freshProject("cli-default");
  try {
    const flagged = JSON.parse(execFileSync(process.execPath, [CLI, "init", "--json", "--pi", "--dir", withFlag], { encoding: "utf8" }));
    const fallback = JSON.parse(execFileSync(process.execPath, [CLI, "init", "--json", "--dir", defaultFlag], { encoding: "utf8" }));
    assert.equal(flagged.protocolVersion, 1);
    assert.equal(flagged.outcome, "completed");
    assert.equal(flagged.data.ready, true);
    assert.equal(fallback.outcome, "completed");
    assert.equal(fallback.data.ready, true);
    assert.deepEqual(flagged.data.created.sort(), fallback.data.created.sort(), "--pi 与无开关等价");
    const manifestOf = (dir) => JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifestOf(withFlag).client, "pi");
    assert.equal(manifestOf(defaultFlag).client, "pi");
    for (const oldArgs of [["--codex"], ["--client", "pi"]]) {
      const bad = spawnSync(process.execPath, [CLI, "init", "--json", ...oldArgs, "--dir", withFlag], { encoding: "utf8" });
      assert.notEqual(bad.status, 0, `${oldArgs.join(" ")} 应失败`);
      assert.match(bad.stderr, /unknown option/, `${oldArgs.join(" ")} 由 commander 拒绝`);
    }
  } finally {
    rmSync(withFlag, { recursive: true, force: true });
    rmSync(defaultFlag, { recursive: true, force: true });
  }
});

test("CLI：start 未初始化提示使用 --pi，未注册客户端开关被拒绝", () => {
  const dir = mkdtempSync(join(tmpdir(), "knit-008-start-"));
  try {
    const missing = spawnSync(process.execPath, [CLI, "--json", "start", "--dir", dir], { encoding: "utf8" });
    assert.notEqual(missing.status, 0);
    const response = JSON.parse(missing.stdout);
    assert.equal(response.reasonCode, "needs_context");
    assert.match(response.data.error, /knit init --pi/);
    const unknown = spawnSync(process.execPath, [CLI, "start", "--codex", "--dir", dir], { encoding: "utf8" });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /unknown option '--codex'/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("项目根解析：目录不存在与文件路径报错", () => {
  assert.throws(() => resolveProjectRoot("/tmp/definitely-not-exist-knit-008"), (error) => error.code === "io_error");
  const file = mkdtempSync(join(tmpdir(), "knit-008-file-"));
  try {
    const filePath = join(file, "f.txt");
    writeFileSync(filePath, "x");
    assert.throws(() => resolveProjectRoot(filePath), (error) => error.code === "io_error");
  } finally {
    rmSync(file, { recursive: true, force: true });
  }
});
