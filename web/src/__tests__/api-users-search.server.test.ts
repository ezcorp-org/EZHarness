/**
 * Server-handler unit tests for /api/users/search/+server.ts.
 *
 * requireAuth + requireScope("read") gated. Short queries return an
 * empty list without touching the DB. Happy path filters name/email
 * case-insensitively and caps results at 10.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/users", () => ({
  listUsers: vi.fn(async () => []),
}));

const { listUsers } = await import("$server/db/queries/users");
const { GET } = await import("../routes/api/users/search/+server");

function makeEvent(opts: {
  q?: string;
  locals?: Record<string, unknown>;
}) {
  const url =
    "http://localhost/api/users/search" +
    (opts.q !== undefined ? `?q=${encodeURIComponent(opts.q)}` : "");
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

describe("GET /api/users/search", () => {
  beforeEach(() => vi.mocked(listUsers).mockReset());

  test("rejects 401 when locals.user is missing", async () => {
    await expectThrown(() => GET(makeEvent({ q: "alice" })), 401);
  });

  test("rejects 403 when API-key lacks 'read' scope", async () => {
    const res = await GET(
      makeEvent({ q: "alice", locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
  });

  test("returns empty list when query is absent", async () => {
    const res = await GET(makeEvent({ locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users?: unknown[] };
    expect(body.users).toEqual([]);
    expect(listUsers).not.toHaveBeenCalled();
  });

  test("returns empty list when query is shorter than 2 chars", async () => {
    const res = await GET(makeEvent({ q: "a", locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { users?: unknown[] };
    expect(body.users).toEqual([]);
    expect(listUsers).not.toHaveBeenCalled();
  });

  test("filters by case-insensitive name/email substring and caps at 10", async () => {
    const many = Array.from({ length: 15 }, (_, i) => ({
      id: `u${i}`,
      name: `Alice ${i}`,
      email: `alice${i}@x`,
    }));
    many.push({ id: "u-bob", name: "Bob", email: "bob@x" });
    vi.mocked(listUsers).mockResolvedValue(many as any);
    const res = await GET(makeEvent({ q: "ALI", locals: authedUser }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      users?: Array<{ id: string; name: string; email: string }>;
    };
    expect(body.users).toHaveLength(10);
    expect(body.users!.every((u) => u.name.toLowerCase().includes("ali"))).toBe(
      true,
    );
    // Only exposes safe fields.
    for (const u of body.users!) {
      expect(Object.keys(u).sort()).toEqual(["email", "id", "name"]);
    }
  });
});
