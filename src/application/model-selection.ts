/** 阶段模型选择：显式参数优先，其次项目 phases 配置；不可用显式阻塞，不静默换模型。 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultConfig, parseConfig, type ProjectConfig } from "./config.js";
import { GuardError } from "./guard-error.js";

export interface PhaseModel {
  runtime: string;
  provider: string;
  model: string;
}

function configOf(root: string): ProjectConfig {
  try {
    return parseConfig(readFileSync(join(root, ".knit", "config.json"), "utf8"));
  } catch {
    return defaultConfig();
  }
}

/** 配置的 phases 值形如 provider/model；也接受单独 model（provider 由显式参数补足）。 */
export function resolvePhaseModel(input: {
  dir: string;
  phase: string;
  provider?: string | null;
  model?: string | null;
  runtime?: string | null;
}): PhaseModel {
  if (input.provider !== undefined && input.provider !== null && input.model !== undefined && input.model !== null) {
    return { runtime: input.runtime ?? "pi", provider: input.provider, model: input.model };
  }
  if ((input.provider === undefined) !== (input.model === undefined)) {
    throw new GuardError("model_required", "必须同时提供 --provider 与 --model");
  }
  const config = configOf(input.dir);
  const configured = config.phases?.[input.phase];
  const configuredModel = configured?.model;
  if (configuredModel === undefined || configuredModel.trim() === "") {
    throw new GuardError("model_required", `未提供 ${input.phase} 阶段模型；用 --provider/--model 或项目 config.phases 配置`);
  }
  const slash = configuredModel.indexOf("/");
  if (slash <= 0 || slash === configuredModel.length - 1) {
    throw new GuardError("invalid_model", `phases.${input.phase}.model 应为 provider/model: ${configuredModel}`);
  }
  return {
    runtime: input.runtime ?? configured?.runtime ?? config.agent.runtime,
    provider: configuredModel.slice(0, slash),
    model: configuredModel.slice(slash + 1),
  };
}
