import { and, eq, lt, gt, desc } from "drizzle-orm";
import { resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { getDb } from "../connection";
import { previewSessions } from "../schema";
import type { PreviewSession } from "../schema";

export type { PreviewSession };

/**
 * Preview registry queries (Secure User-Site Preview / Port Exposure,
 * Phase 1 — see tasks/preview-port-exposure.md §3.4).
 *
 * One row per exposed site. The row's `id` is BOTH the primary key and
 * the `*.preview.<host>` subdomain label, so it must be opaque +
 * unguessable: `generatePreviewId()` mints 128 bits of CSPRNG entropy as
 * a 26-char Crockford base32 string. No enumeration is possible.
 *
 * Ownership + lifecycle are enforced HERE, not at the call site:
 *  - `getServablePreview(id, userId)` returns a row ONLY when it exists,
 *    is owned by `userId`, is `status='active'`, and has not expired /
 *    been revoked. This is the proxy's access-layer requester-only check.
 *  - `revokePreview` / `sweepExpiredPreviews` / `reapPreviewsForConversation`
 *    are the lifecycle transitions (Phase 4 wires the reaper; the API
 *    surface lands in Phase 1 so the revocation UI + tests exist v1).
 */

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

// Crockford base32 alphabet (no I/L/O/U — unambiguous, URL/DNS-safe and
// case-insensitive). 26 chars * 5 bits = 130 bits of address space; we
// fill it from 16 CSPRNG bytes (128 bits) zero-padded.
const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

/**
 * Mint an opaque, unguessable preview id (the subdomain label). 26 chars
 * of Crockford base32 over 128 bits of CSPRNG entropy. Lowercase so it is
 * a valid DNS label and survives case-insensitive Host-header matching.
 */
export function generatePreviewId(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  // Accumulate the 128 bits into a bigint, then peel off 5 bits at a time.
  let acc = 0n;
  for (const b of bytes) acc = (acc << 8n) | BigInt(b);
  let out = "";
  for (let i = 0; i < 26; i++) {
    out = CROCKFORD[Number(acc & 31n)] + out;
    acc >>= 5n;
  }
  return out;
}

/** Shape of a valid preview id: exactly 26 Crockford base32 chars.
 *  Used by the proxy + token endpoints to reject malformed subdomain
 *  labels BEFORE any DB hit (cheap DNS-rebind / enumeration rejection). */
export const PREVIEW_ID_REGEX = /^[0-9a-hjkmnp-tv-z]{26}$/;

export function isValidPreviewId(id: string): boolean {
  return PREVIEW_ID_REGEX.test(id);
}

/**
 * The on-disk root every static preview MUST live under:
 * `<projectRoot>/.ezcorp/sites/`. Derived from `EZCORP_PROJECT_ROOT`
 * (falling back to `process.cwd()`), the same inputs `getProjectRoot()`
 * uses — kept env-derived here so the DB-queries layer doesn't pull in
 * the heavier `extensions/bundled` graph. Tests inject a temp root.
 */
export function previewSitesRoot(projectRoot?: string): string {
  const root = projectRoot ?? process.env.EZCORP_PROJECT_ROOT ?? process.cwd();
  return resolve(root, ".ezcorp", "sites");
}

/**
 * Trust-boundary guard: a `kind:"static"` preview's `staticPath` MUST
 * resolve under the sites root `.ezcorp/sites/` (each preview's served
 * tree is `.ezcorp/sites/<id>/`). This makes the schema comment's
 * invariant load-bearing — the proxy re-validates against the realpath
 * jail, but we reject an out-of-bounds path at the point it FIRST enters
 * the DB so a bad row can never be persisted (e.g. `/etc` or a path that
 * symlinks into `.ezcorp/data`). Mirrors the proxy's realpath-based
 * containment check (`resolveStaticFile`).
 *
 * The id is minted inside `createPreviewSession`, so the caller can't
 * pre-pin the per-id subdir; the enforceable boundary at registration
 * time is the sites root. (`<id>` precision is enforced by the proxy at
 * serve time, which knows the row.)
 *
 * Fails CLOSED: the path must exist (so realpath can canonicalize it) AND
 * realpath under the sites root. Throws otherwise.
 */
export function assertUnderSitesRoot(staticPath: string, projectRoot?: string): void {
  let realRoot: string;
  try {
    // realpath the sites root so the prefix compares canonical paths
    // (defends against the root itself being a symlink).
    realRoot = realpathSync(previewSitesRoot(projectRoot));
  } catch {
    throw new Error(
      `preview: sites root does not exist; refusing to register a static preview (fail-closed)`,
    );
  }
  let realTarget: string;
  try {
    realTarget = realpathSync(resolve(staticPath));
  } catch {
    throw new Error(
      `preview: staticPath does not exist or is not resolvable (fail-closed): ${staticPath}`,
    );
  }
  if (realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
    throw new Error(
      `preview: staticPath must resolve under ${realRoot}; refusing out-of-bounds path: ${staticPath}`,
    );
  }
}

export async function createPreviewSession(data: {
  userId: string;
  conversationId: string;
  kind: "static" | "dynamic";
  /** Static branch — absolute path to the served site root. */
  staticPath?: string | null;
  /** Dynamic branch — port the dev server listens on inside the netns. */
  targetPort?: number | null;
  /** Dynamic branch — the per-conversation netns id. */
  netnsId?: string | null;
  /** Override TTL (ms). Default 24h. */
  ttlMs?: number;
  /** Test/host override for the project root the sites-root guard derives
   *  `.ezcorp/sites/` from. Defaults to env/cwd. */
  projectRoot?: string;
}): Promise<PreviewSession> {
  if (!data.userId) throw new Error("userId is required");
  if (!data.conversationId) throw new Error("conversationId is required");
  if (data.kind === "static" && !data.staticPath) {
    throw new Error("staticPath is required for a static preview");
  }
  if (data.kind === "dynamic" && (data.targetPort == null || data.targetPort <= 0)) {
    throw new Error("a positive targetPort is required for a dynamic preview");
  }
  // Mint the id first so the static containment check can pin to the
  // per-id sites subdir (`.ezcorp/sites/<id>/`).
  const id = generatePreviewId();
  if (data.kind === "static") {
    assertUnderSitesRoot(data.staticPath!, data.projectRoot);
  }
  const now = new Date();
  const expiresAt = new Date(now.getTime() + (data.ttlMs ?? TWENTY_FOUR_HOURS_MS));
  const rows = await getDb()
    .insert(previewSessions)
    .values({
      id,
      userId: data.userId,
      conversationId: data.conversationId,
      kind: data.kind,
      staticPath: data.staticPath ?? null,
      targetPort: data.targetPort ?? null,
      netnsId: data.netnsId ?? null,
      status: "active",
      createdAt: now,
      expiresAt,
    })
    .returning();
  return rows[0]!;
}

/**
 * Load a preview row by id with NO ownership/lifecycle filter. Used by
 * the access layer to distinguish 404 (no such id) from 403 (exists but
 * wrong user) — though the proxy collapses both to 404 for an opaque
 * surface. Returns undefined when the id doesn't exist.
 */
export async function getPreviewByIdRaw(id: string): Promise<PreviewSession | undefined> {
  if (!id || !isValidPreviewId(id)) return undefined;
  const rows = await getDb()
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.id, id));
  return rows[0];
}

/**
 * The access-layer requester-only check. Returns the row ONLY when:
 *   - the id is well-formed and exists,
 *   - `row.userId === userId` (the requester owns it),
 *   - `row.status === 'active'`,
 *   - `row.revokedAt` is null,
 *   - `row.expiresAt` is in the future.
 *
 * Returns undefined for every other case so callers can respond with a
 * single opaque status. This is the THIRD requester-only layer — even if
 * attribution or consent were bypassed, another user has no valid token
 * (their userId won't match) for this preview.
 */
export async function getServablePreview(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<PreviewSession | undefined> {
  if (!id || !userId || !isValidPreviewId(id)) return undefined;
  const row = await getPreviewByIdRaw(id);
  if (!row) return undefined;
  if (row.userId !== userId) return undefined;
  if (row.status !== "active") return undefined;
  if (row.revokedAt !== null) return undefined;
  if (row.expiresAt.getTime() <= now.getTime()) return undefined;
  return row;
}

/**
 * Bump `last_seen_at` on a served request (liveness signal for the
 * Phase 4 idle reaper). Owner-scoped + active-only so a stale/foreign
 * request can't keep a revoked preview "warm". Best-effort: returns the
 * updated row or undefined when nothing matched.
 */
export async function touchPreview(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<PreviewSession | undefined> {
  if (!id || !userId || !isValidPreviewId(id)) return undefined;
  const rows = await getDb()
    .update(previewSessions)
    .set({ lastSeenAt: now })
    .where(and(
      eq(previewSessions.id, id),
      eq(previewSessions.userId, userId),
      eq(previewSessions.status, "active"),
    ))
    .returning();
  return rows[0];
}

/**
 * List a user's previews (most-recent first), including
 * revoked/expired rows so the management UI can show full state.
 */
export async function listPreviewsForUser(userId: string): Promise<PreviewSession[]> {
  if (!userId) return [];
  return getDb()
    .select()
    .from(previewSessions)
    .where(eq(previewSessions.userId, userId))
    .orderBy(desc(previewSessions.createdAt));
}

/**
 * Revoke a preview (owner-scoped). Sets status='revoked' + stamps
 * revokedAt. Idempotent: a second revoke returns the already-revoked
 * row. Returns undefined when the id is missing or owned by another
 * user (so an attacker can't revoke someone else's preview).
 */
export async function revokePreview(
  id: string,
  userId: string,
  now: Date = new Date(),
): Promise<PreviewSession | undefined> {
  if (!id || !userId || !isValidPreviewId(id)) return undefined;
  const existing = await getPreviewByIdRaw(id);
  if (!existing || existing.userId !== userId) return undefined;
  if (existing.status === "revoked") return existing;
  const rows = await getDb()
    .update(previewSessions)
    .set({ status: "revoked", revokedAt: now })
    .where(and(eq(previewSessions.id, id), eq(previewSessions.userId, userId)))
    .returning();
  return rows[0] ?? existing;
}

/**
 * Mark every still-active preview whose `expiresAt` is in the past as
 * `status='expired'`. Returns the number of transitioned rows. Safe to
 * call from a cron-like sweep; idempotent (already-expired rows are not
 * re-touched because the predicate filters on status='active').
 */
export async function sweepExpiredPreviews(now: Date = new Date()): Promise<number> {
  const rows = await getDb()
    .update(previewSessions)
    .set({ status: "expired" })
    .where(and(
      eq(previewSessions.status, "active"),
      lt(previewSessions.expiresAt, now),
    ))
    .returning({ id: previewSessions.id });
  return rows.length;
}

/**
 * Reap every active preview for a conversation (called on conversation
 * close / idle / explicit stop — Phase 4 wires the trigger; the API
 * surface lands Phase 1). Marks them revoked so the proxy fails closed
 * immediately. Returns the number of reaped rows.
 */
export async function reapPreviewsForConversation(
  conversationId: string,
  now: Date = new Date(),
): Promise<number> {
  return (await reapPreviewIdsForConversation(conversationId, now)).length;
}

/**
 * Same as `reapPreviewsForConversation` but returns the revoked preview IDs
 * (not just the count). The reaper uses these to FORGET each preview's
 * per-id rate-limit/quota accounting so a freed id can't leak memory in the
 * dynamic-proxy quota maps. Empty array when nothing was reaped.
 */
export async function reapPreviewIdsForConversation(
  conversationId: string,
  now: Date = new Date(),
): Promise<string[]> {
  if (!conversationId) return [];
  const rows = await getDb()
    .update(previewSessions)
    .set({ status: "revoked", revokedAt: now })
    .where(and(
      eq(previewSessions.conversationId, conversationId),
      eq(previewSessions.status, "active"),
    ))
    .returning({ id: previewSessions.id });
  return rows.map((r: { id: string }) => r.id);
}

/**
 * Count a user's currently-servable (active, unexpired) previews —
 * backs the concurrent-preview cap (Phase 4) + the dashboard badge.
 */
export async function countActivePreviewsForUser(
  userId: string,
  now: Date = new Date(),
): Promise<number> {
  if (!userId) return 0;
  const rows = await getDb()
    .select({ id: previewSessions.id })
    .from(previewSessions)
    .where(and(
      eq(previewSessions.userId, userId),
      eq(previewSessions.status, "active"),
      gt(previewSessions.expiresAt, now),
    ));
  return rows.length;
}
