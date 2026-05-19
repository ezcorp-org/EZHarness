/**
 * Phase 49.3 — server-handler tests for
 * GET /api/marketplace/categories.
 *
 * The handler is a thin pass-through to
 * `getMarketplaceTagCounts()` — these tests pin the JSON shape
 * (`{ categories: [{ tag, count }] }`) and verify the response is
 * public (no auth gate).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/marketplace", () => ({
  getMarketplaceTagCounts: vi.fn(),
}));

const { getMarketplaceTagCounts } = await import(
  "$server/db/queries/marketplace"
);
const { GET } = await import("../routes/api/marketplace/categories/+server.ts");

beforeEach(() => {
  (getMarketplaceTagCounts as ReturnType<typeof vi.fn>).mockReset();
});

function makeEvent() {
  return {
    url: new URL("http://localhost/api/marketplace/categories"),
    locals: {},
    params: {},
    request: new Request("http://localhost/api/marketplace/categories"),
  } as never;
}

describe("GET /api/marketplace/categories", () => {
  test("returns the tag-count list under `categories`", async () => {
    (getMarketplaceTagCounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { tag: "research", count: 7 },
      { tag: "writing", count: 3 },
    ]);
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      categories: [
        { tag: "research", count: 7 },
        { tag: "writing", count: 3 },
      ],
    });
  });

  test("empty taxonomy → `{ categories: [] }` (not 404)", async () => {
    (getMarketplaceTagCounts as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ categories: [] });
  });

  test("no auth required — handler ignores `locals` entirely", async () => {
    (getMarketplaceTagCounts as ReturnType<typeof vi.fn>).mockResolvedValue([
      { tag: "x", count: 1 },
    ]);
    const res = await GET(makeEvent());
    expect(res.status).toBe(200);
    // `locals.user` was never read — no requireAuth gate.
    expect(getMarketplaceTagCounts).toHaveBeenCalledTimes(1);
  });
});
