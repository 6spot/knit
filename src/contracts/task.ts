/**
 * 任务的两个文件：`task.md` 的开头字段和 `record.json` 的结构。
 * 解析和写回在 domain/task-document.ts、domain/task-record.ts。
 */
import { arr, nullable, obj, oneOf, opt, str, type JsonSchema, type Static } from "@earendil-works/pi-schema";
import { schemaErrors } from "./schema.js";
import { AgentNameSchema, WORKFLOW_STAGE_ID_PATTERN } from "./workflow.js";

export const TASK_ID_PATTERN = "^k-[0-9a-f]{12}$";

export const TASK_STATUSES = ["draft", "ready", "active", "done", "delivered", "cancelled"] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_VERIFICATIONS = ["none", "self", "independent"] as const;
export const TASK_PRIORITIES = ["P0", "P1", "P2", "P3"] as const;

/** 属性的先后就是写回文件时字段的先后。 */
export const TaskFrontmatterSchema = obj({
  id: str({ pattern: TASK_ID_PATTERN }),
  title: str({ minLength: 1 }),
  status: oneOf(TASK_STATUSES),
  stage: nullable(str({ pattern: WORKFLOW_STAGE_ID_PATTERN })),
  verification: oneOf(TASK_VERIFICATIONS),
  parent: nullable(str({ pattern: TASK_ID_PATTERN })),
  dependsOn: arr(str({ pattern: TASK_ID_PATTERN })),
  priority: oneOf(TASK_PRIORITIES),
  createdAt: str({ minLength: 1 }),
});
export type TaskFrontmatter = Static<typeof TaskFrontmatterSchema>;

export const TaskRunSchema = obj({
  id: str({ minLength: 1 }),
  stage: str({ pattern: WORKFLOW_STAGE_ID_PATTERN }),
  agent: opt(AgentNameSchema),
  startedAt: str({ minLength: 1 }),
  endedAt: nullable(str({ minLength: 1 })),
  verdict: nullable(str({ minLength: 1 })),
  /** 失败的原因；正在跑和正常结束时是 null。 */
  failure: nullable(str({ minLength: 1 })),
  requirementDigest: str({ minLength: 1 }),
  changedPaths: arr(str({ minLength: 1 })),
  sessionFile: nullable(str({ minLength: 1 })),
});
export type TaskRun = Static<typeof TaskRunSchema>;

export const TaskRecordSchema = obj({
  confirmedDigest: nullable(str({ minLength: 1 })),
  changedPaths: arr(str({ minLength: 1 })),
  runs: arr(TaskRunSchema),
  authorization: nullable(str({ minLength: 1 })),
});
export type TaskRecord = Static<typeof TaskRecordSchema>;

/** 结构不对的地方，一处一句话，句子里带着出问题的字段。 */
export function schemaProblems(schema: JsonSchema, value: unknown): string[] {
  return schemaErrors(schema, value).map((error) => {
    const field = error.path.slice(1);
    if (field === "") return `应当是一组字段：${error.message}`;
    if (error.keyword === "required") return `缺少字段 ${field}`;
    if (error.keyword === "additionalProperties") return `多了字段 ${field}`;
    return `字段 ${field} 的值不对：${error.message}`;
  });
}
