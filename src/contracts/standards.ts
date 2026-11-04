/**
 * 规范候选与审阅回执（DESIGN.md 第8.2节、STATES.md 第9节）。
 * 候选保存为项目级 .knit/standards/candidates.md 的标记块；回执保存于元数据短事务。
 * 旧任务的 standards.md 只读兼容，可经 standards migrate 迁入项目级候选文件。
 * 程序只机械核对候选摘要与决定，不判断规则语义。
 */
import { arr, lit, nul, obj, opt, str, union, type Static } from "@earendil-works/pi-schema";
import { sha256Text } from "./digest.js";

export const CANDIDATE_START_PREFIX = "<!-- knit:candidate:start id=";
export const CANDIDATE_END = "<!-- knit:candidate:end -->";
/** 项目级候选文件；不进入正式规范摘要。 */
export const PROJECT_CANDIDATES_FILE = "candidates.md";
/** standards_reviews 中项目作用域的 task_id 键。 */
export const PROJECT_SCOPE = "project";

const CANDIDATE_ID = /^c-[0-9a-f]{12}$/;

export const StandardsCandidateSchema = obj(
  {
    candidateId: str({ pattern: "^c-[0-9a-f]{12}$" }),
    title: str({ minLength: 1 }),
    /** 发现的问题／缺口。 */
    problem: str({ minLength: 1 }),
    evidence: str(),
    scope: str(),
    /** 建议规则正文；采纳时按此机械追加到目标规范。 */
    rule: str({ minLength: 1 }),
    verification: str(),
    /** 来源说明（讨论、任务 k-...）；只作记录，不进入摘要。 */
    source: opt(str()),
    /** 本候选块的版本摘要；正文变化即变化。 */
    digest: str({ minLength: 1 }),
  },
);
export type StandardsCandidate = Static<typeof StandardsCandidateSchema>;

export const StandardsReviewDecisionSchema = union([
  lit("applied"),
  lit("deferred"),
  lit("rejected"),
  lit("mixed"),
]);
export type StandardsReviewDecision = Static<typeof StandardsReviewDecisionSchema>;

export const StandardsReviewSchema = obj(
  {
    reviewId: str({ pattern: "^r-[0-9a-f]{12}$" }),
    /** 旧任务作用域回执的任务 ID；项目作用域回执省略。 */
    taskId: opt(str({ minLength: 1 })),
    /** 仅标注来源的任务 ID，不参与项目级匹配。 */
    sourceTaskId: opt(str({ minLength: 1 })),
    /** 审阅时的分支，仅作记录；项目级匹配不要求分支一致。 */
    branch: union([str({ minLength: 1 }), nul()]),
    /** 候选集合摘要：按候选 ID 排序的 id:digest。 */
    candidateDigest: str({ minLength: 1 }),
    decision: StandardsReviewDecisionSchema,
    reason: str({ minLength: 1 }),
    /** 采纳／混合时指向的正式规范路径（项目相对，正斜杠）。 */
    targets: arr(str({ minLength: 1 })),
    /** 本次审阅覆盖的候选 ID。 */
    candidateIds: arr(str({ minLength: 1 })),
    operationId: str({ minLength: 1 }),
    recordedAt: str({ minLength: 1 }),
  },
);
export type StandardsReview = Static<typeof StandardsReviewSchema>;

export function newCandidateId(randomHex: (bytes: number) => string): string {
  return `c-${randomHex(6)}`;
}

export function newReviewId(randomHex: (bytes: number) => string): string {
  return `r-${randomHex(6)}`;
}

/** 候选正文摘要；source 只作来源记录，变化不使既有审阅回执失配。 */
export function candidateDigestOf(candidate: Omit<StandardsCandidate, "digest">): string {
  return sha256Text(
    JSON.stringify([
      candidate.candidateId,
      candidate.title,
      candidate.problem,
      candidate.evidence,
      candidate.scope,
      candidate.rule,
      candidate.verification,
    ]),
  );
}

/** 候选集合摘要；顺序不影响，增删或正文变化都会变化。 */
export function candidateSetDigest(candidates: StandardsCandidate[]): string {
  const lines = [...candidates]
    .sort((a, b) => a.candidateId.localeCompare(b.candidateId))
    .map((candidate) => `${candidate.candidateId}:${candidate.digest}`);
  return sha256Text(lines.join("\n"));
}

const FIELD_HEADINGS: Record<string, keyof Pick<StandardsCandidate, "problem" | "evidence" | "scope" | "rule" | "verification" | "source">> = {
  问题: "problem",
  证据: "evidence",
  适用范围: "scope",
  建议规则: "rule",
  "验证／示例": "verification",
  来源: "source",
};

export interface ParsedCandidates {
  candidates: StandardsCandidate[];
  /** 结构错误；调用方按 io_error 报告，不静默修复。 */
  errors: string[];
}

/** 解析候选文件中的标记块；块外文字（说明、空行）忽略。 */
export function parseCandidates(text: string): ParsedCandidates {
  const candidates: StandardsCandidate[] = [];
  const errors: string[] = [];
  const startPattern = /<!-- knit:candidate:start id=(c-[0-9a-f]{12}) -->/g;
  let match: RegExpExecArray | null;
  while ((match = startPattern.exec(text)) !== null) {
    const candidateId = match[1];
    if (candidateId === undefined) continue;
    const bodyStart = match.index + match[0].length;
    const endIndex = text.indexOf(CANDIDATE_END, bodyStart);
    if (endIndex < 0) {
      errors.push(`候选 ${candidateId} 缺少结束标记`);
      break;
    }
    const body = text.slice(bodyStart, endIndex);
    const parsed = parseCandidateBody(candidateId, body);
    if (typeof parsed === "string") errors.push(parsed);
    else candidates.push(parsed);
    startPattern.lastIndex = endIndex + CANDIDATE_END.length;
  }
  return { candidates, errors };
}

function parseCandidateBody(candidateId: string, body: string): StandardsCandidate | string {
  const lines = body.split("\n");
  let title = "";
  const fields: Record<string, string[]> = {};
  let current: string | null = null;
  for (const line of lines) {
    if (line.startsWith("## ")) {
      title = line.slice(3).trim();
      current = null;
      continue;
    }
    if (line.startsWith("### ")) {
      const heading = line.slice(4).trim();
      const field = FIELD_HEADINGS[heading];
      if (field === undefined) return `候选 ${candidateId} 含未知小节: ${heading}`;
      current = field;
      fields[field] = [];
      continue;
    }
    if (current !== null) (fields[current] ??= []).push(line);
  }
  const value = (field: string) => (fields[field] ?? []).join("\n").trim();
  if (title === "") return `候选 ${candidateId} 缺少标题`;
  if (value("problem") === "") return `候选 ${candidateId} 缺少问题`;
  if (value("rule") === "") return `候选 ${candidateId} 缺少建议规则`;
  const base = {
    candidateId,
    title,
    problem: value("problem"),
    evidence: value("evidence"),
    scope: value("scope"),
    rule: value("rule"),
    verification: value("verification"),
    source: value("source"),
  };
  return { ...base, digest: candidateDigestOf(base) };
}

/** 渲染单个候选块；标题与字段正文不得包含标记或小节标题（避免歧义）。 */
export function renderCandidate(candidate: StandardsCandidate): string {
  const guard = (name: string, value: string) => {
    if (value.includes("<!-- knit:candidate") || /(^|\n)## /.test(value)) {
      throw new Error(`候选字段 ${name} 不得包含候选标记或二级标题`);
    }
  };
  guard("title", candidate.title);
  for (const field of ["problem", "evidence", "scope", "rule", "verification"] as const) {
    guard(field, candidate[field]);
  }
  guard("source", candidate.source ?? "");
  return [
    `${CANDIDATE_START_PREFIX}${candidate.candidateId} -->`,
    `## ${candidate.title}`,
    "",
    ...(candidate.source === undefined || candidate.source === ""
      ? []
      : ["### 来源", "", candidate.source, ""]),
    "### 问题",
    "",
    candidate.problem,
    "",
    "### 证据",
    "",
    candidate.evidence,
    "",
    "### 适用范围",
    "",
    candidate.scope,
    "",
    "### 建议规则",
    "",
    candidate.rule,
    "",
    "### 验证／示例",
    "",
    candidate.verification,
    CANDIDATE_END,
  ].join("\n");
}

/** 采纳写入正式规范时的正文（不含候选标记与 ID）；source 为来源说明，不要求任务存在。 */
export function renderCandidateRule(candidate: StandardsCandidate, source: string): string {
  const label = source.trim() === "" ? "项目讨论" : source.trim();
  return [
    `## ${candidate.title}`,
    "",
    candidate.rule,
    "",
    ...(candidate.verification === "" ? [] : ["验证／示例：", "", candidate.verification, ""]),
    `来源：${label}／候选 ${candidate.candidateId}。`,
    "",
  ].join("\n");
}

export function isValidCandidateId(value: string): boolean {
  return CANDIDATE_ID.test(value);
}
