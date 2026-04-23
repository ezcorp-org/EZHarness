/**
 * Server-handler unit tests for /api/providers/[provider]/test (+server.ts).
 *
 * The success path performs a real `complete()` call against the provider
 * API, so we cover only the auth gates and the validation for the
 * provider whitelist.
 */

import { test, expect, describe } from "vitest";
import { POST } from "../routes/api/providers/[provider]/test/+server";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  params?: { provider?: string };
}) {
  return {
    url: new URL("http://localhost/api/providers/x/test"),
    locals: opts.locals ?? {},
    params: opts.params ?? { provider: "anthropic" },
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/providers/[provider]/test", () => {
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

  test("returns 400 for unknown provider", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "bogus" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("returns 400 when provider is empty", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, params: { provider: "" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });
});
