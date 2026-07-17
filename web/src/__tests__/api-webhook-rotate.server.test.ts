/**
 * Server-handler tests for the admin-gated webhook secret rotate route
 * `POST /api/extensions/:name/webhooks/:slug/rotate` (Loops EZ Mode Phase 4).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const getEnabledWebhook = vi.fn<(ext: string, slug: string) => Promise<unknown>>();
vi.mock("$server/extensions/webhook-store", () => ({ getEnabledWebhook }));

const mintWebhookSecret =
  vi.fn<(ext: string, slug: string, actor?: string | null) => Promise<string>>(async () => "ezhook_freshly-rotated-token");
vi.mock("$server/extensions/webhook-secret", () => ({ mintWebhookSecret }));

const insertAuditEntry =
  vi.fn<(userId: string | null, action: string, target: string, metadata: Record<string, unknown>) => Promise<string>>(async () => "audit-1");
vi.mock("$server/db/queries/audit-log", () => ({ insertAuditEntry }));

// checkRole: admin user passes (returns the user), non-admin returns a 403.
const checkRole = vi.fn<(locals: unknown, role: "admin") => unknown>();
vi.mock("$server/auth/middleware", () => ({ checkRole }));

const { POST } = await import(
  "../routes/api/extensions/[name]/webhooks/[slug]/rotate/+server"
);
const { EXT_AUDIT_ACTIONS } = await import("../../../src/extensions/audit-actions");

const ADMIN = { id: "admin-1", email: "a@x", name: "a", role: "admin" };

function makeEvent(opts: { name?: string; slug?: string }) {
  return {
    params: { name: opts.name ?? "docs-updater", slug: opts.slug ?? "tickets" },
    locals: {},
  } as never;
}

beforeEach(() => {
  getEnabledWebhook.mockReset().mockResolvedValue({ id: "hook-1", slug: "tickets", enabled: true });
  mintWebhookSecret.mockReset().mockResolvedValue("ezhook_freshly-rotated-token");
  insertAuditEntry.mockReset().mockResolvedValue("audit-1");
  checkRole.mockReset().mockReturnValue(ADMIN);
});

describe("POST rotate", () => {
  test("admin → mints + returns the secret ONCE + audits (no secret in audit)", async () => {
    const res: Response = await POST(makeEvent({}));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ slug: "tickets", secret: "ezhook_freshly-rotated-token" });
    expect(mintWebhookSecret).toHaveBeenCalledWith("docs-updater", "tickets", "admin-1");
    const audit = insertAuditEntry.mock.calls.find((c) => c[1] === EXT_AUDIT_ACTIONS.SDK_WEBHOOK_SECRET_ROTATED);
    expect(audit?.[3]).toEqual({ slug: "tickets" });
    expect(JSON.stringify(audit?.[3])).not.toContain("ezhook_");
  });

  test("non-admin → the checkRole 403 Response is returned unchanged", async () => {
    const denied = new Response("forbidden", { status: 403 });
    checkRole.mockReturnValue(denied);
    const res: Response = await POST(makeEvent({}));
    expect(res.status).toBe(403);
    expect(mintWebhookSecret).not.toHaveBeenCalled();
  });

  test("unknown / disabled hook → opaque 404 (no mint)", async () => {
    getEnabledWebhook.mockResolvedValue(null);
    const res: Response = await POST(makeEvent({ slug: "never" }));
    expect(res.status).toBe(404);
    expect(mintWebhookSecret).not.toHaveBeenCalled();
  });

  test("malformed slug → 404 before lookup", async () => {
    const res: Response = await POST(makeEvent({ slug: "../etc" }));
    expect(res.status).toBe(404);
    expect(getEnabledWebhook).not.toHaveBeenCalled();
  });
});
