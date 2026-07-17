/**
 * Webhook reconciler (Loops EZ Mode Phase 4). On extension install/update,
 * mirror the extension's GRANTED webhook slugs into `extension_webhooks`
 * non-destructively (mirrors `reconcileSchedules`):
 *   - New slugs → fresh rows (`enabled: true`) + mint an initial secret if one
 *     doesn't already exist (so the hook works immediately; the user rotates it
 *     via the shown-once rotate route to obtain a token they can post with).
 *   - Removed slugs → soft-disable (`enabled: false`); the row + its delivery
 *     history + its secret are preserved (a re-declare re-enables the SAME
 *     secret, never silently invalidating a live token).
 *   - Existing slugs → re-enable if previously disabled; otherwise no-op.
 *
 * IMPORTANT — source of truth is the GRANT, not the manifest declaration. The
 * caller passes the clamped granted slugs (`grantedPermissions.webhooks`), which
 * is already `submitted ∩ manifest` (see clamp-permissions.ts). An undeclared /
 * unauthorized slug never reaches here, so a registry row can only exist for a
 * slug the user actually authorized.
 */
import { logger } from "../logger";
import { getDb } from "../db/connection";
import { extensionWebhooks, type ExtensionWebhook } from "../db/schema";
import { eq, and, notInArray } from "drizzle-orm";
import { WEBHOOK_SLUG_RE } from "./manifest";
import { ensureWebhookSecret } from "./webhook-secret";

const log = logger.child("ext.webhook-reconcile");

export async function reconcileWebhooks(
  extensionId: string,
  grantedSlugs: string[],
  now: () => Date = () => new Date(),
  // Injectable so a test can exercise the mint-failure safeguard without a
  // contrived FK error. Defaults to the real (mint-if-absent) helper.
  ensureSecret: (extId: string, slug: string) => Promise<string | null> = ensureWebhookSecret,
): Promise<{ added: number; disabled: number; preserved: number }> {
  // Defense-in-depth: re-validate slug shape even though the grant path already
  // clamped to manifest-declared slugs (which validation gated). A malformed
  // slug must never reach the route path via a registry row. Dedupe too.
  const valid = [...new Set(grantedSlugs.filter((s) => WEBHOOK_SLUG_RE.test(s)))];
  const db = getDb();

  const existing: ExtensionWebhook[] = await db.select().from(extensionWebhooks)
    .where(eq(extensionWebhooks.extensionId, extensionId));
  const existingBySlug = new Map<string, ExtensionWebhook>(
    existing.map((row) => [row.slug, row] as const),
  );
  const validSet = new Set(valid);

  let added = 0, preserved = 0;
  // Deterministic disabled count from the pre-fetch snapshot — PGlite's UPDATE
  // rowCount is unreliable (mirrors reconcileSchedules, which counts via a
  // follow-up SELECT). A currently-enabled slug not in the new grant is being
  // disabled. This set is disjoint from the re-enable loop below (which only
  // touches slugs IN `valid`).
  const disabled = existing.filter((row) => row.enabled && !validSet.has(row.slug)).length;

  for (const slug of valid) {
    const cur = existingBySlug.get(slug);
    if (cur) {
      if (!cur.enabled) {
        await db.update(extensionWebhooks)
          .set({ enabled: true, updatedAt: now() })
          .where(eq(extensionWebhooks.id, cur.id));
      }
      preserved++;
    } else {
      await db.insert(extensionWebhooks).values({ extensionId, slug, enabled: true });
      added++;
    }
    // Mint an initial secret only when absent — never rotate a live token on
    // re-install. Best-effort: a secrets write failure must not brick install.
    // A slug left without a secret is FAIL-CLOSED, not fail-open: the public
    // route rejects a secretless hook unconditionally (it never falls back to
    // the constant DUMMY_SECRET), so the hook is simply un-authenticatable —
    // reject every delivery — until the user rotates it to mint a real token.
    try {
      await ensureSecret(extensionId, slug);
    } catch (err) {
      log.warn("ensure-secret-failed", { extensionId, slug, error: String(err) });
    }
  }

  // Soft-disable removed slugs (preserve rows + secrets + delivery history).
  if (valid.length > 0) {
    await db.update(extensionWebhooks)
      .set({ enabled: false, updatedAt: now() })
      .where(and(
        eq(extensionWebhooks.extensionId, extensionId),
        notInArray(extensionWebhooks.slug, valid),
        eq(extensionWebhooks.enabled, true),
      ));
  } else if (existing.length > 0) {
    // Grant declared no slugs — disable them all.
    await db.update(extensionWebhooks)
      .set({ enabled: false, updatedAt: now() })
      .where(and(
        eq(extensionWebhooks.extensionId, extensionId),
        eq(extensionWebhooks.enabled, true),
      ));
  }

  log.debug("reconciled", { extensionId, added, disabled, preserved, totalGranted: valid.length });
  return { added, disabled, preserved };
}

/** Test-only helper to fully wipe an extension's webhook registry rows. */
export async function _wipeWebhooksForTests(extensionId: string): Promise<void> {
  const db = getDb();
  await db.delete(extensionWebhooks).where(eq(extensionWebhooks.extensionId, extensionId));
}
