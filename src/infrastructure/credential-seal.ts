/**
 * 本机凭据完整性（任务 k-28296c22647a；DESIGN §10.1、OPERATIONS §2.1）。
 * 检查凭据、完成凭据、实施记录、接收检查点、run 结果与交付 hook 基线写入时附 HMAC-SHA256，
 * 读取时校验；密钥在用户目录 `~/.knit/keys/<project-hash>`（0600，目录 0700），
 * 不在项目内，阶段进程环境也不传其路径（KNIT_KEYS_ROOT 由 isolatedEnv 剔除）。
 * 目标是防阶段 Agent 无意或越权伪造 ignored 明文凭据，不防同一用户账号下的恶意本地进程。
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, writeSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { join } from "node:path";
import { InfrastructureError } from "./errors.js";
import { hashKey } from "./paths.js";

/** 密钥根目录覆盖（隔离测试用）；阶段进程环境中被剔除。 */
export const KEYS_ROOT_ENV = "KNIT_KEYS_ROOT";

/** 签名字段名：写在凭据 JSON 顶层，读取时剥离后再按原 schema 校验。 */
export const INTEGRITY_FIELD = "integrity";

const MAC_ALG = "hmac-sha256";
const KEY_BYTES = 32;

/** 受签名保护的凭据种类；与文件名一起进入 MAC 输入，防止跨文件／跨种类挪用。 */
export type SealKind = "check" | "completion" | "implementation" | "acceptance" | "result" | "delivery-hooks";

export interface IntegritySeal {
  alg: typeof MAC_ALG;
  mac: string;
}

/** 校验失败原因：tampered＝签名不符或本机密钥缺失／已更换；unsigned＝旧凭据缺签名，需重建。 */
export type CredentialFailure = "credential_tampered" | "credential_unsigned";

export class CredentialIntegrityError extends InfrastructureError {
  readonly guardReason: CredentialFailure;
  readonly path: string;

  constructor(reason: CredentialFailure, message: string, path: string) {
    super("credential_integrity", message, { guardReason: reason, path });
    this.name = "CredentialIntegrityError";
    this.guardReason = reason;
    this.path = path;
  }
}

export function isCredentialIntegrityError(error: unknown): error is CredentialIntegrityError {
  return error instanceof CredentialIntegrityError;
}

/**
 * 密钥根：显式覆盖优先；否则取账号主目录（getpwuid，不随 HOME 变量漂移）下 `~/.knit/keys`。
 * 隔离 HOME 的命令（如 worktree 全局根测试）仍与主进程用同一把密钥。
 */
export function keysRoot(): string {
  const override = process.env[KEYS_ROOT_ENV];
  if (override !== undefined && override !== "") return override;
  let home: string;
  try {
    home = userInfo().homedir || homedir();
  } catch {
    home = homedir();
  }
  return join(home, ".knit", "keys");
}

/** 项目密钥路径：按规范化项目根的稳定摘要分文件；路径本身不进项目、不进阶段环境。 */
export function projectKeyPath(root: string): string {
  return join(keysRoot(), hashKey(root));
}

function readKey(path: string): Buffer | null {
  try {
    const data = readFileSync(path);
    return data.length >= KEY_BYTES ? data : null;
  } catch {
    return null;
  }
}

/** 取本机项目密钥；写入时缺失则以 wx 原子创建（并发创建者读取先到者）。读取时不创建。 */
function projectKey(root: string, create: boolean): Buffer | null {
  const path = projectKeyPath(root);
  const existing = readKey(path);
  if (existing !== null || !create) return existing;
  const dir = keysRoot();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(dir, 0o700);
  } catch {
    // 目录权限不可改时仍可用；文件本身为 0600。
  }
  const material = randomBytes(KEY_BYTES);
  let fd: number | null = null;
  try {
    fd = openSync(path, "wx", 0o600);
    writeSync(fd, material);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new InfrastructureError("io_error", `无法创建本机凭据密钥：${path}`);
    }
  } finally {
    if (fd !== null) closeSync(fd);
  }
  const created = readKey(path);
  if (created === null) throw new InfrastructureError("io_error", `本机凭据密钥不可读：${path}`);
  return created;
}

/** 稳定序列化：键排序、去掉 undefined；数组保持顺序。 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter((key) => record[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function macOf(macKey: Buffer, kind: SealKind, name: string, payload: unknown): string {
  // JSON 往返统一 undefined／Date 等表示，使写入与读回的输入一致。
  const normalized = JSON.parse(JSON.stringify(payload)) as unknown;
  return createHmac("sha256", macKey)
    .update(`knit-credential/v1\n${kind}\n${name}\n${canonicalJson(normalized)}`, "utf8")
    .digest("hex");
}

/** 为待写凭据生成签名；payload 不得自带 integrity 字段。 */
export function sealOf(root: string, kind: SealKind, name: string, payload: object): IntegritySeal {
  if (Object.prototype.hasOwnProperty.call(payload, INTEGRITY_FIELD)) {
    throw new InfrastructureError("io_error", `凭据正文不能自带 ${INTEGRITY_FIELD} 字段：${kind}/${name}`);
  }
  const macKey = projectKey(root, true)!;
  return { alg: MAC_ALG, mac: macOf(macKey, kind, name, payload) };
}

/** 带签名的序列化正文（2 空格缩进＋换行，与其它 runtime 文件一致）。 */
export function sealedJson(root: string, kind: SealKind, name: string, payload: object): Buffer {
  const seal = sealOf(root, kind, name, payload);
  return Buffer.from(JSON.stringify({ ...payload, [INTEGRITY_FIELD]: seal }, null, 2) + "\n");
}

export type SealVerdict = "valid" | CredentialFailure;

/**
 * 校验已解析的凭据对象：返回剥离签名后的正文与结论，不抛异常。
 * 缺签名 → credential_unsigned（旧格式，需重建）；签名结构不符、MAC 不符或本机密钥缺失 → credential_tampered。
 */
export function inspectSealed(
  root: string,
  kind: SealKind,
  name: string,
  raw: unknown,
): { verdict: SealVerdict; payload: unknown } {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return { verdict: "credential_tampered", payload: raw };
  const { [INTEGRITY_FIELD]: seal, ...payload } = raw as Record<string, unknown>;
  if (seal === undefined) return { verdict: "credential_unsigned", payload };
  if (seal === null || typeof seal !== "object") return { verdict: "credential_tampered", payload };
  const { alg, mac } = seal as { alg?: unknown; mac?: unknown };
  if (alg !== MAC_ALG || typeof mac !== "string" || !/^[0-9a-f]{64}$/.test(mac)) return { verdict: "credential_tampered", payload };
  const macKey = projectKey(root, false);
  if (macKey === null) return { verdict: "credential_tampered", payload };
  const expected = Buffer.from(macOf(macKey, kind, name, payload), "hex");
  const actual = Buffer.from(mac, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return { verdict: "credential_tampered", payload };
  return { verdict: "valid", payload };
}

/** 失败时的说明：tampered 与 unsigned 给出不同处理建议。 */
export function credentialFailureMessage(reason: CredentialFailure, label: string, path: string): string {
  return reason === "credential_unsigned"
    ? `credential_unsigned: ${label} 缺少完整性签名（旧格式），需重建，不作有效凭据：${path}`
    : `credential_tampered: ${label} 完整性校验失败（内容被改动，或本机密钥缺失／已更换），不作有效凭据：${path}`;
}
