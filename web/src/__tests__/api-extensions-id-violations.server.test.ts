/**
 * Server-handler unit tests for /api/extensions/[id]/violations (+server.ts).
 *
 * Admin-only. GET returns current violations; DELETE clears them so the
 * extension can be re-enabled. Both are mocked at the security-module
 * boundary.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/extensions/security", () => ({
  getSecurityViolations: vi.fn(),
  clearSecurityViolations: vi.fn(async () => undefined),
}));

const { getSecurityViolations, clearSecurityViolations } = await import(
  "$server/extensions/security"
);
const { GET, DELETE } = await import(
  "../routes/api/extensions/[id]/violations/+server.ts"
);

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
}) {
  const id = opts.id ?? "ext-1";
  return {
    url: new URL(`http://localhost/api/extensions/${id}/violations`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/extensions/${id}/violations`),
  } as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/extensions/[id]/violations", () => {
  beforeEach(() => {
    vi.mocked(getSecurityViolations).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("non-admin authenticated user returns 403", async () => {
    const res = await GET(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Admin access required");
  });

  test("API-key scope check returns 403 when scope missing", async () => {
    const res = await GET(
      makeEvent({
        locals: { user: adminUser, apiKeyScopes: ["read"] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
  });

  test("happy path: returns violations array", async () => {
    vi.mocked(getSecurityViolations).mockResolvedValue([
      { id: "v1", reason: "test" },
    ] as any);
    const res = await GET(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { violations: unknown[] };
    expect(body.violations).toHaveLength(1);
  });
});

describe("DELETE /api/extensions/[id]/violations", () => {
  beforeEach(() => {
    vi.mocked(clearSecurityViolations).mockReset();
  });

  test("unauthenticated request throws 401", async () => {
    let res: Response | undefined;
    try {
      await DELETE(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("non-admin authenticated user returns 403", async () => {
    const res = await DELETE(makeEvent({ locals: { user: regularUser } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Admin access required");
  });

  test("happy path: clears violations and returns cleared=true", async () => {
    const res = await DELETE(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { cleared: boolean };
    expect(body.cleared).toBe(true);
    expect(vi.mocked(clearSecurityViolations)).toHaveBeenCalledWith("ext-1");
  });
});
