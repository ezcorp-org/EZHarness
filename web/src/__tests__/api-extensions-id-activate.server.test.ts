/**
 * Server-handler unit tests for /api/extensions/[id]/activate (+server.ts).
 *
 * Covers the gates — admin-only, 404 when extension missing, 403 when
 * violations present, 400 when grantedPermissions payload is malformed.
 * Install/registry internals are mocked at the module boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

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
  return {
    url: new URL(`http://localhost/api/extensions/${id}/activate`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/extensions/${id}/activate`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as any;
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
    const res = await POST(makeEvent({ locals: {} }));
    expect(res.status).toBe(401);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("non-admin authenticated user returns 403", async () => {
    const res = await POST(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions");
  });

  test("unknown extension id returns 404", async () => {
    vi.mocked(getExtension).mockResolvedValue(null as any);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Not found");
  });

  test("extension with unresolved security violation returns 403", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    vi.mocked(hasSecurityViolation).mockResolvedValue(true);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("security violations");
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
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("grantedPermissions must be an object");
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
    expect(res.status).toBe(400);
  });

  test("happy path: enables extension with no permissions change", async () => {
    vi.mocked(getExtension).mockResolvedValue({
      id: "ext-1",
      manifest: { permissions: {} },
    } as any);
    vi.mocked(updateExtension).mockResolvedValue({
      id: "ext-1",
      enabled: true,
    } as any);
    const res = await POST(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    expect(vi.mocked(updateExtension)).toHaveBeenCalledWith(
      "ext-1",
      expect.objectContaining({ enabled: true }),
    );
  });
});
