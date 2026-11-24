import { readFileSync } from "node:fs";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import type { AgentLaunch } from "../../contracts/agent.js";
import { object } from "./protocol.js";

async function main(): Promise<void> {
  const [kind, target, argument] = process.argv.slice(2);
  if (kind === "pane") {
    // Rex delivers terminal interrupts to the native client in the same process group.
    process.on("SIGINT", () => {});
    const { runAgyPane } = await import("./execution.js");
    return runAgyPane(JSON.parse(argument!) as AgentLaunch, target!);
  }

  const socket = createConnection((kind === "hook" ? process.env.KNIT_AGY_SOCKET : target)!);
  socket.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
  if (kind === "hook") {
    socket.end(JSON.stringify({ kind, event: target, key: process.env.KNIT_AGY_HOOK_KEY, payload: object(readFileSync(0, "utf8")) }));
    const chunks: Buffer[] = [];
    for await (const chunk of socket) chunks.push(chunk as Buffer);
    const response = object(Buffer.concat(chunks).toString("utf8"));
    if (response === null || typeof response.error === "string") {
      console.error(response?.error ?? "Knit 钩子没有返回可用的回执");
      process.exitCode = 1;
      return;
    }
    console.log(JSON.stringify(response));
    return;
  }
  if (kind === "command") {
    process.exitCode = 1;
    createInterface({ input: socket }).on("line", (line) => {
      const reply = object(line);
      if (typeof reply?.stdout === "string") process.stdout.write(Buffer.from(reply.stdout, "base64"));
      if (typeof reply?.stderr === "string") process.stderr.write(Buffer.from(reply.stderr, "base64"));
      if (typeof reply?.error === "string") console.error(reply.error);
      if (typeof reply?.code === "number") process.exitCode = reply.code;
    });
    socket.write(`${JSON.stringify({ kind, key: argument })}\n`);
  }
}

await main();
