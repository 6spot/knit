import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { knit } from "./cli.mjs";

const cli = fileURLToPath(new URL("../../dist/cli/knit.js", import.meta.url));

/**
 * 在 `dir` 里运行 `knit init`，加载生成出来的桥接，传给它一个假的 `pi`。
 * `PATH` 最前面放一个指向 `next/dist/cli/knit.js` 的 `knit`，测试结束时改回去。
 * 返回 `{ tool, fire, entries, messages }`：调用工具、触发事件、会话记录、桥接发出的消息。
 */
export async function loadBridge(t, dir) {
  const bin = mkdtempSync(join(tmpdir(), "knit-bin-"));
  const path = process.env.PATH;
  t.after(() => {
    process.env.PATH = path;
    rmSync(bin, { recursive: true, force: true });
  });
  writeFileSync(join(bin, "knit"), `#!/bin/sh\nexec "${process.execPath}" "${cli}" "$@"\n`);
  chmodSync(join(bin, "knit"), 0o755);
  process.env.PATH = `${bin}${delimiter}${path}`;

  const initialized = knit(dir, "init");
  assert.equal(initialized.code, 0, initialized.stderr);

  const tools = new Map();
  const handlers = new Map();
  const entries = [];
  const messages = [];
  const ctx = { sessionManager: { getBranch: () => entries } };
  const bridge = await import(pathToFileURL(join(dir, ".pi", "extensions", "knit.ts")).href);
  await bridge.default({
    registerTool: (tool) => tools.set(tool.name, tool),
    on: (event, handler) => handlers.set(event, [...(handlers.get(event) ?? []), handler]),
    appendEntry: (customType, data) => entries.push({ type: "custom", id: `entry-${entries.length + 1}`, customType, data }),
    sendMessage: (message, options) => messages.push({ message, options }),
  });

  return {
    tool: (name, params) => tools.get(name).execute("call", params, undefined, undefined, ctx),
    fire: async (event, payload) => {
      for (const handler of handlers.get(event) ?? []) await handler(payload, ctx);
    },
    entries,
    messages,
  };
}
