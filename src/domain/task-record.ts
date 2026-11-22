/** `record.json`：人不需要读的运行记录。只处理文本，不读写文件。 */
import { checkSchema, schemaProblems } from "../contracts/schema.js";
import { TaskRecordSchema, type TaskRecord } from "../contracts/task.js";

export type TaskRecordParse =
  | { readonly record: TaskRecord; readonly problems: readonly [] }
  | { readonly record: null; readonly problems: readonly string[] };

/** `json` 是 `null` 表示文件还不存在，得到一份空记录。 */
export function parseTaskRecord(json: string | null): TaskRecordParse {
  if (json === null) {
    return { record: { confirmedDigest: null, changedPaths: [], runs: [], authorization: null }, problems: [] };
  }
  const value = parseJson(json);
  if (value instanceof SyntaxError) return { record: null, problems: [`不是合法的 JSON：${value.message}`] };
  if (!checkSchema(TaskRecordSchema, value)) return { record: null, problems: schemaProblems(TaskRecordSchema, value) };
  return { record: value, problems: [] };
}

export function renderTaskRecord(record: TaskRecord): string {
  const ordered = {
    confirmedDigest: record.confirmedDigest,
    changedPaths: record.changedPaths,
    runs: record.runs.map((run) => ({
      id: run.id,
      stage: run.stage,
      agent: run.agent,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      verdict: run.verdict,
      failure: run.failure,
      requirementDigest: run.requirementDigest,
      changedPaths: run.changedPaths,
      sessionFile: run.sessionFile,
    })),
    authorization: record.authorization,
  };
  return `${JSON.stringify(ordered, null, 2)}\n`;
}

function parseJson(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch (error) {
    if (error instanceof SyntaxError) return error;
    throw error;
  }
}
