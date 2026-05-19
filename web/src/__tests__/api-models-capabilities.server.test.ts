/**
 * Server-handler unit tests for /api/models/capabilities (+server.ts).
 *
 * Pure URL-param + auth surface — no DB or network calls reachable from
 * the error paths exercised below.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/models/capabilities/+server";

function makeEvent(href: string, locals: Record<string, unknown> = {}) {
  return { url: new URL(href), locals } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("GET /api/models/capabilities", () => {
  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent("http://localhost/api/models/capabilities?provider=anthropic&model=claude-opus"));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("returns 400 when provider param is missing", async () => {
    const res = await GET(
      makeEvent("http://localhost/api/models/capabilities?model=claude-opus", authedUser),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provider and model");
  });

  test("returns 400 when model param is missing", async () => {
    const res = await GET(
      makeEvent("http://localhost/api/models/capabilities?provider=anthropic", authedUser),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("provider and model");
  });
});
