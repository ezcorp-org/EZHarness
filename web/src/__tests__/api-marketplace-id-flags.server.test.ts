/**
 * Server-handler unit tests for /api/marketplace/[id]/flags (+server.ts).
 *
 * Covers admin-only gating (GET + PATCH throw via requireRole) and the
 * PATCH 400 path for a bad body. The DB-backed success paths would
 * require mocking `resolveFlag` + `insertAuditEntry` and are skipped.
 */

import { test, expect, describe } from "vitest";
import { GET, PATCH } from "../routes/api/marketplace/[id]/flags/+server.ts";

function makeEvent(opts: {
  method?: "GET" | "PATCH";
  body?: unknown;
  locals?: Record<string, unknown>;
  id?: string;
}) {
  const id = opts.id ?? "abc";
  const method = opts.method ?? "GET";
  return {
    url: new URL(`http://localhost/api/marketplace/${id}/flags`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/marketplace/${id}/flags`, {
      method,
      headers: { "Content-Type": "application/json" },
      body: method === "GET" ? undefined : JSON.stringify(opts.body ?? {}),
    }),
  } as any;
}

describe("GET /api/marketplace/[id]/flags", () => {
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
  });

  test("non-admin authenticated request throws 403 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(
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
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Insufficient permissions");
  });
});

describe("PATCH /api/marketplace/[id]/flags", () => {
  test("admin + invalid body returns 400 via errorJson", async () => {
    const res = await PATCH(
      makeEvent({
        method: "PATCH",
        body: { flagId: "", action: "bogus" },
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "admin" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "flagId and action ('dismissed' | 'removed') are required",
    );
  });

  test("non-admin PATCH throws 403 Response", async () => {
    let res: Response | undefined;
    try {
      await PATCH(
        makeEvent({
          method: "PATCH",
          body: { flagId: "f1", action: "dismissed" },
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
});
