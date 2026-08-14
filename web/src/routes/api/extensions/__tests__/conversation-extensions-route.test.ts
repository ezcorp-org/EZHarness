/**
 * Server-handler unit tests for POST + GET
 * /api/conversations/[id]/extensions (+server.ts) — the per-conversation
 * extension-wiring route.
 *
 * WHY THIS FILE LIVES HERE (not beside the route): the coverage host set
 * (`scripts/lib/test-file-sets.sh`, CODEOWNERS-owned) globs
 * `web/src/routes/api/extensions/__tests__` but NOT
 * `web/src/routes/api/conversations/**`. Placing this bun:test here means the
 * per-file `--coverage` pool measures the route's `+server.ts` at 100% without
 * a gate-file edit. The import reaches across the route tree to the handler.
 *
 * The DB-query + ownership boundaries are mocked at the import boundary (no
 * PGlite); the scope + auth gates run for REAL so 401/403 are genuinely
 * exercised. Same posture as api-runs-id's server test.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "../../../../../../src/__tests__/helpers/mock-cleanup";

// ── Ownership: resolves to a truthy pair by default; set null to deny. ──
let ownershipResult: unknown = { conv: { id: "c1" }, root: { id: "c1" } };
const mockResolveOwnership = mock(async (_id: string, _user: unknown) => ownershipResult);
mock.module("$lib/server/conversation-ownership", () => ({
  resolveRootConversationForOwnership: mockResolveOwnership,
}));

// ── Extensions table: name→row and id→row lookup fixtures. ──
let extByName = new Map<string, { id: string; name: string }>();
let extById = new Map<string, { id: string; name: string }>();
const mockGetExtensionsByNames = mock(async (names: string[]) => {
  const m = new Map<string, { id: string; name: string }>();
  for (const n of names) {
    const e = extByName.get(n);
    if (e) m.set(n, e);
  }
  return m;
});
const mockGetExtension = mock(async (id: string) => extById.get(id) ?? null);
mock.module("$server/db/queries/extensions", () => ({
  getExtensionsByNames: mockGetExtensionsByNames,
  getExtension: mockGetExtension,
}));

// ── conversation_extensions writes/reads. ──
const mockAddConversationExtensions = mock(
  async (_cid: string, _entries: { extensionId: string }[]) => undefined,
);
let wiredIds: string[] = [];
const mockGetConversationExtensionIds = mock(async (_cid: string) => wiredIds);
mock.module("$server/db/queries/conversation-extensions", () => ({
  addConversationExtensions: mockAddConversationExtensions,
  getConversationExtensionIds: mockGetConversationExtensionIds,
}));

// ── Wire-authz gate: mocked as a SEAM, not re-tested here. ──
// The gate's own branch matrix (MCP detection, admin / creator / `use`-grant
// rungs, fail-closed) is unit-tested in
// `src/__tests__/extension-wire-authz.test.ts`, and the whole path is driven
// against real PGlite in `src/__tests__/mcp-wire-authz.integration.test.ts`.
// What this file owns is the ROUTE's half of the contract: that it consults
// the gate at all, with the right coordinates, and that it reports a denial
// as a miss.
let deniedNames: string[] = [];
const mockPartition = mock(
  async (candidates: Array<{ id: string; name: string }>, _actor: unknown) => ({
    allowed: candidates.filter((c) => !deniedNames.includes(c.name)),
    deniedNames: candidates.filter((c) => deniedNames.includes(c.name)).map((c) => c.name),
  }),
);
mock.module("$server/auth/extension-wire-authz", () => ({
  partitionWirableExtensions: mockPartition,
}));

const { GET, POST } = await import("../../conversations/[id]/extensions/+server");

const user = { id: "u1", email: "u@x", name: "u", role: "member" };

function postEvent(opts: {
  cid?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
}) {
  const cid = opts.cid ?? "c1";
  const url = `http://localhost/api/conversations/${cid}/extensions`;
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: opts.rawBody !== undefined ? opts.rawBody : JSON.stringify(opts.body ?? {}),
  });
  return { url: new URL(url), params: { id: cid }, locals: opts.locals ?? {}, request } as never;
}

function getEvent(opts: { cid?: string; locals?: Record<string, unknown> }) {
  const cid = opts.cid ?? "c1";
  const url = `http://localhost/api/conversations/${cid}/extensions`;
  return {
    url: new URL(url),
    params: { id: cid },
    locals: opts.locals ?? {},
    request: new Request(url, { method: "GET" }),
  } as never;
}

beforeEach(() => {
  ownershipResult = { conv: { id: "c1" }, root: { id: "c1" } };
  extByName = new Map();
  extById = new Map();
  wiredIds = [];
  deniedNames = [];
  mockPartition.mockClear();
  mockResolveOwnership.mockClear();
  mockGetExtensionsByNames.mockClear();
  mockGetExtension.mockClear();
  mockAddConversationExtensions.mockClear();
  mockGetConversationExtensionIds.mockClear();
});

// mock.module() permanently replaces modules in Bun's loader cache; restore
// the snapshotted reals in afterAll so nothing leaks into later test files.
afterAll(() => restoreModuleMocks());

describe("POST /api/conversations/[id]/extensions — gates", () => {
  test("403 when an API key lacks the 'extensions' scope", async () => {
    const res = await POST(postEvent({ locals: { user, apiKeyScopes: ["read", "chat"] }, body: { names: ["a"] } }));
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
  });

  test("401 when unauthenticated (no user, cookie session)", async () => {
    let thrown: Response | undefined;
    try {
      await POST(postEvent({ locals: {}, body: { names: ["a"] } }));
      expect.unreachable("should have thrown");
    } catch (e) {
      thrown = e as Response;
    }
    expect(thrown).toBeInstanceOf(Response);
    expect(thrown!.status).toBe(401);
  });

  test("404 when the caller does not own the conversation (or it is missing)", async () => {
    ownershipResult = null;
    const res = await POST(postEvent({ locals: { user }, body: { names: ["a"] } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error?: string }).error).toBe("Not found");
    expect(mockAddConversationExtensions).not.toHaveBeenCalled();
  });
});

describe("POST — body validation (400)", () => {
  test("400 on invalid JSON", async () => {
    const res = await POST(postEvent({ locals: { user }, rawBody: "{ not json" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("Invalid JSON body");
  });

  test("400 on empty names array", async () => {
    const res = await POST(postEvent({ locals: { user }, body: { names: [] } }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toBe("Validation failed");
  });

  test("400 when a name is an empty string", async () => {
    const res = await POST(postEvent({ locals: { user }, body: { names: [""] } }));
    expect(res.status).toBe(400);
  });

  test("400 when a name is not a string", async () => {
    const res = await POST(postEvent({ locals: { user }, body: { names: [123] } }));
    expect(res.status).toBe(400);
  });

  test("400 when the names key is absent", async () => {
    const res = await POST(postEvent({ locals: { user }, body: {} }));
    expect(res.status).toBe(400);
  });

  test("400 when names is not an array", async () => {
    const res = await POST(postEvent({ locals: { user }, body: { names: "scratchpad" } }));
    expect(res.status).toBe(400);
  });

  test("400 when names exceeds the max of 20", async () => {
    const names = Array.from({ length: 21 }, (_, i) => `ext-${i}`);
    const res = await POST(postEvent({ locals: { user }, body: { names } }));
    expect(res.status).toBe(400);
  });

  test("400 on an unknown top-level key (strict schema)", async () => {
    const res = await POST(postEvent({ locals: { user }, body: { names: ["a"], extra: 1 } }));
    expect(res.status).toBe(400);
  });
});

describe("POST — wiring", () => {
  test("404 with the offending set when any name is unknown, and wires NOTHING", async () => {
    extByName.set("known", { id: "id-known", name: "known" });
    const res = await POST(postEvent({ locals: { user }, body: { names: ["known", "ghost"] } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string; unknown?: string[] };
    expect(body.error).toBe("Unknown extension(s)");
    expect(body.unknown).toEqual(["ghost"]);
    expect(mockAddConversationExtensions).not.toHaveBeenCalled();
  });

  test("200 happy path writes rows and returns wired + extensionIds", async () => {
    extByName.set("a", { id: "id-a", name: "a" });
    extByName.set("b", { id: "id-b", name: "b" });
    const res = await POST(postEvent({ locals: { user, apiKeyScopes: ["extensions"] }, body: { names: ["a", "b"] } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wired: string[]; extensionIds: string[] };
    expect(body.wired).toEqual(["a", "b"]);
    expect(body.extensionIds).toEqual(["id-a", "id-b"]);
    expect(mockAddConversationExtensions).toHaveBeenCalledWith("c1", [
      { extensionId: "id-a" },
      { extensionId: "id-b" },
    ]);
  });

  test("200 idempotent + dedupes repeated names (cookie session passes scope gate)", async () => {
    extByName.set("a", { id: "id-a", name: "a" });
    const res = await POST(postEvent({ locals: { user }, body: { names: ["a", "a"] } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wired: string[]; extensionIds: string[] };
    expect(body.wired).toEqual(["a"]);
    expect(body.extensionIds).toEqual(["id-a"]);
    expect(mockAddConversationExtensions).toHaveBeenCalledWith("c1", [{ extensionId: "id-a" }]);
  });
});

describe("POST — wire-authz (B1)", () => {
  test("a denied name is reported as UNKNOWN, byte-identical to a missing one", async () => {
    extByName.set("weather-mcp", { id: "id-mcp", name: "weather-mcp" });
    deniedNames = ["weather-mcp"];

    const res = await POST(postEvent({ locals: { user }, body: { names: ["weather-mcp"] } }));
    expect(res.status).toBe(404);
    const body = (await res.json()) as { error?: string; unknown?: string[] };
    // The row EXISTS and resolved — the 404 is the authorization answer, and
    // it must be indistinguishable from a genuine miss so a member cannot
    // enumerate admin-installed MCP servers by probing names.
    expect(body).toEqual({ error: "Unknown extension(s)", unknown: ["weather-mcp"] });
    expect(mockAddConversationExtensions).not.toHaveBeenCalled();
  });

  test("a denial makes the batch ALL-OR-NOTHING — the allowed sibling is not wired", async () => {
    extByName.set("ok", { id: "id-ok", name: "ok" });
    extByName.set("weather-mcp", { id: "id-mcp", name: "weather-mcp" });
    deniedNames = ["weather-mcp"];

    const res = await POST(postEvent({ locals: { user }, body: { names: ["ok", "weather-mcp"] } }));
    expect(res.status).toBe(404);
    expect(((await res.json()) as { unknown?: string[] }).unknown).toEqual(["weather-mcp"]);
    expect(mockAddConversationExtensions).not.toHaveBeenCalled();
  });

  test("unknown and denied names are reported TOGETHER, in request order", async () => {
    extByName.set("weather-mcp", { id: "id-mcp", name: "weather-mcp" });
    deniedNames = ["weather-mcp"];

    const res = await POST(
      postEvent({ locals: { user }, body: { names: ["weather-mcp", "ghost"] } }),
    );
    expect(((await res.json()) as { unknown?: string[] }).unknown).toEqual(["weather-mcp", "ghost"]);
  });

  test("the gate is asked ONLY about resolved rows, with the conversation's project", async () => {
    ownershipResult = { conv: { id: "c1", projectId: "proj-9" }, root: { id: "c1" } };
    extByName.set("a", { id: "id-a", name: "a" });

    const res = await POST(postEvent({ locals: { user }, body: { names: ["a", "ghost"] } }));
    expect(res.status).toBe(404); // "ghost" is unknown

    expect(mockPartition).toHaveBeenCalledTimes(1);
    const [candidates, actor] = mockPartition.mock.calls[0]!;
    // "ghost" never resolved, so there is no row to authorize.
    expect(candidates).toEqual([{ id: "id-a", name: "a" }]);
    // The project coordinate comes off the CONVERSATION, never the body —
    // a client-supplied project would let a caller pick the coordinates its
    // grants happen to cover.
    expect(actor).toEqual({ user: { id: "u1", role: "member" }, projectId: "proj-9" });
  });

  test("a conversation with no project checks at the all-projects (null) coordinate", async () => {
    ownershipResult = { conv: { id: "c1" }, root: { id: "c1" } };
    extByName.set("a", { id: "id-a", name: "a" });

    await POST(postEvent({ locals: { user }, body: { names: ["a"] } }));
    expect((mockPartition.mock.calls[0]![1] as { projectId: unknown }).projectId).toBeNull();
  });
});

describe("GET /api/conversations/[id]/extensions", () => {
  test("403 when an API key lacks the 'read' scope", async () => {
    const res = await GET(getEvent({ locals: { user, apiKeyScopes: ["chat"] } }));
    expect(res.status).toBe(403);
    expect(((await res.json()) as { required?: string }).required).toBe("read");
  });

  test("401 when unauthenticated", async () => {
    let thrown: Response | undefined;
    try {
      await GET(getEvent({ locals: {} }));
      expect.unreachable("should have thrown");
    } catch (e) {
      thrown = e as Response;
    }
    expect(thrown!.status).toBe(401);
  });

  test("404 when the caller does not own the conversation", async () => {
    ownershipResult = null;
    const res = await GET(getEvent({ locals: { user } }));
    expect(res.status).toBe(404);
  });

  test("200 returns the wired set as { id, name }", async () => {
    wiredIds = ["id-1", "id-2"];
    extById.set("id-1", { id: "id-1", name: "ext-one" });
    extById.set("id-2", { id: "id-2", name: "ext-two" });
    const res = await GET(getEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions: Array<{ id: string; name: string }> };
    expect(body.extensions).toEqual([
      { id: "id-1", name: "ext-one" },
      { id: "id-2", name: "ext-two" },
    ]);
  });

  test("200 skips a wired id whose extension row was deleted", async () => {
    wiredIds = ["id-1", "gone"];
    extById.set("id-1", { id: "id-1", name: "ext-one" });
    const res = await GET(getEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { extensions: Array<{ id: string; name: string }> };
    expect(body.extensions).toEqual([{ id: "id-1", name: "ext-one" }]);
  });

  test("200 with an empty list when nothing is wired", async () => {
    wiredIds = [];
    const res = await GET(getEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { extensions: unknown[] }).extensions).toEqual([]);
  });
});
