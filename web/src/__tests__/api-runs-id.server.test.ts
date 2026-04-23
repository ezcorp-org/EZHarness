/**
 * Server-handler unit tests for /api/runs/[id] (+server.ts).
 *
 * Covers auth gating + scope checks for both GET and DELETE. The 404
 * paths (run not found / not running) are intentionally omitted because
 * they require the executor singleton to be initialized via getExecutor.
 */

import { test, expect, describe } from "vitest";
import { GET, DELETE } from "../routes/api/runs/[id]/+server.ts";

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
  method?: string;
}) {
  const id = opts.id ?? "run-abc";
  return {
    url: new URL(`http://localhost/api/runs/${id}`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/runs/${id}`, { method: opts.method ?? "GET" }),
  } as any;
}

describe("GET /api/runs/[id]", () => {
  test("API-key scope check returns 403 when 'read' scope missing", async () => {
    const res = await GET(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["chat"],
        },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("read");
  });

  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });
});

describe("DELETE /api/runs/[id]", () => {
  test("API-key scope check returns 403 when 'chat' scope missing", async () => {
    const res = await DELETE(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["read"],
        },
        method: "DELETE",
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("chat");
  });

  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await DELETE(makeEvent({ locals: {}, method: "DELETE" }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });
});
