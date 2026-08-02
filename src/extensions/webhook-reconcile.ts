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
 *
 * DYNAMIC ROWS ARE NOT THIS FUNCTION'S BUSINESS (C2). A `ctx.triggers` slug is
 * HOST-MINTED at registration time and is by construction absent from the
 * manifest, hence absent from the clamped grant — so to this reconciler every
 * dynamic row looks exactly like a slug the author just deleted. Every query
 * below therefore filters on `dynamic = false`: the snapshot, the sweep, and
 * the disable-all branch.
 *
 * That filter is load-bearing, not defensive. `activateExtension` calls this
 * on EVERY enable with a `?? []` fallback, so the disable-all branch runs for
 * every extension that declares no manifest webhooks — which is precisely the
 * shape of an extension whose hooks are all dynamic. Without the filter, one
 * enable silently kills every user-created hook: the row survives, the secret
 * survives, the delivery history survives, and the hook just stops firing.
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

  // MANIFEST rows only — see the module header. This snapshot feeds both the
  // re-enable map and the `disabled` count, so filtering here keeps a dynamic
  // row out of BOTH.
  const existing: ExtensionWebhook[] = await db.select().from(extensionWebhooks)
    .where(and(
      eq(extensionWebhooks.extensionId, extensionId),
      eq(extensionWebhooks.dynamic, false),
    ));
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
  // `dynamic = false` on both branches: a user-created hook was never in the
  // grant, so "not in the grant" cannot mean "revoked" for it.
  if (valid.length > 0) {
    await db.update(extensionWebhooks)
      .set({ enabled: false, updatedAt: now() })
      .where(and(
        eq(extensionWebhooks.extensionId, extensionId),
        eq(extensionWebhooks.dynamic, false),
        notInArray(extensionWebhooks.slug, valid),
        eq(extensionWebhooks.enabled, true),
      ));
  } else if (existing.length > 0) {
    // Grant declared no slugs — disable all the MANIFEST ones.
    await db.update(extensionWebhooks)
      .set({ enabled: false, updatedAt: now() })
      .where(and(
        eq(extensionWebhooks.extensionId, extensionId),
        eq(extensionWebhooks.dynamic, false),
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
