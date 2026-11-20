/** 读出项目配置 `.knit/config.json`：交接的字节上限与 Worktree 准备命令。 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { arr, int, obj, opt, str, type Static } from "@earendil-works/pi-schema";
import { schemaProblems } from "../contracts/task.js";
import { DEFAULT_HANDOFF_LIMITS, type HandoffLimits } from "./handoff.js";

export const CONFIG_PATH = ".knit/config.json";

/** 字段都可以不写；不认识的字段算问题，写错字段名时能马上发现。 */
const ConfigFileSchema = obj({
  handoff: opt(obj({ fileBytes: opt(int({ minimum: 1 })), totalBytes: opt(int({ minimum: 1 })) })),
  worktree: opt(obj({ setup: opt(arr(str({ pattern: "\\S" }))) })),
});

export interface ProjectConfig {
  readonly handoff: HandoffLimits;
  readonly worktree?: { readonly setup?: readonly string[] };
}

export interface ConfigLoadResult {
  /** 有问题时是 null。 */
  readonly config: ProjectConfig | null;
  /** 一处一句，每句以配置文件的路径开头。 */
  readonly problems: readonly string[];
}

/** 文件不存在时是全部缺省值，没有问题。 */
export function loadConfig(root: string): ConfigLoadResult {
  const file = join(root, CONFIG_PATH);
  if (!existsSync(file)) return { config: { handoff: DEFAULT_HANDOFF_LIMITS }, problems: [] };
  const raw = parseJson(readFileSync(file, "utf8"));
  if (raw instanceof SyntaxError) {
    return { config: null, problems: [`${CONFIG_PATH}：不是合法的 JSON：${raw.message}`] };
  }
  const problems = schemaProblems(ConfigFileSchema, raw);
  if (problems.length > 0) {
    return { config: null, problems: problems.map((problem) => `${CONFIG_PATH}：${problem}`) };
  }
  const config = raw as Static<typeof ConfigFileSchema>;
  return {
    config: {
      handoff: { ...DEFAULT_HANDOFF_LIMITS, ...config.handoff },
      ...(config.worktree === undefined ? {} : { worktree: config.worktree }),
    },
    problems: [],
  };
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return error;
    throw error;
  }
}
