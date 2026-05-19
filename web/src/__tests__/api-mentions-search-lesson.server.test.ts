/**
 * Vitest server-handler tests for the `type=lesson` branch of
 * `/api/mentions/search/+server.ts`.
 *
 * The branch resolves the active project, calls
 * `$server/db/queries/lessons::searchLessons` scoped to (projectId,
 * user.id), and returns the route-level shape
 * `{ name: slug, description, kind: "lesson" }` with `description`
 * being the lesson body, truncated to 59 chars + `…` only when the
 * body is longer than 60 chars. Internal DB fields (id, body, owner,
 * counters, etc.) must NOT leak into the response.
 *
 * Pattern mirrors `api-mentions-search-feature.server.test.ts`. Runs
 * under `bun run test:component` (vitest), NOT `bun test` (which
 * excludes `.server.test.ts` files via the bunfig + scripts/test.sh).
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/projects", () => ({
  getProject: vi.fn(),
}));

const mockSearchLessons = vi.fn();
vi.mock("$server/db/queries/lessons", () => ({
  searchLessons: mockSearchLessons,
}));

vi.mock("$lib/server/context", () => ({
  // Handler imports getExecutor / getCommandRegistry but the lesson
  // branch doesn't touch them — harmless stubs.
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

// Minimal Lesson row with the fields the route actually reads. Other
// columns (frontmatter, sourceSha256, counters, timestamps) are present
// in real rows but ignored by the route — leaving them off here keeps
// each test fixture readable.
function lessonRow(overrides: Partial<{ id: string; slug: string; title: string; body: string }> = {}) {
  return {
    id: "lid-1",
    projectId: "p1",
    ownerId: "u1",
    visibility: "user" as const,
    slug: "use-bun-not-node",
    title: "Use Bun, not Node",
    body: "Always invoke `bun <file>` instead of `node <file>`.",
    frontmatter: null,
    source: "user" as const,
    sourceSha256: null,
    firedCount: 0,
    lastFiredAt: null,
    dismissedCount: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe("GET /api/mentions/search?type=lesson", () => {
  beforeEach(() => {
    vi.mocked(getProject).mockReset();
    mockSearchLessons.mockReset();
  });

  test("missing projectId → returns []", async () => {
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
    // Should NOT have hit the DB.
    expect(mockSearchLessons).not.toHaveBeenCalled();
  });

  test("unknown projectId → returns [] (no searchLessons call)", async () => {
    vi.mocked(getProject).mockResolvedValue(undefined as any);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson&projectId=ghost",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
    expect(vi.mocked(getProject)).toHaveBeenCalledWith("ghost");
    expect(mockSearchLessons).not.toHaveBeenCalled();
  });

  test("response shape: every entry has {name: slug, description, kind:'lesson'}; internal fields don't leak", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "Alpha", path: "/tmp/a" } as any);
    mockSearchLessons.mockResolvedValue([
      lessonRow({ slug: "rule-a", body: "short body" }),
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
        locals: { user: USER },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]).toEqual({
      name: "rule-a",
      description: "short body",
      kind: "lesson",
    });
    // No leakage of DB internals
    expect(body[0]).not.toHaveProperty("id");
    expect(body[0]).not.toHaveProperty("ownerId");
    expect(body[0]).not.toHaveProperty("body");
    expect(body[0]).not.toHaveProperty("title");
    expect(body[0]).not.toHaveProperty("firedCount");
  });

  test("searchLessons receives (projectId, user.id, q, MAX_RESULTS) — visibility scoping wired through user.id", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockSearchLessons.mockResolvedValue([]);

    await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson&projectId=p1&q=hello",
        locals: { user: USER },
      }),
    );

    expect(mockSearchLessons).toHaveBeenCalledTimes(1);
    const args = mockSearchLessons.mock.calls[0]!;
    expect(args[0]).toBe("p1"); // projectId
    expect(args[1]).toBe("u1"); // user.id (NOT the raw user object — visibility scoping demands the id)
    expect(args[2]).toBe("hello"); // query
    expect(args[3]).toBe(10); // MAX_RESULTS
  });

  describe("body excerpt + ellipsis polish (commit ae5eb39)", () => {
    test("body length 60 (boundary, NOT >60) → no ellipsis appended", async () => {
      const body60 = "x".repeat(60);
      vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
      mockSearchLessons.mockResolvedValue([lessonRow({ body: body60 })]);

      const res = await GET(
        makeEvent({
          href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
          locals: { user: USER },
        }),
      );
      const out = (await res.json()) as Array<{ description: string }>;
      expect(out[0]!.description).toBe(body60);
      expect(out[0]!.description).not.toContain("…");
    });

    test("body length 61 (>60) → description is slice(0,59) + '…' (total 60 chars)", async () => {
      const body61 = "x".repeat(61);
      vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
      mockSearchLessons.mockResolvedValue([lessonRow({ body: body61 })]);

      const res = await GET(
        makeEvent({
          href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
          locals: { user: USER },
        }),
      );
      const out = (await res.json()) as Array<{ description: string }>;
      // 59 'x' chars then a single '…' (one char, even though it looks
      // like three) → length is 60.
      expect(out[0]!.description).toBe("x".repeat(59) + "…");
      expect(out[0]!.description.length).toBe(60);
      expect(out[0]!.description.endsWith("…")).toBe(true);
    });

    test("very long body → still capped at 60 chars including ellipsis", async () => {
      const longBody = "Lorem ipsum dolor sit amet, ".repeat(100);
      vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
      mockSearchLessons.mockResolvedValue([lessonRow({ body: longBody })]);

      const res = await GET(
        makeEvent({
          href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
          locals: { user: USER },
        }),
      );
      const out = (await res.json()) as Array<{ description: string }>;
      expect(out[0]!.description.length).toBe(60);
      expect(out[0]!.description.endsWith("…")).toBe(true);
      expect(out[0]!.description).toBe(longBody.slice(0, 59) + "…");
    });

    test("short body (<60) → unchanged, no ellipsis", async () => {
      vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
      mockSearchLessons.mockResolvedValue([lessonRow({ body: "tiny" })]);

      const res = await GET(
        makeEvent({
          href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
          locals: { user: USER },
        }),
      );
      const out = (await res.json()) as Array<{ description: string }>;
      expect(out[0]!.description).toBe("tiny");
      expect(out[0]!.description).not.toContain("…");
    });
  });

  test("multiple lessons → each entry independently shaped, source order preserved", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockSearchLessons.mockResolvedValue([
      lessonRow({ slug: "first", body: "short" }),
      lessonRow({ slug: "second", body: "y".repeat(80) }),
      lessonRow({ slug: "third", body: "z".repeat(60) }),
    ]);

    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
        locals: { user: USER },
      }),
    );
    const out = (await res.json()) as Array<{ name: string; description: string; kind: string }>;
    expect(out.map((e) => e.name)).toEqual(["first", "second", "third"]);
    expect(out[0]!.description).toBe("short");
    expect(out[1]!.description).toBe("y".repeat(59) + "…");
    expect(out[2]!.description).toBe("z".repeat(60)); // exact-60, no ellipsis
    for (const entry of out) {
      expect(entry.kind).toBe("lesson");
    }
  });

  test("empty searchLessons result → returns []", async () => {
    vi.mocked(getProject).mockResolvedValue({ id: "p1", name: "x", path: "/tmp/x" } as any);
    mockSearchLessons.mockResolvedValue([]);
    const res = await GET(
      makeEvent({
        href: "http://localhost/api/mentions/search?type=lesson&projectId=p1",
        locals: { user: USER },
      }),
    );
    const body = (await res.json()) as unknown[];
    expect(body).toEqual([]);
  });
});
