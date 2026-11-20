import { writeFileSync } from "node:fs";
import { join } from "node:path";

// 测试源码只用单引号字面量；外层双引号同时适用于系统的 POSIX shell 和 cmd.exe。
export const nodeCommand = (source) => `"${process.execPath}" -e "${source}"`;
export const setupConfig = (root, commands) => writeFileSync(join(root, ".knit/config.json"), JSON.stringify({ worktree: { setup: commands } }));
