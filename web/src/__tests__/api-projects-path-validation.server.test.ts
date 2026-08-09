/**
 * PUT /api/projects/[id] — project-path SHAPE validation.
 *
 * The create route's own tests (api-projects.server.test.ts) reach the same
 * guard without any mocking, because POST validates before it touches the
 * DB. PUT cannot: `checkProjectRole` runs first and reads membership, so the
 * guard sits behind a DB call. This file mocks that gate away so the
 * assertion is about the path rule and nothing else.
 *
 * Why PUT needs its own coverage at all: an edit is how a WORKING project
 * gets repointed at a broken directory. A rule enforced only on create would
 * leave the more destructive verb open — the project already has
 * conversations, attachments and history hanging off it when the path moves.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const mockUpdateProject = vi.fn(async (_id: string, patch: unknown) => ({
  id: "p1",
  name: "P",
  ...(patch as Record<string, unknown>),
}));

// Membership gate satisfied: `checkProjectRole` signals success by returning
// anything that is NOT a Response.
vi.mock("$server/auth/middleware", () => ({
  requireAuth: () => ({ id: "u1", email: "u@x", name: "u", role: "member" }),
  checkProjectRole: async () => ({ role: "owner" }),
}));

vi.mock("$server/db/queries/projects", () => ({
  updateProject: mockUpdateProject,
  getProject: async () => ({ id: "p1", name: "P", path: "/app" }),
  deleteProject: async () => true,
}));

const { PUT } = await import("../routes/api/projects/[id]/+server");

function makePutEvent(body: unknown) {
  return {
    url: new URL("http://localhost/api/projects/p1"),
    locals: { user: { id: "u1", email: "u@x", name: "u", role: "member" } },
    params: { id: "p1" },
    request: new Request("http://localhost/api/projects/p1", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  } as never;
}

describe("PUT /api/projects/[id] path shape", () => {
  // Every "did not reach the DB" assertion below is only meaningful against
  // a clean call log — without this the first accepted path in the file
  // makes every later `not.toHaveBeenCalled()` fail for the wrong reason.
  beforeEach(() => {
    mockUpdateProject.mockClear();
  });

  test("rejects a relative path", async () => {
    const res = await PUT(makePutEvent({ path: "app/ezAppTest" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("absolute");
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  test("rejects a resolved tilde path", async () => {
    const res = await PUT(makePutEvent({ path: "/app/web/~/projects/herdr" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("~");
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  test("rejects a .. segment", async () => {
    const res = await PUT(makePutEvent({ path: "/app/web/../../etc" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("..");
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  test("accepts a path on the projects bind", async () => {
    const res = await PUT(makePutEvent({ path: "/app/web/.ezcorp/projects/ezmind" }));
    expect(res.status).toBe(200);
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", {
      path: "/app/web/.ezcorp/projects/ezmind",
    });
  });

  test("rejects an empty path", async () => {
    // POST answers emptiness earlier, with the legacy "name and path
    // required" wording. PUT has no such pre-check, so the schema's own
    // min(1) is the only thing standing between an edit and a project
    // whose path is "".
    const res = await PUT(makePutEvent({ path: "" }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error?: string }).error).toContain("required");
    expect(mockUpdateProject).not.toHaveBeenCalled();
  });

  test("an update that omits path is untouched by the guard", async () => {
    // The rule must not turn a rename into a 400 — `path` is optional on
    // this route and undefined has to skip validation entirely.
    const res = await PUT(makePutEvent({ name: "Renamed" }));
    expect(res.status).toBe(200);
    expect(mockUpdateProject).toHaveBeenCalledWith("p1", { name: "Renamed" });
  });

  test("still accepts the seeded roots that live outside the bind", async () => {
    // `global` is `/` and `self` is `/repo`. The guard checks SHAPE, not
    // location — requiring paths under the projects bind would break both
    // on the next edit.
    for (const path of ["/", "/repo", "/app"]) {
      const res = await PUT(makePutEvent({ path }));
      expect(res.status).toBe(200);
    }
  });
});
