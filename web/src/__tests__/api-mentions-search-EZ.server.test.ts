/**
 * Vitest server-handler tests for the `type=EZ` branch of
 * `/api/mentions/search/+server.ts`.
 *
 * The branch reads the static in-memory registry at
 * `src/runtime/ez-actions/registry.ts`, substring-matches against
 * `name` + `description` (case-insensitive), and returns route-level
 * `{ name, description, kind: "EZ" }` shapes — NO `handler` function,
 * NO internal fields. The registry path is mocked here so the test
 * controls the action set without depending on whichever phase shipped
 * the actual handlers.
 *
 * Pattern mirrors `api-mentions-search-feature.server.test.ts` and
 * `api-mentions-search-lesson.server.test.ts`. Runs under
 * `bun run test:component` (vitest), NOT `bun test`.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

const mockListEzActions = vi.fn();
vi.mock("$server/runtime/ez-actions/registry", () => ({
  listEzActions: mockListEzActions,
}));

vi.mock("$lib/server/context", () => ({
  // Handler imports getExecutor / getCommandRegistry but the EZ
  // branch doesn't touch them — harmless stubs.
  getExecutor: () => ({ listAgents: () => [] }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
}));

// Stub the DB and builtin-registry calls used by the no-colon `!`
// fallback merge path. Empty results so the EZ merge is the only
// contributor when type is undefined — keeps the assertions surgical.
vi.mock("$server/db/connection", () => ({
  getDb: () => ({
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve([]) }),
      }),
    }),
  }),
}));
vi.mock("$server/runtime/tools/builtin-registry", () => ({
  getBuiltInCategories: () => [],
}));

const { GET } = await import("../routes/api/mentions/search/+server");

function makeEvent(opts: { href: string; locals?: Record<string, unknown> }) {
  const href = opts.href;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href, { method: "GET" }),
  } as any;
}

const USER = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/mentions/search?type=EZ", () => {
  beforeEach(() => {
    mockListEzActions.mockReset();
  });

  test("empty registry → returns []", async () => {
    mockListEzActions.mockReturnValue([]);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });

  test("populated registry, no q → returns full list mapped to wire shape", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(2);
    expect(body[0]).toEqual({
      name: "distill",
      description: "Force-trigger lesson distillation",
      kind: "EZ",
    });
    expect(body[1]).toEqual({
      name: "summarize",
      description: "Summarize this conversation",
      kind: "EZ",
    });
  });

  test("substring match on name → filters down", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
      { name: "fork-conv", description: "Fork the current conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ&q=dist",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((b) => b.name)).toEqual(["distill"]);
  });

  test("substring match on description → filters down", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ&q=summary",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // "summary" doesn't appear in either name OR description → empty.
    expect(body).toEqual([]);

    const res2 = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ&q=conversation",
        locals: { user: USER },
      }),
    );
    const body2 = (await res2.json()) as Array<Record<string, unknown>>;
    // "conversation" appears in summarize's description.
    expect(body2.map((b) => b.name)).toEqual(["summarize"]);
  });

  test("case-insensitive matching", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    for (const q of ["DIST", "Dist", "dist", "DiSt"]) {
      const res = await GET(
        makeEvent({
          href: `http://localhost/api/mentions/search?type=EZ&q=${q}`,
          locals: { user: USER },
        }),
      );
      const body = (await res.json()) as Array<Record<string, unknown>>;
      expect(body.map((b) => b.name)).toEqual(["distill"]);
    }
  });

  test("no internal `handler` field leaks into the response", async () => {
    // Even if the registry returned a richer object, the route's
    // explicit `{name, description, kind}` map prevents the function
    // from reaching the wire format. We pass an extra field here and
    // confirm it's stripped.
    mockListEzActions.mockReturnValue([
      {
        name: "distill",
        description: "Force-trigger lesson distillation",
        // listEzActions's contract strips this, but just in case:
        handler: () => Promise.resolve(null),
      },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]!.handler).toBeUndefined();
    expect(Object.keys(body[0]!).sort()).toEqual(["description", "kind", "name"]);
  });

  test("type=EZ with no projectId still works (registry is global, no project scope)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    // No projectId in the query string — should still return the
    // action (unlike type=path / type=feature / type=lesson which
    // require projectId).
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=EZ",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
  });
});

// ── No-colon `!` fallback merge ───────────────────────────────────────
//
// When the user types bare `!` / `!e` / `!ez` (no colon), the trigger
// detector routes to `type: undefined`. The server merges agent + ext +
// team + EZ results. These tests verify EZ is included in the merge —
// the gap that escaped the original v1 build.
describe("GET /api/mentions/search (no type param) — EZ included in merge", () => {
  beforeEach(() => {
    mockListEzActions.mockReset();
  });

  test("no type, populated registry → EZ actions appear in merged response", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.map((b) => b.kind)).toContain("EZ");
    expect(body.find((b) => b.kind === "EZ")).toEqual({
      name: "distill",
      description: "Force-trigger lesson distillation",
      kind: "EZ",
    });
  });

  test("no type, q=dist → action matched by name appears in merged response", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=dist",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const ezResults = body.filter((b) => b.kind === "EZ");
    expect(ezResults.map((b) => b.name)).toEqual(["distill"]);
  });

  test("type=agent → EZ actions are EXCLUDED (filter respected)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=agent",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.filter((b) => b.kind === "EZ")).toEqual([]);
  });

  test("type=ext → EZ actions are EXCLUDED (filter respected)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=ext",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.filter((b) => b.kind === "EZ")).toEqual([]);
  });

  test("type=team → EZ actions are EXCLUDED (filter respected)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=team",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.filter((b) => b.kind === "EZ")).toEqual([]);
  });

  // ── Kind-prefix matching: `!ez` should surface EZ actions even when ──
  // ── the action's name/description doesn't contain "ez".            ──
  //
  // Live bug fixed here: `distill` action name has no "ez", description
  // "Force-trigger lesson distillation" has no "ez". Pre-fix, typing
  // `!ez` matched neither and the user saw an empty popover even
  // though the popover was wired to render the EZ section.

  test("no type, q=ez → ALL EZ actions surface (kind label is `ez` prefix)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=ez",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    const ez = body.filter((b) => b.kind === "EZ");
    expect(ez.map((b) => b.name).sort()).toEqual(["distill", "summarize"]);
  });

  test("no type, q=e → ALL EZ actions surface (`e` is a prefix of `ez`)", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=e",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.filter((b) => b.kind === "EZ").map((b) => b.name)).toEqual(["distill"]);
  });

  test("no type, q=Ez (mixed case) → kind-prefix match is case-insensitive", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=Ez",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body.filter((b) => b.kind === "EZ").map((b) => b.name)).toEqual(["distill"]);
  });

  test("no type, q=ezx (typo past `ez`) → name/description fallback only", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=ezx",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // Neither name nor description contains "ezx" → no match.
    expect(body.filter((b) => b.kind === "EZ")).toEqual([]);
  });

  test("no type, q=dist → name match still works alongside kind-prefix path", async () => {
    mockListEzActions.mockReturnValue([
      { name: "distill", description: "Force-trigger lesson distillation" },
      { name: "summarize", description: "Summarize this conversation" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?q=dist",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    // "dist" doesn't prefix-match "ez", so only the name-substring match fires:
    // distill matches by name, summarize doesn't.
    expect(body.filter((b) => b.kind === "EZ").map((b) => b.name)).toEqual(["distill"]);
  });
});
