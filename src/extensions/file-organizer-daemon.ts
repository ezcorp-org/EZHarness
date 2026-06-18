/**
 * FileOrganizerDaemon — the HOST-side background watcher for the
 * `file-organizer` bundled extension.
 *
 * Modeled on `schedule-daemon.ts`: a module-scoped singleton wired into
 * `background-timers.ts`, with a PID-lockfile (sibling prevention), a
 * strict kill-switch env var, an interval clamp, and a NON-REENTRANT,
 * swallow-and-continue tick. It is NOT cron (cron fires are ownerless →
 * `-32106`) and NOT in-subprocess `Bun.watch` (the host folders are
 * outside the sandbox jail). It reads/writes the file-based state under
 * `.ezcorp/extension-data/file-organizer/` and applies changes via the
 * shared host applier (which carries the realpath/lstat guards + audit).
 *
 * Per-tick pipeline:
 *   read config.json + hashcache.json
 *   → fswalk each folder (depth/loop/budget) with the stability gate
 *   → rule-match (presets + custom + duplicate index)
 *   → dedupe vs pending/applied/suppressed
 *   → write proposals.json (atomic temp+rename under .lock)
 *   → mode handling (ask-everything queue; non-destructive auto-move;
 *     fully-auto auto-apply-all as a batch)
 *   → TTL/size-cap quarantine prune
 *   → invalidate the page cache.
 *
 * Fail-closed: a missing project root, an unreachable watch root, an
 * unwritable quarantine, or a degraded mount (ESTALE/EIO) holds
 * destructive ops — a read disconnect is NEVER read as "all deleted".
 */
import { createHash } from "node:crypto";
import { readdir, lstat, stat, readlink } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger";
import type { PermissionEngine } from "./permission-engine";

// Pure shared logic — leaf modules only (NO page.ts: it pulls @ezcorp/sdk).
import {
  loadProposals,
  saveProposals,
  shouldSkipCandidate,
  dedupeKey as computeDedupeKey,
  pruneSuppressed,
  transition,
  type Proposal,
  type ProposalKind,
  type ProposalsFile,
  type ProposalsIO,
} from "../../docs/extensions/examples/file-organizer/lib/proposals";
import {
  expandPresets,
  ruleMatches,
  patternMatches,
  extOf,
  type FileFacts,
  type Rule,
} from "../../docs/extensions/examples/file-organizer/lib/rules";
import {
  validateConfig,
  effectiveIgnores,
  isIgnored,
  type Config,
  type FolderConfig,
  type Mode,
} from "../../docs/extensions/examples/file-organizer/lib/config";
import {
  walk,
  hashDecision,
  updateHashCache,
  duplicatePathsToRemove,
  duplicateHashes,
  isUnstableName,
  tickStability,
  type DirReader,
  type WalkDirent,
  type HashCache,
  type StabilityMap,
} from "../../docs/extensions/examples/file-organizer/lib/fswalk";
import { routeDestination } from "../../docs/extensions/examples/file-organizer/lib/applier";
import {
  emptyManifest,
  planQuarantine,
  recordQuarantine,
  removeEntry,
  selectPruneVictims,
  type QuarantineManifest,
} from "../../docs/extensions/examples/file-organizer/lib/quarantine";

import {
  applyProposal,
  replayJournal,
  hardDeleteTrash,
  type ApplierContext,
  type ApplierProposal,
} from "./file-organizer-applier";

const log = logger.child("ext.file-organizer-daemon");

const KILL_SWITCH = "EZCORP_DISABLE_FILE_ORGANIZER_DAEMON";
const DEFAULT_LOCKFILE = ".daemon.pid";
const MIN_INTERVAL_SEC = 5;
const MAX_INTERVAL_SEC = 3600;
const WALK_BUDGET = 2000;
const WALK_MAX_DEPTH = 12;

export interface FileOrganizerSettings {
  daemonEnabled: boolean;
  defaultMode: Mode;
  quarantineTtlDays: number;
  quarantineCapGb: number;
  scanIntervalSec: number;
  stabilityTicks: number;
}

export const DEFAULT_SETTINGS: FileOrganizerSettings = {
  daemonEnabled: true,
  defaultMode: "ask-everything",
  quarantineTtlDays: 30,
  quarantineCapGb: 5,
  scanIntervalSec: 45,
  stabilityTicks: 2,
};

/**
 * Pure: resolve effective daemon settings from the manifest's declared
 * defaults overlaid with any stored per-user values. Each field falls back
 * to DEFAULT_SETTINGS when missing or the wrong type — so a partial/garbage
 * settings blob can never produce a NaN interval or an undefined mode.
 */
export function mergeFileOrganizerSettings(
  declared: Record<string, unknown>,
  stored: Record<string, unknown>,
): FileOrganizerSettings {
  const merged = { ...declared, ...stored };
  const numOr = (v: unknown, fallback: number): number =>
    typeof v === "number" && Number.isFinite(v) ? v : fallback;
  const validMode =
    merged.default_mode === "ask-everything" ||
    merged.default_mode === "approve-non-destructive-only" ||
    merged.default_mode === "fully-auto";
  return {
    daemonEnabled: typeof merged.daemon_enabled === "boolean" ? merged.daemon_enabled : DEFAULT_SETTINGS.daemonEnabled,
    defaultMode: validMode ? (merged.default_mode as Mode) : DEFAULT_SETTINGS.defaultMode,
    quarantineTtlDays: numOr(merged.quarantine_ttl_days, DEFAULT_SETTINGS.quarantineTtlDays),
    quarantineCapGb: numOr(merged.quarantine_cap_gb, DEFAULT_SETTINGS.quarantineCapGb),
    scanIntervalSec: numOr(merged.scan_interval_sec, DEFAULT_SETTINGS.scanIntervalSec),
    stabilityTicks: numOr(merged.stability_ticks, DEFAULT_SETTINGS.stabilityTicks),
  };
}

export interface FileOrganizerDaemonOptions {
  /** Absolute data dir (`.ezcorp/extension-data/file-organizer`). */
  dataDir: string;
  /** Permission engine for the applier's audit gate. */
  engine: PermissionEngine;
  extensionId: string;
  /** Resolve current settings each tick (live). */
  getSettings: () => Promise<FileOrganizerSettings>;
  /** Invalidate a Hub page's cache after state changes. */
  invalidatePage?: (pageId: string) => void;
  /** Now-injection for tests. */
  now?: () => number;
  /** Disable the PID lockfile (test-only). */
  skipLockfile?: boolean;
  /** Override the wake interval (ms) — tests pass small. */
  wakeIntervalMsOverride?: number;
}

interface BadgeFile {
  pending: number;
  unclassified: number;
  lastScanAt: string | null;
}

export class FileOrganizerDaemon {
  private timer?: ReturnType<typeof setInterval>;
  private ticking = false;
  private lockfileOwned = false;
  private readonly stability: StabilityMap = {};
  private readonly now: () => number;

  constructor(private readonly opts: FileOrganizerDaemonOptions) {
    this.now = opts.now ?? Date.now;
  }

  private get lockfilePath(): string {
    return join(this.opts.dataDir, DEFAULT_LOCKFILE);
  }
  private get configPath(): string {
    return join(this.opts.dataDir, "config.json");
  }
  private get proposalsPath(): string {
    return join(this.opts.dataDir, "proposals.json");
  }
  private get hashcachePath(): string {
    return join(this.opts.dataDir, "hashcache.json");
  }
  private get journalPath(): string {
    return join(this.opts.dataDir, "journal.json");
  }
  private get trashRoot(): string {
    return join(this.opts.dataDir, ".trash");
  }
  private get manifestPath(): string {
    return join(this.trashRoot, "manifest.json");
  }
  private get badgePath(): string {
    return join(this.opts.dataDir, "badge.json");
  }

  /** Start: kill-switch check → lockfile → journal replay → wake loop.
   *  Returns false when refused (kill-switch or sibling daemon). */
  async start(settings: FileOrganizerSettings): Promise<boolean> {
    if (this.timer) return true;
    if (process.env[KILL_SWITCH] === "1") {
      log.info("file-organizer daemon disabled via kill-switch");
      return false;
    }
    if (!settings.daemonEnabled) {
      log.info("file-organizer daemon disabled via setting");
      return false;
    }
    if (!this.opts.skipLockfile) {
      const acquired = await acquireLockfile(this.lockfilePath);
      if (!acquired) {
        log.warn("file-organizer daemon refused to start (sibling alive)");
        return false;
      }
      this.lockfileOwned = true;
    }

    // Crash-replay any in-flight apply intent before the first tick.
    try {
      const res = await replayJournal(this.journalPath);
      if (res.finished + res.rolledBack > 0) {
        log.info("file-organizer journal replayed", res);
      }
    } catch (err) {
      log.warn("file-organizer journal replay failed", { error: String(err) });
    }

    const intervalMs =
      this.opts.wakeIntervalMsOverride ??
      clampInterval(settings.scanIntervalSec) * 1000;
    this.timer = setInterval(() => {
      void this.tick().catch((err) => log.warn("file-organizer tick failed", { error: String(err) }));
    }, intervalMs);
    if (typeof this.timer === "object" && "unref" in this.timer) {
      (this.timer as unknown as { unref: () => void }).unref();
    }
    return true;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    if (this.lockfileOwned) {
      void releaseLockfile(this.lockfilePath).catch(() => {});
      this.lockfileOwned = false;
    }
  }

  /** One non-reentrant scan+apply pass. Public so tests drive it directly. */
  async tick(): Promise<{ generated: number; applied: number; pruned: number }> {
    if (this.ticking) return { generated: 0, applied: 0, pruned: 0 };
    this.ticking = true;
    try {
      return await this.runTick();
    } finally {
      this.ticking = false;
    }
  }

  private async runTick(): Promise<{ generated: number; applied: number; pruned: number }> {
    const settings = await this.opts.getSettings();
    const config = await this.readConfig();
    const hashcache = await this.readHashCache();
    const propsIO = this.makeProposalsIO();
    const { file: loaded, corrupt } = await loadProposals(propsIO);
    if (corrupt) {
      await this.sidecarCorruptProposals();
    }
    let file: ProposalsFile = loaded;
    let nowMs = this.now();
    let generated = 0;
    let applied = 0;

    // Non-canonical duplicate copies (keep ONE canonical per hash group).
    // Built from the start-of-tick hashcache, same snapshot as the hashes
    // the scan reads below — so duplicate-killer never quarantines every copy.
    const dupesToRemove = duplicatePathsToRemove(hashcache);
    // Hashes shared by >1 file this scan — members are "known" duplicates,
    // never flagged unclassified (neither the kept canonical nor the copies).
    const dupeHashes = duplicateHashes(hashcache);
    let nextCache = hashcache;

    for (const folder of config.folders) {
      // Fail-closed: an unreachable watch root holds the folder (never
      // treat a missing/disconnected mount as "all files gone").
      if (!(await this.reachable(folder.path))) {
        log.warn("file-organizer watch root unreachable — skipping (fail-closed)", { path: folder.path });
        continue;
      }
      const ignores = effectiveIgnores(config, folder);
      const reader = this.makeDirReader();
      const result = await walk(folder.path, reader, {
        maxDepth: WALK_MAX_DEPTH,
        budget: WALK_BUDGET,
        isIgnored: (p) => isIgnored(p, ignores),
      });

      const rules = [...expandPresets(folder.presets), ...folder.customRules];
      const mode = folder.mode ?? settings.defaultMode;

      for (const entry of result.files) {
        if (entry.isSymlink) continue; // recorded but never acted on
        if (isUnstableName(entry.name)) continue; // partial download

        // First-run backlog: new-only skips pre-existing files.
        if (folder.backlogPolicy === "new-only" && folder.epochMs !== undefined && entry.mtimeMs < folder.epochMs) {
          continue;
        }

        // Stability gate — act only after N quiescent ticks.
        const { state, stable } = tickStability(this.stability[entry.path], entry, settings.stabilityTicks);
        this.stability[entry.path] = state;
        if (!stable) continue;

        // Hashcache: re-hash only on size/mtime change.
        const decision = hashDecision(entry, nextCache);
        let sha256: string | undefined;
        if (decision === "hit") {
          sha256 = nextCache[entry.path]!.sha256;
        } else if (decision === "miss") {
          sha256 = await this.hashFile(entry.path);
          if (sha256) nextCache = updateHashCache(nextCache, entry.path, { size: entry.size, mtimeMs: entry.mtimeMs, sha256 });
        }

        const facts: FileFacts = {
          path: entry.path,
          name: entry.name,
          ext: extOf(entry.name),
          size: entry.size,
          mtimeMs: entry.mtimeMs,
          ...(sha256 ? { sha256 } : {}),
          isSymlink: entry.isSymlink,
          nlink: entry.nlink,
        };
        // Flag only NON-canonical duplicate copies — the canonical (oldest)
        // copy is never marked, so dedup always keeps one instance.
        const isDuplicate = dupesToRemove.has(entry.path);

        const matched = firstMatch(rules, facts, nowMs, isDuplicate, folder.path);
        if (!matched) {
          // No rule matched. Emit an `unclassified` "falls outside the
          // workflow" alert ONLY for a genuinely UNRECOGNIZED file:
          //   - new since this folder's watch-start (`epochMs`) — no backlog spam,
          //   - NO active rule PATTERN-matches its name/ext (a file deferred by
          //     a time/size threshold, e.g. a fresh `*.tmp` the dwell guard
          //     protects, is a KNOWN type — never unclassified),
          //   - NOT a member of a duplicate group (a recognized duplicate,
          //     kept canonical or removed copy, is known — never unclassified).
          // Symlinks/unstable/partial were already `continue`d above.
          const isNew = folder.epochMs !== undefined && entry.mtimeMs >= folder.epochMs;
          if (!isNew) continue;
          if (rules.some((r) => patternMatches(r, facts))) continue;
          // Duplicate-group membership is resolved against the START-of-tick
          // hashcache (same snapshot `dupesToRemove` uses). A hashable file
          // whose hash isn't cached YET is deferred one tick — exactly when
          // duplicate-killer would first see it — so we never flag a copy as
          // "unknown" before its duplicate twin is known. Unhashable (too
          // large) files can't be dup-checked, so they flag on pattern alone.
          if (decision !== "skip" && hashcache[entry.path] === undefined) continue;
          if (sha256 !== undefined && dupeHashes.has(sha256)) continue;
          const candidate = { kind: "unclassified" as ProposalKind, src: entry.path, dst: null, ruleId: null, contentHash: sha256 ?? null };
          if (shouldSkipCandidate(file, candidate, nowMs)) continue;
          const proposal: Proposal = {
            id: cryptoId(),
            kind: "unclassified",
            src: entry.path,
            dst: null,
            reason: "No rule matched — pick a destination or teach a rule",
            ruleId: null,
            ruleLabel: null,
            folderId: folder.id,
            snapshot: { size: entry.size, mtimeMs: entry.mtimeMs, ...(sha256 ? { sha256 } : {}), isSymlink: entry.isSymlink, dev: 0, ino: 0, nlink: entry.nlink },
            status: "pending",
            dedupeKey: computeDedupeKey({ kind: "unclassified", src: entry.path, dst: null, ruleId: null }),
            createdAt: new Date(nowMs).toISOString(),
            version: 0,
          };
          file = { ...file, proposals: [...file.proposals, proposal] };
          generated++;
          continue;
        }

        const { kind, dst, ruleId, ruleLabel, reason } = matched;
        if (shouldSkipCandidate(file, { kind, src: entry.path, dst, ruleId, contentHash: sha256 ?? null }, nowMs)) {
          continue;
        }

        const proposal: Proposal = {
          id: cryptoId(),
          kind,
          src: entry.path,
          dst,
          reason,
          ruleId,
          ruleLabel,
          folderId: folder.id,
          snapshot: { size: entry.size, mtimeMs: entry.mtimeMs, ...(sha256 ? { sha256 } : {}), isSymlink: entry.isSymlink, dev: 0, ino: 0, nlink: entry.nlink },
          status: "pending",
          dedupeKey: computeDedupeKey({ kind, src: entry.path, dst, ruleId }),
          createdAt: new Date(nowMs).toISOString(),
          version: 0,
        };
        file = { ...file, proposals: [...file.proposals, proposal] };
        generated++;
      }

      // Mode-driven auto-apply for this folder's freshly-generated pendings.
      if (mode !== "ask-everything") {
        const res = await this.autoApply(file, folder, mode, settings);
        file = res.file;
        applied += res.applied;
      }
    }

    // Persist proposals + hashcache.
    file = { ...file, suppressed: pruneSuppressed(file.suppressed, nowMs) };
    await saveProposals(propsIO, file);
    await this.writeHashCache(nextCache);

    // Quarantine prune (TTL + size cap).
    const pruned = await this.prune(settings);

    // Badge + cache invalidation.
    nowMs = this.now();
    await this.writeBadge(file);
    this.invalidateAll();

    return { generated, applied, pruned };
  }

  // ── Auto-apply per mode ───────────────────────────────────────────

  private async autoApply(
    file: ProposalsFile,
    folder: FolderConfig,
    mode: Mode,
    settings: FileOrganizerSettings,
  ): Promise<{ file: ProposalsFile; applied: number }> {
    const batchId = mode === "fully-auto" ? `batch-${cryptoId()}` : null;
    let applied = 0;
    let working = file;
    const ctx = this.applierContext(folder);

    for (const p of file.proposals) {
      if (p.status !== "pending" || p.folderId !== folder.id) continue;
      // `unclassified` has no destination — it is a user-attention alert,
      // never auto-applied in any mode.
      if (p.kind === "unclassified") continue;
      const destructive = p.kind === "delete-quarantine";
      // approve-non-destructive-only: auto-apply moves/renames only.
      if (mode === "approve-non-destructive-only" && destructive) continue;
      // fully-auto: everything eligible.
      const outcome = await applyProposal(this.toApplierProposal(p), ctx);
      const updated = this.applyOutcomeToProposal(p, outcome, batchId);
      if (updated) {
        working = { ...working, proposals: working.proposals.map((x) => (x.id === p.id ? updated : x)) };
        if (outcome.status === "applied") {
          applied++;
          if (outcome.quarantineId) await this.recordQuarantineEntry(p, outcome.quarantineId, outcome.resolvedPath ?? "", batchId, settings);
        }
      }
    }
    return { file: working, applied };
  }

  private applyOutcomeToProposal(
    p: Proposal,
    outcome: { status: string; quarantineId?: string },
    batchId: string | null,
  ): Proposal | null {
    switch (outcome.status) {
      case "applied":
        return transition(p, "applied", { by: "daemon", at: new Date(this.now()).toISOString(), ...(batchId ? { batchId } : {}), ...(outcome.quarantineId ? { quarantineId: outcome.quarantineId } : {}) });
      case "failed":
        return transition(p, "failed");
      case "stale-source":
        return transition(p, "stale-source");
      case "blocked":
        return transition(p, "blocked");
      default:
        return null; // skipped — leave pending
    }
  }

  // ── Quarantine bookkeeping + prune ────────────────────────────────

  private async recordQuarantineEntry(
    p: Proposal,
    quarantineId: string,
    trashPath: string,
    batchId: string | null,
    settings: FileOrganizerSettings,
  ): Promise<void> {
    const manifest = await this.readManifest();
    const plan = planQuarantine(
      {
        trashRoot: this.trashRoot,
        id: quarantineId,
        originalPath: p.src,
        proposalId: p.id,
        reason: p.reason,
        batchId,
        size: p.snapshot.size,
        now: this.now(),
        ttlMs: settings.quarantineTtlDays * 24 * 60 * 60 * 1000,
      },
      () => false,
    );
    const entry = { ...plan.entry, trashPath: trashPath || plan.trashPath };
    await this.writeManifest(recordQuarantine(manifest, entry));
  }

  private async prune(settings: FileOrganizerSettings): Promise<number> {
    const manifest = await this.readManifest();
    if (manifest.entries.length === 0) return 0;
    const capBytes = settings.quarantineCapGb > 0 ? settings.quarantineCapGb * 1024 ** 3 : 0;
    const victims = selectPruneVictims(manifest, { now: this.now(), capBytes });
    if (victims.length === 0) return 0;
    let next = manifest;
    for (const id of victims) {
      const ok = await hardDeleteTrash(join(this.trashRoot, id));
      if (ok) next = removeEntry(next, id);
    }
    await this.writeManifest(next);
    return victims.length;
  }

  // ── Applier wiring ────────────────────────────────────────────────

  private applierContext(folder: FolderConfig): ApplierContext {
    return {
      extensionId: this.opts.extensionId,
      userId: null,
      conversationId: null,
      engine: this.opts.engine,
      trashRoot: this.trashRoot,
      journalPath: this.journalPath,
      watchedRoot: folder.path,
      dataDirRoot: this.opts.dataDir,
    };
  }

  private toApplierProposal(p: Proposal): ApplierProposal {
    return {
      id: p.id,
      kind: p.kind,
      src: p.src,
      dst: p.dst,
      snapshot: { size: p.snapshot.size, mtimeMs: p.snapshot.mtimeMs, isSymlink: p.snapshot.isSymlink, nlink: p.snapshot.nlink },
      ...(p.quarantineId ? { quarantineId: p.quarantineId } : {}),
    };
  }

  // ── IO helpers ────────────────────────────────────────────────────

  private makeProposalsIO(): ProposalsIO {
    return {
      read: async () => {
        const f = Bun.file(this.proposalsPath);
        return (await f.exists()) ? f.text() : null;
      },
      write: async (text) => atomicWrite(this.proposalsPath, text),
    };
  }

  private makeDirReader(): DirReader {
    return {
      read: async (dir: string): Promise<WalkDirent[]> => {
        const names = await readdir(dir);
        const out: WalkDirent[] = [];
        for (const name of names) {
          const full = join(dir, name);
          try {
            const ls = await lstat(full);
            const isSymlink = ls.isSymbolicLink();
            out.push({
              name,
              path: full,
              isDirectory: ls.isDirectory(),
              isFile: ls.isFile(),
              isSymlink,
              inodeKey: `${ls.dev}:${ls.ino}`,
              size: ls.size,
              mtimeMs: ls.mtimeMs,
              nlink: ls.nlink,
            });
          } catch {
            // ESTALE/EIO on a single entry — skip it, never abort the dir.
          }
        }
        return out;
      },
    };
  }

  private async hashFile(path: string): Promise<string | undefined> {
    try {
      const buf = await Bun.file(path).arrayBuffer();
      return createHash("sha256").update(new Uint8Array(buf)).digest("hex");
    } catch {
      return undefined;
    }
  }

  private async readConfig(): Promise<Config> {
    try {
      const f = Bun.file(this.configPath);
      if (!(await f.exists())) return validateConfig(null);
      return validateConfig(JSON.parse(await f.text()));
    } catch {
      return validateConfig(null);
    }
  }

  private async readHashCache(): Promise<HashCache> {
    try {
      const f = Bun.file(this.hashcachePath);
      if (!(await f.exists())) return {};
      const parsed = JSON.parse(await f.text());
      return parsed && typeof parsed === "object" ? (parsed as HashCache) : {};
    } catch {
      return {};
    }
  }

  private async writeHashCache(cache: HashCache): Promise<void> {
    await atomicWrite(this.hashcachePath, JSON.stringify(cache, null, 2));
  }

  private async readManifest(): Promise<QuarantineManifest> {
    try {
      const f = Bun.file(this.manifestPath);
      if (!(await f.exists())) return emptyManifest();
      const parsed = JSON.parse(await f.text());
      return parsed && Array.isArray(parsed.entries) ? (parsed as QuarantineManifest) : emptyManifest();
    } catch {
      // Corrupt manifest ⇒ keep (fail-safe), never auto-prune.
      return emptyManifest();
    }
  }

  private async writeManifest(manifest: QuarantineManifest): Promise<void> {
    await atomicWrite(this.manifestPath, JSON.stringify(manifest, null, 2));
  }

  private async writeBadge(file: ProposalsFile): Promise<void> {
    const pending = file.proposals.filter((p) => p.status === "pending").length;
    const unclassified = file.proposals.filter((p) => p.kind === "unclassified" && p.status === "pending").length;
    const badge: BadgeFile = { pending, unclassified, lastScanAt: new Date(this.now()).toISOString() };
    await atomicWrite(this.badgePath, JSON.stringify(badge, null, 2));
  }

  private async sidecarCorruptProposals(): Promise<void> {
    try {
      const f = Bun.file(this.proposalsPath);
      if (await f.exists()) {
        await Bun.write(`${this.proposalsPath}.corrupt-${this.now()}`, await f.text());
      }
    } catch {
      /* best-effort */
    }
  }

  private async reachable(path: string): Promise<boolean> {
    try {
      const st = await stat(path);
      return st.isDirectory();
    } catch {
      return false;
    }
  }

  private invalidateAll(): void {
    if (!this.opts.invalidatePage) return;
    for (const id of ["overview", "review", "folders"]) this.opts.invalidatePage(id);
  }

  /** Test seam: which symlinks a dir reader saw (for assertions). */
  async _readlinkSafe(path: string): Promise<string | null> {
    try {
      return await readlink(path);
    } catch {
      return null;
    }
  }
}

// ── Shared helpers ──────────────────────────────────────────────────

/** Pure: the first rule that matches a file → a proposal shape. Routing
 *  destinations are computed against the file's `watchedRoot`. */
function firstMatch(
  rules: Rule[],
  facts: FileFacts,
  now: number,
  isDuplicate: boolean,
  watchedRoot: string,
): { kind: ProposalKind; dst: string | null; ruleId: string | null; ruleLabel: string | null; reason: string } | null {
  for (const rule of rules) {
    if (!ruleMatches(rule, facts, { now, isDuplicate })) continue;
    if (rule.action === "quarantine") {
      return { kind: "delete-quarantine", dst: null, ruleId: rule.id, ruleLabel: rule.label, reason: rule.label };
    }
    const dst = rule.dest ? routeDestination(watchedRoot, rule.dest, facts.path) : null;
    return { kind: "move", dst, ruleId: rule.id, ruleLabel: rule.label, reason: rule.label };
  }
  return null;
}

function clampInterval(sec: number): number {
  if (!Number.isFinite(sec)) return DEFAULT_SETTINGS.scanIntervalSec;
  return Math.min(MAX_INTERVAL_SEC, Math.max(MIN_INTERVAL_SEC, Math.floor(sec)));
}

function cryptoId(): string {
  return crypto.randomUUID();
}

async function atomicWrite(absPath: string, text: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(absPath, ".."), { recursive: true }).catch(() => {});
  const tmp = `${absPath}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  await Bun.write(tmp, text);
  await fs.rename(tmp, absPath);
}

// ── PID lockfile (mirrors schedule-daemon.ts) ───────────────────────

function isProcessAlive(pid: number): boolean {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException)?.code === "EPERM";
  }
}

async function acquireLockfile(path: string): Promise<boolean> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(path, ".."), { recursive: true });
  const file = Bun.file(path);
  if (await file.exists()) {
    const pid = parseInt((await file.text()).trim(), 10);
    if (Number.isFinite(pid) && isProcessAlive(pid)) return false;
    // Stale lock — overwrite.
  }
  await Bun.write(path, String(process.pid));
  return true;
}

async function releaseLockfile(path: string): Promise<void> {
  try {
    const fs = await import("node:fs/promises");
    await fs.unlink(path);
  } catch {
    /* already gone */
  }
}

export const _fileOrganizerDaemonInternals = {
  clampInterval,
  isProcessAlive,
  acquireLockfile,
  releaseLockfile,
  atomicWrite,
};
