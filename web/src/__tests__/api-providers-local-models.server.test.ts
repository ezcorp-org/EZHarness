/**
 * Server-handler unit tests for /api/providers/local/models (+server.ts).
 *
 * The endpoint enforces SSRF defenses (admin role, scheme whitelist,
 * private/loopback rejection). All of those gates run before any
 * external fetch, so they're testable without mocking the network.
 *
 * The DNS-resolution and successful happy paths actually hit the wire,
 * so we leave those for an integration test and stick to the rejecters.
 */

import { test, expect, describe } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";
import { POST } from "../routes/api/providers/local/models/+server.ts";

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
}) {
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  return {
    url: new URL("http://localhost/api/providers/local/models"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/providers/local/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    }),
  } as any;
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/providers/local/models", () => {
  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("rejects unauthenticated callers with 403", async () => {
    const res = await expectDenied(() => POST(makeEvent({ locals: {}, body: {} })), 403);
    expect(res.status).toBe(403);
  });

  test("rejects non-admin authenticated user with 403", async () => {
    const res = await expectDenied(() => POST(
            makeEvent({
              locals: { user: { id: "u1", email: "u@x", name: "u", role: "user" } },
              body: { baseUrl: "https://api.example.com" },
            }),
          ), 403);
    expect(res.status).toBe(403);
  });

  test("rejects non-object JSON body with 400", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, rawBody: "not-json{" }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("rejects missing baseUrl with 400", async () => {
    const res = await POST(makeEvent({ locals: adminUser, body: {} }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("baseUrl is required");
  });

  test("rejects non-http(s) scheme with 400", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "file:///etc/passwd" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("must start with http://");
  });

  test("rejects loopback hostname with 400 (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://127.0.0.1:8080" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
  });

  test("rejects RFC1918 private hostname with 400 (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://10.0.0.1" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
  });
});
