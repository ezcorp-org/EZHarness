/**
 * Server-handler unit tests for /api/observability/+server.ts.
 *
 * Auth + read-scope gated. The observability query is mocked; the test
 * asserts the NaN-safe default (30) and that query values flow through.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/observability", () => ({
  getGlobalStats: vi.fn(async () => ({ totalRuns: 0 })),
}));

const { getGlobalStats } = await import(
  "$server/db/queries/observability"
);
const { GET } = await import("../routes/api/observability/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  query?: Record<string, string>;
}) {
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  const url = "http://localhost/api/observability" + qs;
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    request: new Request(url),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

async function expectThrown(
  fn: () => Promise<Response> | Response,
  status: number,
): Promise<Response> {
  let res: Response | undefined;
  try {
    res = await fn();
  } catch (thrown) {
    expect(thrown).toBeInstanceOf(Response);
    res = thrown as Response;
  }
  expect(res!.status).toBe(status);
  return res!;
}

describe("GET /api/observability", () => {
  beforeEach(() => vi.mocked(getGlobalStats).mockReset());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({})), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("defaults days to 30 when not supplied", async () => {
    vi.mocked(getGlobalStats).mockResolvedValue({ totalRuns: 5 } as any);
    await GET(makeEvent({ locals: authedUser }));
    expect(getGlobalStats).toHaveBeenCalledWith({ days: 30 });
  });

  test("falls back to 30 when days query is NaN", async () => {
    vi.mocked(getGlobalStats).mockResolvedValue({ totalRuns: 5 } as any);
    await GET(
      makeEvent({ locals: authedUser, query: { days: "notanumber" } }),
    );
    expect(getGlobalStats).toHaveBeenCalledWith({ days: 30 });
  });

  test("passes parsed days through to getGlobalStats", async () => {
    vi.mocked(getGlobalStats).mockResolvedValue({ totalRuns: 5 } as any);
    await GET(makeEvent({ locals: authedUser, query: { days: "7" } }));
    expect(getGlobalStats).toHaveBeenCalledWith({ days: 7 });
  });

  test("returns 200 with stats body", async () => {
    vi.mocked(getGlobalStats).mockResolvedValue({ totalRuns: 42 } as any);
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { totalRuns?: number };
    expect(body.totalRuns).toBe(42);
  });
});
