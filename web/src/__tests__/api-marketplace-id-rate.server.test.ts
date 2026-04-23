/**
 * Server-handler unit tests for /api/marketplace/[id]/rate (+server.ts).
 *
 * Covers auth gating (requireAuth throws 401 Response) and the 400
 * validation path for a non-boolean `thumbsUp`. The success path would
 * hit `upsertRating` and is skipped to avoid DB mocking.
 */

import { test, expect, describe } from "vitest";
import { POST } from "../routes/api/marketplace/[id]/rate/+server.ts";

function makeEvent(opts: {
  body?: unknown;
  locals?: Record<string, unknown>;
  id?: string;
}) {
  const id = opts.id ?? "abc";
  return {
    url: new URL(`http://localhost/api/marketplace/${id}/rate`),
    locals: opts.locals ?? {},
    params: { id },
    request: new Request(`http://localhost/api/marketplace/${id}/rate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body ?? {}),
    }),
  } as any;
}

describe("POST /api/marketplace/[id]/rate", () => {
  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { thumbsUp: true }, locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("API-key scope check returns 403 when 'extensions' scope missing", async () => {
    const res = await POST(
      makeEvent({
        body: { thumbsUp: true },
        locals: {
          user: { id: "u1", email: "u@x", name: "u", role: "user" },
          apiKeyScopes: ["read"],
        },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string; required?: string };
    expect(body.error).toBe("Insufficient scope");
    expect(body.required).toBe("extensions");
  });

  test("non-boolean thumbsUp returns 400 via errorJson", async () => {
    const res = await POST(
      makeEvent({
        body: { thumbsUp: "yes" },
        locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
      }),
    );
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("thumbsUp must be a boolean");
  });
});
