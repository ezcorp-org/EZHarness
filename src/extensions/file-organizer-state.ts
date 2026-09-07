/**
 * FileOrganizerState — host-side state helper for the Hub events route.
 *
 * The events route handles every Hub action that MUTATES file-organizer
 * state HOST-SIDE (architecture spine: Accept/Reject that touch host
 * folders run in the events route, not a subprocess action handler). This
 * module is the thin host wrapper around the extension's PURE lib
 * (proposals / config / quarantine planners) plus the shared
 * `file-organizer-applier`:
 *
 *   - atomic load/save of proposals.json / config.json / .trash/manifest.json
 *   - CAS-on-status apply/reject (double-accept is a no-op)
 *   - lookups BY ID (never trust caller-supplied paths)
 *   - config mutations (mode, presets, add/remove folder, ignore, rule)
 *   - quarantine restore / purge / empty via the applier
 *
 * Every mutating handler returns a structured result the route maps to a
 * cache-invalidation + JSON response.
 */
import { join } from "node:path";
import { logger } from "../logger";
import type { PermissionEngine } from "./permission-engine";
import {
  loadProposals,
  saveProposals,
  findProposal,
  replaceProposal,
  transition,
  addSuppressed,
  type Proposal,
  type ProposalsIO,
} from "../../docs/extensions/examples/file-organizer/lib/proposals";
import {
  validateConfig,
  addFolder,
  checkReachability,
  removeFolder,
  setFolderMode,
  toggleFolderPreset,
  setBacklogPolicy,
  addFolderIgnore,
  addFolderRule,
  type Config,
  type Mode,
  type BacklogPolicy,
} from "../../docs/extensions/examples/file-organizer/lib/config";
import { parseDsl } from "../../docs/extensions/examples/file-organizer/lib/rules";
import {
  emptyManifest,
  planRestore,
  removeEntry,
  selectPruneVictims,
  type QuarantineManifest,
} from "../../docs/extensions/examples/file-organizer/lib/quarantine";
import {
  applyProposal,
  restoreFromQuarantine,
  hardDeleteTrash,
  resolveNonOverwrite,
  type ApplierContext,
  type ApplierProposal,
} from "./file-organizer-applier";
import {
  canonicalFileOrganizerPath,
  type FileOrganizerEffect,
} from "./file-organizer-action-authority";

const log = logger.child("ext.file-organizer-state");

export interface StateDeps {
  dataDir: string;
  engine: PermissionEngine;
  extensionId: string;
  userId: string;
  /** Quarantine settings (ttl/cap) resolved by the caller. */
  settings: { quarantineTtlDays: number; quarantineCapGb: number };
  /** Sealed browser proof. Daemon and worker calls intentionally have none. */
  actionAuthority?: unknown;
  now?: () => number;
}

export interface HandlerResult {
  ok: boolean;
  /** Human-readable status for the "Last action" section. */
  message?: string;
  /** Whether anything changed (drives cache invalidation). */
  changed: boolean;
}

// ── Paths ───────────────────────────────────────────────────────────

function paths(dataDir: string) {
  return {
    proposals: join(dataDir, "proposals.json"),
    config: join(dataDir, "config.json"),
    trashRoot: join(dataDir, ".trash"),
    manifest: join(dataDir, ".trash", "manifest.json"),
    journal: join(dataDir, "journal.json"),
  };
}

async function atomicWrite(absPath: string, text: string): Promise<void> {
  const fs = await import("node:fs/promises");
  await fs.mkdir(join(absPath, ".."), { recursive: true }).catch(() => {});
  const tmp = `${absPath}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  await Bun.write(tmp, text);
  await fs.rename(tmp, absPath);
}

function proposalsIO(p: string): ProposalsIO {
  return {
    read: async () => {
      const f = Bun.file(p);
      return (await f.exists()) ? f.text() : null;
    },
    write: (text) => atomicWrite(p, text),
  };
}

async function readConfig(p: string): Promise<Config> {
  try {
    const f = Bun.file(p);
    if (!(await f.exists())) return validateConfig(null);
    return validateConfig(JSON.parse(await f.text()));
  } catch {
    return validateConfig(null);
  }
}

async function readManifest(p: string): Promise<QuarantineManifest> {
  try {
    const f = Bun.file(p);
    if (!(await f.exists())) return emptyManifest();
    const parsed = JSON.parse(await f.text());
    return parsed && Array.isArray(parsed.entries) ? (parsed as QuarantineManifest) : emptyManifest();
  } catch {
    return emptyManifest();
  }
}

// ── Applier context ─────────────────────────────────────────────────

function applierCtx(deps: StateDeps, watchedRoot: string, hostActionEffect?: FileOrganizerEffect): ApplierContext {
  const p = paths(deps.dataDir);
  return {
    extensionId: deps.extensionId,
    userId: deps.userId,
    conversationId: null,
    engine: deps.engine,
    trashRoot: p.trashRoot,
    journalPath: p.journal,
    watchedRoot,
    dataDirRoot: deps.dataDir,
    hostActionAuthority: hostActionEffect ? deps.actionAuthority : undefined,
    hostActionEffect,
  };
}

function toApplierProposal(p: Proposal): ApplierProposal {
  return {
    id: p.id,
    kind: p.kind,
    src: p.src,
    dst: p.dst,
    snapshot: { size: p.snapshot.size, mtimeMs: p.snapshot.mtimeMs, isSymlink: p.snapshot.isSymlink, nlink: p.snapshot.nlink },
    ...(p.quarantineId ? { quarantineId: p.quarantineId } : {}),
  };
}

/**
 * Resolve a proposal's watched root from config (for prefix-checking).
 * Returns null when the proposal's folder no longer exists — the caller
 * MUST refuse the apply (no root ⇒ no containment anchor ⇒ blocked).
 * Never falls back to "/" : `isWithin("/", child)` is always true, which
 * would silently defeat the watched-root prefix-check for an orphaned
 * proposal (generate under folder X → remove X → accept).
 */
function watchedRootFor(config: Config, p: Proposal): string | null {
  const folder = config.folders.find((f) => f.id === p.folderId);
  return folder?.path ?? null;
}

async function proposalEffect(action: string, proposal: Proposal, dataDir?: string): Promise<FileOrganizerEffect> {
  const paths = [proposal.src];
  if ((proposal.kind === "move" || proposal.kind === "rename") && proposal.dst) paths.push(await resolveNonOverwrite(proposal.dst));
  const privatePath = proposal.kind === "delete-quarantine" && dataDir
    ? await privateVirtualPath(dataDir, await resolveNonOverwrite(join(dataDir, ".trash", proposal.quarantineId ?? proposal.id, proposal.src.split("/").at(-1)!)))
    : undefined;
  return { action: `file-organizer:${action}`, subject: `${proposal.id}:${proposal.version}:${proposal.kind}`, paths, ...(privatePath ? { privatePath } : {}) };
}

async function privateVirtualPath(dataDir: string, physicalPath: string): Promise<string | null> {
  const [root, target] = await Promise.all([canonicalFileOrganizerPath(dataDir), canonicalFileOrganizerPath(physicalPath)]);
  if (root === null || target === null || (target !== root && !target.startsWith(`${root}/`))) return null;
  return target === root ? "/data" : `/data${target.slice(root.length)}`;
}

async function restoreEffect(action: string, entry: QuarantineManifest["entries"][number], dataDir: string): Promise<FileOrganizerEffect | null> {
  const privatePath = await privateVirtualPath(dataDir, entry.trashPath);
  if (privatePath === null) return null;
  return {
    action: `file-organizer:${action}`,
    subject: `quarantine:${entry.id}:${entry.trashPath}`,
    paths: [await resolveNonOverwrite(entry.originalPath)],
    privatePath,
  };
}

async function purgeEffect(action: string, entry: QuarantineManifest["entries"][number], dataDir: string): Promise<FileOrganizerEffect | null> {
  const privatePath = await privateVirtualPath(dataDir, join(dataDir, ".trash", entry.id));
  return privatePath === null ? null : {
    action: `file-organizer:${action}`,
    subject: `quarantine:${entry.id}:${entry.trashPath}`,
    paths: [],
    privatePath,
  };
}

/** Route-side preflight: load only host effects from canonical state. The
 * same state is loaded again immediately before consume, so edits after this
 * browser click make the sealed descriptor fail rather than widen its scope. */
export async function prepareFileOrganizerAction(
  deps: Pick<StateDeps, "dataDir" | "settings" | "now">,
  event: string,
  payload: Record<string, unknown> | undefined,
): Promise<FileOrganizerEffect | FileOrganizerEffect[] | null> {
  const p = paths(deps.dataDir);
  const id = typeof payload?.proposalId === "string" ? payload.proposalId : undefined;
  const quarantineId = typeof payload?.quarantineId === "string" ? payload.quarantineId : undefined;
  const canonical = async (effect: FileOrganizerEffect): Promise<FileOrganizerEffect | null> => {
    const paths = await Promise.all(effect.paths.map(canonicalFileOrganizerPath));
    const canonicalPaths = paths.filter((path): path is string => path !== null);
    return canonicalPaths.length !== paths.length ? null : { action: effect.action, subject: effect.subject, paths: canonicalPaths, ...(effect.privatePath ? { privatePath: effect.privatePath } : {}) };
  };
  const canonicalEffects = async (effects: readonly (FileOrganizerEffect | null)[]): Promise<FileOrganizerEffect[] | null> => {
    const canonicalized = await Promise.all(effects.map((effect) => effect === null ? null : canonical(effect)));
    const present = canonicalized.filter((effect): effect is FileOrganizerEffect => effect !== null);
    return present.length === canonicalized.length ? present : null;
  };
  if (event === "accept" && id) {
    const proposal = findProposal((await loadProposals(proposalsIO(p.proposals))).file, id);
    return proposal?.status === "pending" ? canonical(await proposalEffect(event, proposal, deps.dataDir)) : null;
  }
  if (event === "confirm-deletes") {
    const file = (await loadProposals(proposalsIO(p.proposals))).file;
    const proposals = file.proposals.filter((proposal) => proposal.status === "pending" && proposal.kind === "delete-quarantine");
    return canonicalEffects(await Promise.all(proposals.map((proposal) => proposalEffect(event, proposal, deps.dataDir))));
  }
  if (event === "restore" || event === "undo-batch") {
    const manifest = await readManifest(p.manifest);
    const all = payload?.all === true;
    const batchId = typeof payload?.batchId === "string" ? payload.batchId : undefined;
    const entries = event === "undo-batch" ? manifest.entries.filter((entry) => entry.batchId === batchId) : all ? manifest.entries : quarantineId ? manifest.entries.filter((entry) => entry.id === quarantineId) : [];
    return canonicalEffects(await Promise.all(entries.map((entry) => restoreEffect(event, entry, deps.dataDir))));
  }
  if (event === "purge" || event === "empty-quarantine" || event === "purge-expired") {
    const manifest = await readManifest(p.manifest);
    const entries = event === "purge"
      ? manifest.entries.filter((entry) => entry.id === quarantineId)
      : event === "purge-expired"
        ? selectPruneVictims(manifest, { now: now(deps), capBytes: deps.settings.quarantineCapGb > 0 ? deps.settings.quarantineCapGb * 1024 ** 3 : 0 }).map((id) => manifest.entries.find((entry) => entry.id === id)!).filter(Boolean)
        : manifest.entries;
    return canonicalEffects(await Promise.all(entries.map((entry) => purgeEffect(event, entry, deps.dataDir))));
  }
  // Config and view actions do not reach the host applier. Keep the route's
  // authenticated binding flow intact without minting a filesystem effect.
  return { action: `file-organizer:${event}`, subject: "non-filesystem", paths: [] };
}

// ── Proposal apply / reject ─────────────────────────────────────────

/**
 * Accept (apply) a single proposal BY ID. CAS on the proposal's version:
 * a stale double-accept is a no-op. Looks the proposal up by id — the
 * caller's payload paths are NEVER trusted.
 */
export async function acceptProposal(deps: StateDeps, proposalId: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  const proposal = findProposal(file, proposalId);
  if (!proposal) return { ok: false, message: "Proposal not found", changed: false };
  if (proposal.status !== "pending") return { ok: true, message: "Already resolved", changed: false }; // CAS no-op

  const config = await readConfig(p.config);
  const watchedRoot = watchedRootFor(config, proposal);
  if (watchedRoot === null) {
    // Orphaned proposal — its watched folder was removed. Refuse rather
    // than fall back to "/" (which would defeat the prefix-check). Record
    // the proposal as blocked so the row stops re-offering an apply.
    const blocked = applyOutcomeToProposal(proposal, { status: "blocked" }, deps);
    if (blocked) await saveProposals(io, replaceProposal(file, blocked));
    return { ok: false, message: "Blocked: watched folder removed", changed: true };
  }
  const ctx = applierCtx(deps, watchedRoot, await proposalEffect("accept", proposal, deps.dataDir));
  const outcome = await applyProposal(toApplierProposal(proposal), ctx);

  const next = applyOutcomeToProposal(proposal, outcome, deps);
  if (!next) return { ok: false, message: "Apply was a no-op", changed: false };
  const updatedFile = replaceProposal(file, next);

  // Record a quarantine manifest entry on a successful delete.
  if (outcome.status === "applied" && outcome.quarantineId) {
    await recordQuarantineEntry(deps, proposal, outcome.quarantineId, outcome.resolvedPath ?? "", null);
  }
  await saveProposals(io, updatedFile);
  return {
    ok: outcome.status === "applied",
    message: applyMessage(outcome.status, outcome.reason),
    changed: true,
  };
}

/** Reject a proposal BY ID + add it to the suppressed-set (TTL). CAS no-op
 *  on an already-resolved proposal. */
export async function rejectProposal(deps: StateDeps, proposalId: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  const proposal = findProposal(file, proposalId);
  if (!proposal) return { ok: false, message: "Proposal not found", changed: false };
  if (proposal.status !== "pending" && proposal.status !== "stale-source") {
    return { ok: true, message: "Already resolved", changed: false };
  }
  const rejected = transition(proposal, "rejected", { by: deps.userId, at: nowIso(deps) });
  if (!rejected) return { ok: false, message: "Could not reject", changed: false };
  const suppressed = addSuppressed(
    file.suppressed,
    { src: proposal.src, ruleId: proposal.ruleId, contentHash: proposal.snapshot.sha256 ?? null },
    nowIso(deps),
  );
  await saveProposals(io, { ...replaceProposal(file, rejected), suppressed });
  return { ok: true, message: "Rejected", changed: true };
}

/** Reject every pending proposal in a segment (or all). */
export async function rejectSegment(deps: StateDeps, segment: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  const kind = segmentKind(segment);
  let working = file;
  let count = 0;
  for (const proposal of file.proposals) {
    if (proposal.status !== "pending") continue;
    if (kind && proposal.kind !== kind) continue;
    const rejected = transition(proposal, "rejected", { by: deps.userId, at: nowIso(deps) });
    if (rejected) {
      working = {
        ...replaceProposal(working, rejected),
        suppressed: addSuppressed(working.suppressed, { src: proposal.src, ruleId: proposal.ruleId, contentHash: proposal.snapshot.sha256 ?? null }, nowIso(deps)),
      };
      count++;
    }
  }
  await saveProposals(io, working);
  return { ok: true, message: `Rejected ${count}`, changed: count > 0 };
}

/** Confirm + apply every pending delete-quarantine proposal as a batch. */
export async function confirmDeletes(deps: StateDeps): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  const config = await readConfig(p.config);
  let working = file;
  let applied = 0;
  const batchId = `batch-${cryptoId()}`;
  for (const proposal of file.proposals) {
    if (proposal.status !== "pending" || proposal.kind !== "delete-quarantine") continue;
    const watchedRoot = watchedRootFor(config, proposal);
    if (watchedRoot === null) {
      // Orphaned proposal (folder removed) — refuse, mark blocked, never
      // fall back to "/". Quarantine still needs a containment anchor.
      const blocked = applyOutcomeToProposal(proposal, { status: "blocked" }, deps, batchId);
      if (blocked) working = replaceProposal(working, blocked);
      continue;
    }
    const ctx = applierCtx(deps, watchedRoot, await proposalEffect("confirm-deletes", proposal, deps.dataDir));
    const outcome = await applyProposal(toApplierProposal(proposal), ctx);
    const next = applyOutcomeToProposal(proposal, outcome, deps, batchId);
    if (next) working = replaceProposal(working, next);
    if (outcome.status === "applied" && outcome.quarantineId) {
      applied++;
      await recordQuarantineEntry(deps, proposal, outcome.quarantineId, outcome.resolvedPath ?? "", batchId);
    }
  }
  await saveProposals(io, working);
  return { ok: true, message: `Quarantined ${applied}`, changed: applied > 0 };
}

/** Undo a fully-auto batch: restore every quarantined file in the batch. */
export async function undoBatch(deps: StateDeps, batchId: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const manifest = await readManifest(p.manifest);
  const config = await readConfig(p.config);
  const inBatch = manifest.entries.filter((e) => e.batchId === batchId);
  if (inBatch.length === 0) return { ok: true, message: "Nothing to undo", changed: false };
  let working = manifest;
  let restored = 0;
  for (const entry of inBatch) {
    const effect = await restoreEffect("undo-batch", entry, deps.dataDir);
    if (effect === null) continue;
    const ctx = applierCtx(deps, rootForRestore(config, entry.originalPath), effect);
    const outcome = await restoreFromQuarantine({ trashPath: entry.trashPath, restorePath: effect.paths[0]! }, ctx);
    if (outcome.status === "applied") {
      working = removeEntry(working, entry.id);
      restored++;
    }
  }
  await atomicWrite(p.manifest, JSON.stringify(working, null, 2));
  return { ok: true, message: `Restored ${restored}`, changed: restored > 0 };
}

/** Restore one quarantined file (or all) BY ID. */
export async function restore(deps: StateDeps, opts: { quarantineId?: string; all?: boolean }): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const manifest = await readManifest(p.manifest);
  const config = await readConfig(p.config);
  const ids = opts.all ? manifest.entries.map((e) => e.id) : opts.quarantineId ? [opts.quarantineId] : [];
  let working = manifest;
  let restored = 0;
  for (const id of ids) {
    const plan = planRestore(working, id, () => false);
    if (!plan) continue;
    const effect = await restoreEffect("restore", plan.entry, deps.dataDir);
    if (effect === null) continue;
    const ctx = applierCtx(deps, rootForRestore(config, plan.entry.originalPath), effect);
    const outcome = await restoreFromQuarantine({ trashPath: plan.entry.trashPath, restorePath: effect.paths[0]! }, ctx);
    if (outcome.status === "applied") {
      working = removeEntry(working, id);
      restored++;
    }
  }
  await atomicWrite(p.manifest, JSON.stringify(working, null, 2));
  return { ok: true, message: `Restored ${restored}`, changed: restored > 0 };
}

/** Hard-delete one quarantined entry BY ID (the explicit "delete permanently"). */
export async function purge(deps: StateDeps, quarantineId: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const manifest = await readManifest(p.manifest);
  const entry = manifest.entries.find((e) => e.id === quarantineId);
  if (!entry) return { ok: true, message: "Not found", changed: false };
  const effect = await purgeEffect("purge", entry, deps.dataDir);
  if (effect === null || !(await hardDeleteTrash(p.trashRoot, entry.id, applierCtx(deps, rootForRestore(await readConfig(p.config), entry.originalPath), effect)))) {
    return { ok: false, message: "Blocked: engine denied the private purge", changed: false };
  }
  await atomicWrite(p.manifest, JSON.stringify(removeEntry(manifest, quarantineId), null, 2));
  return { ok: true, message: "Deleted permanently", changed: true };
}

/** Empty the entire quarantine (hard-delete all). */
export async function emptyQuarantine(deps: StateDeps): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const manifest = await readManifest(p.manifest);
  const config = await readConfig(p.config);
  let working = manifest;
  let deleted = 0;
  for (const entry of manifest.entries) {
    const effect = await purgeEffect("empty-quarantine", entry, deps.dataDir);
    if (effect && await hardDeleteTrash(p.trashRoot, entry.id, applierCtx(deps, rootForRestore(config, entry.originalPath), effect))) {
      working = removeEntry(working, entry.id);
      deleted++;
    }
  }
  await atomicWrite(p.manifest, JSON.stringify(working, null, 2));
  return { ok: deleted === manifest.entries.length, message: `Quarantine emptied ${deleted}`, changed: deleted > 0 };
}

/** TTL/size-cap prune of expired quarantine entries. */
export async function purgeExpired(deps: StateDeps): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const manifest = await readManifest(p.manifest);
  const capBytes = deps.settings.quarantineCapGb > 0 ? deps.settings.quarantineCapGb * 1024 ** 3 : 0;
  const victims = selectPruneVictims(manifest, { now: now(deps), capBytes });
  const config = await readConfig(p.config);
  let working = manifest;
  let deleted = 0;
  for (const id of victims) {
    const entry = working.entries.find((candidate) => candidate.id === id);
    if (!entry) continue;
    const effect = await purgeEffect("purge-expired", entry, deps.dataDir);
    if (effect && await hardDeleteTrash(p.trashRoot, id, applierCtx(deps, rootForRestore(config, entry.originalPath), effect))) {
      working = removeEntry(working, id);
      deleted++;
    }
  }
  await atomicWrite(p.manifest, JSON.stringify(working, null, 2));
  return { ok: deleted === victims.length, message: `Purged ${deleted}`, changed: deleted > 0 };
}

/**
 * Reset every `failed` proposal back to `pending` so the next accept (or
 * an auto-mode tick) re-applies it. A failed apply is usually transient
 * (ENOSPC freed, mount reconnected) — the Hub's "Retry failed" button
 * must actually move the rows, not just refresh the cache.
 */
export async function retryFailed(deps: StateDeps): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  let working = file;
  let count = 0;
  for (const proposal of file.proposals) {
    if (proposal.status !== "failed") continue;
    const reset = transition(proposal, "pending");
    if (reset) {
      working = replaceProposal(working, reset);
      count++;
    }
  }
  if (count > 0) await saveProposals(io, working);
  return { ok: true, message: `Retrying ${count}`, changed: count > 0 };
}

/** Dismiss a stale-source proposal (reject without suppression). */
export async function dismissStale(deps: StateDeps, proposalId: string): Promise<HandlerResult> {
  const p = paths(deps.dataDir);
  const io = proposalsIO(p.proposals);
  const { file } = await loadProposals(io);
  const proposal = findProposal(file, proposalId);
  if (proposal?.status !== "stale-source") return { ok: true, message: "Nothing to dismiss", changed: false };
  const rejected = transition(proposal, "rejected", { by: deps.userId, at: nowIso(deps) });
  if (!rejected) return { ok: false, message: "Could not dismiss", changed: false };
  await saveProposals(io, replaceProposal(file, rejected));
  return { ok: true, message: "Dismissed", changed: true };
}

// ── Config mutations ────────────────────────────────────────────────

async function writeConfig(deps: StateDeps, config: Config): Promise<void> {
  await atomicWrite(paths(deps.dataDir).config, JSON.stringify(config, null, 2));
}

export async function setMode(deps: StateDeps, folderId: string, mode: Mode): Promise<HandlerResult> {
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, setFolderMode(config, folderId, mode));
  return { ok: true, message: `Mode set to ${mode}`, changed: true };
}

export async function togglePreset(deps: StateDeps, folderId: string, preset: string): Promise<HandlerResult> {
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, toggleFolderPreset(config, folderId, preset));
  return { ok: true, message: `Toggled ${preset}`, changed: true };
}

export async function addWatchedFolder(deps: StateDeps, input: { path: string; backlogPolicy?: BacklogPolicy }): Promise<HandlerResult> {
  // Container-visibility exists-probe FIRST: an unreachable host folder
  // (not bind-mounted into the container) gets the "mount it + restart"
  // message instead of silently watching nothing. Runs host-side, so the
  // probe reflects what the EZCorp process can actually see.
  const { existsSync } = await import("node:fs");
  const reach = checkReachability(input.path, (p) => existsSync(p));
  if (!reach.ok) return { ok: false, message: reach.error, changed: false };

  const config = await readConfig(paths(deps.dataDir).config);
  const result = addFolder(config, {
    path: input.path,
    backlogPolicy: input.backlogPolicy ?? "new-only",
    now: now(deps),
    idGen: cryptoId,
  });
  if (!result.ok) return { ok: false, message: result.error, changed: false };
  await writeConfig(deps, result.config);
  return { ok: true, message: "Folder added", changed: true };
}

export async function setFolderBacklog(deps: StateDeps, folderId: string, policy: BacklogPolicy): Promise<HandlerResult> {
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, setBacklogPolicy(config, folderId, policy, now(deps)));
  return { ok: true, message: `Backlog: ${policy}`, changed: true };
}

export async function removeWatchedFolder(deps: StateDeps, folderId: string): Promise<HandlerResult> {
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, removeFolder(config, folderId));
  return { ok: true, message: "Folder removed", changed: true };
}

export async function addIgnore(deps: StateDeps, folderId: string, entry: string): Promise<HandlerResult> {
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, addFolderIgnore(config, folderId, entry));
  return { ok: true, message: "Ignore added", changed: true };
}

export async function addRule(deps: StateDeps, folderId: string, ruleLine: string): Promise<HandlerResult> {
  const parsed = parseDsl(ruleLine);
  if (!parsed.ok) return { ok: false, message: parsed.error, changed: false };
  const config = await readConfig(paths(deps.dataDir).config);
  await writeConfig(deps, addFolderRule(config, folderId, parsed.rule));
  return { ok: true, message: "Rule added", changed: true };
}

// ── Helpers ─────────────────────────────────────────────────────────

function applyOutcomeToProposal(
  p: Proposal,
  outcome: { status: string; quarantineId?: string },
  deps: StateDeps,
  batchId?: string,
): Proposal | null {
  switch (outcome.status) {
    case "applied":
      return transition(p, "applied", { by: deps.userId, at: nowIso(deps), ...(batchId ? { batchId } : {}), ...(outcome.quarantineId ? { quarantineId: outcome.quarantineId } : {}) });
    case "failed":
      return transition(p, "failed");
    case "stale-source":
      return transition(p, "stale-source");
    case "blocked":
      return transition(p, "blocked");
    default:
      return null;
  }
}

function applyMessage(status: string, reason?: string): string {
  switch (status) {
    case "applied": return "Applied";
    case "blocked": return `Blocked: ${reason ?? "denied"}`;
    case "failed": return `Failed: ${reason ?? "error"}`;
    case "stale-source": return "Source gone";
    default: return status;
  }
}

function segmentKind(segment: string): Proposal["kind"] | null {
  switch (segment) {
    case "moves": return "move";
    case "renames": return "rename";
    case "deletes": return "delete-quarantine";
    case "unclassified": return "unclassified";
    default: return null;
  }
}

function rootForRestore(config: Config, originalPath: string): string {
  // The restore target's watched root — the folder whose path is a prefix.
  for (const f of config.folders) {
    if (originalPath === f.path || originalPath.startsWith(f.path + "/")) return f.path;
  }
  // Fall back to the original file's parent (or `/`) so the prefix-check
  // passes for a folder that's since been removed (quarantine outlives the
  // folder). This `/`/parent fallback is DELIBERATE: restore returns the
  // file to its recorded absolute path and is still guarded by the
  // applier's protected-dir deny (and its trash-root containment on the
  // quarantined source), so a missing watched root must not block recovery.
  // Distinct from the `watchedRootFor` → `blocked` policy on accept /
  // confirm-deletes, where a missing root SHOULD hold the destructive op.
  return originalPath.slice(0, originalPath.lastIndexOf("/")) || "/";
}

async function recordQuarantineEntry(
  deps: StateDeps,
  p: Proposal,
  quarantineId: string,
  trashPath: string,
  batchId: string | null,
): Promise<void> {
  const paths_ = paths(deps.dataDir);
  const manifest = await readManifest(paths_.manifest);
  const ttlMs = deps.settings.quarantineTtlDays * 24 * 60 * 60 * 1000;
  const entry = {
    id: quarantineId,
    originalPath: p.src,
    trashPath,
    proposalId: p.id,
    reason: p.reason,
    deletedAt: nowIso(deps),
    batchId,
    size: p.snapshot.size,
    expiresAtMs: now(deps) + ttlMs,
  };
  await atomicWrite(paths_.manifest, JSON.stringify({ ...manifest, entries: [...manifest.entries, entry] }, null, 2));
}

function now(deps: Pick<StateDeps, "now">): number {
  return (deps.now ?? Date.now)();
}
function nowIso(deps: StateDeps): string {
  return new Date(now(deps)).toISOString();
}
function cryptoId(): string {
  return crypto.randomUUID();
}

/** Test seam. */
export const _stateInternals = {
  paths,
  readConfig,
  readManifest,
  segmentKind,
  rootForRestore,
  atomicWrite,
  applyMessage,
};

void log;
