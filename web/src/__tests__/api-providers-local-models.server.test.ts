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

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/providers/local-model-check", () => ({
  listModels: vi.fn(),
}));

const { listModels } = await import("$server/providers/local-model-check");
const { POST } = await import("../routes/api/providers/local/models/+server.ts");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
}) {
  const body = opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  return makeRequestEvent("http://localhost/api/providers/local/models", {
    locals: opts.locals ?? {},
    request: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    },
  });
}

const adminUser = { user: { id: "u1", email: "u@x", name: "u", role: "admin" } };

describe("POST /api/providers/local/models", () => {
  beforeEach(() => {
    vi.mocked(listModels).mockReset();
  });

  afterEach(() => {
    delete process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS;
  });

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

  // Loopback is now ALLOWED — the discovery half of registering a local
  // Ollama. Bounded immediately below by the private-range refusals.
  test("allows the UI's auto-filled http://localhost:11434 and lists models", async () => {
    vi.mocked(listModels).mockResolvedValue({
      models: [{ id: "qwen3:1.7b", name: "qwen3:1.7b" }],
      endpointType: "ollama",
    } as any);
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://localhost:11434" } }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { models?: Array<{ id: string }> };
    expect(body.models?.[0]?.id).toBe("qwen3:1.7b");
    expect(listModels).toHaveBeenCalledWith("http://localhost:11434");
  });

  test("allows loopback IPv4 literal", async () => {
    vi.mocked(listModels).mockResolvedValue({ models: [], endpointType: null } as any);
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://127.0.0.1:8080" } }),
    );
    expect(res.status).toBe(200);
    expect(listModels).toHaveBeenCalledWith("http://127.0.0.1:8080");
  });

  test("rejects loopback with 400 under EZCORP_BLOCK_LOOPBACK_PROVIDERS=1", async () => {
    process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS = "1";
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://127.0.0.1:8080" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(listModels).not.toHaveBeenCalled();
  });

  test("rejects RFC1918 private hostname with 400 (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://10.0.0.1" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(listModels).not.toHaveBeenCalled();
  });

  test("rejects cloud-metadata link-local with 400 (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://169.254.169.254/" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(listModels).not.toHaveBeenCalled();
  });

  test("rejects 500 when listModels throws", async () => {
    vi.mocked(listModels).mockRejectedValue(new Error("boom"));
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://localhost:11434" } }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("boom");
  });

  test("rejects 500 with a stringified non-Error throw from listModels", async () => {
    vi.mocked(listModels).mockRejectedValue("nope");
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "http://localhost:11434" } }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("nope");
  });

  test("rejects unparseable baseUrl with 400", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { baseUrl: "https://" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid baseUrl");
  });
});
