/**
 * 正式检查凭据的当前有效性核对（DESIGN §5.3、STATES §8）。
 * 只读：检查、输入、规范、分支、scope 与路径现状任一失配都拒绝，不猜 pass。
 */
import type { TaskBinding } from "../contracts/metadata.js";
import type { CheckFile } from "../contracts/run.js";
import type { MetadataStore } from "../ports/infrastructure.js";
import { normalizeRoot } from "../infrastructure/paths.js";
import { RunStore } from "../infrastructure/run-store.js";
import { ContextPlanner } from "./context-planner.js";
import { GuardError } from "./guard-error.js";
import { loadScope, scopeEntriesCurrent } from "./scope.js";

export async function validateCheckEvidence(input: {
  root: string;
  /** 任务正文与成果文件所在执行目录（worktree 路由）；缺省同 root。 */
  executionDir?: string;
  store: MetadataStore;
  taskId: string;
  binding: TaskBinding;
  branch: string | null;
  now: () => Date;
  randomHex: (bytes: number) => string;
}): Promise<CheckFile> {
  const { root: rawRoot, store, taskId, binding, branch } = input;
  const root = normalizeRoot(rawRoot);
  const executionDir = normalizeRoot(input.executionDir ?? rawRoot);
  if (binding.lastCheckRunId === null) throw new GuardError("check_missing", "没有可交付的检查");
  const runs = new RunStore(root);
  const check = runs.readCheck(binding.lastCheckRunId);
  if (check === null) throw new GuardError("check_missing", `检查凭据缺失: ${binding.lastCheckRunId}`);
  if (check.verdict !== "pass") throw new GuardError("check_not_passed", `最新检查结论不是 pass: ${check.verdict}`);
  // worktree 任务的检查产生在执行分支；合入后任务正文改绑目标分支，凭据仍指向产生它的
  // 执行分支。只接受当前分支或当前绑定 worktree 分支，避免放宽到任意历史分支。
  const acceptedBranches = new Set<string>();
  if (branch !== null) acceptedBranches.add(branch);
  if (binding.worktree?.branch !== undefined) acceptedBranches.add(binding.worktree.branch);
  if (check.branch !== null && !acceptedBranches.has(check.branch)) {
    throw new GuardError("check_stale", "检查分支与当前交付分支不一致");
  }
  // 用产生凭据的 run 阶段重建上下文：检查阶段 id 可由配置改名，不能写死 check。
  // 旧夹具／历史凭据没有 run 请求时退回默认 check 阶段。
  const checkRequest = runs.readRequest(check.runId);
  const checkStage = checkRequest?.stageDefinition?.id ?? checkRequest?.phase ?? "check";
  const plan = await new ContextPlanner({ store, now: input.now, randomHex: input.randomHex }).plan({
    dir: executionDir,
    taskId,
    stage: checkStage,
    // 凭据产生时冻结的阶段定义：配置降级后仍按当时的提示词重算输入身份。
    stageDefinition: checkRequest?.stageDefinition,
    // 旧请求没有冻结字段：用产生凭据的 run 请求模式保留当时的提示词。
    keepLegacyStagePrompt: checkRequest?.workflowMode !== "fallback",
  });
  if (!plan.ready) throw new GuardError("check_stale", `检查上下文不再 ready: ${plan.blockers.join(",")}`);
  if (
    check.inputsDigest !== plan.inputsDigest ||
    check.standardsDigest !== plan.standardsDigest ||
    check.effectiveInputsDigest !== plan.effectiveInputsDigest
  ) {
    throw new GuardError("check_stale", "检查后输入或正式规范变化");
  }
  if (binding.confirmedInputsDigest !== plan.inputsDigest || binding.confirmedStandardsDigest !== plan.standardsDigest) {
    throw new GuardError("check_stale", "任务冻结摘要与当前输入／规范不一致");
  }
  const scope = loadScope(runs, taskId, input.now().toISOString());
  if (check.scopeDigest !== scope.digest) throw new GuardError("check_stale", "检查后成果范围变化");
  if (!scopeEntriesCurrent(executionDir, scope.entries)) throw new GuardError("check_stale", "检查后成果路径现状与记录不符");
  return check;
}
