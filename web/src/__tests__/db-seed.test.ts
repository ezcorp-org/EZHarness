/**
 * Unit tests for the real-auth Playwright db-seed fixture.
 *
 * The fixture itself only knows how to call the test-only HTTP
 * endpoints; we stub a `mockRequest` that records calls and lets
 * each test prescribe the response. No webServer is spawned —
 * these tests run under `bun test` from
 * `web/src/__tests__/`.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import type { APIRequestContext } from "@playwright/test";
import {
  cleanupExtensionAuthorDraft,
  cleanupInstalledExtension,
  getCurrentUser,
  seedExtensionAuthorDraft,
} from "../../e2e/fixtures/db-seed.ts";

interface RecordedCall {
  method: "GET" | "POST" | "DELETE";
  url: string;
  data?: unknown;
}

type ResponseSpec = {
  status: number;
  body: unknown;
};

/**
 * Tiny stub of Playwright's `APIRequestContext`. We only implement
 * `get` / `post` / `delete` (the methods db-seed.ts actually calls),
 * plus a recording layer so tests can assert which endpoints fired
 * with what payloads.
 */
function makeMockRequest(responses: Record<string, ResponseSpec>) {
  const calls: RecordedCall[] = [];

  function mkResponse(spec: ResponseSpec) {
    return {
      ok: () => spec.status >= 200 && spec.status < 300,
      status: () => spec.status,
      json: async () => spec.body,
      text: async () =>
        typeof spec.body === "string" ? spec.body : JSON.stringify(spec.body),
    };
  }

  function handle(method: RecordedCall["method"], url: string, data?: unknown) {
    calls.push({ method, url, data });
    const spec = responses[`${method} ${url}`];
    if (!spec) {
      throw new Error(`No mock response for ${method} ${url}`);
    }
    return mkResponse(spec);
  }

  const mock = {
    get: async (url: string) => handle("GET", url),
    post: async (url: string, init?: { data?: unknown }) =>
      handle("POST", url, init?.data),
    delete: async (url: string) => handle("DELETE", url),
  };
  return { mock: mock as unknown as APIRequestContext, calls };
}

describe("getCurrentUser", () => {
  test("returns the user from /api/auth/me on 200", async () => {
    const { mock, calls } = makeMockRequest({
      "GET /api/auth/me": {
        status: 200,
        body: { user: { id: "u1", email: "e2e@test.local", name: "T", role: "admin" } },
      },
    });

    const user = await getCurrentUser(mock);
    expect(user.id).toBe("u1");
    expect(user.email).toBe("e2e@test.local");
    expect(calls).toEqual([{ method: "GET", url: "/api/auth/me" }]);
  });

  test("throws on non-200", async () => {
    const { mock } = makeMockRequest({
      "GET /api/auth/me": { status: 401, body: { error: "Unauthorized" } },
    });
    expect(getCurrentUser(mock)).rejects.toThrow(/401/);
  });

  test("throws on malformed payload (missing user.id)", async () => {
    const { mock } = makeMockRequest({
      "GET /api/auth/me": { status: 200, body: { user: {} } },
    });
    expect(getCurrentUser(mock)).rejects.toThrow(/malformed/);
  });
});

describe("seedExtensionAuthorDraft", () => {
  test("POSTs scaffold args + returns the parsed body", async () => {
    const seeded = {
      draftId: "draft-abc",
      draftDir: "/tmp/.ezcorp/extension-data/extension-author/drafts/u1/draft-abc",
      userId: "u1",
      files: ["ezcorp.config.ts", "index.ts"],
    };
    const { mock, calls } = makeMockRequest({
      "POST /api/__test/seed-extension-author-draft": { status: 201, body: seeded },
    });

    const got = await seedExtensionAuthorDraft({
      request: mock,
      name: "e2e-weather",
      type: "tool",
      description: "Weather lookup",
    });

    expect(got).toEqual(seeded);
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/__test/seed-extension-author-draft",
        data: { name: "e2e-weather", type: "tool", description: "Weather lookup" },
      },
    ]);
  });

  test("description defaults when omitted", async () => {
    const { mock, calls } = makeMockRequest({
      "POST /api/__test/seed-extension-author-draft": {
        status: 201,
        body: { draftId: "d1", draftDir: "/tmp/x", userId: "u1", files: [] },
      },
    });

    await seedExtensionAuthorDraft({
      request: mock,
      name: "e2e-weather",
      type: "skill",
    });

    expect(calls[0]!.data).toEqual({
      name: "e2e-weather",
      type: "skill",
      description: "E2E seeded extension",
    });
  });

  test("surfaces a descriptive error on non-2xx (hints PI_E2E_REAL)", async () => {
    const { mock } = makeMockRequest({
      "POST /api/__test/seed-extension-author-draft": {
        status: 404,
        body: { error: "Not found" },
      },
    });
    expect(
      seedExtensionAuthorDraft({ request: mock, name: "bad", type: "tool" }),
    ).rejects.toThrow(/PI_E2E_REAL=1/);
  });
});

describe("cleanupExtensionAuthorDraft", () => {
  test("DELETEs the draft and returns ok on 200", async () => {
    const { mock, calls } = makeMockRequest({
      "DELETE /api/extensions/author/draft/draft-abc": {
        status: 200,
        body: { ok: true },
      },
    });
    const r = await cleanupExtensionAuthorDraft(mock, "draft-abc");
    expect(r).toEqual({ ok: true });
    expect(calls).toEqual([
      { method: "DELETE", url: "/api/extensions/author/draft/draft-abc" },
    ]);
  });

  test("treats 404 (already gone) as success — idempotent", async () => {
    const { mock } = makeMockRequest({
      "DELETE /api/extensions/author/draft/missing": {
        status: 404,
        body: { error: "Not found" },
      },
    });
    const r = await cleanupExtensionAuthorDraft(mock, "missing");
    expect(r).toEqual({ ok: true });
  });

  test("noop on empty draftId", async () => {
    // No response registered — if the helper calls anything, the
    // mock's handle() throws "No mock response", failing the test.
    const { mock } = makeMockRequest({});
    const r = await cleanupExtensionAuthorDraft(mock, "");
    expect(r).toEqual({ ok: true });
  });

  test("throws on non-2xx / non-404, message contains server body text", async () => {
    const { mock } = makeMockRequest({
      "DELETE /api/extensions/author/draft/d1": {
        status: 500,
        body: { error: "boom" },
      },
    });
    // The helper composes its error from `(status): ${body}`; both the
    // status code AND the server's response text must surface so a
    // debugging spec author can grep the error message and find the
    // upstream cause without digging into Playwright traces.
    expect(cleanupExtensionAuthorDraft(mock, "d1")).rejects.toThrow(/500/);
    expect(cleanupExtensionAuthorDraft(mock, "d1")).rejects.toThrow(/boom/);
  });
});

describe("cleanupInstalledExtension", () => {
  test("POSTs to the test-only cleanup endpoint", async () => {
    const { mock, calls } = makeMockRequest({
      "POST /api/__test/cleanup-extension": {
        status: 200,
        body: { ok: true, rowDeleted: true, dirRemoved: true },
      },
    });
    const r = await cleanupInstalledExtension(mock, "e2e-weather");
    expect(r).toEqual({ ok: true, rowDeleted: true, dirRemoved: true });
    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/__test/cleanup-extension",
        data: { name: "e2e-weather" },
      },
    ]);
  });

  test("tolerates already-cleaned state — server returns ok:true with dirRemoved:false", async () => {
    const { mock } = makeMockRequest({
      "POST /api/__test/cleanup-extension": {
        status: 200,
        body: { ok: true, rowDeleted: false, dirRemoved: false },
      },
    });
    const r = await cleanupInstalledExtension(mock, "missing-ext");
    expect(r.ok).toBe(true);
    expect(r.rowDeleted).toBe(false);
    expect(r.dirRemoved).toBe(false);
  });

  test("throws with a hint when PI_E2E_REAL is not set (404)", async () => {
    const { mock } = makeMockRequest({
      "POST /api/__test/cleanup-extension": {
        status: 404,
        body: { error: "Not found" },
      },
    });
    expect(cleanupInstalledExtension(mock, "x")).rejects.toThrow(/PI_E2E_REAL=1/);
  });
});

describe("integration shape", () => {
  beforeEach(() => {
    // No globals — each test owns its mock. This is a sanity guard
    // for future helpers that might grow shared state.
  });

  test("seed → cleanup-draft pair forms an idempotent round trip", async () => {
    const seeded = {
      draftId: "round-trip",
      draftDir: "/tmp/r",
      userId: "u1",
      files: ["ezcorp.config.ts"],
    };
    const { mock } = makeMockRequest({
      "POST /api/__test/seed-extension-author-draft": { status: 201, body: seeded },
      "DELETE /api/extensions/author/draft/round-trip": { status: 200, body: { ok: true } },
    });

    const got = await seedExtensionAuthorDraft({ request: mock, name: "x", type: "tool" });
    expect(got.draftId).toBe("round-trip");

    const r = await cleanupExtensionAuthorDraft(mock, got.draftId);
    expect(r.ok).toBe(true);
  });
});
