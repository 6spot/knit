/**
 * 确定性摘要（TECHNOLOGY.md 第4节）：SHA-256 纯函数，只依赖 node:crypto，无文件系统访问。
 * contracts／domain 用其对输入与清单做稳定指纹；infrastructure/fingerprint 复用本模块，
 * 因此 contracts 不反向依赖 infrastructure（DESIGN.md 第2节分层）。
 */
import { createHash } from "node:crypto";

/** 字节指纹：sha256 hex；用于原子写预期版本与快照对照。 */
export function sha256Bytes(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, "utf8"));
}
