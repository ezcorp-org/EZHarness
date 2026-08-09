/**
 * Endpoint test for GET /api/version. The handler is a thin passthrough:
 * call getUpdateCheck() and return it as JSON. We mock the server module so
 * this exercises ONLY the endpoint wiring (call → json() → 200), decoupled
 * from GitHub / cache / db. The full getUpdateCheck behaviour is covered by
 * src/__tests__/update-check.test.ts.
 *
 * Runs under the vitest leg (resolves the `$server` alias) so the route's
 * line coverage is measured and gated; bun:test can't resolve `$server`
 * from the repo-root coverage runner.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const { getUpdateCheck } = vi.hoisted(() => ({ getUpdateCheck: vi.fn() }));
vi.mock("$server/update-check", () => ({ getUpdateCheck }));

describe("GET /api/version", () => {
  beforeEach(() => getUpdateCheck.mockReset());

  test("returns getUpdateCheck()'s result as a 200 JSON response", async () => {
    const result = {
      current: "1.3.0",
      latest: "1.4.0",
      updateAvailable: true,
      checkedAt: "2026-06-01T00:00:00.000Z",
      source: "github-releases",
      releaseUrl: "https://github.com/ezcorp-org/EZCorp/releases/tag/app-v1.4.0",
    };
    getUpdateCheck.mockResolvedValue(result);

    const { GET } = await import("../routes/api/version/+server");
    const res = await (GET as (event: unknown) => Promise<Response>)({});

    expect(getUpdateCheck).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(result);
  });

  test("passes through the disabled-mode shape unchanged", async () => {
    const disabled = {
      current: "dev",
      latest: null,
      updateAvailable: false,
      checkedAt: null,
      source: "disabled",
    };
    getUpdateCheck.mockResolvedValue(disabled);

    const { GET } = await import("../routes/api/version/+server");
    const res = await (GET as (event: unknown) => Promise<Response>)({});

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(disabled);
  });
});
