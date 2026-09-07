/**
 * FileOrganizerApplier — the HOST-side filesystem executor shared by both
 * the FileOrganizerDaemon and the Hub events route.
 *
 * Architecture spine (see tasks/file-organizer-plan.md): host folders
 * outside the subprocess `$CWD` jail (Desktop/Downloads/…) are touched
 * ONLY here, with raw `node:fs`. Every fs op is guarded:
 *
 *   1. realpath BEFORE the operation (src-parent + dst-parent) — TOCTOU
 *      mitigation, mirroring `fs-handler.ts`.
 *   2. lstat-leaf for unlink (operate on the LINK, never a resolved
 *      symlink target) — the `fs-handler.ts:408-486` contract. The LIVE
 *      lstat is also what decides "is this a symlink?"; the proposal's
 *      `snapshot.isSymlink` is caller-supplied and is never trusted.
 *   3. watched-root prefix-check on BOTH ends: a proposal's SOURCE and
 *      its destination must stay inside the (realpath'd) watched root,
 *      and neither may touch a protected platform dir (`.ezcorp/data`,
 *      the PGlite datadir, its backups sibling). Every containment
 *      anchor is realpath'd first and a root that won't resolve refuses
 *      the operation (fail-closed) rather than falling back to a raw
 *      prefix compare a symlink could defeat.
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
import { realpathInsideRoot } from "../runtime/fs/scan-fs";
import type { PermissionEngine } from "./permission-engine";
import type { FileOrganizerEffect } from "./file-organizer-action-authority";

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
  /** Sealed browser proof consumed by PermissionEngine against this effect. */
  hostActionAuthority?: unknown;
  hostActionEffect?: FileOrganizerEffect;
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

/** Containment anchors for a journal replay (see {@link replayJournal}). */
export interface ReplayAnchors extends Pick<ApplierContext, "engine" | "extensionId" | "userId" | "conversationId"> {
  /**
   * ALREADY realpath'd roots an entry may touch: the configured watched
   * folders plus the trash root. An entry outside every one of them is
   * refused. An EMPTY list refuses everything — a journal we cannot
   * anchor is a journal we do not replay.
   */
  roots: string[];
  /** The extension data dir, for the protected-dir check. */
  dataDirRoot: string;
}

/**
 * Is one journal path safe to act on? The journal is a plain JSON file
 * under the extension data dir, so its contents are only as trustworthy
 * as that file — and this runs at server BOOT, before any UI. Every
 * path is canonicalized (parent-realpath'd, leaf preserved, exactly as
 * the apply sites that wrote it) and must land inside an anchor and
 * outside every protected platform dir.
 */
async function replayPathAllowed(p: string, anchors: ReplayAnchors): Promise<boolean> {
  const canonical = await resolveCreateTarget(p);
  if (!anchors.roots.some((root) => isWithin(root, canonical))) return false;
  return !(await touchesProtectedDir(canonical, anchors.dataDirRoot));
}

/**
 * Replay the intent journal on startup. A `copy-done`/`unlink-pending`
 * entry means a crash happened after the destination was written but
 * before the source was removed — finish the unlink idempotently. A
 * `copy-pending` entry means the copy may be incomplete — leave the
 * original intact (fail-safe) and drop the half-written destination.
 *
 * Every entry is containment-checked against `anchors` FIRST: replay is
 * a boot-time unlink/rm driven by an on-disk file, so an entry naming a
 * path outside the watched roots + trash root is refused and dropped
 * rather than executed. Each mutation then re-runs the same PermissionEngine
 * fs.write authorization as a normal apply. Deny, prompt, or engine failure
 * leaves the file unchanged. The journal is still cleared afterwards (a
 * refused entry must not be retried on the next boot).
 */
export async function replayJournal(
  journalPath: string,
  anchors: ReplayAnchors,
): Promise<{ finished: number; rolledBack: number; refused: number }> {
  const entries = await readJournal(journalPath);
  let finished = 0;
  let rolledBack = 0;
  let refused = 0;
  for (const e of entries) {
    try {
      if (!(await replayPathAllowed(e.src, anchors))) {
        log.warn("journal replay entry refused (source outside every anchor)", { src: e.src });
        refused++;
        continue;
      }
      if (e.phase === "copy-done" || e.phase === "unlink-pending") {
        // Destination is fully written — remove the original to complete the move.
        if (await pathExists(e.src)) {
          if ((await authorizeWrite(anchors, e.src)) === null) {
            refused++;
            continue;
          }
          await unlink(e.src).catch(() => {});
        }
        finished++;
      } else if (e.dst !== null && !(await replayPathAllowed(e.dst, anchors))) {
        log.warn("journal replay entry refused (destination outside every anchor)", { dst: e.dst });
        refused++;
      } else {
        // copy-pending: drop a possibly-partial destination; keep original.
        if (e.dst && (await pathExists(e.dst))) {
          if ((await authorizeWrite(anchors, e.dst)) === null) {
            refused++;
            continue;
          }
          await rm(e.dst, { force: true }).catch(() => {});
        }
        rolledBack++;
      }
    } catch (err) {
      log.warn("journal replay entry failed", { src: e.src, error: String(err) });
      refused++;
    }
  }
  if (entries.length > 0) await writeJournal(journalPath, []);
  return { finished, rolledBack, refused };
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
 * A quarantine id is a single path SEGMENT that gets joined onto the
 * trash root to build a directory the pruner later removes RECURSIVELY.
 * Everything that reaches here is host-generated — `crypto.randomUUID()`
 * (daemon + state), `agent-<epochMs>-<n>`, `f-<n>` — so a strict charset
 * costs nothing and refuses `../`, absolute paths and nested segments
 * before they can be written into `.trash/manifest.json`, which is the
 * input the pruner reads back.
 */
const QUARANTINE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function isQuarantineId(id: unknown): id is string {
  return typeof id === "string" && QUARANTINE_ID_RE.test(id) && !id.includes("..");
}

/**
 * realpath a containment ANCHOR (watched root, trash root). Fail-closed:
 * an anchor that won't resolve returns null and the caller refuses the
 * operation. Anchoring on the RAW path instead would silently mis-answer
 * in both directions — a symlinked watched root makes every legitimate
 * in-root path look like an escape, and a canonical child compared
 * against a raw parent never matches.
 */
async function canonicalRoot(root: string): Promise<string | null> {
  try {
    return await realpath(root);
  } catch {
    return null;
  }
}

type PrivateDirectory =
  | { status: "ready"; path: string }
  | { status: "blocked" | "failed"; reason: string };

/**
 * Plan the one private directory quarantine may create. `trashRoot` is part
 * of the host context, but it must still resolve to exactly the `.trash`
 * child of this extension's canonical data root before we make a directory.
 */
async function plannedPrivateTrashRoot(ctx: ApplierContext): Promise<PrivateDirectory> {
  const dataRoot = await canonicalRoot(ctx.dataDirRoot);
  if (dataRoot === null) return { status: "failed", reason: "extension data root unresolvable" };

  const expected = join(dataRoot, ".trash");
  const requested = await resolveCreateTarget(ctx.trashRoot);
  if (requested !== expected) {
    return { status: "blocked", reason: "trash root is outside the extension private data directory" };
  }
  return { status: "ready", path: expected };
}

/** Create then canonicalize a known private directory. Symlinks and files
 * fail closed, including a path planted between planning and creation. */
async function materializePrivateDirectory(path: string): Promise<PrivateDirectory> {
  try {
    await mkdir(path, { recursive: true });
    const entry = await lstat(path);
    if (!entry.isDirectory()) return { status: "blocked", reason: "private quarantine path is not a directory" };
    const canonical = await realpath(path);
    if (canonical !== path) return { status: "blocked", reason: "private quarantine path resolves outside its anchor" };
    return { status: "ready", path: canonical };
  } catch {
    return { status: "failed", reason: "private quarantine directory could not be created or verified" };
  }
}

/**
 * True if a path crosses into a protected platform directory — never
 * readable-by-move and never writable (they hold the DB, the JWT secret
 * and the pre-boot snapshots). Three layers; ANY of them is decisive:
 *
 *   1. anchored — `dataDirRoot` is the extension's own data dir
 *      (`<projectRoot>/.ezcorp/extension-data/file-organizer`), so its
 *      `.ezcorp` ancestor's sibling `data/` is the exact dir to protect
 *      for the configured project root.
 *   2. a `.ezcorp/data` SEGMENT anywhere in the path — defense-in-depth
 *      for a path whose project root we can't infer (a hand-crafted
 *      target under a *different* project's `.ezcorp/data`). Segment-
 *      bounded on purpose: the old substring form also matched
 *      `/x/.ezcorp/data-export`, which is not a protected dir.
 *   3. `isReservedSensitivePath()` — the platform's canonical answer,
 *      and the ONLY one that covers `EZCORP_DB_PATH`. The shipped
 *      container sets `EZCORP_DB_PATH=/app/data/ezcorp` (`Dockerfile:253`),
 *      which has no `.ezcorp/data` segment at all, so layers 1 and 2
 *      both miss the real database directory there.
 *
 * `permissions.ts` is imported LAZILY: its module graph reaches the DB
 * (`db/queries/settings`, `db/connection`) and is ~40x this module's own
 * load cost, so a static import would make this leaf module pull the
 * database in at boot and risk a cycle through `bundled.ts`.
 */
async function touchesProtectedDir(p: string, dataDirRoot?: string): Promise<boolean> {
  if (dataDirRoot) {
    const marker = `${sep}.ezcorp${sep}`;
    const idx = dataDirRoot.lastIndexOf(marker);
    if (idx !== -1) {
      const protectedDir = join(dataDirRoot.slice(0, idx), ".ezcorp", "data");
      if (p === protectedDir || isWithin(protectedDir, p)) return true;
    }
  }
  const dataSegment = `${sep}.ezcorp${sep}data`;
  if (p.includes(`${dataSegment}${sep}`) || p.endsWith(dataSegment)) return true;
  const { isReservedSensitivePath } = await import("./permissions");
  return isReservedSensitivePath(p);
}

/**
 * Canonicalize a path whose LEAF must already exist: realpath the parent
 * and re-append the basename — the `fs-handler.ts:gateWritePath` pattern.
 * Leaf-preserving by construction, which is the whole contract of this
 * file: we operate on the LINK, never on a resolved symlink target, so
 * the leaf is never fed to `realpath`. Returns null when the parent
 * can't be resolved (⇒ nothing can exist at `target`).
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

/**
 * Canonicalize a path we may be about to CREATE, whose parent chain may
 * not exist yet (`mkdir -p` runs later): realpath the lowest existing
 * ancestor and re-append the unresolved tail, then re-append the leaf.
 *
 * Reuses the platform's `resolveGrantPrefixCanonical` — the same
 * resolver the host fs gate compares grants with, so a destination and a
 * grant prefix meet on identical canonical footing. A component that
 * does not exist cannot contain a symlink, so resolving only the
 * existing ancestor adds no escape surface, and `join` collapses any
 * `..` left in the tail.
 *
 * Non-nullable on purpose: the underlying resolver only yields null when
 * even `realpath("/")` fails, and there is nothing safer to do in that
 * case than fall back to the literal path (which then still has to pass
 * the containment compare).
 */
async function resolveCreateTarget(target: string): Promise<string> {
  const { resolveGrantPrefixCanonical } = await import("./permissions");
  const realParent = await resolveGrantPrefixCanonical(dirname(target));
  return realParent === null ? target : join(realParent, basename(target));
}

/** Non-overwrite suffix resolution against the live filesystem. */
export async function resolveNonOverwrite(desired: string): Promise<string> {
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
async function authorizeWrite(
  ctx: Pick<ApplierContext, "engine" | "extensionId" | "userId" | "conversationId" | "dataDirRoot" | "hostActionAuthority" | "hostActionEffect">,
  value: string,
): Promise<string | null> {
  const dataRoot = await canonicalRoot(ctx.dataDirRoot);
  if (dataRoot !== null && isWithin(dataRoot, value)) {
    // The V4 grant is deliberately virtual (`/data`), while this host applier
    // uses the physical extension-data directory. Only this known private
    // root is translated; public project files never acquire a fake `/data`
    // grant through this path.
    const rel = value === dataRoot ? "" : value.slice(dataRoot.length + 1);
    value = rel ? `/data/${rel}` : "/data";
  }
  const decision = await ctx.engine.authorize(
    {
      extensionId: ctx.extensionId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
      ...(ctx.hostActionAuthority && ctx.hostActionEffect ? { fileOrganizerActionAuthority: ctx.hostActionAuthority, fileOrganizerEffect: ctx.hostActionEffect } : {}),
    },
    [{ kind: "fs.write", value }],
  );
  if (decision.decision === "deny") {
    log.warn("file-organizer filesystem mutation denied by engine", { value, reason: decision.reason });
    return null;
  }
  if (decision.decision === "prompt") {
    // Bundled auto-allow means we should never land here; treat as deny
    // (fail-closed — never apply on an unresolved prompt).
    log.warn("file-organizer filesystem mutation unexpectedly prompted — failing closed", { value });
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
  // ── Source gate ───────────────────────────────────────────────────
  //
  // The SOURCE is as attacker-influenced as the destination: every kind
  // reads it (copy) and then unlinks it, so an uncontained `src` is an
  // arbitrary host-file read AND delete — a `delete-quarantine` naming
  // `~/.ssh/id_ed25519` would move that file into the extension's own
  // readable `.trash/`. Gate it once, here, for every kind.
  const realWatched = await canonicalRoot(ctx.watchedRoot);
  if (realWatched === null) {
    return { status: "blocked", reason: "no containment anchor (watched root unresolvable)" };
  }
  const srcCanon = await resolveWriteTarget(proposal.src);
  if (srcCanon === null) {
    return { status: "stale-source", reason: "source no longer exists" };
  }
  if (!isWithin(realWatched, srcCanon)) {
    return { status: "blocked", reason: "source escapes the watched root" };
  }
  if (await touchesProtectedDir(srcCanon, ctx.dataDirRoot)) {
    return { status: "blocked", reason: "source targets a protected platform dir" };
  }

  // Source must still exist (stale-source detection BEFORE any mutation),
  // and symlinks are never followed/applied in v1. Both answers come from
  // ONE live lstat: `snapshot.isSymlink` is caller-supplied, so trusting
  // it let a caller declare `false` on a real link and have the applier
  // copy the link's TARGET out.
  const st = await lstat(proposal.src).catch(() => null);
  if (st === null) {
    return { status: "stale-source", reason: "source no longer exists" };
  }
  if (st.isSymbolicLink()) {
    return { status: "skipped", reason: "symlink skipped (v1 policy)" };
  }

  // Quarantine writes privately under `/data`; consume the public source
  // authority first so its later unlink never relies on the private grant.
  if (proposal.kind === "delete-quarantine") {
    const auditId = await authorizeWrite(ctx, srcCanon);
    if (auditId === null) return { status: "blocked", reason: "engine denied the source write" };
  }

  if (proposal.kind === "delete-quarantine") {
    return applyQuarantine(proposal, ctx);
  }
  if (proposal.kind === "move" || proposal.kind === "rename") {
    return applyMove(proposal, ctx, realWatched);
  }
  return { status: "skipped", reason: `${proposal.kind} is not directly applyable` };
}

async function applyMove(
  proposal: ApplierProposal,
  ctx: ApplierContext,
  realWatched: string,
): Promise<ApplyOutcome> {
  if (!proposal.dst) return { status: "failed", reason: "move requires a destination" };

  // Resolve the destination's canonical target. The parent chain may not
  // exist yet (we `mkdir -p` below), so this resolves the lowest existing
  // ancestor and re-appends the tail rather than giving up.
  const dstForCheck = await resolveCreateTarget(proposal.dst);

  // Containment: destination must stay inside the REALPATH'd watched root
  // and must never touch a protected platform dir (refuse `../` escapes).
  if (!isWithin(realWatched, dstForCheck) || (await touchesProtectedDir(dstForCheck, ctx.dataDirRoot))) {
    return { status: "blocked", reason: "destination escapes the watched root or targets a protected platform dir" };
  }

  // A sealed host action binds the exact destination shown to the user. Do
  // not silently redirect it to a collision suffix after admission.
  const sealedDestination = ctx.hostActionEffect?.paths.at(-1);
  if (ctx.hostActionAuthority && (!sealedDestination || await pathExists(sealedDestination))) {
    return { status: "blocked", reason: "destination changed after approval" };
  }
  const resolvedDst = ctx.hostActionAuthority
    ? sealedDestination!
    : await resolveNonOverwrite(proposal.dst);
  // Authorize the exact collision-resolved target, never the pre-plan name.
  const auditId = await authorizeWrite(ctx, await resolveCreateTarget(resolvedDst));
  if (auditId === null) return { status: "blocked", reason: "engine denied the write" };
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
  // Validate BEFORE the id can reach `.trash/manifest.json`: the manifest
  // is what the pruner reads back, so an escaping id recorded here is a
  // recursive delete waiting for the next TTL sweep.
  if (!isQuarantineId(quarantineId)) {
    return { status: "blocked", reason: "invalid quarantine id" };
  }

  const plannedTrash = await plannedPrivateTrashRoot(ctx);
  if (plannedTrash.status !== "ready") return plannedTrash;
  // Authorize the exact initial target BEFORE creating even the private
  // directory, so a denied operation leaves no new filesystem state.
  const desired = join(plannedTrash.path, quarantineId, basename(proposal.src));
  const sealedPrivate = ctx.hostActionEffect?.privatePath;
  let plannedTarget = desired;
  if (ctx.hostActionAuthority) {
    // The route planned the collision suffix before it issued the proof.
    // Convert only that exact virtual companion back into our trusted own
    // data directory; never accept a broad `/data` prefix as host authority.
    if (!sealedPrivate?.startsWith("/data/")) {
      return { status: "blocked", reason: "missing sealed quarantine target" };
    }
    const relative = sealedPrivate.slice("/data/".length);
    plannedTarget = join(await canonicalRoot(ctx.dataDirRoot) ?? ctx.dataDirRoot, relative);
    const quarantineRoot = join(plannedTrash.path, quarantineId);
    if (!isWithin(quarantineRoot, plannedTarget) || await pathExists(plannedTarget)) {
      return { status: "blocked", reason: "quarantine destination changed after approval" };
    }
  }

  // Audit gate on the trash destination.
  const auditId = await authorizeWrite(ctx, plannedTarget);
  if (auditId === null) return { status: "blocked", reason: "engine denied the quarantine write" };

  const realTrash = await materializePrivateDirectory(plannedTrash.path);
  if (realTrash.status !== "ready") return realTrash;
  const plannedTrashDir = join(realTrash.path, quarantineId);
  const trashDir = await materializePrivateDirectory(plannedTrashDir);
  if (trashDir.status !== "ready") return trashDir;

  try {
    const trashPath = ctx.hostActionAuthority
      ? plannedTarget
      : await resolveNonOverwrite(join(trashDir.path, basename(proposal.src)));
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
  // The trash path comes from `.trash/manifest.json`, i.e. from a file —
  // contain it against the realpath'd trash root before it reaches
  // `rename`/`unlink`.
  const realTrash = await canonicalRoot(ctx.trashRoot);
  if (realTrash === null) {
    return { status: "blocked", reason: "no containment anchor (trash root unresolvable)" };
  }
  const trashCanon = await resolveWriteTarget(input.trashPath);
  if (trashCanon === null || !(await pathExists(input.trashPath))) {
    return { status: "stale-source", reason: "quarantined file missing" };
  }
  if (!isWithin(realTrash, trashCanon)) {
    return { status: "blocked", reason: "quarantine source escapes the trash root" };
  }
  // NOTE: the restore TARGET deliberately gets no watched-root check —
  // `rootForRestore` (file-organizer-state.ts) falls back to the original
  // file's parent so quarantine outlives the removal of its watched
  // folder. The protected-dir deny is what guards it.
  const sealedDestination = ctx.hostActionEffect?.paths.at(-1);
  const finalPath = ctx.hostActionAuthority ? sealedDestination : await resolveNonOverwrite(input.restorePath);
  if (!finalPath) return { status: "blocked", reason: "missing sealed restore target" };
  const restoreCanon = await resolveCreateTarget(finalPath);
  if (await touchesProtectedDir(restoreCanon, ctx.dataDirRoot)) {
    return { status: "blocked", reason: "restore target inside a protected platform dir" };
  }
  if (ctx.hostActionAuthority && await pathExists(finalPath)) {
    return { status: "blocked", reason: "restore destination changed after approval" };
  }
  const auditId = await authorizeWrite(ctx, restoreCanon);
  if (auditId === null) return { status: "blocked", reason: "engine denied the restore" };
  // Removing the quarantined source is a second private mutation. Its
  // exact virtual companion is sealed beside the public destination.
  const privateAuditId = await authorizeWrite(ctx, input.trashPath);
  if (privateAuditId === null) return { status: "blocked", reason: "engine denied the private restore source" };
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

/**
 * Hard-delete one quarantined entry (TTL/size-cap prune ONLY).
 *
 * Takes the trash ROOT and the id separately — never a pre-joined path —
 * so no caller can hand this a traversal it built itself. This is the
 * one recursive `rm` in the file and its id arrives from
 * `.trash/manifest.json`, so it is guarded three ways: charset (a single
 * safe segment), an lstat symlink branch (a link under `.trash/` is
 * never something the applier created — unlink the LINK, never recurse
 * through it), and a realpath containment re-check that closes the TOCTOU
 * window between the lstat and the `rm`.
 *
 * Returns true when the entry is gone, INCLUDING when it was already
 * absent — prune is idempotent and the manifest row should still drop.
 */
export async function hardDeleteTrash(trashRoot: string, quarantineId: string, ctx?: ApplierContext): Promise<boolean> {
  if (!isQuarantineId(quarantineId)) {
    log.warn("file-organizer prune refused: invalid quarantine id", { quarantineId: String(quarantineId) });
    return false;
  }
  const realRoot = await canonicalRoot(trashRoot);
  if (realRoot === null) {
    log.warn("file-organizer prune refused: trash root unresolvable", { trashRoot });
    return false;
  }
  const trashDir = join(realRoot, quarantineId);
  if (ctx && (await authorizeWrite(ctx, trashDir)) === null) {
    log.warn("file-organizer prune denied by permission engine", { trashDir });
    return false;
  }
  const st = await lstat(trashDir).catch(() => null);
  if (st === null) return true; // already gone — prune is idempotent
  if (st.isSymbolicLink()) {
    // `rm(link, {recursive:true})` unlinks the LINK only, but be explicit:
    // a symlink here is never legitimate, so drop the link and keep the
    // recursive delete for real directories.
    try {
      await unlink(trashDir);
      return true;
    } catch (err) {
      log.warn("file-organizer prune failed to unlink a symlinked entry", { trashDir, error: String(err) });
      return false;
    }
  }
  if (!(await realpathInsideRoot(realRoot, trashDir))) {
    log.warn("file-organizer prune refused: entry escapes the trash root", { trashDir });
    return false;
  }
  try {
    await rm(trashDir, { recursive: true, force: true });
    return true;
  } catch (err) {
    log.warn("file-organizer prune failed", { trashDir, error: String(err) });
    return false;
  }
}

/** Test-only seam for journal IO + the path guards. */
export const _applierInternals = {
  readJournal,
  writeJournal,
  isWithin,
  touchesProtectedDir,
  isQuarantineId,
  canonicalRoot,
  resolveCreateTarget,
  resolveNonOverwrite,
  pathExists,
};
