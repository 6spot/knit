import { AGENT_SPECS, DEFAULT_AGENT, type AgentName } from "../contracts/workflow.js";

/** 配置省略 agent 时逐字段接受任一规格，派发时传入实际 agent 和生效的参数。 */
export function validateAgentTarget(target: {
  readonly agent: AgentName | null;
  readonly model: string | null;
  readonly thinking: string | null;
}) {
  const spec = AGENT_SPECS[target.agent ?? DEFAULT_AGENT];
  const candidates = target.agent === null ? Object.values(AGENT_SPECS) : [spec];
  const levels = target.agent === null
    ? [...new Set(candidates.flatMap((candidate) => candidate.thinkingLevels))]
    : spec.thinkingLevels;
  const model = target.model;
  const thinking = levels.find((level) => level === target.thinking) ?? null;
  return {
    modelProblem: model !== null && !candidates.some((candidate) => candidate.modelPattern.test(model))
      ? `要写成 ${spec.modelFormat}` : null,
    thinkingProblem: target.thinking !== null && thinking === null ? `只允许 ${levels.join("／")}` : null,
    thinking,
  };
}
