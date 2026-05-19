/**
 * Server-handler unit tests for /api/pipelines (+server.ts).
 *
 * The list/create paths hit the in-memory pipeline registry / DB, so we
 * limit to the auth gates and the missing-field validation that runs
 * before any side effect.
 */

import { test, expect, describe } from "vitest";
import { GET, POST } from "../routes/api/pipelines/+server";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
}) {
  const body = opts.body !== undefined ? JSON.stringify(opts.body) : "{}";
  return {
    url: new URL("http://localhost/api/pipelines"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/pipelines", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/pipelines", () => {
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

describe("POST /api/pipelines", () => {
  test("returns 403 when API-key scope missing 'chat'", async () => {
    const res = await POST(
      makeEvent({
        locals: { ...authedUser, apiKeyScopes: ["read"] },
        body: { name: "p1", steps: [{}] },
      }),
    );
    expect(res.status).toBe(403);
    const body = (await res.json()) as { required?: string };
    expect(body.required).toBe("chat");
  });

  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { name: "p1", steps: [{}] } }));
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
    const res = await POST(makeEvent({ locals: authedUser, body: { name: "p1" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });

  test("returns 400 when steps is empty array", async () => {
    const res = await POST(
      makeEvent({ locals: authedUser, body: { name: "p1", steps: [] } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("name and steps required");
  });
});
