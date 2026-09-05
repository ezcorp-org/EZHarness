
import { test, expect, describe, vi, beforeEach } from "vitest";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/extensions", () => ({
  getExtension: vi.fn(),
  updateExtension: vi.fn(),
  resetFailures: vi.fn(async () => undefined),
}));

vi.mock("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({ reload: vi.fn(async () => undefined) }),
  },
}));

vi.mock("$server/extensions/security", () => ({
  hasSecurityViolation: vi.fn(async () => false),
}));

vi.mock("$server/db/queries/audit-log", () => ({
  insertAuditEntry: vi.fn(async () => undefined),
}));

const { getExtension, updateExtension } = await import("$server/db/queries/extensions");
const { hasSecurityViolation } = await import("$server/extensions/security");
const { POST } = await import(
  "../routes/api/extensions/[id]/activate/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const id = opts.id ?? "ext-1";
  return makeRequestEvent(`http://localhost/api/extensions/${id}/activate`, {
    locals: opts.locals ?? {},
    params: { id },
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    },
  });
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("POST /api/extensions/[id]/activate", () => {
  beforeEach(() => {
    vi.mocked(getExtension).mockReset();
    vi.mocked(updateExtension).mockReset();
    vi.mocked(hasSecurityViolation).mockReset().mockResolvedValue(false);
  });

  test("unauthenticated request returns 401", async () => {
    const res = await expectThrownResponse(() => POST(makeEvent({ locals: {} })), 401);
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("non-admin authenticated user receives a migration response", async () => {
    const res = await POST(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body).toMatchObject({ code: "extension_v4_required" });
    expect(updateExtension).not.toHaveBeenCalled();
  });

  test("unknown extension id cannot bypass migration", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body).toMatchObject({ code: "extension_v4_required" });
    expect(updateExtension).not.toHaveBeenCalled();
  });

  test("extension with unresolved security violation receives a migration response", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    vi.mocked(hasSecurityViolation).mockResolvedValue(true);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body).toMatchObject({ code: "extension_v4_required" });
    expect(updateExtension).not.toHaveBeenCalled();
  });

  test("grantedPermissions must be an object (array rejected)", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { grantedPermissions: ["not", "an", "object"] },
      }),
    );
    expect(res.status).toBe(410);
    const body = (await res.json()) as { error?: string };
    expect(body).toMatchObject({ code: "extension_v4_required" });
    expect(updateExtension).not.toHaveBeenCalled();
  });

  test("grantedPermissions must be an object (null rejected)", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    const res = await POST(
      makeEvent({
        locals: { user: adminUser },
        body: { grantedPermissions: null },
      }),
    );
    expect(res.status).toBe(410);
  });

  test("retired route never enables an extension", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    vi.mocked(updateExtension).mockResolvedValue({
      id: "ext-1",
      enabled: true,
    } as any);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(410);
    expect(updateExtension).not.toHaveBeenCalled();
  });
});
