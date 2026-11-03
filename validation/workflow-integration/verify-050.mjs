import { spawnSync, execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const root = "/home/opc/work/knit";
// prepack 已生成 knit-0.1.0.tgz（build 先行）。
const tarball = "knit-0.1.0.tgz";
const installDir = mkdtempSync(join(tmpdir(), "knit050-pkg-"));
execFileSync("tar", ["-xzf", join(root, tarball), "-C", installDir]);
execFileSync("npm", ["install", "--omit=dev", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: join(installDir, "package"), encoding: "utf8" });
const pkgNodeModules = join(installDir, "package");
// 新项目 init
const fresh = mkdtempSync(join(tmpdir(), "knit050-fresh-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: fresh });
execFileSync("git", ["config", "user.email", "t@x"], { cwd: fresh });
execFileSync("git", ["config", "user.name", "t"], { cwd: fresh });
writeFileSync(join(fresh, "a.txt"), "x\n");
execFileSync("git", ["add", "."], { cwd: fresh });
execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: fresh });
const init1 = spawnSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "init", "--client", "pi", "--dir", fresh], { encoding: "utf8" });
const r1 = JSON.parse(init1.stdout);
console.log("FRESH_INIT:", r1.outcome, r1.data.ready, "conflicts:", r1.data.conflicts.length);
// 新工作流内容存在
const wf = readFileSync(join(fresh, ".knit", "workflow.md"), "utf8");
console.log("WORKFLOW_NEW:", wf.includes("主会话：识别请求与任务入口"), wf.includes("plan.md"));
// AGENTS 受管块含规划资料入口
const agents = readFileSync(join(fresh, "AGENTS.md"), "utf8");
console.log("AGENTS_NEW:", agents.includes("任务规划资料"), agents.includes("每轮提供当前任务与下一步上下文"));
// 桥接含注入与材料工具
const bridge = readFileSync(join(fresh, ".pi", "extensions", "knit.ts"), "utf8");
console.log("BRIDGE_NEW:", bridge.includes("before_agent_start"), bridge.includes("knit_material"), bridge.includes("buildTurnContext"));
// 材料接口可用（CLI）
const matSave = spawnSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "task", "new", "--title", "T", "--dir", fresh], { encoding: "utf8" });
const taskId = JSON.parse(matSave.stdout).data.taskId;
const matOut = spawnSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "task", "material", "save", taskId, "plan.md", "--dir", fresh], { encoding: "utf8", input: "# 计划\n" });
console.log("MATERIAL_SAVE:", JSON.parse(matOut.stdout).outcome);
// 旧模板项目升级：预置旧 workflow + 自定义规则 + 旧单文件任务
const upgraded = mkdtempSync(join(tmpdir(), "knit050-up-"));
execFileSync("git", ["init", "-q", "-b", "main"], { cwd: upgraded });
execFileSync("git", ["config", "user.email", "t@x"], { cwd: upgraded });
execFileSync("git", ["config", "user.name", "t"], { cwd: upgraded });
writeFileSync(join(upgraded, "a.txt"), "x\n");
execFileSync("git", ["add", "."], { cwd: upgraded });
execFileSync("git", ["commit", "-q", "-m", "i"], { cwd: upgraded });
mkdirSync(join(upgraded, ".knit", "tasks"), { recursive: true });
writeFileSync(join(upgraded, ".knit", "workflow.md"), "# 项目自定义工作流\n\n自有规则。\n");
execFileSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "init", "--client", "pi", "--dir", upgraded], { encoding: "utf8" });
console.log("UPGRADE_KEEPS_CUSTOM:", readFileSync(join(upgraded, ".knit", "workflow.md"), "utf8").includes("自有规则"));
// 旧单文件任务继续
const t2 = spawnSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "task", "new", "--title", "旧任务", "--dir", upgraded], { encoding: "utf8" });
const oldTaskId = JSON.parse(t2.stdout).data.taskId;
console.log("OLD_TASK_OK:", oldTaskId !== undefined);
// 旧任务无 plan.md 也能 ready（简单任务）
const rd = spawnSync(process.execPath, [join(pkgNodeModules, "dist", "cli", "knit.js"), "--json", "task", "ready", oldTaskId, "--dir", upgraded], { encoding: "utf8" });
console.log("OLD_TASK_READY:", JSON.parse(rd.stdout).outcome);
