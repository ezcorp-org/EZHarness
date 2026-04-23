/**
 * Server-handler unit tests for /api/marketplace/[id] (+server.ts).
 *
 * Focused on auth gating: DELETE requires admin via requireRole. The
 * non-admin and unauthenticated paths throw before any DB call, so
 * there's no mocking required.
 *
 * The success path is intentionally NOT covered here — it would need
 * `updateListingStatus` + `insertAuditEntry` mocks. The handler's
 * helpers live one import deep (real DB) and we don't want to stand
 * up PGlite for a smoke test.
 */

import { test, expect, describe } from "vitest";
import { DELETE } from "../routes/api/marketplace/[id]/+server.ts";

function makeEvent(opts: {
  id?: string;
  locals?: Record<string, unknown>;
}) {
  return {
    url: new URL(`http://localhost/api/marketplace/${opts.id ?? "abc"}`),
    locals: opts.locals ?? {},
    params: { id: opts.id ?? "abc" },
    request: new Request("http://localhost/api/marketplace/abc", { method: "DELETE" }),
  } as any;
}

describe("DELETE /api/marketplace/[id]", () => {
  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await DELETE(makeEvent({ locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("non-admin authenticated request throws 403 Response", async () => {
    let res: Response | undefined;
    try {
      await DELETE(
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

  test("API-key scope check returns 403 when scope missing", async () => {
    // requireScope(locals, "admin") returns a Response when apiKeyScopes is
    // present but does not include "admin". Cookie auth (no apiKeyScopes)
    // bypasses the scope check entirely.
    const res = await DELETE(
      makeEvent({
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "admin" },
          apiKeyScopes: ["read"],
        },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("admin");
  });
});
