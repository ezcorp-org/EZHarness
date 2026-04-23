/**
 * Server-handler unit tests for /api/mcp-servers/[id]/refresh (+server.ts).
 *
 * The success path hits the real `ExtensionRegistry` singleton and would
 * need a tool-server harness, so we cover only the auth gates and the
 * missing-id pre-check that runs before any registry call.
 */

import { test, expect, describe } from "vitest";
import { POST } from "../routes/api/mcp-servers/[id]/refresh/+server";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  params?: { id?: string };
}) {
  return {
    url: new URL("http://localhost/api/mcp-servers/x/refresh"),
    locals: opts.locals ?? {},
    params: opts.params ?? { id: "x" },
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/mcp-servers/[id]/refresh", () => {
  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({}));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects non-admin authenticated user with 403", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({
          locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
  });

  test("returns 400 when id param is empty", async () => {
    const res = await POST(makeEvent({ locals: adminUser, params: { id: "" } }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("id required");
  });
});
