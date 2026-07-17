/**
 * Coverage for the Loops EZ Mode Phase 4 webhook host storage layer:
 * `webhook-secret.ts` (AES-GCM secret mint/read/rotate), `webhook-reconcile.ts`
 * (install-time registry reconcile + initial secret mint), and
 * `webhook-store.ts` (registry lookup + delivery-queue helpers).
 *
 * DB-backed: each helper hits PGlite via the isolated per-file snapshot. Secrets
 * need an encryption key, so it is set before any secrets-store import runs.
 */
import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import {
  setupTestDb, closeTestDb, mockDbConnection, getTestDb,
} from "./helpers/test-pglite";

process.env.EZCORP_ENCRYPTION_SECRET ??= "0".repeat(64);

mockDbConnection();

import {
  mintWebhookSecret,
  getWebhookSecret,
  hasWebhookSecret,
  ensureWebhookSecret,
  deleteWebhookSecret,
  generateWebhookToken,
  webhookSecretName,
  WEBHOOK_TOKEN_PREFIX,
} from "../extensions/webhook-secret";
import { reconcileWebhooks, _wipeWebhooksForTests } from "../extensions/webhook-reconcile";
import {
  getEnabledWebhook,
  insertDelivery,
  countDeliveriesSince,
  startOfUtcDay,
  cleanupOldWebhookDeliveries,
} from "../extensions/webhook-store";
import { extensionWebhooks, webhookDeliveries, extensions } from "../db/schema";
import { eq } from "drizzle-orm";

// The webhook subsystem keys by extension NAME (matches the extension_secrets
// FK + the /api/extensions/:name convention), so `extId` here holds the name.
let extId: string;

async function ensureExtension(name: string): Promise<string> {
  await getTestDb().insert(extensions).values({
    name, version: "0.0.1", description: "",
    manifest: { schemaVersion: 2, name, version: "0.0.1", description: "", author: { name: "t" }, permissions: {} } as never,
    source: "test", enabled: true, grantedPermissions: {} as never,
  });
  return name;
}

beforeAll(async () => {
  await setupTestDb();
  extId = await ensureExtension("wh-ext-1");
});

beforeEach(async () => {
  await getTestDb().delete(webhookDeliveries);
  await _wipeWebhooksForTests(extId);
});

afterAll(async () => {
  await closeTestDb();
});

// ── webhook-secret ────────────────────────────────────────────────────

describe("webhook-secret", () => {
  test("generateWebhookToken → prefixed 256-bit base64url token", () => {
    const t = generateWebhookToken();
    expect(t.startsWith(WEBHOOK_TOKEN_PREFIX)).toBe(true);
    const raw = t.slice(WEBHOOK_TOKEN_PREFIX.length);
    // 32 bytes base64url → 43 chars (no padding).
    expect(raw.length).toBe(43);
    expect(/^[A-Za-z0-9_-]+$/.test(raw)).toBe(true);
    // Fresh entropy each call.
    expect(generateWebhookToken()).not.toBe(t);
  });

  test("webhookSecretName namespaces the slug", () => {
    expect(webhookSecretName("tickets")).toBe("webhook:tickets");
  });

  test("mint → get round-trips the plaintext; hasWebhookSecret true", async () => {
    const token = await mintWebhookSecret(extId, "tickets");
    expect(token.startsWith(WEBHOOK_TOKEN_PREFIX)).toBe(true);
    expect(await getWebhookSecret(extId, "tickets")).toBe(token);
    expect(await hasWebhookSecret(extId, "tickets")).toBe(true);
  });

  test("mint rotates — a second mint overwrites (old token invalid)", async () => {
    const first = await mintWebhookSecret(extId, "tickets");
    const second = await mintWebhookSecret(extId, "tickets");
    expect(second).not.toBe(first);
    expect(await getWebhookSecret(extId, "tickets")).toBe(second);
  });

  test("ensureWebhookSecret mints only when absent (idempotent)", async () => {
    const minted = await ensureWebhookSecret(extId, "alerts");
    expect(minted).not.toBeNull();
    // Second call returns null (already present) and does NOT rotate.
    const again = await ensureWebhookSecret(extId, "alerts");
    expect(again).toBeNull();
    expect(await getWebhookSecret(extId, "alerts")).toBe(minted);
  });

  test("get / has return null/false for an unknown slug", async () => {
    expect(await getWebhookSecret(extId, "nope")).toBeNull();
    expect(await hasWebhookSecret(extId, "nope")).toBe(false);
  });

  test("deleteWebhookSecret removes it", async () => {
    await mintWebhookSecret(extId, "gone");
    expect(await deleteWebhookSecret(extId, "gone")).toBe(true);
    expect(await hasWebhookSecret(extId, "gone")).toBe(false);
    // Deleting again is a no-op false.
    expect(await deleteWebhookSecret(extId, "gone")).toBe(false);
  });
});

// ── webhook-reconcile ─────────────────────────────────────────────────

describe("reconcileWebhooks", () => {
  test("new slugs → enabled rows + initial secret minted", async () => {
    const r = await reconcileWebhooks(extId, ["tickets", "alerts"]);
    expect(r).toEqual({ added: 2, disabled: 0, preserved: 0 });
    const rows = await getTestDb().select().from(extensionWebhooks)
      .where(eq(extensionWebhooks.extensionId, extId));
    expect(rows.map((x) => x.slug).sort()).toEqual(["alerts", "tickets"]);
    expect(rows.every((x) => x.enabled)).toBe(true);
    expect(await hasWebhookSecret(extId, "tickets")).toBe(true);
    expect(await hasWebhookSecret(extId, "alerts")).toBe(true);
  });

  test("existing slug preserved; removed slug soft-disabled (row + secret kept)", async () => {
    await reconcileWebhooks(extId, ["tickets", "alerts"]);
    const secretBefore = await getWebhookSecret(extId, "tickets");
    const r = await reconcileWebhooks(extId, ["tickets"]);
    expect(r.preserved).toBe(1);
    expect(r.disabled).toBe(1);
    const alerts = await getTestDb().select().from(extensionWebhooks).where(eq(extensionWebhooks.slug, "alerts"));
    expect(alerts[0]!.enabled).toBe(false);
    // The kept slug's secret is NOT rotated by re-reconcile.
    expect(await getWebhookSecret(extId, "tickets")).toBe(secretBefore);
    // The disabled slug's secret survives (a re-declare reuses it).
    expect(await hasWebhookSecret(extId, "alerts")).toBe(true);
  });

  test("re-declaring a disabled slug re-enables it (no secret rotation)", async () => {
    await reconcileWebhooks(extId, ["tickets"]);
    const secret = await getWebhookSecret(extId, "tickets");
    await reconcileWebhooks(extId, []); // disable all
    const disabled = await getTestDb().select().from(extensionWebhooks).where(eq(extensionWebhooks.slug, "tickets"));
    expect(disabled[0]!.enabled).toBe(false);
    const r = await reconcileWebhooks(extId, ["tickets"]);
    expect(r.preserved).toBe(1);
    const reenabled = await getTestDb().select().from(extensionWebhooks).where(eq(extensionWebhooks.slug, "tickets"));
    expect(reenabled[0]!.enabled).toBe(true);
    expect(await getWebhookSecret(extId, "tickets")).toBe(secret);
  });

  test("empty grant with no existing rows → all-zero", async () => {
    const r = await reconcileWebhooks(extId, []);
    expect(r).toEqual({ added: 0, disabled: 0, preserved: 0 });
  });

  test("a secret-mint failure is swallowed — install is never bricked", async () => {
    // The registry row is still created; the hook is simply un-authenticatable
    // until the user rotates the secret (a secrets-store write must not fail
    // the whole reconcile).
    const r = await reconcileWebhooks(extId, ["resilient"], undefined, async () => {
      throw new Error("simulated secrets-store failure");
    });
    expect(r.added).toBe(1);
    const rows = await getTestDb().select().from(extensionWebhooks).where(eq(extensionWebhooks.slug, "resilient"));
    expect(rows[0]!.enabled).toBe(true);
  });

  test("malformed slugs are filtered (defense-in-depth) + deduped", async () => {
    const r = await reconcileWebhooks(extId, ["ok", "ok", "../bad", "UP", "a/b"]);
    // Only "ok" survives, once.
    expect(r.added).toBe(1);
    const rows = await getTestDb().select().from(extensionWebhooks).where(eq(extensionWebhooks.extensionId, extId));
    expect(rows.map((x) => x.slug)).toEqual(["ok"]);
  });
});

// ── webhook-store ─────────────────────────────────────────────────────

describe("webhook-store", () => {
  test("getEnabledWebhook returns enabled row, null for disabled/absent", async () => {
    await reconcileWebhooks(extId, ["tickets"]);
    const hook = await getEnabledWebhook(extId, "tickets");
    expect(hook?.slug).toBe("tickets");
    // Disable it → null.
    await reconcileWebhooks(extId, []);
    expect(await getEnabledWebhook(extId, "tickets")).toBeNull();
    // Never-declared slug → null (enumeration-safe).
    expect(await getEnabledWebhook(extId, "never")).toBeNull();
    expect(await getEnabledWebhook("no-such-ext", "tickets")).toBeNull();
  });

  test("insertDelivery persists a pending row and returns its id", async () => {
    await reconcileWebhooks(extId, ["tickets"]);
    const hook = (await getEnabledWebhook(extId, "tickets"))!;
    const at = new Date("2026-07-16T10:00:00.000Z");
    const id = await insertDelivery({
      webhookId: hook.id,
      extensionId: extId,
      slug: "tickets",
      contentType: "application/json",
      body: '{"x":1}',
      receivedAt: at,
    });
    expect(typeof id).toBe("string");
    const rows = await getTestDb().select().from(webhookDeliveries).where(eq(webhookDeliveries.id, id));
    expect(rows[0]!.status).toBe("pending");
    expect(rows[0]!.body).toBe('{"x":1}');
    expect(rows[0]!.catchUp).toBe(false);
  });

  test("countDeliveriesSince counts within the window only", async () => {
    await reconcileWebhooks(extId, ["tickets"]);
    const hook = (await getEnabledWebhook(extId, "tickets"))!;
    const today = new Date("2026-07-16T12:00:00.000Z");
    const yesterday = new Date("2026-07-15T12:00:00.000Z");
    for (const at of [today, today, yesterday]) {
      await insertDelivery({
        webhookId: hook.id, extensionId: extId, slug: "tickets",
        contentType: null, body: "x", receivedAt: at,
      });
    }
    const since = startOfUtcDay(today);
    expect(since.toISOString()).toBe("2026-07-16T00:00:00.000Z");
    // Only the two "today" deliveries count.
    expect(await countDeliveriesSince(extId, "tickets", since)).toBe(2);
  });

  test("cleanupOldWebhookDeliveries sweeps old terminal rows, keeps recent + pending/running", async () => {
    await reconcileWebhooks(extId, ["tickets"]);
    const hook = (await getEnabledWebhook(extId, "tickets"))!;
    const old = new Date(Date.now() - 60 * 86_400_000); // 60 days ago
    const recent = new Date();
    async function ins(status: "pending" | "running" | "ok" | "error", receivedAt: Date): Promise<string> {
      const [r] = await getTestDb().insert(webhookDeliveries).values({
        webhookId: hook.id, extensionId: extId, slug: "tickets", status,
        contentType: null, body: "x", receivedAt,
      }).returning({ id: webhookDeliveries.id });
      return r!.id;
    }
    const oldOk = await ins("ok", old);
    const oldErr = await ins("error", old);
    const oldPending = await ins("pending", old);   // live — NEVER swept
    const oldRunning = await ins("running", old);   // live — NEVER swept
    const recentOk = await ins("ok", recent);       // within retention — kept
    const deleted = await cleanupOldWebhookDeliveries(30);
    expect(deleted).toBe(2); // only the two OLD terminal rows
    const ids = (await getTestDb().select({ id: webhookDeliveries.id }).from(webhookDeliveries)).map((r) => r.id);
    expect(ids.sort()).toEqual([oldPending, oldRunning, recentOk].sort());
    expect(ids).not.toContain(oldOk);
    expect(ids).not.toContain(oldErr);
  });

  test("countDeliveriesSince is per-HOOK: two hooks on one ext have independent budgets", async () => {
    await reconcileWebhooks(extId, ["tickets", "alerts"]);
    const tickets = (await getEnabledWebhook(extId, "tickets"))!;
    const alerts = (await getEnabledWebhook(extId, "alerts"))!;
    const today = new Date("2026-07-16T12:00:00.000Z");
    // 3 deliveries to `tickets`, 1 to `alerts`.
    for (let i = 0; i < 3; i++) {
      await insertDelivery({ webhookId: tickets.id, extensionId: extId, slug: "tickets", contentType: null, body: "x", receivedAt: today });
    }
    await insertDelivery({ webhookId: alerts.id, extensionId: extId, slug: "alerts", contentType: null, body: "x", receivedAt: today });
    const since = startOfUtcDay(today);
    // Each hook's count reflects ONLY its own slug — a flood on `tickets` never
    // consumes `alerts`'s budget.
    expect(await countDeliveriesSince(extId, "tickets", since)).toBe(3);
    expect(await countDeliveriesSince(extId, "alerts", since)).toBe(1);
  });
});
