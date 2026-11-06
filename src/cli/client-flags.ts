/** 按客户端注册表生成布尔开关；未注册的客户端开关保留 commander 的未知选项错误。 */
import type { Command } from "commander";
import { CLIENT_SPECS, resolveClientIds } from "../application/clients.js";

export function registerClientFlags(command: Command): void {
  for (const spec of CLIENT_SPECS) command.option(`--${spec.flag}`, spec.description);
}

/** 从解析后的命令选项取客户端 ID；未带任何客户端开关时使用默认项。 */
export function selectedClientIds(options: Record<string, unknown>): string[] {
  return resolveClientIds(CLIENT_SPECS.filter((spec) => options[spec.flag] === true).map((spec) => spec.id));
}
