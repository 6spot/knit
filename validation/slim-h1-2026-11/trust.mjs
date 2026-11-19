// 项目信任：--approve 时桥接的三个工具都在，--no-approve 时一个都没有。不调用模型。
import { execFileSync } from "node:child_process";
import { readFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { cleanEnv, startPi } from "./rpc.mjs";

const here = dirname(fileURLToPath(import.meta.url));
// 模型写成 provider/模型，第一个 / 之前是 provider；日志目录可以从外面指定。
const model = process.env.KNIT_H1_MODEL || "magpie/group/deepseek";
const [provider, ...modelName] = model.split("/");
const logs = process.env.KNIT_H1_LOGS || join(here, "logs");
mkdirSync(logs, { recursive: true });
const base = execFileSync(join(here, "setup.sh"), ["trust"], { encoding: "utf8" }).trim();
const out = join(base, "tools.json");
const env = cleanEnv({ PATH: `${join(base, "bin")}:${process.env.PATH}`, H1_OUT: out });
const WANT = ["knit_task", "knit_run", "knit_deliver"];

let failed = false;
for (const [flag, expected] of [["--approve", WANT], ["--no-approve", []]]) {
  rmSync(out, { force: true });
  const pi = startPi({
    cwd: join(base, "proj"),
    env,
    log: join(logs, `trust${flag}.jsonl`),
    args: [flag, "--no-mcp", "--no-skills", "--no-prompt-templates", "--no-themes", "--extension", join(here, "tools-ext.ts"),
      "--session-dir", join(base, "sessions"), "--provider", provider, "--model", modelName.join("/")],
  });
  try {
    const handled = await pi.call("prompt", { message: "/h1-tools" });
    const tools = JSON.parse(readFileSync(out, "utf8"));
    const registered = tools.all.filter((tool) => tool.name.startsWith("knit_"));
    const active = tools.active.filter((name) => name.startsWith("knit_"));
    const ok = JSON.stringify(registered.map((tool) => tool.name)) === JSON.stringify(expected) && JSON.stringify(active) === JSON.stringify(expected);
    if (!ok) failed = true;
    console.log(`${flag}: 命令 ${handled.data?.disposition}；注册的 knit 工具 ${JSON.stringify(registered)}；启用的 ${JSON.stringify(active)}；${ok ? "符合" : "不符合"}`);
    console.log(`  有没有开始模型轮次: ${pi.events.some((event) => event.type === "agent_start")}`);
  } finally {
    const done = await pi.stop();
    console.log(`  Pi 退出: ${JSON.stringify(done)}；标准错误: ${JSON.stringify(pi.stderr().slice(0, 300))}`);
  }
}
process.exit(failed ? 1 : 0);
