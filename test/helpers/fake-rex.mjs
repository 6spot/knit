#!/usr/bin/env node
/**
 * 测试用的假 rex：照docs/research/REX-PANE.md 里核实过的样子回答 `rex api call` 和 `rex wait`。
 * 环境变量 KNIT_FAKE_REX 是一个目录：calls.jsonl 记下每次调用，layers/ 里一个窗格一个文件；
 * 目录里有 fail 文件时，名字写在里面的方法失败。窗格里的命令真的会被启动。
 */
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

const home = process.env.KNIT_FAKE_REX;
const args = process.argv.slice(2).filter((arg) => arg !== "--autostart=false");
const layerFile = (name) => join(home, "layers", `${name}.json`);
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const fail = (message, code) => {
  process.stderr.write(`Error: ${message}\n`);
  process.exit(code);
};
mkdirSync(join(home, "layers"), { recursive: true });

if (args[0] === "wait") {
  const name = args[1].replace("block:", "");
  if (!existsSync(layerFile(name))) fail("not found", 3);
  const { pid } = JSON.parse(readFileSync(layerFile(name), "utf8"));
  while (alive(pid) && existsSync(layerFile(name))) await sleep(50);
  // 程序结束时窗格自己关掉。
  rmSync(layerFile(name), { force: true });
  process.exit(0);
}

const [, , method, json] = args;
const params = JSON.parse(json);
appendFileSync(join(home, "calls.jsonl"), `${JSON.stringify({ method, params })}\n`);
if (!params.session_id) fail("session_id is required", 1);
if (existsSync(join(home, "fail")) && readFileSync(join(home, "fail"), "utf8").includes(method)) fail(`${method} failed`, 1);

if (method === "session.describe_block") {
  process.stdout.write(JSON.stringify({ block: { window_id: "window:1" } }));
} else if (method === "session.new_layer") {
  const { command, cwd } = params.layout.block.options;
  const name = `${Date.now()}${process.pid}`;
  const child = spawn(command[0], command.slice(1), { cwd, detached: true, stdio: "ignore" });
  child.unref();
  writeFileSync(layerFile(name), JSON.stringify({ pid: child.pid }));
  process.stdout.write(JSON.stringify({ layer_id: `layer:${name}`, block_ids: [`block:${name}`], revision: 1 }));
} else if (method === "session.set_layer_state") {
  process.stdout.write(JSON.stringify({ revision: 2 }));
} else if (method === "session.close_layer") {
  const name = params.layer_id.replace("layer:", "");
  if (!existsSync(layerFile(name))) fail("not found (status=404 code=not_found)", 3);
  const { pid } = JSON.parse(readFileSync(layerFile(name), "utf8"));
  rmSync(layerFile(name));
  // 真的 Rex 发的是 SIGHUP，Pi 收到之后退出。
  if (alive(pid)) process.kill(pid, "SIGHUP");
  process.stdout.write(JSON.stringify({ revision: 3 }));
} else {
  fail(`unknown method ${method}`, 1);
}
