/**
 * Server-handler unit tests for /api/marketplace/updates (+server.ts).
 *
 * Given a comma-separated list of installed agent-config IDs, reports
 * which have marketplace updates available. Settings + marketplace-listing
 * queries are mocked.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/settings", () => ({
  getSetting: vi.fn(),
}));

vi.mock("$server/db/queries/marketplace", () => ({
  getListingById: vi.fn(),
}));

const { getSetting } = await import("$server/db/queries/settings");
const { getListingById } = await import("$server/db/queries/marketplace");
const { GET } = await import("../routes/api/marketplace/updates/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  ids?: string;
}) {
  const href = opts.ids
    ? `http://localhost/api/marketplace/updates?ids=${opts.ids}`
    : "http://localhost/api/marketplace/updates";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/marketplace/updates", () => {
  beforeEach(() => {
    vi.mocked(getSetting).mockReset();
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

  test("API-key scope check returns 403 when scope missing", async () => {
    const res = await GET(
      makeEvent({ locals: { user, apiKeyScopes: ["read"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
  });

  test("returns empty object when ids query param absent", async () => {
    const res = await GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  test("skips ids with no installed-marketplace setting", async () => {
    vi.mocked(getSetting).mockResolvedValue(undefined as any);
    const res = await GET(
      makeEvent({ locals: { user }, ids: "cfg-a,cfg-b" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  test("skips ids whose listing is gone", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      listingId: "l1",
      version: "1.0.0",
      installedAt: "now",
    } as any);
    vi.mocked(getListingById).mockResolvedValue(null as any);
    const res = await GET(
      makeEvent({ locals: { user }, ids: "cfg-a" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).toEqual({});
  });

  test("happy path: reports hasUpdate=true when latestVersion differs", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      listingId: "l1",
      version: "1.0.0",
      installedAt: "now",
    } as any);
    vi.mocked(getListingById).mockResolvedValue({
      id: "l1",
      latestVersion: "1.2.0",
    } as any);
    const res = await GET(
      makeEvent({ locals: { user }, ids: "cfg-a" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<
      string,
      { hasUpdate: boolean; currentVersion: string; latestVersion: string }
    >;
    expect(body["cfg-a"]).toBeDefined();
    expect(body["cfg-a"].hasUpdate).toBe(true);
    expect(body["cfg-a"].currentVersion).toBe("1.0.0");
    expect(body["cfg-a"].latestVersion).toBe("1.2.0");
  });

  test("reports hasUpdate=false when versions match", async () => {
    vi.mocked(getSetting).mockResolvedValue({
      listingId: "l1",
      version: "1.2.0",
      installedAt: "now",
    } as any);
    vi.mocked(getListingById).mockResolvedValue({
      id: "l1",
      latestVersion: "1.2.0",
    } as any);
    const res = await GET(
      makeEvent({ locals: { user }, ids: "cfg-a" }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<
      string,
      { hasUpdate: boolean }
    >;
    expect(body["cfg-a"].hasUpdate).toBe(false);
  });
});
