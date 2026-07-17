/**
 * Pipeline test (Loops EZ Mode Phase 4, reviewer C1/C1b): activate → route →
 * claim → fire, exercising the REAL `activateExtension` + the REAL public
 * `POST /api/hooks/:ext/:slug` handler + the REAL `buildFireContext` wrapper.
 *
 * The point is the ACTIVATE WIRING: this test never hand-calls
 * `reconcileWebhooks` — `activateExtension` must call it (item 5). If that wiring
 * regresses, the spy assertion fails AND the route POST below has no secret to
 * authenticate against (so it would 401). `reconcileWebhooks`'s own DB
 * correctness is covered by `src/__tests__/webhook-storage.test.ts`; here it is
 * a spy that writes the row + secret into a shared in-memory store the route
 * then reads — so activate → route → fire is one connected chain.
 *
 * The subprocess half (fire → loop `check`/`act`) is covered faithfully by
 * `docs/extensions/examples/webhook-ticket-loop/subprocess.integration.test.ts`
 * (real subprocess). This test proves the HOST half: activate registers +
 * mints, the route accepts + persists, and the dispatched fire is the delimited
 * UNTRUSTED `WebhookInput` a loop's `check` receives.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

interface DeliveryRow {
  id: string;
  webhookId: string;
  extensionId: string;
  slug: string;
  status: string;
  contentType: string | null;
  body: string;
  receivedAt: Date;
  claimedAt: Date | null;
  deliveredAt: Date | null;
  error: string | null;
  catchUp: boolean;
}

// ── Shared in-memory backing (registry + delivery queue + captured fire) ──
const registry = new Map<string, { id: string; secret: string; enabled: boolean }>();
const deliveries: DeliveryRow[] = [];
let capturedFire: Record<string, unknown> | null = null;

// reconcileWebhooks: NOT hand-called — activate calls it. The spy simulates its
// effect (create the registry row + mint the initial secret) into the shared
// store the route reads.
const reconcileWebhooks = vi.fn(async (_name: string, slugs: string[]) => {
  let added = 0;
  for (const slug of slugs) {
    if (!registry.has(slug)) {
      registry.set(slug, { id: `hook-${slug}`, secret: `ezhook_minted-${slug}`, enabled: true });
      added++;
    }
  }
  return { added, disabled: 0, preserved: 0 };
});
vi.mock("$server/extensions/webhook-reconcile", () => ({ reconcileWebhooks }));

vi.mock("$server/extensions/webhook-store", () => ({
  getEnabledWebhook: async (ext: string, slug: string) => {
    const r = registry.get(slug);
    return r?.enabled ? { id: r.id, extensionId: ext, slug, enabled: true } : null;
  },
  insertDelivery: async (input: Omit<DeliveryRow, "id" | "status" | "claimedAt" | "deliveredAt" | "error"> & { catchUp?: boolean }) => {
    const id = `del-${deliveries.length + 1}`;
    deliveries.push({
      id, webhookId: input.webhookId, extensionId: input.extensionId, slug: input.slug,
      status: "pending", contentType: input.contentType, body: input.body,
      receivedAt: input.receivedAt, claimedAt: null, deliveredAt: null, error: null,
      catchUp: input.catchUp ?? false,
    });
    return id;
  },
  countDeliveriesSince: async () => 0,
  startOfUtcDay: (d: Date) => d,
}));

vi.mock("$server/extensions/webhook-secret", () => ({
  getWebhookSecret: async (_ext: string, slug: string) => registry.get(slug)?.secret ?? null,
}));

// Real buildFireContext (the wrapper under assertion); drainDelivery captures
// the fire the daemon WOULD push to the subprocess.
vi.mock("$server/extensions/webhook-delivery-daemon", async (orig) => {
  const actual = await orig<typeof import("../../../src/extensions/webhook-delivery-daemon")>();
  return {
    ...actual,
    drainDelivery: (id: string) => {
      const row = deliveries.find((d) => d.id === id);
      // Cast to the daemon's DeliveryRow — our in-memory row is shape-compatible.
      if (row) capturedFire = actual.buildFireContext(row as never, false);
      return Promise.resolve();
    },
  };
});

const insertAuditEntry = vi.fn(async () => "audit-1");
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry }));
vi.mock("$server/db/queries/settings", () => ({ getSetting: async () => undefined }));

// ── activateExtension dependency mocks ────────────────────────────────────
let storedExtension: Record<string, unknown>;
vi.mock("$server/db/queries/extensions", () => ({
  getExtension: async () => storedExtension,
  updateExtension: async (_id: string, update: Record<string, unknown>) => ({ ...storedExtension, ...update }),
  resetFailures: async () => {},
}));
vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: { getInstance: () => ({ reload: async () => {} }) },
}));
vi.mock("$server/extensions/security", () => ({ hasSecurityViolation: async () => false }));
vi.mock("$lib/server/extension-helpers", () => ({
  clampExtensionPermissions: (submitted: { webhooks?: string[] }) => ({ webhooks: submitted.webhooks ?? [] }),
}));
vi.mock("$server/extensions/clamp-permissions", () => ({ emitEnvKeyLeakWarnings: async () => {} }));
vi.mock("$server/extensions/schedule-reconcile", () => ({ reconcileSchedules: async () => {} }));
vi.mock("$server/extensions/npm-deps", () => ({
  verifyNpmDependencies: () => ({ ok: true, issues: [] }),
  formatNpmDepError: () => "",
}));

const { activateExtension } = await import("../lib/server/extensions/activate-extension");
const { POST, __resetWebhookLimiterForTests } = await import(
  "../routes/api/hooks/[extensionId]/[slug]/+server"
);
const { webhookSignature } = await import("../../../src/extensions/webhook-auth");

const EXT_NAME = "webhook-ticket-loop";

function deliver(headers: Record<string, string>, body: string): Promise<Response> {
  return POST({
    params: { extensionId: EXT_NAME, slug: "tickets" },
    getClientAddress: () => "pipe-ip",
    request: new Request(`http://localhost/api/hooks/${EXT_NAME}/tickets`, { method: "POST", headers, body }),
  } as never) as Promise<Response>;
}

beforeEach(() => {
  registry.clear();
  deliveries.length = 0;
  capturedFire = null;
  reconcileWebhooks.mockClear();
  insertAuditEntry.mockClear();
  __resetWebhookLimiterForTests();
  storedExtension = {
    id: "ext-uuid-1",
    name: EXT_NAME,
    manifest: { permissions: { webhooks: ["tickets"] } },
    grantedPermissions: {},
    installPath: null,
  };
});

describe("webhook pipeline: activate → route → fire", () => {
  test("activate wires reconcile → registry row + secret minted → POST accepted → fire is the wrapped WebhookInput", async () => {
    // 1. Activate with a webhook grant (the wiring under test).
    const result = await activateExtension("ext-uuid-1", { submittedPermissions: { webhooks: ["tickets"] } }, "admin-1");
    expect(result.ok).toBe(true);
    // Wiring guard — activate MUST call reconcileWebhooks with the NAME (not the
    // row UUID) and the clamped granted slug. Removing item 5 fails this.
    expect(reconcileWebhooks).toHaveBeenCalledWith(EXT_NAME, ["tickets"]);
    // Effect: the registry row + its shown-once secret now exist.
    const minted = registry.get("tickets");
    expect(minted).toBeTruthy();
    const token = minted!.secret;

    // 2. A real inbound POST with the minted token is accepted + persisted.
    const body = '{"id":"T-1","priority":"high"}';
    const res = await deliver({ authorization: `Bearer ${token}`, "content-type": "application/json" }, body);
    expect(res.status).toBe(202);
    const accepted = (await res.json()) as { accepted: boolean; deliveryId: string };
    expect(accepted.accepted).toBe(true);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]!.status).toBe("pending");
    expect(deliveries[0]!.body).toBe(body);

    // 3. The dispatched fire is the delimited UNTRUSTED WebhookInput wrapper a
    //    loop's check/act receive — raw body + parsed JSON, marked untrusted.
    expect(capturedFire).toBeTruthy();
    expect(capturedFire!.slug).toBe("tickets");
    expect(capturedFire!.input).toMatchObject({
      kind: "webhook",
      slug: "tickets",
      untrusted: true,
      contentType: "application/json",
      body,
      parsed: { id: "T-1", priority: "high" },
      deliveryId: accepted.deliveryId,
    });
  });

  test("an HMAC-signed delivery on the activated hook is also accepted", async () => {
    await activateExtension("ext-uuid-1", { submittedPermissions: { webhooks: ["tickets"] } }, "admin-1");
    const token = registry.get("tickets")!.secret;
    const body = '{"id":"T-2"}';
    const res = await deliver(
      { "x-hub-signature-256": webhookSignature(token, body), "content-type": "application/json" },
      body,
    );
    expect(res.status).toBe(202);
  });

  test("regression fence: BEFORE activate the hook is unknown → route 404 (no secret to accept)", async () => {
    // The registry is empty until activate runs — the route cannot accept.
    const res = await deliver({ authorization: "Bearer ezhook_anything" }, "x");
    expect(res.status).toBe(404);
    expect(deliveries).toHaveLength(0);
  });
});
