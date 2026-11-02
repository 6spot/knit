import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseConfig, defaultConfig } from "../dist/application/config.js";
import { resolveProjectRoot, InitializationService } from "../dist/application/initialization.js";
import { AGENTS_MANAGED_MARKER_BEGIN, AGENTS_MANAGED_MARKER_END, agentsManagedBlock, templateDigest } from "../dist/application/templates.js";
import { sha256Text } from "../dist/infrastructure/fingerprint.js";

const CLI = join(import.meta.dirname, "..", "dist", "cli", "knit.js");

function freshProject(prefix) {
  const dir = mkdtempSync(join(tmpdir(), `knit-008-${prefix}-`));
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
    assert.ok(result.created.includes(".knit/workflow.md"));
    assert.ok(result.created.includes(".pi/extensions/knit.ts"));
    assert.ok(result.created.includes("AGENTS.md"));
    // 清单 ready、逐项 created
    const manifest = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "init-manifest.json"), "utf8"));
    assert.equal(manifest.state, "ready");
    assert.equal(manifest.schemaVersion, 1);
    assert.ok(manifest.items.every((item) => item.state === "created"));
    // 安装映射：CLI 入口存在、包版本
    const installation = JSON.parse(readFileSync(join(dir, ".knit", ".runtime", "installation.json"), "utf8"));
    assert.ok(existsSync(installation.cliEntry), `CLI 入口 ${installation.cliEntry}`);
    assert.equal(installation.packageVersion, JSON.parse(readFileSync(join(import.meta.dirname, "..", "package.json"), "utf8")).version);
    // 权限：运行目录 0700、清单 0600；项目资料 0644
    assert.equal(statSync(join(dir, ".knit", ".runtime")).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, ".knit", ".runtime", "init-manifest.json")).mode & 0o777, 0o600);
    assert.equal(statSync(join(dir, ".knit", "workflow.md")).mode & 0o777, 0o644);
    // 运行目录被忽略且未跟踪
    execFileSync("git", ["check-ignore", "-q", ".knit/.runtime"], { cwd: dir });
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
    writeFileSync(join(dir, ".knit", "workflow.md"), "项目自定义工作流\n");
    writeFileSync(join(dir, ".pi", "extensions", "knit.ts"), "// 人工改动\n");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    writeFileSync(join(dir, "AGENTS.md"), `${agents}人工补充规则\n`);
    const result = await init(service, dir);
    assert.equal(result.ready, false);
    assert.deepEqual(result.conflicts, [".pi/extensions/knit.ts"]);
    assert.equal(readFileSync(join(dir, ".knit", "workflow.md"), "utf8"), "项目自定义工作流\n", "项目正文不覆盖");
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
    assert.ok(readFileSync(join(dir, ".knit", "workflow.md"), "utf8").startsWith("项目自定义工作流"), "force 仍不覆盖项目资料");
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
    assert.ok(existsSync(join(dir, ".knit", "workflow.md")));
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

test("模板：受管基线指纹稳定，AGENTS 块含标记与入口", () => {
  const digest = templateDigest(".pi/extensions/knit.ts");
  assert.equal(digest, templateDigest(".pi/extensions/knit.ts"), "指纹稳定");
  const block = agentsManagedBlock("knit");
  assert.ok(block.startsWith(AGENTS_MANAGED_MARKER_BEGIN));
  assert.ok(block.trimEnd().endsWith(AGENTS_MANAGED_MARKER_END));
  assert.ok(block.includes(".knit/workflow.md"));
  assert.ok(block.includes("knit list"));
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
