/**
 * 派发一个环节的第一步：检查能不能派发，把交给执行者的内容和工作区的记录存下来，
 * 在任务的执行记录里登记这一次。不能派发时说明原因，不登记执行。
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { TaskRecord, TaskRun } from "../contracts/task.js";
import { checkSchema } from "../contracts/schema.js";
import { THINKING_LEVELS, ThinkingLevelSchema, type ThinkingLevel, WORKFLOW_MODEL_PATTERN } from "../contracts/workflow.js";
import { countedRuns, nextStep, type NextStep } from "../domain/progress.js";
import { stageRules } from "../domain/stage-rules.js";
import { currentStatus, parseTaskDocument, requirementDigest } from "../domain/task-document.js";
import type { WorkflowDefinition, WorkflowStage } from "../domain/workflow.js";
import { gitSync } from "../infrastructure/process.js";
import type { ProjectConfig } from "./config.js";
import { assembleHandoff, type HandoffReport } from "./handoff.js";
import { saveTask, scanTasks, type StoredTask } from "./task-store.js";
import { takeSnapshot } from "./workspace.js";
import { ensureWorktree, rollbackWorktree, taskWorktree, type TaskWorktree } from "./worktree.js";

/** 一次执行的目录是 `<RUNS_DIR>/<run-id>`。 */
export const RUNS_DIR = ".knit/.runtime/runs";

export interface PrepareRunInput {
  readonly root: string;
  readonly taskId: string;
  readonly workflow: WorkflowDefinition;
  readonly config: ProjectConfig;
  /** 调用方临时指定的模型（provider/模型）；null 时先用流程里的，再用主会话的。 */
  readonly model: string | null;
  /** 临时指定的思考等级；没给时先用流程里的，再用主会话的。 */
  readonly thinking?: string | null;
}

export interface PreparedRun {
  readonly id: string;
  /** 执行目录，相对项目根。 */
  readonly dir: string;
  readonly stage: WorkflowStage;
  readonly worktree: TaskWorktree;
  /** 最后用的模型。 */
  readonly model: string;
  /** 最后用的思考等级；null 时让 Pi 自己取缺省。 */
  readonly thinking: ThinkingLevel | null;
  /** 这次新建目录后运行的准备命令数；没运行时不带这个字段。 */
  readonly setupCommands?: number;
}

export type PrepareRunResult =
  | { readonly run: PreparedRun; readonly problems: readonly [] }
  | { readonly run: null; readonly problems: readonly string[] };

export function prepareRun(input: PrepareRunInput): PrepareRunResult {
  const { root, taskId } = input;
  const refuse = (...problems: string[]): PrepareRunResult => ({ run: null, problems });
  const tasks = scanTasks(root);
  const stored = tasks.find((task) => task.id === taskId);
  if (stored === undefined) return refuse(`没有任务 ${taskId}；用 knit task list 查看现有任务`);
  const { document, record } = stored;
  if (document === null || record === null) return refuse(...stored.problems);
  if (gitSync(["rev-parse", "--is-inside-work-tree"], root).code !== 0) {
    return refuse("这个目录不在 Git 仓库里，不能派发执行者");
  }
  const status = currentStatus(document, record);
  if (status === "draft") return refuse(`需求还没有确认，或确认之后改过；先运行 knit task ready ${taskId}`);
  if (status !== "ready" && status !== "active") return refuse(`任务已经结束（${status}），不能再派发`);
  // 依赖的任务已经归档的也算在内。
  const waiting = document.frontmatter.dependsOn.flatMap((id) => dependencyProblems(root, tasks, id));
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
  const stage = step.stage;
  const model =
    input.model ?? stage.model ??
    (process.env.PI_PROVIDER && process.env.PI_MODEL ? `${process.env.PI_PROVIDER}/${process.env.PI_MODEL}` : null);
  if (model === null) {
    return refuse("没有指定执行者的模型：不在 Pi 会话里时，在 .knit/workflow.yaml 里写 model，或加 --model provider/模型");
  }
  if (!new RegExp(WORKFLOW_MODEL_PATTERN).test(model)) return refuse(`--model 要写成 provider/模型：${model}`);
  const thinking = input.thinking ?? stage.thinking ?? process.env.PI_REASONING_LEVEL ?? null;
  if (thinking !== null && !checkSchema(ThinkingLevelSchema, thinking)) {
    return refuse(`思考等级只允许 ${THINKING_LEVELS.join("／")}：${thinking}`);
  }

  if (gitSync(["rev-parse", "--verify", "--quiet", "HEAD"], root).code !== 0) {
    return refuse("这个 Git 仓库还没有提交；先提交一次，再派发执行者");
  }
  const worktree = taskWorktree(root, stored.dir);
  const preparedWorktree = ensureWorktree(root, worktree);
  if (preparedWorktree.problems.length > 0) return refuse(...preparedWorktree.problems);
  const refusePrepared = (problems: readonly string[], force = false) =>
    refuse(...problems, ...rollbackWorktree(root, worktree, preparedWorktree, force));

  const counted = countedRuns(record);
  const last = counted.at(-1);
  // 再次进入这个环节时带上它自己上一次的报告；留在原环节再做时那就是上一个环节的报告，不重复给。
  const own = counted.findLast((run) => run.stage === stage.id);
  const handoff = assembleHandoff({
    root,
    worktree: worktree.path,
    task: { dir: stored.dir, document },
    stage,
    previous: last === undefined ? null : reportOf(root, last),
    own: own === undefined || own === last ? null : reportOf(root, own),
    limits: input.config.handoff,
  });
  if (handoff.problems.length > 0) return refusePrepared(handoff.problems);

  const setup = preparedWorktree.created ? input.config.worktree?.setup ?? [] : [];
  const setupProblems = setup.reduce<string[]>((problems, command) => {
    if (problems.length > 0) return problems;
    const result = spawnSync(command, { cwd: worktree.path, shell: true, encoding: "utf8", maxBuffer: Infinity });
    if (result.status === 0) return [];
    return [
      `准备命令失败：${command}\n退出码：${result.status ?? -1}` +
      (result.signal === null ? "" : `（信号：${result.signal}）`) +
      `\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error?.message ?? ""}`,
    ];
  }, []);
  if (setupProblems.length > 0) return refusePrepared(setupProblems, true);

  const id = `r-${randomBytes(6).toString("hex")}`;
  const conflicts = saveTask(
    root,
    stored,
    { ...document, frontmatter: { ...document.frontmatter, status: "active", stage: stage.id } },
    {
      ...record,
      runs: [
        ...record.runs,
        {
          id,
          stage: stage.id,
          startedAt: new Date().toISOString(),
          endedAt: null,
          verdict: null,
          failure: null,
          requirementDigest: requirementDigest(document),
          changedPaths: [],
          sessionFile: null,
        },
      ],
    },
  );
  if (conflicts.length > 0) return refusePrepared(conflicts, setup.length > 0);

  const dir = `${RUNS_DIR}/${id}`;
  mkdirSync(join(root, dir), { recursive: true });
  // 规则不计入交接的字节上限。
  writeFileSync(join(root, dir, "system.md"), `${handoff.systemPrompt}\n\n${stageRules(input.workflow, stage)}`);
  writeFileSync(join(root, dir, "message.md"), handoff.firstMessage);
  writeFileSync(join(root, dir, "before.json"), `${JSON.stringify(takeSnapshot(worktree.path), null, 2)}\n`);
  return { run: { id, dir, stage, worktree, model, thinking, ...(setup.length === 0 ? {} : { setupCommands: setup.length }) }, problems: [] };
}

function dependencyProblems(root: string, tasks: readonly StoredTask[], id: string): string[] {
  const dependency = tasks.find((task) => task.document?.frontmatter.id === id);
  const status = dependency?.document?.frontmatter.status;
  if (dependency === undefined || status === undefined) {
    const branches = gitSync(["for-each-ref", "--format=%(refname)", "refs/heads/knit/"], root).stdout
      .split("\n")
      .filter((reference) => reference !== "")
      .filter((reference) => gitSync(["grep", "-l", "-z", "-F", "-e", id, reference, "--", ":(glob).knit/tasks/**/task.md"], root).stdout
        .split("\0")
        .some((file) => {
          const path = file.slice(reference.length + 1);
          // 别的分支可能带着归档，正文也可能举例写了这个 ID；只认对应目录的开头字段。
          return reference === `refs/heads/knit/${basename(dirname(path))}` &&
            parseTaskDocument(gitSync(["show", `${reference}:${path}`], root).stdout).document?.frontmatter.id === id;
        }))
      .map((reference) => reference.slice("refs/heads/".length));
    return [
      `主检出里找不到依赖的任务：${id}；可能已经在任务分支上交付、还没有合并，也可能确实不存在；交付并合并之后再派发` +
      branches.map((branch) => `\n任务分支：${branch}；在主检出里运行 git merge ${branch}`).join(""),
    ];
  }
  if (status === "cancelled") return [`依赖的任务还没有完成：${id}（${status}）`];
  if (status !== "delivered") return [`依赖的任务还没有交付：${id}（${status}）；交付并合并之后再派发`];
  const branch = taskWorktree(root, dependency.dir).branch;
  const reference = `refs/heads/${branch}`;
  if (gitSync(["show-ref", "--verify", "--quiet", reference], root).code !== 0) return [];
  if (gitSync(["merge-base", "--is-ancestor", reference, "HEAD"], root).code === 0) return [];
  return [`依赖的任务已经交付，但任务分支还没有合并进主检出的当前分支：${id}（${branch}）；在主检出里运行 git merge ${branch}，合并之后再派发`];
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
    ...countedRuns(record).map(
      (run) => `  ${nameOf(run.stage)}（${run.id}）${run.verdict ?? ""}：${RUNS_DIR}/${run.id}/report.md`,
    ),
    "可以走的路：",
    `  1. 主会话直接修，改完运行 knit task close ${taskId} --paths <改动的文件>`,
    "  2. 拆成更小的任务",
    `  3. 需求本身有问题就改需求，再运行 knit task ready ${taskId}；进入次数从头数`,
    `  4. 用户决定带理由接受：knit task close ${taskId} --reason <理由>`,
  ];
}

/** 一次执行的报告，交接时用。 */
function reportOf(root: string, run: TaskRun): HandoffReport {
  const path = resolve(root, RUNS_DIR, run.id, "report.md");
  return {
    stage: run.stage,
    path,
    changedPaths: run.changedPaths,
    text: existsSync(path) ? readFileSync(path, "utf8") : "报告原文不在这台机器上。",
  };
}
