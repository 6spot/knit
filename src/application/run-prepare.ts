/**
 * 派发一个环节的第一步：检查能不能派发，把交给执行者的内容和工作区的记录存下来，
 * 在任务的执行记录里登记这一次。不能派发时说明原因，不登记执行。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { RUNS_DIR, TASK_ID_PATTERN, type TaskRecord, type TaskRun } from "../contracts/task.js";
import { AGENT_SPECS, DEFAULT_AGENT, type AgentName, type ThinkingLevel, type ToolCapability } from "../contracts/workflow.js";
import { completedBatches, dispatchLimit, nextStep, resumeDecision, type NextStep } from "../domain/progress.js";
import { stageRules } from "../domain/report.js";
import { currentStatus, parseTaskDocument, requirementDigest } from "../domain/task.js";
import { validateAgentTarget, workflowPrompts, type WorkflowDefinition, type WorkflowExecutor, type WorkflowStage } from "../domain/workflow.js";
import { atomicWrite } from "../infrastructure/fs.js";
import { fileURLToPath } from "node:url";
import { sha256Text } from "../contracts/primitives.js";
import { gitSync, shellQuote } from "../infrastructure/process.js";
import type { ProjectConfig } from "./project-config.js";
import { appendReviewChanges, loadHandoffSources, prepareHandoff, resumeMessage, reviewChanges, type HandoffReport } from "./handoff.js";
import { logSessionMode } from "./run-execute.js";
import { withTaskRunLock } from "./run-control.js";
import { findTask, saveTask, type LoadedTask } from "./task-store.js";
import { takeSnapshot } from "./workspace.js";
import { ensureWorktree, rollbackWorktree, taskWorktree, type TaskWorktree } from "./worktree.js";

/** 一次执行的目录是 `<RUNS_DIR>/<run-id>`。 */
export { RUNS_DIR };

export interface PrepareRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly workflow: WorkflowDefinition;
  readonly fresh?: boolean;
  readonly instruction?: string;
  readonly stage?: string;
  readonly config: ProjectConfig;
  /** 本次派发的模型覆盖值。null 时按实际 Agent 的规格取值。 */
  readonly model: string | null;
  /** 本次派发的思考等级覆盖值。省略时按实际 Agent 的规格取值。 */
  readonly thinking?: string | null;
  /** 客户端边界观察到的主会话缺省值，不作为命令行覆盖。 */
  readonly sessionDefaults?: { readonly agent?: AgentName; readonly model: string | null; readonly thinking: string | null };
  readonly checkAgent?: (agent: AgentName, capabilities: readonly ToolCapability[] | null, worktree: TaskWorktree) => string | null;
}

export interface PreparedRun {
  readonly id: string;
  /** 执行目录，相对项目根。 */
  readonly dir: string;
  readonly stage: WorkflowStage;
  readonly worktree: TaskWorktree;
  readonly agent: AgentName;
  /** 生效的模型。null 时由客户端取缺省。 */
  readonly model: string | null;
  /** 最后用的思考等级；null 时让客户端自己取缺省。 */
  readonly thinking: ThinkingLevel | null;
  /** 同批成员使用各自的执行器标识。 */
  readonly executor?: string;
  /** 这次新建目录后运行的准备命令数；没运行时不带这个字段。 */
  readonly setupCommands?: number;
}

export type PrepareRunResult =
  | { readonly run: PreparedRun; readonly runs: readonly PreparedRun[]; readonly title: string; readonly problems: readonly [] }
  | { readonly run: null; readonly problems: readonly string[] };

function refuse(...problems: string[]): PrepareRunResult {
  return { run: null, problems };
}

export function prepareRun(input: PrepareRunInput, startWorker?: (run: PreparedRun) => void): PrepareRunResult {
  const { root, taskId } = input;
  const missing = () => refuse(`没有任务 ${taskId}；用 knit task list 查看现有任务`);
  const initial = findTask(root, taskId, { includeWorktrees: false });
  if (initial === null) return missing();
  // 损坏的任务可以按原始 id 查到，只有合法任务 id 才能用于锁文件名。
  if (!new RegExp(TASK_ID_PATTERN).test(taskId)) return refuse(...initial.problems);
  if (gitSync(["rev-parse", "--is-inside-work-tree"], root).code !== 0) {
    return refuse("这个目录不在 Git 仓库里，不能派发执行者");
  }
  return withTaskRunLock(root, taskId, 0, () => {
    const stored = findTask(root, taskId, { includeWorktrees: false });
    if (stored === null) return missing();
    const { document, record } = stored;
    if (document === null || record === null) return refuse(...stored.problems);
    const prepared = prepareStage(input, { root, stored, document, record });
    if (!prepared.run || !startWorker) return prepared;
    for (const [index, run] of prepared.runs.entries()) {
      try { startWorker(run); }
      catch (error) {
        const failure = `执行者启动失败：${String(error)}`;
        const pending = new Set(prepared.runs.slice(index).map((member) => member.id));
        const latest = findTask(root, taskId, { includeWorktrees: false });
        if (!latest?.record) return refuse(failure, ...(latest?.problems ?? ["无法读取执行记录"]));
        const endedAt = new Date().toISOString();
        return refuse(failure, ...saveTask(root, latest, null, { ...latest.record,
          runs: latest.record.runs.map((item) => pending.has(item.id) ? { ...item, endedAt, failure } : item) }));
      }
    }
    return prepared;
  }, () => refuse(`任务 ${taskId} 正在准备或结算执行，请稍后重试`));
}

function prepareStage(input: PrepareRunInput, task: LoadedTask): PrepareRunResult {
  const { root, document, record } = task;
  const taskId = input.taskId;
  const status = currentStatus(document, record);
  if (status === "draft") return refuse(`需求还没有确认，或确认之后改过；先运行 knit task ready ${taskId}`);
  if (status !== "ready" && status !== "active") return refuse(`任务已经结束（${status}），不能再派发`);
  // 依赖的任务已经归档的也算在内。
  const waiting = document.frontmatter.dependsOn.flatMap((id) => dependencyProblems(root, id));
  if (waiting.length > 0) return refuse(...waiting);
  const running = record.runs.find((run) => run.endedAt === null);
  if (running !== undefined) {
    return refuse(
      `任务 ${taskId} 的执行 ${running.id} 还没有结束；等它结束，或运行 knit run cancel ${taskId}`,
    );
  }
  const step = nextStep(input.workflow, document.frontmatter.verification, record);
  if (step.kind === "close") return refuse(`所有环节都做完了；核对之后运行 knit task close ${taskId}`);
  if (step.kind === "limit") return refuse(...limitNotice(taskId, input.workflow, record, step));
  if (input.instruction !== undefined && !input.instruction.trim()) return refuse("主会话修改指令不能为空");
  if (input.stage !== undefined && step.kind !== "arbitrate") return refuse("只有批次等待主会话裁决时可以指定 --stage");
  if (step.kind === "arbitrate" && !input.instruction && !input.stage) return refuse(...arbitrationNotice(taskId, step));
  const stageId = input.stage ?? step.stage.id;
  const stage = input.workflow.stages.find((item) => item.id === stageId);
  if (!stage) return refuse(`流程里没有环节 ${stageId}`);
  if (step.kind === "arbitrate") {
    const limit = dispatchLimit(record, stage, step.reports[0]?.run.stage);
    if (limit) return refuse(...limitNotice(taskId, input.workflow, record, limit));
  }
  const targets = stage.executors.map((executor) => resolveExecutor(input, executor));
  const problems = targets.flatMap((target) => target.problem ? [target.problem] : []);
  if (problems.length) return refuse(...problems);

  if (gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root).code !== 0) {
    return refuse("这个 Git 仓库还没有提交；先提交一次，再派发执行者");
  }
  return prepareExecutors(input, task, stage, targets);
}

function prepareExecutors(input: PrepareRunInput, task: LoadedTask, stage: WorkflowStage, targets: readonly ReturnType<typeof resolveExecutor>[]): PrepareRunResult {
  const { root, stored, document, record } = task;
  const worktree = taskWorktree(root, stored.dir);
  const agents = [...new Set(targets.map((target) => target.agent))];
  const checkIsolation = () => agents.flatMap((agent) => input.checkAgent?.(agent, stage.tools, worktree) ?? []);
  const unavailable = checkIsolation();
  if (unavailable.length) return refuse(...unavailable);
  const preparedWorktree = ensureWorktree(root, worktree);
  if (preparedWorktree.problems.length > 0) return refuse(...preparedWorktree.problems);
  const refusePrepared = (problems: readonly string[], force = false) =>
    refuse(...problems, ...rollbackWorktree(root, worktree, preparedWorktree, force));

  const batches = completedBatches(record);
  const previous = batches.at(-1) ?? [];
  const metadata = gitSync(["rev-parse", "--absolute-git-dir"], worktree.path);
  if (metadata.code !== 0) return refusePrepared([metadata.stderr]);
  const marker = join(metadata.stdout.trimEnd(), "knit-setup.sha256");
  const commands = input.config.worktree?.setup ?? [];
  const digest = sha256Text(JSON.stringify(commands));
  const setup = existsSync(marker) && readFileSync(marker, "utf8") === digest ? [] : commands;
  const batchId = targets.length > 1 ? `b-${randomBytes(6).toString("hex")}` : undefined;
  const runs = targets.map(({ executor, agent, model, thinking }) => {
    const id = `r-${randomBytes(6).toString("hex")}`;
    return { id, dir: `${RUNS_DIR}/${id}`, stage, worktree, agent, model, thinking,
      ...(batchId ? { executor: executor.id } : {}), ...(setup.length ? { setupCommands: setup.length } : {}) };
  });
  const discard = (issues: readonly string[]) => {
    runs.forEach((run) => rmSync(join(root, run.dir), { recursive: true, force: true }));
    return refusePrepared(issues, setup.length > 0);
  };
  try {
    const reports = previous.map((run) => reportOf(root, run));
    const shared = { root, worktree: worktree.path, task: { dir: stored.dir, document }, stage, limits: input.config.handoff };
    const sources = loadHandoffSources(shared);
    const handoffs = targets.map(({ executor }) => {
      const own = batches.flat().findLast((run) => run.stage === stage.id && (!run.executor || run.executor === executor.id));
      return prepareHandoff({ ...shared, stage: { ...stage, prompt: executor.prompt }, previous: reports,
        own: own && !previous.includes(own) ? reportOf(root, own) : null,
        instruction: input.instruction }, sources);
    });
    const issues = handoffs.flatMap((handoff) => handoff.problems);
    if (issues.length) return refusePrepared(issues);
    if (!commands.length || setup.length) rmSync(marker, { force: true });
    if (setup.length) {
      const result = spawnSync(process.execPath, [fileURLToPath(new URL("./worktree-setup.js", import.meta.url))], {
        cwd: worktree.path, encoding: "utf8", stdio: ["pipe", "pipe", "inherit"],
        input: JSON.stringify({ commands, timeoutSeconds: input.config.worktree?.setupTimeoutSeconds ?? null, parent: process.pid }),
      });
      if (result.status !== 0) return refusePrepared([result.stdout || `准备命令失败：${result.error?.message ?? result.signal}`], true);
      atomicWrite({ path: marker, data: Buffer.from(digest) });
      const unavailableAfterSetup = checkIsolation();
      if (unavailableAfterSetup.length) return refusePrepared(unavailableAfterSetup, true);
    }
    const changes = Object.hasOwn(stage.report, "verdict") ? reviewChanges(worktree.path) : null;
    const snapshot = Buffer.from(`${JSON.stringify(takeSnapshot(worktree.path, workflowPrompts(input.workflow)))}\n`);
    runs.forEach((run, index) => {
      const dir = join(root, run.dir);
      mkdirSync(dir, { recursive: true });
      const rules = stageRules(input.workflow, stage);
      const handoff = handoffs[index]!;
      const system = `${handoff.systemPrompt}\n\n${rules}`;
      writeFileSync(join(dir, "system.md"), system);
      prepareResumeHandoff(dir, input, record, run, reports, rules, handoff.standardsDigest, changes);
      writeFileSync(join(dir, "message.md"), handoff.message(changes, rules));
      atomicWrite({ path: join(dir, "before.json"), data: snapshot });
    });
  } catch (error) {
    return discard([error instanceof Error ? error.message : String(error)]);
  }
  const startedAt = new Date().toISOString();
  const conflicts = saveTask(root, stored,
    { ...document, frontmatter: { ...document.frontmatter, status: "active", stage: stage.id } },
    { ...record, runs: [...record.runs, ...runs.map((run) => ({
      id: run.id, stage: stage.id, agent: run.agent, executor: run.executor, batchId, startedAt,
      endedAt: null, verdict: null, failure: null, requirementDigest: requirementDigest(document), changedPaths: [], sessionFile: null,
    }))] });
  if (conflicts.length) return discard(conflicts);
  return { run: runs[0]!, runs, title: document.frontmatter.title, problems: [] };
}

function prepareResumeHandoff(dir: string, input: PrepareRunInput, record: TaskRecord, run: PreparedRun, reports: readonly HandoffReport[], rules: string, standardsDigest: string, changes: ReturnType<typeof reviewChanges>): void {
  if (run.stage.resume) writeFileSync(join(dir, "standards.sha256"), standardsDigest);
  if (input.fresh) return logSessionMode(dir, "新会话（指定了 --fresh）");
  if (!run.stage.resume) return;
  const decision = resumeDecision(record, { stage: run.stage.id, executor: run.executor, agent: run.agent });
  const prior = decision.run;
  if (prior?.resumeId) {
    const priorDigest = join(input.root, RUNS_DIR, prior.id, "standards.sha256");
    if (!existsSync(priorDigest) || readFileSync(priorDigest, "utf8") !== standardsDigest) {
      return logSessionMode(dir, "已自动回退新会话（适用规范已有更新或旧执行没有规范摘要）");
    }
    const inlineLimits = run.stage.tools !== null && !run.stage.tools.includes("read") ? input.config.handoff : undefined;
    writeFileSync(join(dir, "resume-id.txt"), prior.resumeId);
    const message = resumeMessage(input.instruction, reports, rules, inlineLimits, prior.failure);
    writeFileSync(join(dir, "resume-message.md"), appendReviewChanges(message, changes, input.config.handoff, 0, run.stage.tools == null || run.stage.tools.includes("exec")));
    return;
  }
  if (decision.reason) logSessionMode(dir, `已自动回退新会话（${decision.reason}）`);
}

function resolveExecutor(input: PrepareRunInput, executor: WorkflowExecutor) {
  const sessionAgent = input.sessionDefaults?.agent ?? DEFAULT_AGENT;
  const agent = executor.agent ?? sessionAgent;
  const spec = AGENT_SPECS[agent];
  const workflowDefaults = spec.inheritsWorkflowDefaults ? input.workflow : null;
  const session = spec.inheritsWorkflowDefaults && agent === sessionAgent ? input.sessionDefaults : null;
  const model = input.model ?? executor.model ?? workflowDefaults?.model ?? session?.model ?? null;
  const thinking = input.thinking ?? executor.thinking ?? workflowDefaults?.thinking ?? session?.thinking ?? null;
  const target = validateAgentTarget({ agent, model, thinking });
  const problem = model === null && spec.modelRequired ? spec.missingModelMessage
    : target.modelProblem ? `--model ${target.modelProblem}：${model}`
    : target.thinkingProblem ? `思考等级${target.thinkingProblem}：${thinking}` : null;
  return { executor, agent, model, thinking: target.thinking, problem };
}

export function arbitrationNotice(id: string, step: Extract<NextStep, { kind: "arbitrate" }>): string[] {
  return ["批次已结束，等待主会话裁决汇总。", ...step.reports.map(({ run, path }) =>
    `  ${run.executor ?? run.id}（${run.agent ?? "pi"}）：${run.failure ?? run.verdict ?? "正常结束"}，${path}`),
    `主会话汇总后派发${step.stage.name}：knit run start ${id} --instruction <修改指令>；指定环节用 --stage <环节>。`];
}

function dependencyProblems(root: string, id: string): string[] {
  const dependency = findTask(root, id, { includeWorktrees: false, requireDocument: true });
  if (!dependency?.document) {
    const refs = gitSync(["for-each-ref", "--format=%(refname)", "refs/heads/knit/"], root).stdout.split("\n").filter(Boolean);
    const files = refs.length ? gitSync(["grep", "-l", "-z", "-F", "-e", id, ...refs, "--", ":(glob).knit/tasks/**/task.md"], root).stdout : "";
    const branches = files.split("\0").filter(Boolean).flatMap((file) => {
      const colon = file.indexOf(":");
      const reference = file.slice(0, colon);
      const branch = `knit/${basename(dirname(file.slice(colon + 1)))}`;
      return reference === `refs/heads/${branch}` && parseTaskDocument(gitSync(["show", file], root).stdout).document?.frontmatter.id === id ? [branch] : [];
    });
    return [
      `主检出里找不到依赖的任务：${id}；可能已经在任务分支上交付、还没有合并，也可能确实不存在；交付并合并之后再派发` +
      branches.map((branch) => `\n任务分支：${branch}；在主检出里运行 git merge --no-edit ${shellQuote(branch)}`).join(""),
    ];
  }
  const status = dependency.document.frontmatter.status;
  if (status === "cancelled") return [`依赖的任务还没有完成：${id}（${status}）`];
  if (status !== "delivered") return [`依赖的任务还没有交付：${id}（${status}）；交付并合并之后再派发`];
  const branch = taskWorktree(root, dependency.dir).branch;
  const reference = `refs/heads/${branch}`;
  if (gitSync(["show-ref", "--verify", "--quiet", reference], root).code !== 0) return [];
  if (gitSync(["merge-base", "--is-ancestor", reference, "HEAD"], root).code === 0) return [];
  return [`依赖的任务已经交付，但任务分支还没有合并进主检出的当前分支：${id}（${branch}）；在主检出里运行 git merge --no-edit ${shellQuote(branch)}，合并之后再派发`];
}

/**
 * 返工到了上限时交回主会话的话：各轮报告在哪里，可以走哪几条路。
 * 不读报告的内容，不生成汇总。
 */
export function limitNotice(
  taskId: string,
  workflow: WorkflowDefinition,
  record: TaskRecord,
  step: Extract<NextStep, { kind: "limit" }>,
): string[] {
  const nameOf = (stageId: string) => workflow.stages.find((stage) => stage.id === stageId)?.name ?? stageId;
  return [
    `${step.stage.name}环节已经进入 ${step.entries} 次，到了上限，不再派发。各轮的报告：`,
    ...completedBatches(record).flat().map(
      (run) => `  ${nameOf(run.stage)}（${run.id}）${run.verdict ?? ""}：${RUNS_DIR}/${run.id}/report.md`,
    ),
    "可以走的路：",
    `  1. 主会话直接修，改完运行 knit task close ${taskId} --result <总结> --paths <改动的文件>`,
    "  2. 拆成更小的任务",
    `  3. 需求本身有问题就改需求，再运行 knit task ready ${taskId}；进入次数从头数`,
    `  4. 用户决定带理由接受：knit task close ${taskId} --result <总结> --reason <理由>`,
  ];
}

/** 一次执行的报告，交接时用。 */
function reportOf(root: string, run: TaskRun): HandoffReport {
  const path = resolve(root, RUNS_DIR, run.id, "report.md");
  return {
    stage: run.stage,
    executor: run.executor, verdict: run.verdict, failure: run.failure,
    path,
    changedPaths: run.changedPaths,
    text: existsSync(path) ? readFileSync(path, "utf8") : "报告原文不在这台机器上。",
  };
}
