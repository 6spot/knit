/**
 * InitializationService（ARCHITECTURE.md 第3节）：文件所有权、计划、安装映射、
 * 模板发布、ready 和失败恢复。流程按 DESIGN.md 第14节：
 * 计划 → preparing 清单与安装映射 → 项目补缺与受管候选 → 指纹核对 → 原子发布桥接 → ready。
 * --check 只读；失败记录逐项结果，部分初始化不当成功。
 */
import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "../infrastructure/atomic.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { fileFacts, sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { defaultConfig } from "./config.js";
import {
  AGENTS_MANAGED_MARKER_BEGIN,
  AGENTS_MANAGED_MARKER_END,
  agentsManagedBlock,
  readTemplate,
  TEMPLATE_SPECS,
  templateDigest,
  templateVersion,
} from "./templates.js";
import type { TemplateSpec } from "./templates.js";
import { isReady, newManifest } from "./init-manifest.js";
import type { InitManifest, ManifestItem } from "./init-manifest.js";

export interface InitPlanItem {
  path: string;
  ownership: "project" | "managed";
  action: "create" | "keep" | "update" | "conflict";
  reason: string;
}

export interface InitPlan {
  root: string;
  isGitRepo: boolean;
  /** monorepo/子目录归一到仓库根时记录来源目录。 */
  resolvedFrom: string | null;
  gitWarning: string | null;
  items: InitPlanItem[];
  agentsHasManagedBlock: boolean;
}

export interface InitResult {
  root: string;
  manifestState: "preparing" | "ready" | "failed";
  created: string[];
  kept: string[];
  updated: string[];
  conflicts: string[];
  failed: Array<{ path: string; error: string }>;
  ready: boolean;
  /** 桥接文件已发布且清单 ready；缺映射或未 ready 不能声称可调用。 */
  bridgeReady: boolean;
  gitWarning: string | null;
}

export interface InitServiceOptions {
  /** 覆盖用户锁根（测试注入；生产默认 ~/.knit/locks）。 */
  locksRoot?: string;
  /** 受管块展示的 CLI 调用名。 */
  knitCommand?: string;
  now?: () => Date;
}

const GIT_ENV = { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" } as NodeJS.ProcessEnv;

/** 项目根解析：Git 仓库根或指定目录；子目录归一到已确认仓库根（DESIGN.md 第14节）。 */
export function resolveProjectRoot(dir: string): { root: string; isGitRepo: boolean; resolvedFrom: string | null } {
  const requested = resolve(dir);
  if (!existsSync(requested)) {
    throw new InfrastructureError("io_error", `目录不存在: ${requested}`);
  }
  if (!statSync(requested).isDirectory()) {
    throw new InfrastructureError("io_error", `不是目录: ${requested}`);
  }
  const probe = spawnSync("git", ["-C", requested, "rev-parse", "--show-toplevel"], { encoding: "utf8", env: GIT_ENV });
  if (probe.status === 0 && probe.stdout.trim()) {
    const root = resolve(probe.stdout.trim());
    return { root, isGitRepo: true, resolvedFrom: root === requested ? null : requested };
  }
  // 非 Git 目录：按指定目录准备资料，正式执行再核 Git 条件
  return { root: requested, isGitRepo: false, resolvedFrom: null };
}

/** .runtime 忽略与跟踪状态核对；返回告警或 null。 */
function runtimeIgnoreWarning(root: string, isGitRepo: boolean): string | null {
  if (!isGitRepo) return null;
  const probe = (args: string[]) =>
    spawnSync("git", ["-C", root, ...args], { encoding: "utf8", env: GIT_ENV });
  const runtimeRel = ".knit/.runtime";
  const tracked = probe(["ls-files", "--", runtimeRel]);
  if (tracked.status === 0 && tracked.stdout.trim()) {
    return ".knit/.runtime 已被 Git 跟踪；运行目录不入 Git，正式执行前须移出跟踪";
  }
  const ignored = probe(["check-ignore", "-q", runtimeRel]);
  if (ignored.status !== 0) {
    return ".knit/.runtime 尚未被 Git 忽略；.knit/.gitignore 已写入排除规则，确认后随项目提交";
  }
  return null;
}

export class InitializationService {
  private readonly locks: LockManager;
  private readonly knitCommand: string;
  private readonly now: () => Date;

  constructor(options: InitServiceOptions = {}) {
    this.locks = new LockManager(options.locksRoot ? { root: options.locksRoot } : {});
    this.knitCommand = options.knitCommand ?? "knit";
    this.now = options.now ?? (() => new Date());
  }

  private runtimeDir(root: string): string {
    return join(root, ".knit", ".runtime");
  }

  private manifestPath(root: string): string {
    return join(this.runtimeDir(root), "init-manifest.json");
  }

  private installationPath(root: string): string {
    return join(this.runtimeDir(root), "installation.json");
  }

  /** 本机 CLI 入口绝对路径（dist/cli/knit.js），安装映射记录。 */
  private cliEntry(): string {
    // dist/application/initialization.js → dist → dist/cli/knit.js
    return join(fileURLToPath(new URL("../cli/knit.js", import.meta.url)));
  }

  private readManifestIfExists(root: string): InitManifest | null {
    const path = this.manifestPath(root);
    if (!existsSync(path)) return null;
    try {
      const manifest = JSON.parse(readFileSync(path, "utf8")) as InitManifest;
      if (manifest.schemaVersion !== 1) {
        throw new InfrastructureError("version_conflict", `不支持的 init-manifest schemaVersion ${manifest.schemaVersion}，期望 1；未知版本不降级`);
      }
      return manifest;
    } catch (error) {
      if (error instanceof InfrastructureError) throw error;
      return null; // 损坏清单按无清单处理，重新走 preparing
    }
  }

  /** 清单原子写：以磁盘字节为版本依据；中断后重入不覆盖并发更新。 */
  private writeManifest(root: string, manifest: InitManifest): void {
    const path = this.manifestPath(root);
    const next = { ...manifest, updatedAt: this.now().toISOString() };
    let expected: string | null = null;
    if (existsSync(path)) {
      expected = sha256Bytes(readFileSync(path));
    }
    atomicWrite({
      path,
      data: Buffer.from(JSON.stringify(next, null, 2) + "\n", "utf8"),
      expectedSha256: expected,
      mode: 0o600,
    });
  }

  /**
   * 逐文件计划（只读）。项目文件存在即 keep；受管文件与当前模板基线一致 → update，
   * 不一致 → conflict（人工改动报告差异，不静默覆盖）；AGENTS.md 按受管块单独处理。
   */
  plan(root: string): InitPlan {
    const { root: resolved, isGitRepo, resolvedFrom } = resolveProjectRoot(root);
    const items: InitPlanItem[] = [];
    let agentsHasManagedBlock = false;
    for (const spec of TEMPLATE_SPECS) {
      const target = join(resolved, spec.path);
      if (!existsSync(target)) {
        items.push({ path: spec.path, ownership: spec.ownership, action: "create", reason: "文件尚不存在" });
        continue;
      }
      if (spec.ownership === "project") {
        items.push({ path: spec.path, ownership: spec.ownership, action: "keep", reason: "项目资料只补缺，已存在则沿用" });
        continue;
      }
      const current = sha256Text(readFileSync(target, "utf8"));
      if (current === templateDigest(spec.path)) {
        items.push({ path: spec.path, ownership: spec.ownership, action: "update", reason: "与旧基线一致，按新模板更新" });
      } else {
        items.push({ path: spec.path, ownership: spec.ownership, action: "conflict", reason: "与模板基线不一致（人工改动或旧版本），需先报告差异" });
      }
    }
    const agentsPath = join(resolved, "AGENTS.md");
    if (!existsSync(agentsPath)) {
      items.push({ path: "AGENTS.md", ownership: "managed", action: "create", reason: "尚无 AGENTS.md，生成受管入口" });
    } else {
      const content = readFileSync(agentsPath, "utf8");
      agentsHasManagedBlock = content.includes(AGENTS_MANAGED_MARKER_BEGIN);
      items.push(
        agentsHasManagedBlock
          ? { path: "AGENTS.md", ownership: "managed", action: "keep", reason: "受管标记块已存在（执行时按块内容逐字核对）" }
          : { path: "AGENTS.md", ownership: "managed", action: "update", reason: "已有正文保留，追加受管标记块" },
      );
    }
    const gitWarning = isGitRepo ? runtimeIgnoreWarning(resolved, true) : "非 Git 目录：资料可初始化；正式任务执行需 Git 仓库、可读 HEAD 与本地分支";
    return { root: resolved, isGitRepo, resolvedFrom, gitWarning, items, agentsHasManagedBlock };
  }

  /** --check：只读计划与现状说明，不写文件、不建锁目录。 */
  check(root: string): InitPlan {
    return this.plan(root);
  }

  /**
   * 执行初始化。与其他项目写操作共用项目占用（OPERATIONS.md 第1节）。
   * 冲突/失败不中断其余项；ready 要求全部项成功且桥接已发布。
   */
  async execute(input: { dir: string; client: string; force?: boolean }): Promise<InitResult> {
    const { root, isGitRepo } = resolveProjectRoot(input.dir);
    const acquired = await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: root }]), action: "init" });
    try {
      return this.executeLocked({ root, isGitRepo, client: input.client, force: input.force ?? false });
    } finally {
      this.locks.release(acquired);
    }
  }

  private executeLocked(input: { root: string; isGitRepo: boolean; client: string; force: boolean }): InitResult {
    const { root } = input;
    const manifest = newManifest({ client: input.client, templateVersion: templateVersion(), now: this.now().toISOString() });
    const items: ManifestItem[] = [];
    const created: string[] = [];
    const kept: string[] = [];
    const updated: string[] = [];
    const conflicts: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const record = (
      path: string,
      ownership: "project" | "managed",
      state: ManifestItem["state"],
      extra: Partial<ManifestItem> = {},
    ) => {
      items.push({ path, ownership, state, ...extra });
      if (state === "created") created.push(path);
      else if (state === "kept") kept.push(path);
      else if (state === "updated") updated.push(path);
      else if (state === "conflict") conflicts.push(path);
      else if (state === "failed") failed.push({ path, error: extra.error ?? "unknown" });
    };

    // 1. 运行目录私有权限、忽略规则与本机安装映射
    try {
      mkdirSync(this.runtimeDir(root), { recursive: true, mode: 0o700 });
      const gitignorePath = join(root, ".knit", ".gitignore");
      if (!existsSync(gitignorePath)) {
        const rule = ".runtime/\n";
        atomicWrite({ path: gitignorePath, data: Buffer.from(rule, "utf8"), expectedSha256: null, mode: 0o644 });
        record(".knit/.gitignore", "managed", "created", { baselineSha256: sha256Text(rule) });
      } else {
        record(".knit/.gitignore", "managed", "kept", { currentSha256: sha256Text(readFileSync(gitignorePath, "utf8")) });
      }
      const installPath = this.installationPath(root);
      const installExisted = existsSync(installPath);
      const installRecord = {
        schemaVersion: 1,
        cliEntry: this.cliEntry(),
        packageVersion: templateVersion(),
        recordedAt: this.now().toISOString(),
      };
      const installBody = JSON.stringify(installRecord, null, 2) + "\n";
      const installExpected = installExisted ? sha256Bytes(readFileSync(installPath)) : null;
      atomicWrite({ path: installPath, data: Buffer.from(installBody, "utf8"), expectedSha256: installExpected, mode: 0o600 });
      record(".knit/.runtime/installation.json", "managed", installExisted ? "updated" : "created");
    } catch (error) {
      failed.push({ path: ".knit/.runtime", error: String(error) });
    }

    // 2. preparing 清单先行落盘（中断按逐项结果续做）
    manifest.items = [...items];
    this.writeManifest(root, manifest);

    // 3. 项目资料补缺（配置、工作流、角色、规范索引；存在即沿用）
    for (const spec of TEMPLATE_SPECS.filter((s) => !s.bridge)) {
      const target = join(root, spec.path);
      try {
        if (!existsSync(target)) {
          const content = spec.path === ".knit/config.json" ? JSON.stringify(defaultConfig(), null, 2) + "\n" : readTemplate(spec.path);
          atomicWrite({ path: target, data: Buffer.from(content, "utf8"), expectedSha256: null, mode: 0o644 });
          record(spec.path, spec.ownership, "created", { baselineSha256: sha256Text(content) });
        } else {
          record(spec.path, spec.ownership, "kept", { currentSha256: fileFacts(target).sha256 });
        }
      } catch (error) {
        record(spec.path, spec.ownership, "failed", { error: String(error) });
      }
    }

    // 4. AGENTS.md 受管入口：已有正文保留并追加；已有块按块内容核对，人工改动冲突不覆盖
    const agentsPath = join(root, "AGENTS.md");
    try {
      const managedBlock = agentsManagedBlock(this.knitCommand);
      if (!existsSync(agentsPath)) {
        atomicWrite({ path: agentsPath, data: Buffer.from(managedBlock, "utf8"), expectedSha256: null, mode: 0o644 });
        record("AGENTS.md", "managed", "created", { baselineSha256: sha256Text(managedBlock) });
      } else {
        const content = readFileSync(agentsPath, "utf8");
        const begin = content.indexOf(AGENTS_MANAGED_MARKER_BEGIN);
        const end = content.indexOf(AGENTS_MANAGED_MARKER_END);
        if (begin === -1 || end === -1) {
          const next = content.endsWith("\n") ? `${content}\n${managedBlock}` : `${content}\n\n${managedBlock}`;
          atomicWrite({ path: agentsPath, data: Buffer.from(next, "utf8"), expectedSha256: sha256Text(content), mode: 0o644 });
          record("AGENTS.md", "managed", "updated", { baselineSha256: sha256Text(next) });
        } else {
          const currentBlock = `${content.slice(begin, end + AGENTS_MANAGED_MARKER_END.length)}\n`;
          if (currentBlock === managedBlock) {
            record("AGENTS.md", "managed", "kept", { currentSha256: sha256Text(content) });
          } else if (input.force) {
            const next = `${content.slice(0, begin)}${managedBlock}${content.slice(end + AGENTS_MANAGED_MARKER_END.length).replace(/^\n/, "")}`;
            atomicWrite({ path: agentsPath, data: Buffer.from(next, "utf8"), expectedSha256: sha256Text(content), mode: 0o644 });
            record("AGENTS.md", "managed", "updated", { baselineSha256: sha256Text(next) });
          } else {
            record("AGENTS.md", "managed", "conflict", { error: "受管块与当前基线不一致（人工改动），未覆盖；确认后用 --force 更新" });
          }
        }
      }
    } catch (error) {
      record("AGENTS.md", "managed", "failed", { error: String(error) });
    }

    // 5. 逐项结果落盘（桥接发布前）
    manifest.items = [...items];
    this.writeManifest(root, manifest);

    // 6. 桥接最后发布：不存在或与基线一致才写；人工改动冲突不覆盖
    const bridgeSpec = TEMPLATE_SPECS.find((spec) => spec.bridge) as TemplateSpec;
    const bridgeTarget = join(root, bridgeSpec.path);
    try {
      const content = readTemplate(bridgeSpec.path);
      if (!existsSync(bridgeTarget)) {
        atomicWrite({ path: bridgeTarget, data: Buffer.from(content, "utf8"), expectedSha256: null, mode: 0o644 });
        record(bridgeSpec.path, "managed", "created", { baselineSha256: templateDigest(bridgeSpec.path) });
      } else {
        const current = sha256Text(readFileSync(bridgeTarget, "utf8"));
        if (current === sha256Text(content)) {
          // 内容已与新模板一致：不重写，幂等
          record(bridgeSpec.path, "managed", "kept", { currentSha256: current, baselineSha256: templateDigest(bridgeSpec.path) });
        } else if (current === templateDigest(bridgeSpec.path) || input.force) {
          atomicWrite({ path: bridgeTarget, data: Buffer.from(content, "utf8"), expectedSha256: current, mode: 0o644 });
          record(bridgeSpec.path, "managed", "updated", { baselineSha256: sha256Text(content) });
        } else {
          record(bridgeSpec.path, "managed", "conflict", { error: "桥接与模板基线不一致（人工改动），未覆盖；确认后用 --force 更新" });
        }
      }
    } catch (error) {
      record(bridgeSpec.path, "managed", "failed", { error: String(error) });
    }

    // 7. 收束：全部项成功 → ready；否则 failed（保留逐项结果，中断续做不冒充成功）
    manifest.items = [...items];
    manifest.state = isReady(manifest, bridgeSpec.path) ? "ready" : "failed";
    this.writeManifest(root, manifest);

    const gitWarning = input.isGitRepo ? runtimeIgnoreWarning(root, true) : "非 Git 目录：资料可初始化；正式任务执行需 Git 仓库、可读 HEAD 与本地分支";
    return {
      root,
      manifestState: manifest.state,
      created,
      kept,
      updated,
      conflicts,
      failed,
      ready: manifest.state === "ready",
      bridgeReady: manifest.state === "ready" && existsSync(bridgeTarget),
      gitWarning,
    };
  }
}
