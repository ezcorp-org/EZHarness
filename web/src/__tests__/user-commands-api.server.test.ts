/**
 * Server-handler unit tests for /api/user-commands and
 * /api/user-commands/[name]. Covers every status code: 200 / 201 /
 * 204 / 400 / 401 / 403 / 404 / 413 plus the registry-invalidation
 * contract (every successful mutation calls registry.invalidateUser
 * exactly once with the authed user id — see the rationale comment in
 * the route file: the popover keys cache by the active chat's
 * projectId, not "global", so per-projectId invalidate misses).
 *
 * The DB query layer + the runtime registry are both mocked — this
 * test focuses on handler behaviour (auth gate, scope gate, validation,
 * byte cap, status codes, side-effect wiring, response-shape userId
 * stripping). The query layer's own tests cover the rename helper and
 * the rest.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const invalidate = vi.fn();
const invalidateUser = vi.fn();

vi.mock("$server/db/queries/user-commands", () => ({
  listUserCommands: vi.fn(),
  getUserCommand: vi.fn(),
  createUserCommand: vi.fn(),
  updateUserCommand: vi.fn(),
  deleteUserCommand: vi.fn(),
}));

vi.mock("$lib/server/context", () => ({
  getCommandRegistry: () => ({ invalidate, invalidateUser }),
}));

const {
  listUserCommands,
  getUserCommand,
  createUserCommand,
  updateUserCommand,
  deleteUserCommand,
} = await import("$server/db/queries/user-commands");
const collection = await import("../routes/api/user-commands/+server.ts");
const item = await import("../routes/api/user-commands/[name]/+server.ts");

const user = { id: "u1", email: "u@x", name: "u", role: "user" } as const;

function makeEvent(opts: {
  method?: string;
  locals?: Record<string, unknown>;
  body?: unknown;
  params?: Record<string, string>;
}) {
  const href = "http://localhost/api/user-commands";
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    params: opts.params ?? {},
    request: new Request(href, {
      method: opts.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    }),
    // SvelteKit's RequestEvent is over-typed for our handler boundary;
    // the structural subset above is what every handler actually reads.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
}

beforeEach(() => {
  vi.mocked(listUserCommands).mockReset();
  vi.mocked(getUserCommand).mockReset();
  vi.mocked(createUserCommand).mockReset();
  vi.mocked(updateUserCommand).mockReset();
  vi.mocked(deleteUserCommand).mockReset();
  invalidate.mockReset();
  invalidateUser.mockReset();
});

describe("GET /api/user-commands", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await collection.GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("403 when API key scope is insufficient (no `read`)", async () => {
    // requireScope returns 403 BEFORE requireAuth, so the DB layer is
    // never hit. apiKeyScopes present (so cookie-auth bypass doesn't
    // apply) but missing the required `read` scope.
    const res = await collection.GET(
      makeEvent({ locals: { user, apiKeyScopes: [] } }),
    );
    expect(res.status).toBe(403);
    expect(listUserCommands).not.toHaveBeenCalled();
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("200 returns the user's commands without userId", async () => {
    vi.mocked(listUserCommands).mockResolvedValue([
      {
        id: "c1",
        userId: "u1",
        name: "review",
        description: "",
        body: "b",
        frontmatter: {},
        createdAt: new Date(),
        updatedAt: new Date(),
      },
    ] as never);
    const res = await collection.GET(makeEvent({ locals: { user } }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as Array<Record<string, unknown>>;
    expect(body).toHaveLength(1);
    expect(body[0]!.name).toBe("review");
    // userId is stripped at the boundary — it's redundant on a per-user
    // endpoint and clients shouldn't reintroduce a dependency on it.
    expect(body[0]!).not.toHaveProperty("userId");
    expect(listUserCommands).toHaveBeenCalledWith("u1");
  });
});

describe("POST /api/user-commands", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await collection.POST(
        makeEvent({ method: "POST", locals: {}, body: { name: "x", body: "y" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("403 when API key scope is insufficient (no `chat`)", async () => {
    // `read` alone is not enough for POST — the handler demands `chat`.
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user, apiKeyScopes: ["read"] },
        body: { name: "review", body: "x" },
      }),
    );
    expect(res.status).toBe(403);
    expect(createUserCommand).not.toHaveBeenCalled();
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("400 when name is missing", async () => {
    const res = await collection.POST(
      makeEvent({ method: "POST", locals: { user }, body: { body: "y" } }),
    );
    expect(res.status).toBe(400);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("400 when slug is invalid (uppercase / spaces)", async () => {
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { name: "My Review", body: "y" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { fields?: Record<string, string> };
    expect(body.fields?.name).toBeDefined();
  });

  test("400 when slug exceeds max length", async () => {
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { name: "a".repeat(65), body: "y" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("400 when request body is not valid JSON object", async () => {
    // Passing `null` triggers the catch-then-null branch.
    const res = await collection.POST(
      makeEvent({ method: "POST", locals: { user }, body: null }),
    );
    expect(res.status).toBe(400);
  });

  test("413 when body exceeds 64 KB", async () => {
    const oversized = "x".repeat(64 * 1024 + 1);
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { name: "review", body: oversized },
      }),
    );
    expect(res.status).toBe(413);
    const body = (await res.json()) as { maxBytes?: number; actualBytes?: number };
    expect(body.maxBytes).toBe(64 * 1024);
    expect(body.actualBytes).toBeGreaterThan(64 * 1024);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("201 happy path returns row (no userId) + invalidates user cache exactly once", async () => {
    vi.mocked(createUserCommand).mockResolvedValue({
      id: "new1",
      userId: "u1",
      name: "review",
      description: "",
      body: "do the thing",
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { name: "review", body: "do the thing" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.id).toBe("new1");
    expect(body.name).toBe("review");
    expect(body).not.toHaveProperty("userId");
    expect(createUserCommand).toHaveBeenCalledTimes(1);
    expect(invalidateUser).toHaveBeenCalledTimes(1);
    expect(invalidateUser).toHaveBeenCalledWith("u1");
    // The narrower per-projectId form is no longer used by the handlers
    // — we drop the whole user's cache so the popover (keyed by the
    // active chat's projectId) doesn't miss the invalidation.
    expect(invalidate).not.toHaveBeenCalled();
  });

  test("201 surfaces auto-suffixed name when DB layer renamed it", async () => {
    vi.mocked(createUserCommand).mockResolvedValue({
      id: "new2",
      userId: "u1",
      name: "review-2",
      description: "",
      body: "x",
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: { name: "review", body: "x" },
      }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { name: string };
    // Caller asked for `review` but DB returned `review-2`. The UI uses
    // this to surface the rename toast.
    expect(body.name).toBe("review-2");
  });

  test("filters unknown frontmatter keys before calling DB layer", async () => {
    vi.mocked(createUserCommand).mockResolvedValue({
      id: "new3",
      userId: "u1",
      name: "x",
      description: "",
      body: "b",
      frontmatter: { description: "kept", agent: "bot" },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await collection.POST(
      makeEvent({
        method: "POST",
        locals: { user },
        body: {
          name: "x",
          body: "b",
          frontmatter: {
            description: "kept",
            "argument-hint": "$ARGUMENTS",
            agent: "bot",
            model: "gpt-4",
            evil: "dropped",
            another_unknown: "dropped",
          },
        },
      }),
    );
    const call = vi.mocked(createUserCommand).mock.calls[0]![0];
    expect(call.frontmatter).toEqual({
      description: "kept",
      "argument-hint": "$ARGUMENTS",
      agent: "bot",
      model: "gpt-4",
    });
  });
});

describe("GET /api/user-commands/[name]", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await item.GET(makeEvent({ locals: {}, params: { name: "x" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("403 when API key scope is insufficient (no `read`)", async () => {
    const res = await item.GET(
      makeEvent({ locals: { user, apiKeyScopes: [] }, params: { name: "r" } }),
    );
    expect(res.status).toBe(403);
    expect(getUserCommand).not.toHaveBeenCalled();
  });

  test("404 when command does not exist", async () => {
    vi.mocked(getUserCommand).mockResolvedValue(undefined);
    const res = await item.GET(
      makeEvent({ locals: { user }, params: { name: "missing" } }),
    );
    expect(res.status).toBe(404);
  });

  test("200 returns the row (no userId) when present", async () => {
    vi.mocked(getUserCommand).mockResolvedValue({
      id: "c1",
      userId: "u1",
      name: "review",
      description: "",
      body: "x",
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await item.GET(
      makeEvent({ locals: { user }, params: { name: "review" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.name).toBe("review");
    expect(body).not.toHaveProperty("userId");
  });
});

describe("PATCH /api/user-commands/[name]", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await item.PATCH(
        makeEvent({
          method: "PATCH",
          locals: {},
          body: { body: "x" },
          params: { name: "r" },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("403 when API key scope is insufficient (no `chat`)", async () => {
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user, apiKeyScopes: ["read"] },
        body: { body: "x" },
        params: { name: "r" },
      }),
    );
    expect(res.status).toBe(403);
    expect(updateUserCommand).not.toHaveBeenCalled();
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("400 when body is not a valid JSON object", async () => {
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: null,
        params: { name: "r" },
      }),
    );
    expect(res.status).toBe(400);
  });

  test("413 when patched body exceeds 64 KB", async () => {
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: { body: "x".repeat(64 * 1024 + 1) },
        params: { name: "r" },
      }),
    );
    expect(res.status).toBe(413);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("404 when target command is missing", async () => {
    vi.mocked(updateUserCommand).mockResolvedValue(undefined);
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: { body: "x" },
        params: { name: "missing" },
      }),
    );
    expect(res.status).toBe(404);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("200 on happy path invalidates user cache exactly once", async () => {
    vi.mocked(updateUserCommand).mockResolvedValue({
      id: "c1",
      userId: "u1",
      name: "review",
      description: "new desc",
      body: "Audit: $ARGUMENTS",
      frontmatter: {},
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: { body: "Audit: $ARGUMENTS", description: "new desc" },
        params: { name: "review" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.description).toBe("new desc");
    expect(body).not.toHaveProperty("userId");
    expect(invalidateUser).toHaveBeenCalledTimes(1);
    expect(invalidateUser).toHaveBeenCalledWith("u1");
  });

  test("200 on empty patch `{}` still bumps updatedAt + invalidates exactly once", async () => {
    // An empty patch is a valid no-op-style touch: it doesn't change
    // any field but the DB still bumps updatedAt (see query layer).
    // Locks the contract that the handler doesn't short-circuit on an
    // empty object and that the registry is still invalidated.
    const before = new Date("2025-01-01T00:00:00Z");
    const after = new Date("2025-01-02T00:00:00Z");
    vi.mocked(updateUserCommand).mockResolvedValue({
      id: "c1",
      userId: "u1",
      name: "review",
      description: "",
      body: "b",
      frontmatter: {},
      createdAt: before,
      updatedAt: after,
    } as never);
    const res = await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: {},
        params: { name: "review" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { updatedAt: string };
    expect(new Date(body.updatedAt).getTime()).toBeGreaterThan(before.getTime());
    expect(invalidateUser).toHaveBeenCalledTimes(1);
    expect(invalidateUser).toHaveBeenCalledWith("u1");
  });

  test("filters frontmatter on patch too", async () => {
    vi.mocked(updateUserCommand).mockResolvedValue({
      id: "c1",
      userId: "u1",
      name: "r",
      description: "",
      body: "b",
      frontmatter: { agent: "bot" },
      createdAt: new Date(),
      updatedAt: new Date(),
    } as never);
    await item.PATCH(
      makeEvent({
        method: "PATCH",
        locals: { user },
        body: { frontmatter: { agent: "bot", evil: "dropped" } },
        params: { name: "r" },
      }),
    );
    const call = vi.mocked(updateUserCommand).mock.calls[0]!;
    expect(call[2].frontmatter).toEqual({ agent: "bot" });
  });
});

describe("DELETE /api/user-commands/[name]", () => {
  test("401 when unauthenticated", async () => {
    let res: Response | undefined;
    try {
      await item.DELETE(
        makeEvent({ method: "DELETE", locals: {}, params: { name: "r" } }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("403 when API key scope is insufficient (no `chat`)", async () => {
    const res = await item.DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user, apiKeyScopes: ["read"] },
        params: { name: "r" },
      }),
    );
    expect(res.status).toBe(403);
    expect(deleteUserCommand).not.toHaveBeenCalled();
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("404 when command does not exist", async () => {
    vi.mocked(deleteUserCommand).mockResolvedValue(false);
    const res = await item.DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user },
        params: { name: "missing" },
      }),
    );
    expect(res.status).toBe(404);
    expect(invalidateUser).not.toHaveBeenCalled();
  });

  test("204 on success + invalidates user cache exactly once", async () => {
    vi.mocked(deleteUserCommand).mockResolvedValue(true);
    const res = await item.DELETE(
      makeEvent({
        method: "DELETE",
        locals: { user },
        params: { name: "review" },
      }),
    );
    expect(res.status).toBe(204);
    expect(deleteUserCommand).toHaveBeenCalledWith("u1", "review");
    expect(invalidateUser).toHaveBeenCalledTimes(1);
    expect(invalidateUser).toHaveBeenCalledWith("u1");
  });
});
