/**
 * Server-handler unit tests for /api/providers/local/test (+server.ts).
 *
 * The endpoint is admin-gated (sec-H1), runs an SSRF allowlist, and then
 * delegates to `checkLocalModel` which performs live HTTP probes. We mock
 * the DNS-pinning helper (so we don't hit real DNS) and `checkLocalModel`
 * (so we don't hit the wire) to exercise every branch deterministically.
 */

import { test, expect, describe, vi, beforeEach, afterEach } from "vitest";
import { expectDenied } from "./fixtures/expect-denied";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

// Mock the RESOLVER, not the guard. Previously this file stubbed
// `resolveAndValidateHostname` out of `$lib/server/security/url-validation`;
// the route now calls the module's own `checkLocalProviderTarget`, whose
// internal call to the resolver is a module-local binding a namespace mock
// cannot intercept. Mocking `node:dns/promises` instead runs the REAL
// validation end to end against a controlled resolver — same technique as the
// bun-side sibling suite (src/__tests__/security/h1-local-provider-ssrf.test.ts).
const dns = vi.hoisted(() => {
  const table = new Map<string, Array<{ address: string; family: 4 | 6 }> | "throw">();
  return { table };
});

vi.mock("node:dns/promises", () => {
  const lookup = async (hostname: string) => {
    // Real `dns.lookup` returns IP literals unchanged without a resolver.
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      return [{ address: hostname, family: 4 as const }];
    }
    const hit = dns.table.get(hostname);
    if (hit === undefined || hit === "throw") {
      const err = new Error(`ENOTFOUND ${hostname}`) as Error & { code: string };
      err.code = "ENOTFOUND";
      throw err;
    }
    return hit;
  };
  return { lookup, default: { lookup } };
});

vi.mock("$server/providers/local-model-check", () => ({
  checkLocalModel: vi.fn(),
}));

const { checkLocalModel } = await import("$server/providers/local-model-check");
const { POST } = await import("../routes/api/providers/local/test/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
}) {
  const body =
    opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  return makeRequestEvent("http://localhost/api/providers/local/test", {
    locals: opts.locals ?? {},
    request: {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    },
  });
}

const adminUser = {
  user: { id: "admin-1", email: "a@x", name: "a", role: "admin" },
};
const memberUser = {
  user: { id: "u1", email: "u@x", name: "u", role: "user" },
};

describe("POST /api/providers/local/test", () => {
  beforeEach(() => {
    vi.mocked(checkLocalModel).mockReset();
    dns.table.clear();
    // Public resolution for the happy-path hostname used throughout.
    dns.table.set("api.example.com", [{ address: "203.0.113.20", family: 4 }]);
  });

  afterEach(() => {
    delete process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS;
  });

  // 403, not 401: this route's gate is now the role-only `requireAdmin`,
  // which RETURNS its denial (requireRole THREW one, so the caller actually
  // got a 500). requireAdmin answers "not an admin principal" uniformly — a
  // missing principal is not an admin either. Unreachable in production
  // regardless: hooks.server.ts 401s unauthenticated /api/* before the handler.
  test("rejects 403 when locals.user is missing", async () => {
    const res = await expectDenied(() => POST(makeEvent({ body: { baseUrl: "https://api.example.com", modelId: "m" } })), 403);
    expect(res.status).toBe(403);
  });

  test("rejects 403 when caller is not admin", async () => {
    const res = await expectDenied(() => POST(
            makeEvent({
              locals: memberUser,
              body: { baseUrl: "https://api.example.com", modelId: "m" },
            }),
          ), 403);
    expect(res.status).toBe(403);
  });

  test("rejects 400 when body is not valid JSON", async () => {
    const res = await POST(makeEvent({ locals: adminUser, rawBody: "not-json{" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("rejects 400 when body is a JSON primitive (not an object)", async () => {
    const res = await POST(makeEvent({ locals: adminUser, rawBody: "42" }));
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid JSON body");
  });

  test("rejects 400 when baseUrl is missing", async () => {
    const res = await POST(
      makeEvent({ locals: adminUser, body: { modelId: "m" } }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("baseUrl is required");
  });

  test("rejects 400 when modelId is missing", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://api.example.com" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("modelId is required");
  });

  test("rejects 400 when baseUrl uses non-http(s) scheme", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "file:///etc/passwd", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("must start with http://");
  });

  test("rejects 400 when baseUrl fails URL parsing", async () => {
    // Starts with https:// so the prefix check passes, but is not a valid URL.
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("Invalid baseUrl");
  });

  // Loopback is now ALLOWED by the documented carve-out — this is the path a
  // self-hosted Ollama takes. Paired below with the RFC1918 refusal and the
  // kill-switch, which together bound how far the carve-out reaches.
  test("allows loopback and reaches checkLocalModel (local-inference carve-out)", async () => {
    vi.mocked(checkLocalModel).mockResolvedValue({ reachable: true } as any);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://127.0.0.1:8080", modelId: "m" },
      }),
    );
    expect(res.status).toBe(200);
    expect(checkLocalModel).toHaveBeenCalledWith("http://127.0.0.1:8080", "m");
  });

  test("allows the UI's auto-filled http://localhost:11434", async () => {
    vi.mocked(checkLocalModel).mockResolvedValue({ reachable: true } as any);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://localhost:11434", modelId: "llama3" },
      }),
    );
    expect(res.status).toBe(200);
    expect(checkLocalModel).toHaveBeenCalledWith("http://localhost:11434", "llama3");
  });

  test("rejects 400 with EZCORP_BLOCK_LOOPBACK_PROVIDERS=1", async () => {
    process.env.EZCORP_BLOCK_LOOPBACK_PROVIDERS = "1";
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://localhost:11434", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(checkLocalModel).not.toHaveBeenCalled();
  });

  test("rejects 400 when baseUrl points at RFC1918 range (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://10.0.0.5", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(checkLocalModel).not.toHaveBeenCalled();
  });

  test("rejects 400 when baseUrl points at cloud metadata (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://169.254.169.254/latest/meta-data/", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
    expect(checkLocalModel).not.toHaveBeenCalled();
  });

  test("rejects 400 when DNS resolution returns private address", async () => {
    dns.table.set("sneaky.example.com", [{ address: "10.0.0.5", family: 4 }]);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://sneaky.example.com", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("hostname resolves to private/loopback");
  });

  test("rejects 400 when a hostname RESOLVES to loopback (carve-out is literal-only)", async () => {
    dns.table.set("rebind.example.com", [{ address: "127.0.0.1", family: 4 }]);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://rebind.example.com", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("hostname resolves to private/loopback");
    expect(checkLocalModel).not.toHaveBeenCalled();
  });

  test("rejects 400 when DNS lookup throws", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://nowhere.invalid", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("hostname could not be resolved");
  });

  test("returns 200 with checkLocalModel result on success", async () => {
    vi.mocked(checkLocalModel).mockResolvedValue({
      reachable: true,
      endpointType: "openai-compatible",
      modelAvailable: true,
    } as any);
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://api.example.com", modelId: "gpt-ok" },
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reachable?: boolean;
      endpointType?: string;
      modelAvailable?: boolean;
    };
    expect(body.reachable).toBe(true);
    expect(body.endpointType).toBe("openai-compatible");
    expect(body.modelAvailable).toBe(true);
    expect(checkLocalModel).toHaveBeenCalledWith(
      "https://api.example.com",
      "gpt-ok",
    );
  });

  test("returns 500 when checkLocalModel throws", async () => {
    vi.mocked(checkLocalModel).mockRejectedValue(new Error("fetch timeout"));
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://api.example.com", modelId: "gpt-ok" },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("fetch timeout");
  });

  test("returns 500 when checkLocalModel throws a non-Error value", async () => {
    vi.mocked(checkLocalModel).mockRejectedValue("string-error");
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "https://api.example.com", modelId: "gpt-ok" },
      }),
    );
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("string-error");
  });
});
