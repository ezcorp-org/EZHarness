/**
 * Vitest server-handler tests for the `type=feature` branch added to
 * `/api/mentions/search/+server.ts` (dev's #4).
 *
 * The branch resolves the active project, calls
 * `$server/db/queries/features::listFeatures`, fuzzy-ranks by name OR
 * description, and returns at most MAX_RESULTS=10 entries with shape
 * `{ name, description, kind: "feature", fileCount }`.
 *
 * Pattern mirrors the existing `api-mentions-search.server.test.ts`:
 * uses vitest's `vi.mock` for $server aliases. Runs under
 * `bun run test:component` (vitest), NOT `bun test` (which excludes
 * `.server.test.ts` files via the bunfig root + scripts/test.sh).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/projects", () => ({
  getProject: vi.fn(),
}));

const mockListFeatures = vi.fn();
vi.mock("$server/db/queries/features", () => ({
  listFeatures: mockListFeatures,
}));

vi.mock("$lib/server/context", () => ({
  // The handler imports getExecutor / getCommandRegistry but neither is
  // touched by the `type=feature` branch — provide harmless stubs anyway.
  getExecutor: () => ({ listAgents: () => [] }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
}));

const { getProject } = await import("$server/db/queries/projects");
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

describe("GET /api/mentions/search?type=feature", () => {
  beforeEach(() => {
    vi.mocked(getProject).mockReset();
    mockListFeatures.mockReset();
  });

  test("missing projectId → returns []", async () => {
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
    // Should NOT have hit the DB.
    expect(mockListFeatures).not.toHaveBeenCalled();
  });

  test("unknown projectId → returns [] (no listFeatures call)", async () => {
    vi.mocked(getProject).mockResolvedValue(undefined as any);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=ghost",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
    expect(vi.mocked(getProject)).toHaveBeenCalledWith("ghost");
    expect(mockListFeatures).not.toHaveBeenCalled();
  });

  test("empty query → returns all features (up to MAX_RESULTS=10) in listFeatures order", async () => {
    vi.mocked(getProject).mockResolvedValue({
      id: "p1",
      name: "Alpha",
      path: "/tmp/alpha",
    } as any);
    mockListFeatures.mockResolvedValue([
      { id: "f1", name: "auth", description: "Auth module", fileCount: 5, source: "agent" },
      { id: "f2", name: "chat", description: "Chat surface", fileCount: 12, source: "user" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<{
      name: string;
      description: string;
      kind: string;
      fileCount: number;
    }>;
    expect(body).toHaveLength(2);
    expect(body.map((b) => b.name)).toEqual(["auth", "chat"]);
    expect(body[0]).toMatchObject({
      name: "auth",
      description: "Auth module",
      kind: "feature",
      fileCount: 5,
    });
  });

  test("response shape: every entry has {name, description, kind:'feature', fileCount}", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockListFeatures.mockResolvedValue([
      { id: "f1", name: "a", description: "A", fileCount: 1, source: "user" },
    ]);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<Record<string, unknown>>;
    for (const entry of body) {
      expect(entry).toHaveProperty("name");
      expect(entry).toHaveProperty("description");
      expect(entry.kind).toBe("feature");
      expect(entry).toHaveProperty("fileCount");
      // Importantly, internal DB fields like `id`, `source`, `createdAt`
      // do NOT leak into the search response.
      expect(entry).not.toHaveProperty("id");
      expect(entry).not.toHaveProperty("source");
    }
  });

  test("query string fuzzy-ranks by name/description and returns best matches first", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockListFeatures.mockResolvedValue([
      { id: "f1", name: "auth", description: "Authentication", fileCount: 3, source: "agent" },
      { id: "f2", name: "chat", description: "Chat surface", fileCount: 5, source: "agent" },
      { id: "f3", name: "billing", description: "Stripe integration", fileCount: 2, source: "user" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1&q=chat",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<{ name: string }>;
    // The exact-name "chat" should rank above the others; non-matching
    // entries (e.g. billing) might be filtered out entirely.
    expect(body[0]!.name).toBe("chat");
    expect(body.map((b) => b.name)).not.toContain("billing");
  });

  test("query that matches DESCRIPTION only is included (cross-field fuzzy match)", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockListFeatures.mockResolvedValue([
      { id: "f1", name: "auth", description: "Stripe billing module", fileCount: 1, source: "agent" },
      { id: "f2", name: "ui", description: "Dashboard layout", fileCount: 1, source: "agent" },
    ]);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1&q=Stripe",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<{ name: string }>;
    // 'auth' should rank because its description contains "Stripe", even
    // though the name doesn't.
    expect(body.map((b) => b.name)).toContain("auth");
  });

  test("results capped at MAX_RESULTS=10 even when listFeatures returns more", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    const many = Array.from({ length: 25 }, (_, i) => ({
      id: `f${i}`,
      name: `feat-${i.toString().padStart(2, "0")}`,
      description: `Files under src/feat-${i}`,
      fileCount: i + 1,
      source: "agent" as const,
    }));
    mockListFeatures.mockResolvedValue(many);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as unknown[];
    expect(body.length).toBe(10);
  });

  test("fileCount reflects the UNION of scan + user file rows (no source bias)", async () => {
    // PM headline ask: the search-endpoint response must surface a
    // fileCount that counts every featureFiles row, not just one source.
    // listFeatures (DB layer) is responsible for the actual aggregation;
    // we drive it here to assert the wire-shape preserves that count
    // unchanged. listFeatures returns rows with the union already
    // computed — the search endpoint just maps it through.
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockListFeatures.mockResolvedValue([
      // Pretend listFeatures already counted 2 scan + 1 user = 3 total.
      { id: "f1", name: "union", description: "Mixed", fileCount: 3, source: "user" },
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as Array<{ name: string; fileCount: number }>;
    expect(body).toHaveLength(1);
    expect(body[0]!.fileCount).toBe(3); // scan + user union — no down-count.
  });

  test("empty listFeatures result → returns []", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockListFeatures.mockResolvedValue([]);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=feature&projectId=p1",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});
