/**
 * Server-handler unit tests for /api/workflows (+server.ts).
 *
 * The list/create paths hit the in-memory workflow registry / DB, so we
 * limit to the auth gates, the missing-field validation, and the
 * definition-time (`validateWorkflow`) rejections that all run BEFORE any
 * DB side effect.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/workflows/+server";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : "{}";
  return {
    url: new URL("http://localhost/api/workflows"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/workflows", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/workflows", () => {
  test("returns 403 when API-key scope missing 'read'", async () => {
    const res = await GET(
      makeEvent({ locals: { ...authedUser, apiKeyScopes: ["chat"] } }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("read");
  });

  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });
});

describe("POST /api/workflows", () => {
  test("returns 403 when API-key scope missing 'chat'", async () => {
    const res = await POST(
      makeEvent({
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { name: "w1", steps: [{ name: "s1", agent: "a" }] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("chat");
  });

  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { name: "w1", steps: [{ name: "s1", agent: "a" }] } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 400 when name is missing", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { steps: [{}] } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when steps is missing", async () => {
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "w1" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when steps is empty array", async () => {
    const res = await POST(
      makeEvent({ locals: authedUser, body: { name: "w1", steps: [] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 with the validator message for duplicate step names", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [
            { name: "dup", agent: "a" },
            { name: "dup", agent: "b" },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Duplicate step name "dup"');
  });

  test("returns 400 for a gate step missing its condition", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "g", kind: "gate" }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "g" (kind "gate") requires a "condition"');
  });

  test("returns 400 for a step combining loop and retries", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [{ name: "s", agent: "a", retries: 1, loop: { maxIterations: 3 } }],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "s" cannot combine "loop" and "retries" (mutually exclusive)');
  });

  test("returns 400 for a loop on a gate step", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: {
          name: "w1",
          steps: [
            { name: "g", kind: "gate", condition: { ref: "$input.x", op: "truthy" }, loop: { maxIterations: 2 } },
          ],
        },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "g" (kind "gate") cannot have a "loop"');
  });

  test("returns 400 for an unknown dependsOn reference", async () => {
    const res = await POST(
      makeEvent({
        locals: authedUser,
        body: { name: "w1", steps: [{ name: "s", agent: "a", dependsOn: ["ghost"] }] },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe('Step "s" depends on unknown step "ghost"');
  });
});
