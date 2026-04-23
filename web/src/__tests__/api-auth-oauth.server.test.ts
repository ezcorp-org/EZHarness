/**
 * Server-handler unit tests for /api/auth/oauth (+server.ts).
 *
 * Covers the auth gate plus the provider-validation guards. The success
 * path (which spawns a callback HTTP server and writes a settings row)
 * is intentionally omitted — it requires DB + filesystem setup the
 * `.server.test.ts` template doesn't bring up.
 */

import { test, expect, describe } from "vitest";
import { GET } from "../routes/api/auth/oauth/+server.ts";

function makeEvent(opts: {
  provider?: string | null;
  locals?: Record<string, unknown>;
}) {
  const params = new URLSearchParams();
  if (opts.provider !== null && opts.provider !== undefined) {
    params.set("provider", opts.provider);
  }
  const href = `http://localhost/api/auth/oauth?${params.toString()}`;
  return {
    url: new URL(href),
    locals: opts.locals ?? {},
    request: new Request(href),
  } as any;
}

const adminLocals = {
  user: { id: "u1", email: "u@x", name: "u", role: "admin" },
};

describe("GET /api/auth/oauth", () => {
  test("unauthenticated request throws 401 Response", async () => {
    let res: Response | undefined;
    try {
      await GET(makeEvent({ provider: "google", locals: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
    const body = (await res!.json()) as { error?: string };
    expect(body.error).toBe("Authentication required");
  });

  test("missing provider returns 400", async () => {
    const res = await GET(makeEvent({ provider: null, locals: adminLocals }));
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "Invalid provider. Must be one of: openai, google, anthropic",
    );
  });

  test("unsupported provider returns 400", async () => {
    const res = await GET(makeEvent({ provider: "wat", locals: adminLocals }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe(
      "Invalid provider. Must be one of: openai, google, anthropic",
    );
  });

  test("anthropic provider returns 400 (no OAuth path)", async () => {
    const res = await GET(makeEvent({ provider: "anthropic", locals: adminLocals }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("OAuth not available for Anthropic. Use API keys.");
  });
});
