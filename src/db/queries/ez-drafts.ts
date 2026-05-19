import { and, eq, gt, isNull, lt } from "drizzle-orm";
import { existsSync } from "node:fs";
import { mkdir, readdir, rm, rmdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { getDb } from "../connection";
import { ezDrafts } from "../schema";
import { logger } from "../../logger";

const log = logger.child("ez-drafts");

/**
 * Phase 48: Ez concierge drafts.
 *
 * Each `propose_*` server tool persists a draft row (kind ∈
 * { 'project' | 'agent' | 'extension' }) and returns its id in the tool
 * result. The Ez panel renders that as a one-button "Open prefilled
 * form" card whose URL embeds the draft id. The destination page reads
 * `?prefill=<id>`, hydrates form state from `payload`, and stamps
 * `consumedAt` on submit. Rows expire 24h after `createdAt` regardless
 * of consumption — sweepExpired() is the GC.
 *
 * Ownership: every read/consume/delete is scoped to userId so an
 * attacker cannot redeem another user's draft by guessing its id.
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

export type EzDraftKind = "project" | "agent" | "extension";

export type EzDraftRow = typeof ezDrafts.$inferSelect;

/**
 * Flat allowlist of file names an extension-author draft directory may
 * contain. MUST stay in lockstep with the SDK scaffolder's emitted keys
 * (`packages/@ezcorp/sdk/src/scaffold/index.ts` — `ScaffoldResult.files`)
 * and the subprocess-side mirror in
 * `docs/extensions/examples/extension-author/index.ts`'s
 * `ALLOWED_DRAFT_FILES`. Kept inline here (rather than imported from the
 * SDK) for the same reason `scaffold/index.ts` inlines `NAME_REGEX`:
 * host persistence must not trust/transit a list across the sandbox
 * boundary. Every entry is a flat basename — no nested paths.
 */
export const SCAFFOLD_DRAFT_FILES: ReadonlySet<string> = new Set([
  "ezcorp.config.ts",
  "index.ts",
  "index.test.ts",
  "README.md",
  "package.json",
  "tsconfig.json",
  ".gitignore",
]);

/**
 * Insert a draft row.
 *
 * ── "stuck chat" Defect-3: corrected diagnosis ──
 *
 * Earlier triage claimed this `INSERT … RETURNING` wedged at the
 * `drizzle-orm/bun-sql` driver layer ("environmental / unfixable") when
 * binding the identity-mapped jsonb `payload` object over an external
 * Postgres connection. That conclusion was NOT reproducible. Driving
 * the real `initPostgres()` path (identity patch + migrate + repair)
 * against a real Postgres — including a populated multi-KB
 * extension-author payload, `.returning()`, concurrency, transactions,
 * and an 80ms/chunk high-latency proxy — `createDraft` completes in
 * single-digit ms every time. There is no driver wedge.
 *
 * The interim "fix" (`payload: sql`${JSON.stringify(...)}::jsonb``) was
 * actively harmful: that binds the JSON as a text parameter which
 * Bun.sql then re-encodes, so Postgres parses `'"{\\"…\\"}"'::jsonb`
 * and stores a jsonb STRING scalar (`jsonb_typeof = 'string'`). That is
 * exactly the double-encoding bug `initPostgres()`'s identity
 * `mapToDriverValue` patch + `jsonb-double-encoding.test.ts` exist to
 * prevent. Every server-side `payload->>'key'` then returns NULL. It
 * only looked "fine" for extension-author drafts because the handler's
 * follow-up draftDir UPDATE (raw-object bind) overwrote the corrupted
 * value; project/agent drafts (no follow-up UPDATE) were left corrupt.
 *
 * Correct form: bind the raw JS object. `initPostgres()`'s identity
 * `mapToDriverValue` patch makes Bun.sql serialize it to jsonb natively
 * (`jsonb_typeof = 'object'`, `payload->>'name'` works) — verified on
 * the real bun-sql + Postgres path with the identity patch active. The
 * Phase-1 bounded reverse-RPC dispatch
 * (`HOST_REVERSE_RPC_HANDLER_TIMEOUT_MS`) stays as a generic
 * defence-in-depth guardrail (it is NOT compensating for a real wedge
 * here). See
 * `src/__tests__/createdraft-stall-guardrail.integration.test.ts`.
 */
export async function createDraft(data: {
  userId: string;
  kind: EzDraftKind;
  payload: Record<string, unknown>;
  /** Override TTL (ms). Default 24h. */
  ttlMs?: number;
}): Promise<EzDraftRow> {
  if (!data.userId) throw new Error("userId is required");
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (data.ttlMs ?? TWENTY_FOUR_HOURS_MS));
  const rows = await getDb()
    .insert(ezDrafts)
    .values({
      userId: data.userId,
      kind: data.kind,
      payload: data.payload,
      createdAt: now,
      expiresAt,
    })
    .returning();
  return rows[0]!;
}

/**
 * Read a draft by id, scoped to its owning user. Returns undefined when
 *  - the draft doesn't exist
 *  - the caller is not the owner
 *  - the draft has expired (regardless of consumption)
 *
 * Note: a consumed-but-not-expired draft is still returned — the caller
 * may want to display "this draft was already used" rather than a 404.
 * Filter on `consumedAt !== null` at the call site if needed.
 */
export async function getDraft(id: string, userId: string): Promise<EzDraftRow | undefined> {
  if (!id || !userId) return undefined;
  const now = new Date();
  const rows = await getDb()
    .select()
    .from(ezDrafts)
    .where(and(eq(ezDrafts.id, id), eq(ezDrafts.userId, userId)));
  const row = rows[0];
  if (!row) return undefined;
  if (row.expiresAt.getTime() <= now.getTime()) return undefined;
  return row;
}

/**
 * Mark a draft as consumed. Idempotent: a second consume on the same row
 * returns the existing consumedAt timestamp (does not advance it).
 *
 * Returns undefined when the draft is missing, expired, or owned by a
 * different user — same gates as getDraft.
 */
export async function consumeDraft(id: string, userId: string): Promise<EzDraftRow | undefined> {
  const existing = await getDraft(id, userId);
  if (!existing) return undefined;
  if (existing.consumedAt) return existing;

  const rows = await getDb()
    .update(ezDrafts)
    .set({ consumedAt: new Date() })
    .where(and(eq(ezDrafts.id, id), eq(ezDrafts.userId, userId), isNull(ezDrafts.consumedAt)))
    .returning();
  return rows[0] ?? existing;
}

/**
 * Walk up from `from` looking for a `.git` directory. Mirrors
 * `@ezcorp/sdk/runtime`'s `findProjectRoot` — inlined here because the
 * sweep runs from inside a backend module that should not pull SDK
 * runtime helpers.
 */
function findProjectRoot(from: string): string {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

/**
 * Compute the on-disk directory for a given extension-author draft,
 * namespaced by the owning userId:
 *   `<projectRoot>/.ezcorp/extension-data/extension-author/drafts/<userId>/<draftId>/`
 *
 * The userId namespace is a defense-in-depth gate: even with a leaked
 * draftId, an attacker cannot read another user's files because the
 * resolver requires the userId in the path. The DB ownership check
 * (`getDraft(id, userId)`) is the primary gate; this is the second.
 */
export function getExtensionAuthorDraftDir(
  draftId: string,
  userId: string,
  projectRoot?: string,
): string {
  if (!draftId || !/^[a-zA-Z0-9_-]+$/.test(draftId)) {
    throw new Error(`Invalid draftId: "${draftId}"`);
  }
  if (!userId || !/^[a-zA-Z0-9_-]+$/.test(userId)) {
    throw new Error(`Invalid userId: "${userId}"`);
  }
  const root = projectRoot ?? findProjectRoot(process.cwd());
  return join(root, ".ezcorp/extension-data/extension-author/drafts", userId, draftId);
}

/**
 * Materialize an extension-author draft's directory + files HOST-SIDE.
 *
 * This is the deterministic create path: the sandboxed extension
 * subprocess no longer does `fsMkdir` / `fsWrite` reverse-RPCs (which
 * deadlocked the host filesystem gate when the granted
 * `.ezcorp/extension-data/extension-author` dir didn't exist yet). The
 * host owns the filesystem here — full access, no sandbox, no
 * permission gate — so a fresh-project `create_extension` always lands
 * a populated draft dir regardless of which LLM drove it.
 *
 * `files` is validated even though the only caller is the bundled
 * `extension-author` (defense-in-depth — the host must never blindly
 * write subprocess-supplied paths): every key MUST be a flat basename
 * in {@link SCAFFOLD_DRAFT_FILES} with no absolute / `..` / separator
 * segments, and every value MUST be a string. Any violation throws
 * BEFORE any file is written (the caller treats a throw as a
 * transactional create failure and discards the row).
 */
export async function writeExtensionAuthorDraftFiles(
  draftId: string,
  userId: string,
  files: Record<string, string>,
): Promise<{ draftDir: string; written: string[] }> {
  if (!files || typeof files !== "object" || Array.isArray(files)) {
    throw new Error("files must be a non-array object");
  }
  const entries = Object.entries(files);
  if (entries.length === 0) {
    throw new Error("files is empty — nothing to materialize");
  }
  // Validate the WHOLE map before touching disk (all-or-nothing).
  for (const [name, content] of entries) {
    if (typeof content !== "string") {
      throw new Error(`file "${name}" content must be a string`);
    }
    if (isAbsolute(name) || name.includes("..") || /[\\/]/.test(name)) {
      throw new Error(`file "${name}" must be a flat relative basename`);
    }
    if (!SCAFFOLD_DRAFT_FILES.has(name)) {
      throw new Error(`file "${name}" not in the scaffold allowlist`);
    }
  }
  // `getExtensionAuthorDraftDir` re-validates draftId/userId shape.
  const draftDir = getExtensionAuthorDraftDir(draftId, userId);
  await mkdir(draftDir, { recursive: true });
  const written: string[] = [];
  for (const [name, content] of entries) {
    await writeFile(join(draftDir, name), content, "utf-8");
    written.push(name);
  }
  return { draftDir, written };
}

/**
 * Discard an extension-author draft: consume the row AND recursively
 * remove its on-disk directory. Owner-scoped. Idempotent — missing
 * row / missing dir both return `{ ok: true }`.
 *
 * Returns `ok: false` only when the row exists but is owned by a
 * different user (consumeDraft returned undefined for an existing id).
 * Callers that don't distinguish can treat both as success.
 */
export async function discardDraftAndDir(
  draftId: string,
  userId: string,
): Promise<{ ok: boolean }> {
  if (!draftId || !userId) return { ok: false };
  // Compute the dir BEFORE consuming so we have the path even if the
  // row goes away mid-call.
  let dir: string | null = null;
  try {
    dir = getExtensionAuthorDraftDir(draftId, userId);
  } catch {
    return { ok: false };
  }

  // Consume row (owner-scoped). Idempotent: returns the existing row
  // even on second call. Undefined → row missing OR wrong owner.
  const consumed = await consumeDraft(draftId, userId);
  // We can't distinguish "missing row" from "wrong owner" here without
  // a second query, but the dir removal is gated by the userId in the
  // path — so a wrong-owner caller never reaches another user's dir.

  if (dir && existsSync(dir)) {
    try {
      await rm(dir, { recursive: true, force: true });
    } catch (err) {
      log.warn("discardDraftAndDir: rm failed", { draftId, dir, error: String(err) });
    }
  }

  return { ok: consumed != null || true /* dir-removal succeeded counts as ok */ };
}

/**
 * Delete every draft whose expiresAt is in the past. Returns the number
 * of deleted rows. Safe to call from a cron-like sweep; idempotent.
 *
 * For draft rows whose payload describes an `extension-author` draft
 * (`kind === "extension"` AND `payload.mode === "author"`), this also
 * `rm -rf`s the on-disk draft directory under
 * `<projectRoot>/.ezcorp/extension-data/extension-author/drafts/<id>/`.
 * The bundled extension can't reach in to clean up via its sandbox at
 * sweep time (no host-side hook fires when a row expires), so the
 * cleanup runs HERE — owned by the same code path that deletes the
 * row, keeping disk + DB in lockstep.
 *
 * Filesystem failures during sweep are LOGGED + SWALLOWED. Sweep is a
 * cron-like cleanup; one bad row should not stop the others. Stale
 * directories from a prior sweep failure pile up under the same
 * convention path; a future garbage-collection job (or the next
 * sweep, if the cause was transient) cleans them up.
 */
export async function sweepExpired(now: Date = new Date()): Promise<number> {
  const rows = await getDb()
    .delete(ezDrafts)
    .where(lt(ezDrafts.expiresAt, now))
    .returning({
      id: ezDrafts.id,
      // userId is needed for the userId-namespaced draft-dir layout
      // (drafts/<userId>/<draftId>). Missing it would leave dirs orphan.
      userId: ezDrafts.userId,
      kind: ezDrafts.kind,
      payload: ezDrafts.payload,
    });

  // Best-effort fs cleanup for extension-author drafts. The directory
  // path is conventional (matches what `extension-author/index.ts`
  // writes via the host-side resolver), not stored in the row. We
  // re-derive the path from row.userId + row.id — never from
  // `payload.draftDir`, which a malicious payload could change.
  let projectRoot: string | null = null;
  const touchedUserDirs = new Set<string>();
  for (const row of rows) {
    if (row.kind !== "extension") continue;
    const payload = row.payload as Record<string, unknown> | null;
    if (!payload || payload.mode !== "author") continue;

    if (projectRoot === null) {
      try {
        projectRoot = findProjectRoot(process.cwd());
      } catch {
        projectRoot = process.cwd();
      }
    }
    let dir: string;
    try {
      dir = getExtensionAuthorDraftDir(row.id, row.userId, projectRoot);
    } catch (err) {
      log.warn("sweep: failed to compute extension-author draft dir", {
        draftId: row.id,
        userId: row.userId,
        error: String(err),
      });
      continue;
    }
    if (existsSync(dir)) {
      try {
        await rm(dir, { recursive: true, force: true });
      } catch (err) {
        log.warn("sweep: failed to remove extension-author draft dir", {
          draftId: row.id,
          dir,
          error: String(err),
        });
      }
    }
    // Track parent so we can sweep empty `<userId>/` after all
    // per-row removals.
    touchedUserDirs.add(dirname(dir));
  }

  // Best-effort cleanup of empty per-user parent dirs. rmdir() throws
  // ENOTEMPTY if other drafts (e.g. unexpired) remain — that's the
  // expected case and we swallow it silently.
  for (const userDir of touchedUserDirs) {
    if (!existsSync(userDir)) continue;
    try {
      const remaining = await readdir(userDir);
      if (remaining.length === 0) {
        await rmdir(userDir);
      }
    } catch {
      // swallow — empty-check failures are non-fatal
    }
  }

  return rows.length;
}

/**
 * Diagnostic helper: list a user's still-valid drafts. Excludes expired
 * rows; consumed-but-not-expired rows are included so the UI can show
 * "already used" state.
 */
export async function listActiveDraftsForUser(userId: string): Promise<EzDraftRow[]> {
  if (!userId) return [];
  const now = new Date();
  return getDb()
    .select()
    .from(ezDrafts)
    .where(and(eq(ezDrafts.userId, userId), gt(ezDrafts.expiresAt, now)));
}
