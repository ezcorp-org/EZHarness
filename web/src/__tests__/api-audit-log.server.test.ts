/**
 * Server-handler unit tests for /api/audit-log/+server.ts.
 *
 * Admin-role gated. Tests cover the auth/scope/role gates, the
 * limit/offset clamping (limit capped at 500, offset floored at 0),
 * and the happy path with listAuditLog mocked.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/audit-log", () => ({
  listAuditLog: vi.fn(async () => []),
}));

const { listAuditLog } = await import("$server/db/queries/audit-log");
const { GET } = await import("../routes/api/audit-log/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  query?: Record<string, string>;
}) {
  const qs = opts.query
    ? "?" + new URLSearchParams(opts.query).toString()
    : "";
  const url = "http://localhost/api/audit-log" + qs;
  return {
    url: new URL(url),
    locals: opts.locals ?? {},
    request: new Request(url),
  } as any;
}

const adminLocals = {
  user: { id: "a1", email: "a@x", name: "A", role: "admin" },
};
const memberLocals = {
  user: { id: "u1", email: "u@x", name: "U", role: "user" },
};

describe("GET /api/audit-log", () => {
  beforeEach(() => vi.mocked(listAuditLog).mockReset());

  test("returns 401 when locals.user is missing", async () => {
    const res = await GET(makeEvent({}));
    expect(res.status).toBe(401);
  });

  test("returns 403 when caller is not admin", async () => {
    const res = await GET(makeEvent({ locals: memberLocals }));
    expect(res.status).toBe(403);
  });

  test("rejects 403 when API-key lacks 'admin' scope", async () => {
    const res = await GET(
      makeEvent({ locals: { ...adminLocals, apiKeyScopes: ["read"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("caps limit at 500 and floors offset at 0", async () => {
    vi.mocked(listAuditLog).mockResolvedValue([] as any);
    await GET(
      makeEvent({
        locals: adminLocals,
        query: { limit: "9999", offset: "-5" },
      }),
    );
    expect(listAuditLog).toHaveBeenCalledWith({
      limit: 500,
      offset: 0,
      action: undefined,
    });
  });

  test("passes action filter through when supplied", async () => {
    vi.mocked(listAuditLog).mockResolvedValue([] as any);
    await GET(
      makeEvent({
        locals: adminLocals,
        query: { action: "login" },
      }),
    );
    expect(listAuditLog).toHaveBeenCalledWith({
      limit: 100,
      offset: 0,
      action: "login",
    });
  });

  test("returns entries wrapped in { entries }", async () => {
    vi.mocked(listAuditLog).mockResolvedValue([
      { id: 1, action: "x" },
    ] as any);
    const res = await GET(makeEvent({ locals: adminLocals }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { entries?: unknown[] };
    expect(body.entries).toHaveLength(1);
  });
});
