/**
 * Server-handler unit tests for /api/auth/oauth/callback (+server.ts).
 *
 * Covers the early validation gates of POST and DELETE — auth, provider
 * whitelist, required body fields. These all return/throw before any
 * DB or external HTTP call, so no mocks are needed. The token-exchange
 * happy path is left for an integration test.
 */

import { test, expect, describe } from "vitest";
import { POST, DELETE } from "../routes/api/auth/oauth/callback/+server.ts";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body: unknown;
  method: "POST" | "DELETE";
}) {
  return {
    url: new URL("http://localhost/api/auth/oauth/callback"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/auth/oauth/callback", {
      method: opts.method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts.body),
    }),
  } as any;
}

const authedUser = { user: { id: "u1", email: "u@x", name: "u", role: "user" } };

describe("POST /api/auth/oauth/callback", () => {
  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ method: "POST", locals: {}, body: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects unknown provider with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { provider: "evil", code: "c", state: "s" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });

  test("rejects missing code with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { provider: "openai", state: "s" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("code is required");
  });

  test("rejects missing state with 400", async () => {
    const res = await POST(
      makeEvent({
        method: "POST",
        locals: authedUser,
        body: { provider: "openai", code: "c" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("state is required");
  });
});

describe("DELETE /api/auth/oauth/callback", () => {
  test("rejects unauthenticated callers with 401", async () => {
    let res: Response | undefined;
    try {
      await DELETE(makeEvent({ method: "DELETE", locals: {}, body: {} }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects unknown provider with 400", async () => {
    const res = await DELETE(
      makeEvent({
        method: "DELETE",
        locals: authedUser,
        body: { provider: "evil" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("Invalid provider");
  });
});
