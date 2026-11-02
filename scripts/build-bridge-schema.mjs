#!/usr/bin/env node
/** 从编译后的同源 TypeBox schema 派生桥接 JSON schema；不手写第二份定义。 */
import { chmodSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const modulePath = join(root, "dist", "contracts", "bridge-tools.js");
const { BRIDGE_TOOL_SCHEMAS } = await import(pathToFileURL(modulePath).href);
const output = {};
for (const [name, schema] of Object.entries(BRIDGE_TOOL_SCHEMAS)) output[name] = schema;
const target = join(root, "dist", "contracts", "bridge-tools.json");
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, JSON.stringify(output, null, 2) + "\n");

// tsc 产物不保留源文件执行位；bin 入口（npm link 指向）每次构建后需恢复可执行。
const binEntry = join(root, "dist", "cli", "knit.js");
if (existsSync(binEntry)) chmodSync(binEntry, 0o755);
