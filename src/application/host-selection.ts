/**
 * 执行宿主解析（DESIGN.md 第5.7、13节）。
 *
 * 优先级：调用级显式 --rex／--local > 项目 execution.host > auto。
 * 只有 auto（含未配置）在派发前探测失败时回退 local 并保留原因；
 * 显式或配置指定 rex 时失败报 rex_unavailable，不静默换宿主。
 * 探测复用 RexApi：环境变量、rex CLI 与必需方法齐备才认为 Rex 可用。
 */
import { accessSync, constants as fsConstants } from "node:fs";
import { delimiter, join } from "node:path";
import { RexApi, RexCapabilityError } from "../adapters/rex/index.js";
import type { RunPresentation, RunPresentationSource } from "../contracts/run.js";
import type { ExecutionHost } from "./config.js";
import { GuardError } from "./guard-error.js";

export interface HostSelection {
  host: RunPresentation;
  source: RunPresentationSource;
  /** 仅 auto 探测失败时记录；显式／配置选择为 null。 */
  fallbackReason: string | null;
}

export type HostProbe = (env: NodeJS.ProcessEnv) => Promise<void>;

export type HostProbeFailure =
  | "missing_environment"
  | "cli_missing"
  | "connection_failed"
  | "missing_methods";

/** 默认探测的可分类失败；原因文本直接进入 rex_unavailable 或回退记录。 */
export class HostProbeError extends Error {
  constructor(
    readonly kind: HostProbeFailure,
    message: string,
  ) {
    super(message);
    this.name = "HostProbeError";
  }
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function executableNames(): string[] {
  return process.platform === "win32" ? ["rex.exe", "rex.cmd", "rex"] : ["rex"];
}

/** REX_BIN_DIR/rex 优先，其次 PATH；找不到可执行文件返回 null。 */
export function resolveRexExecutable(env: NodeJS.ProcessEnv = process.env): string | null {
  const names = executableNames();
  const binDir = env.REX_BIN_DIR?.trim();
  if (binDir !== undefined && binDir !== "") {
    for (const name of names) {
      const candidate = join(binDir, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

/** 复用 RexApi 的能力探测；不新写协议。 */
export async function probeRexHost(env: NodeJS.ProcessEnv = process.env): Promise<void> {
  if ((env.REX_SESSION ?? "") === "" || (env.REX_BLOCK ?? "") === "") {
    throw new HostProbeError("missing_environment", "未检测到 Rex 环境（REX_SESSION／REX_BLOCK 缺失）");
  }
  const executable = resolveRexExecutable(env);
  if (executable === null) {
    throw new HostProbeError("cli_missing", "未找到可执行的 rex CLI（REX_BIN_DIR 或 PATH）");
  }
  const api = new RexApi({
    executable,
    session: env.REX_SESSION ?? null,
    server: env.REX_SERVER ?? null,
  });
  try {
    await api.check();
  } catch (error) {
    if (error instanceof RexCapabilityError) {
      throw new HostProbeError("missing_methods", error.message);
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new HostProbeError("connection_failed", `Rex server 不可连接：${message}`);
  }
}

function failureText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.trim() === "" ? "原因未知" : message;
}

export interface SelectHostInput {
  /** 调用级显式选择；null／缺省表示未指定。 */
  explicit?: RunPresentation | null;
  /** 项目 execution.host；null／缺省按 auto。 */
  config?: ExecutionHost | null;
  env?: NodeJS.ProcessEnv;
  probe?: HostProbe;
}

export async function selectHost(input: SelectHostInput = {}): Promise<HostSelection> {
  const env = input.env ?? process.env;
  const probe = input.probe ?? probeRexHost;
  const explicit = input.explicit ?? null;

  if (explicit === "local") {
    return { host: "local", source: "explicit", fallbackReason: null };
  }
  if (explicit === "rex") {
    try {
      await probe(env);
    } catch (error) {
      throw new GuardError("rex_unavailable", `显式 --rex 不可用：${failureText(error)}`);
    }
    return { host: "rex", source: "explicit", fallbackReason: null };
  }

  const configured = input.config ?? "auto";
  if (configured === "local") {
    return { host: "local", source: "config", fallbackReason: null };
  }
  if (configured === "rex") {
    try {
      await probe(env);
    } catch (error) {
      throw new GuardError("rex_unavailable", `execution.host=rex 不可用：${failureText(error)}`);
    }
    return { host: "rex", source: "config", fallbackReason: null };
  }

  try {
    await probe(env);
    return { host: "rex", source: "auto", fallbackReason: null };
  } catch (error) {
    return { host: "local", source: "auto", fallbackReason: failureText(error) };
  }
}
