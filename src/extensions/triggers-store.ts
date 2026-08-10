/**
 * `ctx.triggers` row store (C2) — the persistence half of dynamic cron and
 * webhook triggers. Pure DB + slug minting; no RPC, no permission logic
 * (that is `triggers-handler.ts`), so every rule here is independently
 * testable.
 *
 * ── Why the host mints the slug ────────────────────────────────────────
 *
 * The extension supplies a `key`; the HOST derives the slug as
 * `<prefix><sha256(extensionName \0 key)[0..12]>`. The extension never
 * transmits a slug on register, so there is no field in which to name
 * another extension's hook — forgery is inexpressible rather than merely
 * denied. And because the digest covers the registry-resolved
 * `extensionName` (never the wire), two extensions cannot collide even
 * with identical keys. Same structural bound namespacing gives workflows.
 *
 * ── Identity ──────────────────────────────────────────────────────────
 *
 * `key` is a dynamic row's identity — NOT the cron expression, which two
 * user jobs routinely share. The `(extension_id, key)` partial unique index
 * enforces that. `extension_schedules` keys on the extension UUID;
 * `extension_webhooks` keys on the extension NAME (it FKs `extensions.name`
 * so the session-less public route can look a hook up by the same key it
 * reads the secret with). Both are host-resolved from the registry.
 */
import { createHash } from "node:crypto";
import { getDb } from "../db/connection";
import {
  extensionSchedules,
  extensionScheduleFires,
  extensionWebhooks,
  type ExtensionSchedule,
  type ExtensionWebhook,
} from "../db/schema";
import { eq, and, gte, isNull } from "drizzle-orm";
import { WEBHOOK_SLUG_RE, WEBHOOK_PREFIX_RE } from "./manifest";

export { WEBHOOK_PREFIX_RE };

export type TriggerKind = "cron" | "webhook";

/** Extension-supplied trigger identity. Scoped to the extension, never
 *  global — `job:42` under two extensions are two different triggers. */
export const TRIGGER_KEY_RE = /^[a-z0-9][a-z0-9:_-]{0,63}$/;

/** Digest length of the minted slug's tail. 12 hex chars = 48 bits; the
 *  namespace is per-extension and per-prefix, so this bounds collisions
 *  across one extension's own keys, which are already unique by index. */
const SLUG_DIGEST_LEN = 12;

/**
 * Derive a webhook slug from the manifest prefix + the extension NAME + the
 * key. Deterministic: the same `(extension, key)` always yields the same
 * slug, which is what makes re-registration idempotent (T4) — the row, the
 * slug, and therefore the secret all survive a repeat register.
 */
export function mintWebhookSlug(prefix: string, extensionName: string, key: string): string {
  const digest = createHash("sha256")
    .update(`${extensionName}\0${key}`)
    .digest("hex")
    .slice(0, SLUG_DIGEST_LEN);
  return `${prefix}${digest}`;
}

/**
 * The per-key default daily cap: an equal share of the extension-wide
 * envelope. `maxRunsPerDay` is an ENVELOPE, not an allowance — with 25
 * dynamic crons drawing on one budget, a single job firing every 5 minutes
 * exhausts it before lunch and starves the other 24, whose only signal
 * would be a quota audit row naming no job.
 *
 * Floors at 1: a share that rounds to zero would disable a job the user
 * just created, which is worse than letting it fire once a day.
 */
export function defaultPerKeyCap(envelope: number, maxCron: number): number {
  if (maxCron <= 0) return envelope;
  return Math.max(1, Math.floor(envelope / maxCron));
}

// ── Reads ──────────────────────────────────────────────────────────────

/** This extension's dynamic cron rows. */
export async function listDynamicCrons(extensionId: string): Promise<ExtensionSchedule[]> {
  return getDb()
    .select()
    .from(extensionSchedules)
    .where(
      and(eq(extensionSchedules.extensionId, extensionId), eq(extensionSchedules.dynamic, true)),
    );
}

/** This extension's dynamic webhook rows. Soft-deleted rows (`key IS NULL`)
 *  are excluded — they are tombstones kept only for delivery history. */
export async function listDynamicWebhooks(extensionName: string): Promise<ExtensionWebhook[]> {
  const rows: ExtensionWebhook[] = await getDb()
    .select()
    .from(extensionWebhooks)
    .where(
      and(eq(extensionWebhooks.extensionId, extensionName), eq(extensionWebhooks.dynamic, true)),
    );
  return rows.filter((r) => r.key !== null);
}

export async function getDynamicCron(
  extensionId: string,
  key: string,
): Promise<ExtensionSchedule | undefined> {
  const rows = await getDb()
    .select()
    .from(extensionSchedules)
    .where(
      and(
        eq(extensionSchedules.extensionId, extensionId),
        eq(extensionSchedules.dynamic, true),
        eq(extensionSchedules.key, key),
      ),
    );
  return rows[0];
}

export async function getDynamicWebhook(
  extensionName: string,
  key: string,
): Promise<ExtensionWebhook | undefined> {
  const rows = await getDb()
    .select()
    .from(extensionWebhooks)
    .where(
      and(
        eq(extensionWebhooks.extensionId, extensionName),
        eq(extensionWebhooks.dynamic, true),
        eq(extensionWebhooks.key, key),
      ),
    );
  return rows[0];
}

/**
 * Fires recorded today (UTC day) for ONE schedule row — i.e. for one key.
 * The daemon's own `todaysFireCount` counts across the whole extension,
 * which is the spend bound; this is the fairness bound that keeps one busy
 * job from consuming it.
 *
 * `now` is injected, never read from the wall clock, so a test driving the
 * daemon's injected clock cannot straddle a UTC midnight non-deterministically.
 */
export async function todaysFireCountForSchedule(scheduleId: string, now: Date): Promise<number> {
  const startOfDay = new Date(now);
  startOfDay.setUTCHours(0, 0, 0, 0);
  const rows = await getDb()
    .select({ id: extensionScheduleFires.id })
    .from(extensionScheduleFires)
    .where(
      and(
        eq(extensionScheduleFires.scheduleId, scheduleId),
        gte(extensionScheduleFires.firedAt, startOfDay),
      ),
    );
  return rows.length;
}

// ── Writes ─────────────────────────────────────────────────────────────

export interface UpsertCronSpec {
  extensionId: string;
  key: string;
  cron: string;
  timezone: string | null;
  nextFireAt: Date;
  maxRunsPerDay: number;
  now: Date;
}

/**
 * Register (or re-register) a dynamic cron. Re-registering an existing key
 * UPDATES IN PLACE rather than erroring — a job editor saving twice is the
 * normal case, not an error condition. An update re-enables the row and
 * resets `consecutive_errors`, because the user just told us this job is
 * live; leaving a previously auto-disabled row disabled would make "save
 * again" silently do nothing.
 */
export async function upsertDynamicCron(spec: UpsertCronSpec): Promise<ExtensionSchedule> {
  const db = getDb();
  const existing = await getDynamicCron(spec.extensionId, spec.key);
  if (existing) {
    const [updated] = await db
      .update(extensionSchedules)
      .set({
        cron: spec.cron,
        timezone: spec.timezone,
        nextFireAt: spec.nextFireAt,
        maxRunsPerDay: spec.maxRunsPerDay,
        enabled: true,
        consecutiveErrors: 0,
        updatedAt: spec.now,
      })
      .where(eq(extensionSchedules.id, existing.id))
      .returning();
    return updated!;
  }
  const [inserted] = await db
    .insert(extensionSchedules)
    .values({
      extensionId: spec.extensionId,
      cron: spec.cron,
      timezone: spec.timezone,
      nextFireAt: spec.nextFireAt,
      maxRunsPerDay: spec.maxRunsPerDay,
      enabled: true,
      dynamic: true,
      key: spec.key,
    })
    .returning();
  return inserted!;
}

export interface UpsertWebhookSpec {
  extensionName: string;
  key: string;
  slug: string;
  now: Date;
}

/**
 * Register (or re-register) a dynamic webhook. Same idempotency contract as
 * {@link upsertDynamicCron}: the row, the slug and hence the secret survive
 * a repeat register.
 *
 * THREE cases, not two, because `uniq_ext_webhook(extension_id, slug)` is a
 * TOTAL index (it is the constraint that stops a dynamic slug from
 * shadowing a manifest one on the public route):
 *
 *   1. A live row for this key → update in place.
 *   2. A TOMBSTONE holding this slug → REVIVE it. Unregister soft-deletes
 *      (`enabled = false`, `key = NULL`) but leaves the slug on the row so
 *      its `webhook_deliveries` history stays coherent. Since the slug is a
 *      deterministic digest of `(extensionName, key)`, re-registering the
 *      same key mints the SAME slug — which would collide with that
 *      tombstone forever. Reviving both fixes that and returns the job its
 *      delivery history. The secret does NOT come back: unregister deleted
 *      it, and the caller mints a fresh one, so a revoked token stays
 *      revoked.
 *   3. Neither → insert.
 */
export async function upsertDynamicWebhook(spec: UpsertWebhookSpec): Promise<ExtensionWebhook> {
  const db = getDb();
  const existing = await getDynamicWebhook(spec.extensionName, spec.key);
  if (existing) {
    const [updated] = await db
      .update(extensionWebhooks)
      .set({
        slug: spec.slug,
        enabled: true,
        updatedAt: spec.now,
      })
      .where(eq(extensionWebhooks.id, existing.id))
      .returning();
    return updated!;
  }

  const tombstone = await findDynamicTombstone(spec.extensionName, spec.slug);
  if (tombstone) {
    const [revived] = await db
      .update(extensionWebhooks)
      .set({
        key: spec.key,
        enabled: true,
        updatedAt: spec.now,
      })
      .where(eq(extensionWebhooks.id, tombstone.id))
      .returning();
    return revived!;
  }

  const [inserted] = await db
    .insert(extensionWebhooks)
    .values({
      extensionId: spec.extensionName,
      slug: spec.slug,
      enabled: true,
      dynamic: true,
      key: spec.key,
    })
    .returning();
  return inserted!;
}

/** A soft-deleted dynamic row still holding `slug` (`key IS NULL`). */
async function findDynamicTombstone(
  extensionName: string,
  slug: string,
): Promise<ExtensionWebhook | undefined> {
  const rows: ExtensionWebhook[] = await getDb()
    .select()
    .from(extensionWebhooks)
    .where(
      and(
        eq(extensionWebhooks.extensionId, extensionName),
        eq(extensionWebhooks.slug, slug),
        eq(extensionWebhooks.dynamic, true),
        isNull(extensionWebhooks.key),
      ),
    );
  return rows[0];
}

/** True iff a MANIFEST webhook row already holds this slug. A minted slug
 *  colliding with an author-declared one would leave two rows answering the
 *  same URL, and the route's lookup would pick arbitrarily. Vanishingly
 *  unlikely (the tail is a hex digest) but cheap to refuse outright. */
export async function manifestSlugExists(extensionName: string, slug: string): Promise<boolean> {
  const rows = await getDb()
    .select({ id: extensionWebhooks.id })
    .from(extensionWebhooks)
    .where(
      and(
        eq(extensionWebhooks.extensionId, extensionName),
        eq(extensionWebhooks.slug, slug),
        eq(extensionWebhooks.dynamic, false),
      ),
    );
  return rows.length > 0;
}

/** Hard-delete a dynamic cron row. Its `extension_schedule_fires` history
 *  cascades — unlike a webhook's delivery history, cron fire rows carry no
 *  payload an operator would need after the job is gone. Returns true when a
 *  row was actually removed. */
export async function deleteDynamicCron(extensionId: string, key: string): Promise<boolean> {
  const existing = await getDynamicCron(extensionId, key);
  if (!existing) return false;
  await getDb().delete(extensionSchedules).where(eq(extensionSchedules.id, existing.id));
  return true;
}

/**
 * SOFT-delete a dynamic webhook: `enabled = false`, `key = NULL`.
 *
 * A hard delete would cascade `webhook_deliveries` (FK `ON DELETE CASCADE`)
 * and destroy delivery history an operator may still need. Clearing `key`
 * drops the row out of the `(extension_id, key)` partial unique index, so
 * the same key can be registered again later; the tombstone stays until
 * `cleanupOldWebhookDeliveries` reaps it on its own retention schedule.
 *
 * Returns the freed slug so the caller can delete the secret — which does
 * NOT survive, or a revoked hook's token would outlive it.
 */
export async function softDeleteDynamicWebhook(
  extensionName: string,
  key: string,
  now: Date,
): Promise<string | null> {
  const existing = await getDynamicWebhook(extensionName, key);
  if (!existing) return null;
  await getDb()
    .update(extensionWebhooks)
    .set({ enabled: false, key: null, updatedAt: now })
    .where(eq(extensionWebhooks.id, existing.id));
  return existing.slug;
}

/** Soft-disable every dynamic row for an extension, returning the affected
 *  keys. Used when the `triggers` capability itself disappears from the
 *  manifest, and by the orphan sweep. Rows are preserved — this is the one
 *  case where disabling a dynamic row is correct, because the capability
 *  that created it is gone. */
export async function disableDynamicCrons(
  extensionId: string,
  keys: string[],
  now: Date,
): Promise<number> {
  if (keys.length === 0) return 0;
  const db = getDb();
  let n = 0;
  for (const key of keys) {
    const row = await getDynamicCron(extensionId, key);
    if (!row?.enabled) continue;
    await db
      .update(extensionSchedules)
      .set({ enabled: false, updatedAt: now })
      .where(eq(extensionSchedules.id, row.id));
    n++;
  }
  return n;
}

export async function disableDynamicWebhooks(
  extensionName: string,
  keys: string[],
  now: Date,
): Promise<number> {
  if (keys.length === 0) return 0;
  const db = getDb();
  let n = 0;
  for (const key of keys) {
    const row = await getDynamicWebhook(extensionName, key);
    if (!row?.enabled) continue;
    await db
      .update(extensionWebhooks)
      .set({ enabled: false, updatedAt: now })
      .where(eq(extensionWebhooks.id, row.id));
    n++;
  }
  return n;
}

/** Defense-in-depth: a minted slug must still satisfy the same shape the
 *  route and the manifest validator enforce. The prefix clamp guarantees the
 *  head character and the hex digest the tail, so this can only fail on a
 *  bug — but a malformed slug must never reach a registry row. */
export function isMintableSlug(slug: string): boolean {
  return WEBHOOK_SLUG_RE.test(slug);
}
