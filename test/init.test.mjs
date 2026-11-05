import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
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

test("init：AGENTS 受管块含创建前需求澄清门与复杂拆分提示（k-efc748322ccf）", async () => {
  const dir = freshProject("clarify-gate");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    assert.match(agents, /关键缺口先讨论/, "关键缺口先讨论");
    assert.match(agents, /需求明确直接登记/, "需求明确直接登记");
    assert.match(agents, /想法登记/, "想法登记路径");
    assert.match(agents, /（Agent 建议，待确认）/, "Agent 建议标注");
    assert.match(agents, /复杂需求先拆分/, "复杂需求拆分提示");
    assert.match(agents, /创建同意不等于实施授权/, "创建同意与实施授权分开");
    assert.match(agents, /任务创建同意不等于需求确认或实施授权/, "discuss 段同步澄清含义");
    assert.match(agents, /历史查询意愿/, "历史查询意愿触发规则");
    assert.match(agents, /knit task search/, "历史检索入口");
    assert.match(agents, /相关记录不等于证明因果/, "相关性与因果边界");
    assert.match(agents, /新事项先问是否建任务/, "先问任务选择");
    assert.match(agents, /暂不创建时继续讨论/, "暂不创建可继续讨论");
    assert.match(agents, /明确不创建时同一事项持续有效/, "拒绝创建持续有效");
    assert.match(agents, /不能用“你做吧”代替/, "实施前补问任务选择");
    assert.match(agents, /用户明确“按这个做”等可同时确认范围与授权实施/, "明确实施可合并确认");
    assert.match(agents, /归纳问题、范围、完成条件与待决事项/, "讨论可实施时归纳结构");
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
    assert.match(asset, /能力白名单；不写 = 全部放开/);
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
    assert.match(implement, /不修改 `\.knit\/` 下任何文件/, "实施保护路径");
    assert.match(implement, /不 git commit／push／rebase/, "实施禁止 Git 操作");
    assert.match(implement, /由主会话通过核心材料接口写回/, "计划进度不直接写 .knit");
    assert.doesNotMatch(implement, /直接更新 plan\.md/, "不指示阶段直接改受保护计划");
    const check = readFileSync(join(dir, ".knit", "agents", "check.md"), "utf8");
    assert.match(check, /StageReportSchema/);
    assert.match(check, /verdict/);
    assert.match(check, /coverage/);
    assert.match(check, /selfVerified/);
    assert.match(check, /findings/);
    assert.match(check, /unverified/);
    assert.match(check, /可直接修改必要文件/, "检查可在范围内修复");
    assert.match(check, /不修改 `\.knit\/` 下任何文件/, "检查保护路径");
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

test("init：项目资料只补缺，受管冲突不覆盖，--force 显式更新", async () => {
  const dir = freshProject("conflict");
  try {
    const service = new InitializationService({ locksRoot: join(dir, ".locks-root") });
    await init(service, dir);
    // 人工修改项目正文、受管桥接、AGENTS 正文
    writeFileSync(join(dir, ".knit", "workflow.yaml"), "# 项目自定义流程\nversion: 1\nstages:\n  - id: implement\n");
    writeFileSync(join(dir, ".pi", "extensions", "knit.ts"), "// 人工改动\n");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    writeFileSync(join(dir, "AGENTS.md"), `${agents}人工补充规则\n`);
    const result = await init(service, dir);
    assert.equal(result.ready, false);
    assert.deepEqual(result.conflicts, [".pi/extensions/knit.ts"]);
    assert.equal(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8"), "# 项目自定义流程\nversion: 1\nstages:\n  - id: implement\n", "项目配置不覆盖");
    assert.equal(readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8"), "// 人工改动\n", "受管冲突不覆盖");
    assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").endsWith("人工补充规则\n"), "AGENTS 正文保留");
    // 清单 failed，逐项 conflict
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifest.state, "failed");
    const bridgeItem = manifest.items.find((item) => item.path === ".pi/extensions/knit.ts");
    assert.equal(bridgeItem.state, "conflict");
    // --force 更新受管内容
    const forced = await init(service, dir, { force: true });
    assert.equal(forced.ready, true);
    assert.ok(readFileSync(join(dir, ".pi", "extensions", "knit.ts"), "utf8").includes("Knit 项目薄桥接"));
    assert.ok(readFileSync(join(dir, ".knit", "workflow.yaml"), "utf8").startsWith("# 项目自定义流程"), "force 仍不覆盖项目资料");
    // 受管 AGENTS 块与基线一致时人工改动不受影响
    assert.ok(readFileSync(join(dir, "AGENTS.md"), "utf8").endsWith("人工补充规则\n"));
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

test("CLI：init --json 输出协议响应；未知客户端拒绝", async () => {
  const dir = freshProject("cli-json");
  try {
    const out = execFileSync(process.execPath, [CLI, "init", "--json", "--dir", dir], { encoding: "utf8" });
    const response = JSON.parse(out);
    assert.equal(response.protocolVersion, 1);
    assert.equal(response.outcome, "completed");
    assert.equal(response.data.ready, true);
    const bad = execFileSync(process.execPath, [CLI, "init", "--json", "--client", "codex", "--dir", dir], { encoding: "utf8" });
    const badResponse = JSON.parse(bad);
    assert.equal(badResponse.outcome, "error");
    assert.equal(badResponse.reasonCode, "invalid_request");
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
