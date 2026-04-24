/**
 * Server-handler unit tests for /api/marketplace/flags (+server.ts).
 *
 * Admin-only list of pending flag reports. DB queries mocked.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace-ratings", () => ({
  listFlags: vi.fn(),
}));

vi.mock("$server/db/queries/marketplace", () => ({
  getListingById: vi.fn(),
}));

const { listFlags } = await import("$server/db/queries/marketplace-ratings");
const { getListingById } = await import("$server/db/queries/marketplace");
const { GET } = await import("../routes/api/marketplace/flags/+server.ts");

function makeEvent(opts: { locals?: Record<string, unknown> }) {
  return {
    url: new URL("http://localhost/api/marketplace/flags"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/marketplace/flags"),
  } as any;
}

const adminUser = { id: "u1", email: "a@x", name: "a", role: "admin" };
const regularUser = { id: "u2", email: "u@x", name: "u", role: "user" };

describe("GET /api/marketplace/flags", () => {
  beforeEach(() => {
    vi.mocked(listFlags).mockReset();
    vi.mocked(getListingById).mockReset();
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

  test("non-admin authenticated user throws 403", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: { user: regularUser } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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
    expect(body.required).toBe("admin");
  });

  test("happy path: returns enriched flag list", async () => {
    vi.mocked(listFlags).mockResolvedValue([
      { id: "f1", listingId: "l1", reason: "spam" },
    ] as any);
    vi.mocked(getListingById).mockResolvedValue({
      id: "l1",
      name: "Listing 1",
      slug: "listing-1",
    } as any);
    const res = await GET(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flags: Array<{ id: string; listing: { name: string } | null }>;
    };
    expect(body.flags).toHaveLength(1);
    expect(body.flags[0].listing?.name).toBe("Listing 1");
    expect(vi.mocked(listFlags)).toHaveBeenCalledWith({ status: "pending" });
  });

  test("enrichment tolerates missing listing", async () => {
    vi.mocked(listFlags).mockResolvedValue([
      { id: "f1", listingId: "l-missing" },
    ] as any);
    vi.mocked(getListingById).mockResolvedValue(null as any);
    const res = await GET(makeEvent({ locals: { user: adminUser } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      flags: Array<{ listing: unknown }>;
    };
    expect(body.flags[0].listing).toBeNull();
  });
});
