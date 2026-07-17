/**
 * Server-handler tests for the public inbound webhook route
 * `POST /api/hooks/:extensionId/:slug` (Loops EZ Mode Phase 4).
 *
 * The DB + secret store are mocked; `webhook-auth` stays REAL (constant-time
 * compare + HMAC), with `constantTimeEqual` wrapped in a spy so the
 * enumeration-safe dummy-compare path is structurally observable.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

interface DeliveryInput {
  webhookId: string;
  extensionId: string;
  slug: string;
  contentType: string | null;
  body: string;
  receivedAt: Date;
  catchUp?: boolean;
}

const getEnabledWebhook = vi.fn<(ext: string, slug: string) => Promise<unknown>>();
const insertDelivery = vi.fn<(input: DeliveryInput) => Promise<string>>(async () => "del-1");
const countDeliveriesSince = vi.fn<(ext: string, since: Date) => Promise<number>>(async () => 0);
vi.mock("$server/extensions/webhook-store", () => ({
  getEnabledWebhook,
  insertDelivery,
  countDeliveriesSince,
  startOfUtcDay: (d: Date) => d,
}));

const getWebhookSecret = vi.fn<(ext: string, slug: string) => Promise<string | null>>();
vi.mock("$server/extensions/webhook-secret", () => ({ getWebhookSecret }));

const insertAuditEntry =
  vi.fn<(userId: string | null, action: string, target: string, metadata: Record<string, unknown>) => Promise<string>>(async () => "audit-1");
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry }));

const getSetting = vi.fn<(key: string) => Promise<unknown>>(async () => undefined);
vi.mock("$server/db/queries/settings", () => ({ getSetting }));

// Keep webhook-auth REAL but wrap constantTimeEqual so we can assert it runs on
// the unknown-hook path (timing-equalization structural check).
const constantTimeEqualSpy = vi.fn();
vi.mock("$server/extensions/webhook-auth", async (orig) => {
  const actual = await orig<typeof import("../../../src/extensions/webhook-auth")>();
  return {
    ...actual,
    constantTimeEqual: (a: string, b: string) => {
      constantTimeEqualSpy(a, b);
      return actual.constantTimeEqual(a, b);
    },
  };
});

const { POST, __resetWebhookLimiterForTests } = await import(
  "../routes/api/hooks/[extensionId]/[slug]/+server"
);
const { webhookSignature } = await import("../../../src/extensions/webhook-auth");
const { EXT_AUDIT_ACTIONS } = await import("../../../src/extensions/audit-actions");

const SECRET = "ezhook_the-real-secret-token";
const HOOK = { id: "hook-1", extensionId: "docs-updater", slug: "tickets", enabled: true };

function makeEvent(opts: {
  ext?: string;
  slug?: string;
  headers?: Record<string, string>;
  body?: string;
}) {
  const ext = opts.ext ?? "docs-updater";
  const slug = opts.slug ?? "tickets";
  return {
    params: { extensionId: ext, slug },
    request: new Request(`http://localhost/api/hooks/${ext}/${slug}`, {
      method: "POST",
      headers: opts.headers ?? {},
      body: opts.body ?? "",
    }),
  } as never;
}

beforeEach(() => {
  __resetWebhookLimiterForTests();
  getEnabledWebhook.mockReset().mockResolvedValue(HOOK);
  insertDelivery.mockReset().mockResolvedValue("del-1");
  countDeliveriesSince.mockReset().mockResolvedValue(0);
  getWebhookSecret.mockReset().mockResolvedValue(SECRET);
  insertAuditEntry.mockReset().mockResolvedValue("audit-1");
  getSetting.mockReset().mockResolvedValue(undefined);
  constantTimeEqualSpy.mockReset();
});

async function auditReasons(): Promise<string[]> {
  return insertAuditEntry.mock.calls
    .filter((c) => c[1] === EXT_AUDIT_ACTIONS.SDK_WEBHOOK_REJECTED)
    .map((c) => (c[3] as { reason: string }).reason);
}

describe("accept path", () => {
  test("valid Bearer → 202, delivery persisted, accepted audit (no secret/payload)", async () => {
    const res: Response = await POST(makeEvent({
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: '{"payload":"PAYLOAD_SENTINEL_9times"}',
    }));
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ accepted: true, deliveryId: "del-1" });
    expect(insertDelivery).toHaveBeenCalledTimes(1);
    const accepted = insertAuditEntry.mock.calls.find((c) => c[1] === EXT_AUDIT_ACTIONS.SDK_WEBHOOK_ACCEPTED);
    expect(accepted?.[3]).toEqual({ slug: "tickets", deliveryId: "del-1", auth: "bearer" });
    // Neither the secret nor the payload content appears in any audit metadata.
    const allMeta = JSON.stringify(insertAuditEntry.mock.calls.map((c) => c[3]));
    expect(allMeta).not.toContain(SECRET);
    expect(allMeta).not.toContain("PAYLOAD_SENTINEL_9times");
    // The persisted body is the exact raw bytes.
    expect(insertDelivery.mock.calls[0]![0].body).toBe('{"payload":"PAYLOAD_SENTINEL_9times"}');
  });

  test("valid HMAC (X-Hub-Signature-256) → 202", async () => {
    const body = '{"ticket":2}';
    const res: Response = await POST(makeEvent({
      headers: { "x-hub-signature-256": webhookSignature(SECRET, body), "content-type": "application/json" },
      body,
    }));
    expect(res.status).toBe(202);
    const accepted = insertAuditEntry.mock.calls.find((c) => c[1] === EXT_AUDIT_ACTIONS.SDK_WEBHOOK_ACCEPTED);
    expect((accepted?.[3] as { auth: string }).auth).toBe("hmac");
  });

  test("malformed JSON is accepted verbatim (raw body persisted, route never parses)", async () => {
    const res: Response = await POST(makeEvent({
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: "{not json",
    }));
    expect(res.status).toBe(202);
    expect(insertDelivery.mock.calls[0]![0].body).toBe("{not json");
  });
});

describe("auth failures → 401", () => {
  test("wrong bearer on a known hook → 401 + unauthorized audit", async () => {
    const res: Response = await POST(makeEvent({ headers: { authorization: "Bearer wrong" }, body: "x" }));
    expect(res.status).toBe(401);
    expect(await auditReasons()).toContain("unauthorized");
    expect(insertDelivery).not.toHaveBeenCalled();
  });

  test("absent auth → 401", async () => {
    const res: Response = await POST(makeEvent({ body: "x" }));
    expect(res.status).toBe(401);
  });

  test("cross-hook replay: hook A's token against hook B's secret → 401", async () => {
    // The route reads hook B's secret; A's token never matches it.
    getWebhookSecret.mockResolvedValue("ezhook_hook-B-different-secret");
    const res: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    expect(res.status).toBe(401);
  });

  test("invalid HMAC (tampered body) → 401", async () => {
    const sig = webhookSignature(SECRET, '{"a":1}');
    const res: Response = await POST(makeEvent({ headers: { "x-hub-signature-256": sig }, body: '{"a":2}' }));
    expect(res.status).toBe(401);
  });
});

describe("enumeration-safe 404", () => {
  test("unknown ext / unknown slug / disabled all → identical 404 + dummy constant-time compare", async () => {
    getEnabledWebhook.mockResolvedValue(null);
    const bodies: unknown[] = [];
    for (const [ext, slug] of [["nope", "tickets"], ["docs-updater", "never"], ["docs-updater", "disabled"]]) {
      const res: Response = await POST(makeEvent({ ext, slug, headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
      expect(res.status).toBe(404);
      bodies.push(await res.json());
    }
    // All three unknown sub-cases return the SAME body.
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[1]).toEqual(bodies[2]);
    // The dummy constant-time compare ran on every unknown-hook request (timing
    // equalization vs a real bad-auth path).
    expect(constantTimeEqualSpy).toHaveBeenCalledTimes(3);
    expect(insertDelivery).not.toHaveBeenCalled();
    expect(await auditReasons()).toEqual(["unknown", "unknown", "unknown"]);
  });

  test("malformed slug → 404 (unknown) before any DB lookup", async () => {
    const res: Response = await POST(makeEvent({ slug: "../etc", headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    expect(res.status).toBe(404);
    expect(getEnabledWebhook).not.toHaveBeenCalled();
  });
});

describe("size limits → 413", () => {
  test("oversize declared Content-Length → 413 before reading body", async () => {
    const res: Response = await POST(makeEvent({
      headers: { authorization: `Bearer ${SECRET}`, "content-length": String(256 * 1024 + 1) },
      body: "x",
    }));
    expect(res.status).toBe(413);
    expect(await auditReasons()).toContain("oversize");
  });

  test("actual body over 256KB → 413 even with a small/absent Content-Length (lying header)", async () => {
    // A Request built from a big body auto-sets content-length; delete it to
    // simulate a lying/absent header so the ACTUAL-bytes guard is what fires.
    const big = "a".repeat(256 * 1024 + 10);
    const req = new Request("http://localhost/api/hooks/docs-updater/tickets", {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
      body: big,
    });
    const spoofed = new Request(req.url, { method: "POST", headers: { authorization: `Bearer ${SECRET}` }, body: big });
    // Force the declared length to look small.
    Object.defineProperty(spoofed.headers, "get", {
      value: (k: string) => (k.toLowerCase() === "content-length" ? "5" : req.headers.get(k)),
    });
    const res: Response = await POST({ params: { extensionId: "docs-updater", slug: "tickets" }, request: spoofed } as never);
    expect(res.status).toBe(413);
  });
});

describe("rate limit + daily budget → 429", () => {
  test("per-hook burst limit: 61st request in the window → 429 + rate-limited audit", async () => {
    for (let i = 0; i < 60; i++) {
      const ok: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
      expect(ok.status).toBe(202);
    }
    const blocked: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(await auditReasons()).toContain("rate-limited");
  });

  test("daily fire budget exhausted → 429 + budget-exceeded audit", async () => {
    countDeliveriesSince.mockResolvedValue(1000); // == default budget
    const res: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    expect(res.status).toBe(429);
    expect(await auditReasons()).toContain("budget-exceeded");
    expect(insertDelivery).not.toHaveBeenCalled();
  });

  test("a settings override lowers the budget", async () => {
    getSetting.mockResolvedValue(2);
    countDeliveriesSince.mockResolvedValue(2);
    const res: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    expect(res.status).toBe(429);
  });
});
