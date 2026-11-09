#!/usr/bin/env node
/**
 * 最小 rex CLI 假实现：只用于 Rex 启动失败与 auto 回退测试，不模拟真实浮层。
 * 能力探测与浮层创建都成功，但块内进程立即退出、从不启动 worker（模拟 S7「worker 未报到」）。
 * FAKE_REX_LOG：逐行记录调用（方法名或子命令），供断言 capture 等诊断调用确实发生。
 */
import { appendFileSync } from "node:fs";

const argv = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_REX_LOG) appendFileSync(process.env.FAKE_REX_LOG, `${entry}\n`);
};
const methods = [
  "session.new_layer",
  "session.set_layer_state",
  "session.float_block",
  "session.view",
  "session.list_blocks",
  "session.describe_block",
  "session.close_layer",
].map((name) => ({ name }));

const apiIndex = argv.indexOf("api");
if (argv.includes("capture")) {
  log("capture");
  process.stdout.write("pi: fatal: fake rex block failed before worker report\n");
  process.exit(0);
}
if (argv.includes("events")) {
  log("events");
  process.exit(0);
}
if (apiIndex >= 0 && argv[apiIndex + 1] === "list") {
  log("api.list");
  process.stdout.write(JSON.stringify({ methods }));
  process.exit(0);
}
if (apiIndex >= 0 && argv[apiIndex + 1] === "call") {
  const method = argv[apiIndex + 2];
  log(method);
  const responses = {
    "session.describe_block": { block: { window_id: "w-1", label: "main", host_id: null } },
    "session.new_layer": { layer_id: "layer-1", block_ids: ["block-1"], revision: 1 },
    "session.list_blocks": { blocks: [] },
    "session.view": { windows: [{ layers: [{ layer_id: "layer-1", kind: "floating", state: "minimized", blocks: [{ block_id: "block-1" }] }] }] },
    // 块内进程已退出（exit 1）：worker 从未报到。
    "com.superlogical.terminal.process": { last_exit: { code: 1 } },
  };
  process.stdout.write(JSON.stringify(responses[method] ?? {}));
  process.exit(0);
}
process.stderr.write(`fake-rex: unsupported ${argv.join(" ")}\n`);
process.exit(2);
