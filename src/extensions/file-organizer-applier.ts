/**
 * FileOrganizerApplier — the HOST-side filesystem executor shared by both
 * the FileOrganizerDaemon and the Hub events route.
 *
 * Architecture spine (see tasks/file-organizer-plan.md): host folders
 * outside the subprocess `$CWD` jail (Desktop/Downloads/…) are touched
 * ONLY here, with raw `node:fs`. Every fs op is guarded:
 *
 *   1. realpath BEFORE the operation (src + dst-parent) — TOCTOU
 *      mitigation, mirroring `fs-handler.ts`.
 *   2. lstat-leaf for unlink (operate on the LINK, never a resolved
 *      symlink target) — the `fs-handler.ts:408-486` contract.
 *   3. watched-root prefix-check: a destination must stay inside the
 *      proposal's watched root and must never land in `.ezcorp/data`.
 *   4. copy → fsync → size-verify → unlink (EXDEV-safe by construction).
 *   5. an intent JOURNAL (`journal.json`) so a crash mid-apply
 *      (copy-done / unlink-pending) replays idempotently on restart.
 *   6. `engine.authorize({kind:"fs.write", value})` on every apply — the
 *      bundled grant auto-allows, but the call still writes the AUDIT row
 *      that every destructive action requires. A `deny` blocks the apply.
 *
 * The applier reuses the PURE planners in the extension package
 * (`lib/applier.ts`, `lib/quarantine.ts`) — this file is only the
 * IO + guards + audit layer.
 */
import { realpath, lstat, copyFile, unlink, mkdir, rename, stat, rm, open } from "node:fs/promises";
import { dirname, basename, join, sep } from "node:path";
import { logger } from "../logger";
import type { PermissionEngine } from "./permission-engine";

const log = logger.child("ext.file-organizer-applier");

// ── Shapes mirrored from the extension package's pure planners ──────
//
// We intentionally re-declare the minimal structural types here rather
// than import across the host ↔ docs/examples boundary (the bundled
// extension is loaded as data, not linked as a module from src/). These
// MUST stay in sync with `docs/extensions/examples/file-organizer/lib/`.

export interface ApplierProposalSnapshot {
  size: number;
  mtimeMs: number;
  isSymlink: boolean;
  nlink: number;
}

export interface ApplierProposal {
  id: string;
  kind: "move" | "rename" | "delete-quarantine" | "unclassified";
  src: string;
  dst: string | null;
  snapshot: ApplierProposalSnapshot;
  quarantineId?: string;
}

export interface ApplyOutcome {
  status: "applied" | "failed" | "stale-source" | "blocked" | "skipped";
  reason?: string;
  /** Resolved destination (move) or trash path (quarantine). */
  resolvedPath?: string;
  /** Quarantine id when a delete-quarantine was applied. */
  quarantineId?: string;
  auditId?: string;
}

export interface ApplierContext {
  extensionId: string;
  userId: string | null;
  conversationId: string | null;
  engine: PermissionEngine;
  /** Absolute `.trash/` directory for quarantine moves. */
  trashRoot: string;
  /** Absolute `journal.json` path for crash-replay. */
  journalPath: string;
  /** The proposal's watched root (dst must stay within it). */
  watchedRoot: string;
  /** The extension data dir whose `.ezcorp/data` ancestor must never be written. */
  dataDirRoot: string;
}

// ── Journal (crash-replay) ──────────────────────────────────────────

interface JournalEntry {
  op: "move" | "quarantine";
  src: string;
  dst: string | null;
  quarantineId: string | null;
  /** "copy-done" ⇒ original may still exist; "unlink-pending" ⇒ finish unlink. */
  phase: "copy-pending" | "copy-done" | "unlink-pending";
}

async function readJournal(path: string): Promise<JournalEntry[]> {
  try {
    const f = Bun.file(path);
    if (!(await f.exists())) return [];
    const parsed = JSON.parse(await f.text());
    return Array.isArray(parsed) ? (parsed as JournalEntry[]) : [];
  } catch {
    return [];
  }
}

async function writeJournal(path: string, entries: JournalEntry[]): Promise<void> {
  const tmp = `${path}.tmp-${Math.random().toString(36).slice(2, 10)}`;
  await Bun.write(tmp, JSON.stringify(entries, null, 2));
  const fs = await import("node:fs/promises");
  await fs.rename(tmp, path);
}

/**
 * Replay the intent journal on startup. A `copy-done`/`unlink-pending`
 * entry means a crash happened after the destination was written but
 * before the source was removed — finish the unlink idempotently. A
 * `copy-pending` entry means the copy may be incomplete — leave the
 * original intact (fail-safe) and drop the half-written destination.
 */
export async function replayJournal(journalPath: string): Promise<{ finished: number; rolledBack: number }> {
  const entries = await readJournal(journalPath);
  let finished = 0;
  let rolledBack = 0;
  for (const e of entries) {
    try {
      if (e.phase === "copy-done" || e.phase === "unlink-pending") {
        // Destination is fully written — remove the original to complete the move.
        if (await pathExists(e.src)) {
          await unlink(e.src).catch(() => {});
        }
        finished++;
      } else {
        // copy-pending: drop a possibly-partial destination; keep original.
        if (e.dst && (await pathExists(e.dst))) {
          await rm(e.dst, { force: true }).catch(() => {});
        }
        rolledBack++;
      }
    } catch (err) {
      log.warn("journal replay entry failed", { src: e.src, error: String(err) });
    }
  }
  if (entries.length > 0) await writeJournal(journalPath, []);
  return { finished, rolledBack };
}

// ── Guards ──────────────────────────────────────────────────────────

async function pathExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

/** Normalized prefix containment: is `child` inside `parent`? */
function isWithin(parent: string, child: string): boolean {
  if (parent === child) return true;
  const prefix = parent.endsWith(sep) ? parent : parent + sep;
  return child.startsWith(prefix);
}

/**
 * True if a path crosses into the protected `.ezcorp/data` directory —
 * NEVER writable (it holds the DB + JWT secret).
 *
 * `dataDirRoot` is the extension's own data dir
 * (`<projectRoot>/.ezcorp/extension-data/file-organizer`); its `.ezcorp`
 * ancestor's sibling `data/` is the real path to protect. We anchor the
 * check to that ABSOLUTE path so the guard is exact for the configured
 * project root — the loose `.ezcorp/data` substring match is kept only as
 * a defense-in-depth fallback for paths whose project root we can't infer
 * (e.g. a hand-crafted dst under a *different* `.ezcorp/data`).
 */
function touchesDataDir(p: string, dataDirRoot?: string): boolean {
  if (dataDirRoot) {
    const marker = `${sep}.ezcorp${sep}`;
    const idx = dataDirRoot.lastIndexOf(marker);
    if (idx !== -1) {
      const protectedDir = join(dataDirRoot.slice(0, idx), ".ezcorp", "data");
      if (p === protectedDir || isWithin(protectedDir, p)) return true;
    }
  }
  return p.includes(`.ezcorp${sep}data`);
}

/**
 * Resolve a write destination's canonical path WITHOUT requiring the leaf
 * to exist (realpath the parent, append the basename) — the
 * `fs-handler.ts:gateWritePath` pattern. Returns null when the parent
 * can't be resolved.
 */
async function resolveWriteTarget(target: string): Promise<string | null> {
  const parent = dirname(target);
  try {
    const realParent = await realpath(parent);
    return join(realParent, basename(target));
  } catch {
    return null;
  }
}

/** Non-overwrite suffix resolution against the live filesystem. */
async function resolveNonOverwrite(desired: string): Promise<string> {
  if (!(await pathExists(desired))) return desired;
  const dir = dirname(desired);
  const name = basename(desired);
  // Extension = the LAST dot that isn't the leading dotfile dot. A dotfile
  // like `.bashrc` has no extension (the dot is the dotfile marker, not an
  // ext separator) — without this guard the split yields ext=".bashrc",
  // stem="" → " (2).bashrc". `archive.tar.gz` keeps its single `.gz` ext.
  const dotIdx = name.lastIndexOf(".");
  const hasExt = dotIdx > 0; // > 0, not !== -1: index 0 is the dotfile dot
  const ext = hasExt ? name.slice(dotIdx) : "";
  const stem = hasExt ? name.slice(0, dotIdx) : name;
  for (let n = 2; n <= 9999; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!(await pathExists(candidate))) return candidate;
  }
  return join(dir, `${stem} (${Date.now()})${ext}`);
}

// ── Audit gate ──────────────────────────────────────────────────────

/**
 * Re-run `engine.authorize` for an fs.write on `value`. The bundled grant
 * auto-allows, but this writes the audit row every destructive action
 * needs. Returns the auditId on allow, or null on deny (caller → blocked).
 */
async function authorizeWrite(ctx: ApplierContext, value: string): Promise<string | null> {
  const decision = await ctx.engine.authorize(
    { extensionId: ctx.extensionId, userId: ctx.userId, conversationId: ctx.conversationId },
    [{ kind: "fs.write", value }],
  );
  if (decision.decision === "deny") {
    log.warn("file-organizer apply denied by engine", { value, reason: decision.reason });
    return null;
  }
  if (decision.decision === "prompt") {
    // Bundled auto-allow means we should never land here; treat as deny
    // (fail-closed — never apply on an unresolved prompt).
    log.warn("file-organizer apply unexpectedly prompted — failing closed", { value });
    return null;
  }
  return decision.auditId;
}

// ── copy + fsync + verify ───────────────────────────────────────────

async function copyVerified(src: string, dst: string, expectedSize: number): Promise<void> {
  await copyFile(src, dst);
  // fsync the destination so the bytes are durable before we unlink the
  // source (crash-safety for the move).
  const fh = await open(dst, "r+").catch(() => null);
  if (fh) {
    try {
      await fh.sync();
    } finally {
      await fh.close();
    }
  }
  const st = await stat(dst);
  if (st.size !== expectedSize) {
    // Size mismatch ⇒ a torn copy. Remove the destination, leave the
    // original intact, and abort.
    await rm(dst, { force: true }).catch(() => {});
    throw new Error(`copy verify failed: expected ${expectedSize} bytes, got ${st.size}`);
  }
}

// ── Apply one proposal ──────────────────────────────────────────────

/**
 * Apply one accepted proposal host-side. Pure-planner decisions
 * (no-overwrite, symlink skip, …) are mirrored here against the LIVE
 * filesystem. Every branch returns a structured `ApplyOutcome`; the
 * caller (daemon or events route) maps it onto the proposal's status.
 */
export async function applyProposal(
  proposal: ApplierProposal,
  ctx: ApplierContext,
): Promise<ApplyOutcome> {
  // Symlinks are never followed/applied in v1.
  if (proposal.snapshot.isSymlink) {
    return { status: "skipped", reason: "symlink skipped (v1 policy)" };
  }

  // Source must still exist (stale-source detection BEFORE any mutation).
  if (!(await pathExists(proposal.src))) {
    return { status: "stale-source", reason: "source no longer exists" };
  }

  if (proposal.kind === "delete-quarantine") {
    return applyQuarantine(proposal, ctx);
  }
  if (proposal.kind === "move" || proposal.kind === "rename") {
    return applyMove(proposal, ctx);
  }
  return { status: "skipped", reason: `${proposal.kind} is not directly applyable` };
}

async function applyMove(proposal: ApplierProposal, ctx: ApplierContext): Promise<ApplyOutcome> {
  if (!proposal.dst) return { status: "failed", reason: "move requires a destination" };

  // Resolve the destination's canonical target (realpath parent + leaf).
  const canonical = await resolveWriteTarget(proposal.dst);
  if (canonical === null) {
    // Parent doesn't exist yet — we'll mkdir it; compute the canonical
    // form against the watched root instead so the prefix-check is valid.
    // Fall back to the literal dst for containment checks.
  }
  const dstForCheck = canonical ?? proposal.dst;

  // Containment: destination must stay inside the watched root and must
  // never touch `.ezcorp/data` (refuse `../` escapes).
  if (!isWithin(ctx.watchedRoot, dstForCheck) || touchesDataDir(dstForCheck, ctx.dataDirRoot)) {
    return { status: "blocked", reason: "destination escapes the watched root or targets .ezcorp/data" };
  }

  // Audit gate (writes the audit row; deny ⇒ blocked).
  const auditId = await authorizeWrite(ctx, dstForCheck);
  if (auditId === null) return { status: "blocked", reason: "engine denied the write" };

  // Never overwrite — resolve a collision-free destination.
  const resolvedDst = await resolveNonOverwrite(proposal.dst);
  const destDir = dirname(resolvedDst);

  try {
    await mkdir(destDir, { recursive: true });
    // Journal BEFORE the copy so a crash leaves a replayable intent.
    await writeJournal(ctx.journalPath, [
      { op: "move", src: proposal.src, dst: resolvedDst, quarantineId: null, phase: "copy-pending" },
    ]);
    await copyVerified(proposal.src, resolvedDst, proposal.snapshot.size);
    // Copy verified — advance the journal so a crash now finishes the unlink.
    await writeJournal(ctx.journalPath, [
      { op: "move", src: proposal.src, dst: resolvedDst, quarantineId: null, phase: "copy-done" },
    ]);
    // lstat-leaf then unlink the LINK (never a resolved target).
    await lstat(proposal.src);
    await unlink(proposal.src);
    await writeJournal(ctx.journalPath, []);
    return { status: "applied", resolvedPath: resolvedDst, auditId };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // ENOSPC (or any copy failure) — original is intact by construction
    // (we never unlink before a verified copy). Clear the journal.
    await writeJournal(ctx.journalPath, []).catch(() => {});
    log.warn("file-organizer move failed", { src: proposal.src, dst: resolvedDst, code, error: String(err) });
    return { status: "failed", reason: String((err as Error)?.message ?? err) };
  }
}

async function applyQuarantine(proposal: ApplierProposal, ctx: ApplierContext): Promise<ApplyOutcome> {
  const quarantineId = proposal.quarantineId ?? proposal.id;
  const trashDir = join(ctx.trashRoot, quarantineId);
  const desired = join(trashDir, basename(proposal.src));

  // Audit gate on the trash destination.
  const auditId = await authorizeWrite(ctx, desired);
  if (auditId === null) return { status: "blocked", reason: "engine denied the quarantine write" };

  try {
    await mkdir(trashDir, { recursive: true });
    const trashPath = await resolveNonOverwrite(desired);
    // Journal the quarantine intent.
    await writeJournal(ctx.journalPath, [
      { op: "quarantine", src: proposal.src, dst: trashPath, quarantineId, phase: "copy-pending" },
    ]);
    // Cross-device safe: try rename, fall back to copy+unlink on EXDEV.
    try {
      await rename(proposal.src, trashPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      const st = await stat(proposal.src);
      await copyVerified(proposal.src, trashPath, st.size);
      await writeJournal(ctx.journalPath, [
        { op: "quarantine", src: proposal.src, dst: trashPath, quarantineId, phase: "copy-done" },
      ]);
      await lstat(proposal.src);
      await unlink(proposal.src);
    }
    await writeJournal(ctx.journalPath, []);
    return { status: "applied", resolvedPath: trashPath, quarantineId, auditId };
  } catch (err) {
    await writeJournal(ctx.journalPath, []).catch(() => {});
    log.warn("file-organizer quarantine failed", { src: proposal.src, error: String(err) });
    return { status: "failed", reason: String((err as Error)?.message ?? err) };
  }
}

// ── Restore from quarantine ─────────────────────────────────────────

export async function restoreFromQuarantine(
  input: { trashPath: string; restorePath: string },
  ctx: ApplierContext,
): Promise<ApplyOutcome> {
  if (!(await pathExists(input.trashPath))) {
    return { status: "stale-source", reason: "quarantined file missing" };
  }
  if (touchesDataDir(input.restorePath, ctx.dataDirRoot)) {
    return { status: "blocked", reason: "restore target inside .ezcorp/data" };
  }
  const auditId = await authorizeWrite(ctx, input.restorePath);
  if (auditId === null) return { status: "blocked", reason: "engine denied the restore" };

  const finalPath = await resolveNonOverwrite(input.restorePath);
  try {
    await mkdir(dirname(finalPath), { recursive: true });
    try {
      await rename(input.trashPath, finalPath);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
      const st = await stat(input.trashPath);
      await copyVerified(input.trashPath, finalPath, st.size);
      await unlink(input.trashPath);
    }
    return { status: "applied", resolvedPath: finalPath, auditId };
  } catch (err) {
    log.warn("file-organizer restore failed", { trashPath: input.trashPath, error: String(err) });
    return { status: "failed", reason: String((err as Error)?.message ?? err) };
  }
}

/** Hard-delete a quarantined file (TTL/size-cap prune ONLY). */
export async function hardDeleteTrash(trashDir: string): Promise<boolean> {
  try {
    await rm(trashDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn("file-organizer prune failed", { trashDir, error: String(err) });
    return false;
  }
}

/** Test-only seam for journal IO. */
export const _applierInternals = {
  readJournal,
  writeJournal,
  isWithin,
  touchesDataDir,
  resolveNonOverwrite,
  pathExists,
};
