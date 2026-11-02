/**
 * 常见 token／私钥模式扫描（DESIGN.md §5.6、§15.1 第6项）。
 * 写入任务、规范、配置与限定提交前扫描待写内容；命中暂停该副作用，
 * 只报告类型与位置，不回显完整敏感值。扫描不构成无泄露证明。
 */
import { sha256Text } from "./digest.js";

export interface CredentialHit {
  /** 模式类型，如 private_key_header、aws_access_key_id。 */
  type: string;
  /** 命中行号（1 起始）。 */
  line: number;
  /** 命中片段：只保留模式自身或前缀，不含完整敏感值。 */
  excerpt: string;
}

interface Pattern {
  type: string;
  /** 命中位置：模式起始。 */
  match: RegExp;
  /** 命中后是否要求同行继续满足（降低误报）。 */
  confirm?: RegExp;
  /** 报告用的模式自身长度上限；缺省 16 字符。 */
  excerptLength?: number;
}

/** 常见凭据模式；全部为合成可验证的标记，不要求真实密钥可连接。 */
const PATTERNS: Pattern[] = [
  { type: "private_key_header", match: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { type: "private_key_block_end", match: /-----END (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY-----/ },
  { type: "aws_access_key_id", match: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { type: "github_token", match: /\bgh[pousr]_[A-Za-z0-9]{36,255}\b/ },
  { type: "gitlab_token", match: /\bglpat-[A-Za-z0-9_\-]{20,}\b/ },
  { type: "slack_token", match: /\bxox[baprs]-[A-Za-z0-9\-]{10,}\b/ },
  { type: "openai_api_key", match: /\bsk-[A-Za-z0-9_\-]{20,}\b/ },
  { type: "anthropic_api_key", match: /\bsk-ant-[A-Za-z0-9_\-]{24,}\b/ },
  { type: "google_api_key", match: /\bAIza[0-9A-Za-z_\-]{35}\b/ },
  { type: "heroku_api_key", match: /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/, confirm: /heroku/i },
  { type: "jwt", match: /\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\b/ },
  {
    type: "generic_secret_assignment",
    match: /\b(?:api[_-]?key|secret|password|token|passwd|access[_-]?key)\b["'\s]*[:=]["'\s]*\S{8,}/i,
    confirm: /\b(?:api[_-]?key|secret|password|token|passwd|access[_-]?key)\b["'\s]*[:=]["'\s]*[A-Za-z0-9+/_\-]{8,}/i,
  },
];

/** 扫描文本；命中只报告类型、行号与模式自身摘录，不返回完整敏感值。 */
export function scanCredentials(text: string): CredentialHit[] {
  const hits: CredentialHit[] = [];
  const lines = text.split(/\r?\n/);
  for (const [lineIndex, rawLine] of lines.entries()) {
    const line = rawLine ?? "";
    for (const pattern of PATTERNS) {
      const found = pattern.match.exec(line);
      if (found === null) continue;
      if (pattern.confirm !== undefined && !pattern.confirm.test(line)) continue;
      const excerpt = found[0].slice(0, Math.min(found[0].length, pattern.excerptLength ?? 16));
      hits.push({
        type: pattern.type,
        line: lineIndex + 1,
        excerpt,
      });
    }
  }
  return hits;
}

/** 命中的稳定指纹：类型与位置相同即同一次报告；不含敏感值。 */
export function credentialHitsDigest(hits: CredentialHit[]): string {
  return sha256Text(hits.map((hit) => `${hit.type}:${hit.line}:${hit.excerpt}`).join("\n") || "no-hits");
}
