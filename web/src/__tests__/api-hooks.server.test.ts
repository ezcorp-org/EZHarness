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
const countDeliveriesSince = vi.fn<(ext: string, slug: string, since: Date) => Promise<number>>(async () => 0);
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

// The route best-effort drains after persisting — stub it out (the daemon has
// its own tests; the route only fires-and-forgets it).
const drainDelivery = vi.fn<(id: string) => Promise<void>>(async () => undefined);
vi.mock("$server/extensions/webhook-delivery-daemon", () => ({ drainDelivery }));

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
  ip?: string;
}) {
  const ext = opts.ext ?? "docs-updater";
  const slug = opts.slug ?? "tickets";
  return {
    params: { extensionId: ext, slug },
    getClientAddress: () => opts.ip ?? "test-ip",
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

  test("daily budget count is slug-scoped (per-hook, not per-extension)", async () => {
    countDeliveriesSince.mockResolvedValue(0);
    await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x" }));
    // The budget query is keyed by (extensionName, slug, since) so two hooks on
    // one extension never share a budget.
    expect(countDeliveriesSince).toHaveBeenCalledWith("docs-updater", "tickets", expect.any(Date));
  });
});

describe("secretless enabled hook → fail CLOSED (never the DUMMY_SECRET)", () => {
  // The public DUMMY_SECRET is a compile-time constant. A hook whose secret is
  // absent / undecryptable (best-effort mint failure, corrupt ciphertext, admin
  // deletion) must NOT accept it — it rejects unconditionally after a timing-
  // uniform dummy compare.
  const DUMMY = "ezhook_0000000000000000000000000000000000000000000000000000000000";

  test("Bearer DUMMY_SECRET on a secretless hook → 401 (not 202) + dummy compare ran", async () => {
    getWebhookSecret.mockResolvedValue(null);
    const res: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${DUMMY}` }, body: "x" }));
    expect(res.status).toBe(401);
    expect(insertDelivery).not.toHaveBeenCalled();
    expect(await auditReasons()).toContain("unauthorized");
    // Timing-uniform: one constant-time compare ran against the dummy secret.
    expect(constantTimeEqualSpy).toHaveBeenCalledTimes(1);
    expect(constantTimeEqualSpy.mock.calls[0]![1]).toBe(DUMMY);
  });

  test("HMAC keyed with the DUMMY_SECRET on a secretless hook → 401 (not 202)", async () => {
    getWebhookSecret.mockResolvedValue(null);
    const body = '{"x":1}';
    const res: Response = await POST(makeEvent({
      headers: { "x-hub-signature-256": webhookSignature(DUMMY, body), "content-type": "application/json" },
      body,
    }));
    expect(res.status).toBe(401);
    expect(insertDelivery).not.toHaveBeenCalled();
  });
});

describe("pre-lookup per-IP flood limiter (bounds audit growth)", () => {
  async function floodUnknown(n: number, ip: string): Promise<Response> {
    getEnabledWebhook.mockResolvedValue(null); // every request an unknown hook
    let last!: Response;
    for (let i = 0; i < n; i++) {
      last = await POST(makeEvent({ slug: "ghost", headers: { authorization: `Bearer ${SECRET}` }, body: "x", ip }));
    }
    return last;
  }

  test("unknown-slug flood → 429 past the cap, audit rows BOUNDED (no per-request row)", async () => {
    // 120 unknown-hook requests each write one `unknown` audit row; the 121st is
    // pre-lookup rate-limited → 429 and writes at most ONE `rate-limited` row.
    const blocked = await floodUnknown(122, "flood-ip");
    expect(blocked.status).toBe(429);
    const reasons = await auditReasons();
    const unknowns = reasons.filter((r) => r === "unknown").length;
    const limited = reasons.filter((r) => r === "rate-limited").length;
    // Audit growth is bounded at the cap (120), not one-per-request (122).
    expect(unknowns).toBe(120);
    // Exactly one flood-signal row (firstBlock), not one per blocked request.
    expect(limited).toBe(1);
  });

  test("limiter does NOT distinguish known from unknown (enumeration parity)", async () => {
    // Exhaust the per-IP budget on unknown slugs, then a KNOWN hook from the
    // same IP is throttled identically — the limiter is applied pre-lookup, so
    // it cannot become a known/unknown oracle.
    await floodUnknown(120, "parity-ip");
    getEnabledWebhook.mockResolvedValue(HOOK); // now a real, known hook
    const res: Response = await POST(makeEvent({ headers: { authorization: `Bearer ${SECRET}` }, body: "x", ip: "parity-ip" }));
    expect(res.status).toBe(429);
    // The known hook never reached the accept path (blocked before lookup).
    expect(insertDelivery).not.toHaveBeenCalled();
  });

  test("getClientAddress throwing (proxy not configured) falls back to a fixed key, request proceeds", async () => {
    // A prerender/no-proxy adapter throws from getClientAddress; the handler
    // must not 500 — it falls back to the "unknown" bucket and continues.
    const event = {
      params: { extensionId: "docs-updater", slug: "tickets" },
      getClientAddress: () => { throw new Error("proxy not configured"); },
      request: new Request("http://localhost/api/hooks/docs-updater/tickets", { method: "POST", body: "x" }),
    } as never;
    const res: Response = await POST(event);
    // Absent auth on a known hook → 401 (proves it got PAST the limiter).
    expect(res.status).toBe(401);
  });

  test("attacker-controlled ext name + slug are sanitized + length-bounded in audit", async () => {
    getEnabledWebhook.mockResolvedValue(null);
    const evilExt = "x".repeat(300) + String.fromCharCode(10, 7) + "inject";
    const res: Response = await POST(makeEvent({ ext: evilExt, slug: "ghost", body: "x", ip: "sani-ip" }));
    expect(res.status).toBe(404);
    const rejectCall = insertAuditEntry.mock.calls.find((c) => c[1] === EXT_AUDIT_ACTIONS.SDK_WEBHOOK_REJECTED)!;
    const target = rejectCall[2] as string;
    // Length-bounded (≤128) and stripped of ALL control chars (incl. the
    // newline in the payload) so nothing hostile is echoed raw into the log.
    expect(target.length).toBeLessThanOrEqual(128);
    const hasControlChar = [...target].some((ch) => {
      const code = ch.charCodeAt(0);
      return code < 0x20 || code === 0x7f;
    });
    expect(hasControlChar).toBe(false);
  });
});
