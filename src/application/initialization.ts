/**
 * InitializationService（ARCHITECTURE.md 第3节）：文件所有权、计划、安装映射、
 * 模板发布、ready 和失败恢复。流程按 DESIGN.md 第14节：
 * 计划 → preparing 清单与安装映射 → 项目补缺与受管候选 → 指纹核对 → 原子发布桥接 → ready。
 * --check 只读；失败记录逐项结果，部分初始化不当成功。
 */
import { accessSync, constants, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { atomicWrite } from "../infrastructure/atomic.js";
import { enforcePrivateDatabase, enforcePrivateFile, ensurePrivateDir, ensurePrivateRuntimeRoot } from "../infrastructure/private-mode.js";
import { InfrastructureError } from "../infrastructure/errors.js";
import { sha256Bytes, sha256Text } from "../infrastructure/fingerprint.js";
import { LockManager, orderKeys } from "../infrastructure/locks.js";
import { defaultClientIds } from "./clients.js";
import {
  AGENTS_MANAGED_MARKER_BEGIN,
  AGENTS_MANAGED_MARKER_END,
  agentsManagedBlock,
  readTemplate,
  TEMPLATE_SPECS,
  templateContent,
  templateDigest,
  templateVersion,
} from "./templates.js";
import type { TemplateSpec } from "./templates.js";
import { isReady, newManifest } from "./init-manifest.js";
import type { FileOwnership, InitManifest, ManifestItem } from "./init-manifest.js";

export interface InitPlanItem {
  path: string;
  ownership: "project" | "managed";
  action: "create" | "keep" | "update" | "conflict";
  reason: string;
  /** --force 预览：已存在且与当前模板不同，执行时按模板覆盖并先备份。 */
  overwrite?: boolean;
}

/**
 * 模板已移除文件：上次清单记录过、当前模板不再生成，但项目里仍存在。
 * 默认只报告，不删除；是否清理由主会话核对内容与来源后决定。
 */
export interface InitOrphan {
  path: string;
  ownership: FileOwnership;
  /** 上次清单记录的状态，仅作判断证据。 */
  lastState: ManifestItem["state"];
  /** 当前文件仍存在；报告只收录仍存在的路径。 */
  exists: boolean;
}

export interface InitPlan {
  root: string;
  isGitRepo: boolean;
  /** monorepo/子目录归一到仓库根时记录来源目录。 */
  resolvedFrom: string | null;
  gitWarning: string | null;
  items: InitPlanItem[];
  /** 预览是否按 --force 计算（只读，不代表已覆盖）。 */
  force: boolean;
  /** --force 预览中将被覆盖的项目模板文件数。 */
  overwriteCount: number;
  /** 模板已移除、仍留在项目中的文件；执行 init 同样只报告不删除。 */
  orphans: InitOrphan[];
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
  /** --force 下按模板覆盖的项目模板文件。 */
  overwritten: string[];
  /** 覆盖计数（overwritten.length）。 */
  overwriteCount: number;
  /** 本次覆盖的备份根；未发生覆盖时为 null，不创建备份目录。 */
  backupRoot: string | null;
  /** 覆盖前的原文件备份路径清单。 */
  backups: Array<{ path: string; backupPath: string }>;
  /** --force 下内容已与模板一致、未重写的项目文件。 */
  alreadyCurrent: string[];
  /** 模板已移除、仍留在项目中的文件；只报告，不删除。 */
  orphans: InitOrphan[];
  gitWarning: string | null;
}

export interface InitServiceOptions {
  /** 覆盖用户锁根（测试注入；生产默认 ~/.knit/locks）。 */
  locksRoot?: string;
  /** 受管块展示的 CLI 调用名；默认按 PATH 中 knit 的版本解析（测试可用此注入）。 */
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
  private readonly knitCommand: string | undefined;
  private readonly now: () => Date;
  /** 本次服务实例解析出的受管入口命令；同一实例重复 init 不重复探测 PATH。 */
  private resolvedKnitCommand: string | null = null;

  constructor(options: InitServiceOptions = {}) {
    this.locks = new LockManager(options.locksRoot ? { root: options.locksRoot } : {});
    this.knitCommand = options.knitCommand;
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

  /**
   * 受管块与提示里的 CLI 调用名。显式注入优先；否则 PATH 中的 knit 可执行且
   * `knit --version` 与本 CLI 一致时写 `knit`，否则回退当前 CLI 入口绝对路径。
   * 不写 `npx --no-install knit`：README 的安装方式是 npm 全局安装，新项目没有项目内依赖。
   */
  private managedCommand(version: string): string {
    if (this.knitCommand !== undefined) return this.knitCommand;
    if (this.resolvedKnitCommand === null) {
      this.resolvedKnitCommand = resolveManagedKnitCommand(this.cliEntry(), version);
    }
    return this.resolvedKnitCommand;
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
   * 上次清单记录、当前模板不再生成且项目里仍存在的文件。
   * 排除本次仍维护的模板路径、AGENTS.md 与 init 自身生成的运行资料；
   * 不按路径猜测内容，不自动删除。
   */
  private orphanedTemplateItems(root: string, previous: InitManifest | null): InitOrphan[] {
    if (previous === null) return [];
    const maintained = new Set([
      ...TEMPLATE_SPECS.map((spec) => spec.path),
      "AGENTS.md",
      ".knit/.gitignore",
      ".knit/.runtime/installation.json",
    ]);
    return previous.items
      .filter((item) => !maintained.has(item.path))
      .map((item) => ({
        path: item.path,
        ownership: item.ownership,
        lastState: item.state,
        exists: existsSync(join(root, item.path)),
      }))
      .filter((item) => item.exists)
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  /**
   * 逐文件计划（只读）。项目文件默认存在即 keep；--force 预览时与当前模板不同则标为将覆盖。
   * 受管文件与当前模板基线一致 → update，不一致 → conflict（人工改动报告差异，不静默覆盖）；
   * AGENTS.md 按受管块单独处理。
   */
  plan(root: string, options: { force?: boolean } = {}): InitPlan {
    const force = options.force ?? false;
    const { root: resolved, isGitRepo, resolvedFrom } = resolveProjectRoot(root);
    const previous = this.readManifestIfExists(resolved);
    const orphans = this.orphanedTemplateItems(resolved, previous);
    const items: InitPlanItem[] = [];
    let overwriteCount = 0;
    let agentsHasManagedBlock = false;
    for (const spec of TEMPLATE_SPECS) {
      const target = join(resolved, spec.path);
      if (!existsSync(target)) {
        items.push({ path: spec.path, ownership: spec.ownership, action: "create", reason: "文件尚不存在" });
        continue;
      }
      if (spec.ownership === "project") {
        if (!force) {
          items.push({ path: spec.path, ownership: spec.ownership, action: "keep", reason: "项目资料只补缺，已存在则沿用" });
          continue;
        }
        const current = sha256Text(readFileSync(target, "utf8"));
        const next = sha256Text(templateContent(spec.path));
        if (current === next) {
          items.push({ path: spec.path, ownership: spec.ownership, action: "keep", reason: "已与当前模板一致" });
          continue;
        }
        const recordedBaseline = previous?.items.find((item) => item.path === spec.path)?.baselineSha256 ?? null;
        const reason = recordedBaseline !== null && current === recordedBaseline
          ? "模板已更新，--force 将按当前模板覆盖并备份"
          : "与当前模板不同，--force 将按模板覆盖并备份";
        items.push({ path: spec.path, ownership: spec.ownership, action: "update", reason, overwrite: true });
        overwriteCount += 1;
        continue;
      }
      const current = sha256Text(readFileSync(target, "utf8"));
      const next = templateDigest(spec.path);
      const recordedBaseline = previous?.items.find((item) => item.path === spec.path)?.baselineSha256 ?? null;
      if (current === next) {
        items.push({ path: spec.path, ownership: spec.ownership, action: "keep", reason: "已与当前模板一致" });
      } else if (recordedBaseline !== null && current === recordedBaseline) {
        items.push({ path: spec.path, ownership: spec.ownership, action: "update", reason: "与上次受管基线一致，按新模板更新" });
      } else {
        items.push({ path: spec.path, ownership: spec.ownership, action: "conflict", reason: "与受管基线不一致（人工改动或未知来源），需先报告差异" });
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
    return { root: resolved, isGitRepo, resolvedFrom, gitWarning, items, force, overwriteCount, orphans, agentsHasManagedBlock };
  }

  /** --check：只读计划与现状说明，不写文件、不建锁目录；--force 只预览将覆盖项。 */
  check(root: string, options: { force?: boolean } = {}): InitPlan {
    return this.plan(root, options);
  }

  /**
   * 执行初始化。与其他项目写操作共用项目占用（OPERATIONS.md 第1节）。
   * 冲突/失败不中断其余项；ready 要求全部项成功且桥接已发布。
   */
  async execute(input: { dir: string; clients?: string[]; client?: string; force?: boolean }): Promise<InitResult> {
    const requestedClients = input.clients ?? (input.client !== undefined ? [input.client] : []);
    const clients = requestedClients.length > 0 ? requestedClients : defaultClientIds();
    const { root, isGitRepo } = resolveProjectRoot(input.dir);
    const acquired = await this.locks.acquire({ keys: orderKeys([{ scope: "project", rawKey: root }]), action: "init" });
    try {
      return this.executeLocked({ root, isGitRepo, clients, force: input.force ?? false });
    } finally {
      this.locks.release(acquired);
    }
  }

  private executeLocked(input: { root: string; isGitRepo: boolean; clients: string[]; force: boolean }): InitResult {
    const { root } = input;
    const previous = this.readManifestIfExists(root);
    const orphans = this.orphanedTemplateItems(root, previous);
    const currentVersion = templateVersion();
    if (previous !== null && compareVersions(previous.templateVersion, currentVersion) > 0) {
      throw new InfrastructureError(
        "version_conflict",
        `项目由更新版本 ${previous.templateVersion} 初始化，当前安装包 ${currentVersion} 不能降级覆盖；请安装匹配版本`,
      );
    }
    const manifest = newManifest({ client: input.clients.join(","), templateVersion: currentVersion, now: this.now().toISOString() });
    const items: ManifestItem[] = [];
    const created: string[] = [];
    const kept: string[] = [];
    const updated: string[] = [];
    const conflicts: string[] = [];
    const failed: Array<{ path: string; error: string }> = [];
    const overwritten: string[] = [];
    const backups: Array<{ path: string; backupPath: string }> = [];
    const alreadyCurrent: string[] = [];
    let backupRoot: string | null = null;
    /** 首次实际覆盖时才建 0700 备份根；同毫秒重复运行时追加序号避免覆盖旧备份。 */
    const ensureBackupRoot = (): string => {
      if (backupRoot !== null) return backupRoot;
      const base = join(this.runtimeDir(root), "init-backup", this.now().toISOString().replace(/[:.]/g, "-"));
      let candidate = base;
      let suffix = 1;
      while (existsSync(candidate)) candidate = `${base}-${suffix++}`;
      ensurePrivateDir(join(this.runtimeDir(root), "init-backup"));
      ensurePrivateDir(candidate);
      backupRoot = candidate;
      return candidate;
    };
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

    // 1. 运行目录私有权限、忽略规则与本机安装映射（目录 0700、文件 0600；已有目录也收紧，任务040）
    try {
      ensurePrivateRuntimeRoot(this.runtimeDir(root));
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
      enforcePrivateDatabase(join(root, ".knit", ".runtime", "metadata.db"));
      enforcePrivateFile(installPath);
      enforcePrivateFile(join(root, ".knit", ".runtime", "init-manifest.json"));
      record(".knit/.runtime/installation.json", "managed", installExisted ? "updated" : "created");
    } catch (error) {
      failed.push({ path: ".knit/.runtime", error: String(error) });
    }

    // 2. preparing 清单先行落盘（中断按逐项结果续做）。
    // 旧清单逐项结果与当前项合并持久保留：尚未处理的路径保留旧基线，
    // 桥接发布前中断的重试仍能按旧基线核实升级，不把旧桥接判为未知来源（任务039）。
    const previousItemsByPath = new Map(previous?.items.map((item) => [item.path, item]) ?? []);
    manifest.items = [...items, ...previous?.items.filter((item) => !items.some((current) => current.path === item.path)) ?? []];
    this.writeManifest(root, manifest);

    // 3. 项目资料：默认只补缺（存在即沿用）；--force 时与模板不同则先备份再按模板覆盖。
    for (const spec of TEMPLATE_SPECS.filter((s) => !s.bridge)) {
      const target = join(root, spec.path);
      try {
        const content = templateContent(spec.path);
        const nextSha = sha256Text(content);
        if (!existsSync(target)) {
          atomicWrite({ path: target, data: Buffer.from(content, "utf8"), expectedSha256: null, mode: 0o644 });
          record(spec.path, spec.ownership, "created", { baselineSha256: nextSha });
        } else {
          const currentBytes = readFileSync(target);
          const currentSha = sha256Bytes(currentBytes);
          if (!input.force) {
            record(spec.path, spec.ownership, "kept", { currentSha256: currentSha });
          } else if (currentSha === nextSha) {
            // 已一致不重写，也不建备份目录。
            record(spec.path, spec.ownership, "kept", { currentSha256: currentSha, baselineSha256: nextSha });
            alreadyCurrent.push(spec.path);
          } else {
            const rootForBackup = ensureBackupRoot();
            const backupPath = join(rootForBackup, spec.path);
            atomicWrite({ path: backupPath, data: currentBytes, expectedSha256: null, mode: 0o600 });
            backups.push({ path: spec.path, backupPath });
            atomicWrite({ path: target, data: Buffer.from(content, "utf8"), expectedSha256: currentSha, mode: 0o644 });
            record(spec.path, spec.ownership, "updated", { baselineSha256: nextSha, backupPath });
            overwritten.push(spec.path);
          }
        }
      } catch (error) {
        record(spec.path, spec.ownership, "failed", { error: String(error) });
      }
    }

    // 4. AGENTS.md 受管入口：已有正文保留并追加；已有块按块内容核对，人工改动冲突不覆盖
    const agentsPath = join(root, "AGENTS.md");
    try {
      const managedBlock = agentsManagedBlock(this.managedCommand(currentVersion));
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

    // 5. 逐项结果落盘（桥接发布前）；旧清单项按路径合并保留（任务039）。
    manifest.items = [...items, ...previousItemsByPath.size > 0
      ? (previous?.items ?? []).filter((item) => !items.some((current) => current.path === item.path))
      : []];
    this.writeManifest(root, manifest);

    // 6. 桥接最后发布：不存在或与基线一致才写；人工改动冲突不覆盖
    const bridgeSpec = TEMPLATE_SPECS.find((spec) => spec.bridge) as TemplateSpec;
    const bridgeTarget = join(root, bridgeSpec.path);
    try {
      const content = readTemplate(bridgeSpec.path);
      const nextDigest = templateDigest(bridgeSpec.path);
      const recordedBaseline = previous?.items.find((item) => item.path === bridgeSpec.path)?.baselineSha256 ?? null;
      if (!existsSync(bridgeTarget)) {
        atomicWrite({ path: bridgeTarget, data: Buffer.from(content, "utf8"), expectedSha256: null, mode: 0o644 });
        record(bridgeSpec.path, "managed", "created", { baselineSha256: nextDigest });
      } else {
        const current = sha256Text(readFileSync(bridgeTarget, "utf8"));
        if (current === sha256Text(content)) {
          // 内容已与新模板一致：不重写，幂等
          record(bridgeSpec.path, "managed", "kept", { currentSha256: current, baselineSha256: nextDigest });
        } else if (current === recordedBaseline || input.force) {
          atomicWrite({ path: bridgeTarget, data: Buffer.from(content, "utf8"), expectedSha256: current, mode: 0o644 });
          record(bridgeSpec.path, "managed", "updated", { baselineSha256: nextDigest });
        } else {
          record(bridgeSpec.path, "managed", "conflict", { error: "桥接与受管基线不一致（人工改动或未知来源），未覆盖；确认后用 --force 更新" });
        }
      }
    } catch (error) {
      record(bridgeSpec.path, "managed", "failed", { error: String(error) });
    }

    // 7. 收束：全部项成功 → ready；否则 failed（保留逐项结果，中断续做不冒充成功）。
    // 最终清单仍合并旧项：已消失的旧受管路径留作历史基线证据，不丢失（任务039）。
    manifest.overwriteCount = overwritten.length;
    manifest.backupRoot = backupRoot;
    manifest.backups = backups;
    manifest.items = [...items, ...(previous?.items ?? []).filter((item) => !items.some((current) => current.path === item.path))];
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
      overwritten,
      overwriteCount: overwritten.length,
      backupRoot,
      backups,
      alreadyCurrent,
      orphans,
      gitWarning,
    };
  }
}

/** 简单数字段比较，仅用于拒绝降级；非数字段按 0 处理。 */
function compareVersions(left: string, right: string): number {
  const a = left.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  const b = right.split(/[.+-]/).map((part) => Number.parseInt(part, 10) || 0);
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0);
    if (delta !== 0) return delta;
  }
  return 0;
}

/**
 * 受管入口命令：PATH 中的 `knit` 可执行且 `knit --version` 与当前 CLI 版本一致时返回
 * `knit`，否则返回当前 CLI 入口绝对路径的 shell token。文件路径身份仍保留原值。
 * `npx --no-install knit` 依赖项目内
 * node_modules，与 README 的 npm 全局安装方式不符，不再作为回退。
 */
export function resolveManagedKnitCommand(
  cliEntry: string,
  cliVersion: string,
  options: { env?: NodeJS.ProcessEnv; timeoutMs?: number } = {},
): string {
  const env = options.env ?? process.env;
  const timeoutMs = options.timeoutMs ?? 3000;
  const fallbackCommand = shellPathToken(cliEntry);
  for (const candidate of pathCandidates("knit", env)) {
    if (!isExecutableFile(candidate)) continue;
    // 只核对 shell 实际会解析到的第一个 knit：若它版本不符，写 `knit` 仍会执行错版本，必须回退。
    const probe = spawnSync(candidate, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
      env,
      windowsHide: true,
      shell: process.platform === "win32" && /\.(?:cmd|bat)$/i.test(candidate),
    });
    return probe.status === 0 && (probe.stdout ?? "").trim() === cliVersion ? "knit" : fallbackCommand;
  }
  return fallbackCommand;
}

/** POSIX shell 中的字面量路径；安全普通路径保持原样，单引号用闭合、转义、重开表示。 */
function shellPathToken(path: string): string {
  return /^[a-zA-Z0-9_./-]+$/.test(path) ? path : `'${path.replace(/'/g, "'\\''")}'`;
}

/** PATH 中的命令候选；Windows 按 PATHEXT 展开，Windows PATH 条目可带引号。 */
function pathCandidates(command: string, env: NodeJS.ProcessEnv): string[] {
  const rawPath = env.PATH ?? env.Path ?? "";
  const directories = rawPath
    .split(delimiter)
    .map((entry) => entry.replace(/^"(.*)"$/, "$1"))
    .filter((entry) => entry.length > 0);
  const extensions = process.platform === "win32"
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter((entry) => entry.length > 0)
    : [""];
  const candidates: string[] = [];
  for (const directory of directories) {
    for (const extension of extensions) {
      const suffix = extension === "" || extension.startsWith(".") ? extension.toLowerCase() : `.${extension.toLowerCase()}`;
      candidates.push(join(directory, `${command}${suffix}`));
    }
  }
  return candidates;
}

/** 普通文件且当前用户可执行；Windows 只看文件是否存在。 */
function isExecutableFile(path: string): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (process.platform !== "win32") accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
