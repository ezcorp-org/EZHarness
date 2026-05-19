/**
 * Server-handler unit tests for /api/providers/local/test (+server.ts).
 *
 * The endpoint is admin-gated (sec-H1), runs an SSRF allowlist, and then
 * delegates to `checkLocalModel` which performs live HTTP probes. We mock
 * the DNS-pinning helper (so we don't hit real DNS) and `checkLocalModel`
 * (so we don't hit the wire) to exercise every branch deterministically.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$lib/server/security/url-validation", async () => {
  const actual = await vi.importActual<
    typeof import("$lib/server/security/url-validation")
  >("$lib/server/security/url-validation");
  return {
    ...actual,
    // Stub DNS pinning so test URLs with real-looking hostnames don't
    // attempt an actual DNS lookup.
    resolveAndValidateHostname: vi.fn(async () => ({ ok: true })),
  };
});

vi.mock("$server/providers/local-model-check", () => ({
  checkLocalModel: vi.fn(),
}));

const { resolveAndValidateHostname } = await import(
  "$lib/server/security/url-validation"
);
const { checkLocalModel } = await import("$server/providers/local-model-check");
const { POST } = await import("../routes/api/providers/local/test/+server");

function makeEvent(opts: {
  locals?: Record<string, unknown>;
  body?: unknown;
  rawBody?: string;
}) {
  const body =
    opts.rawBody ?? (opts.body !== undefined ? JSON.stringify(opts.body) : undefined);
  return {
    url: new URL("http://localhost/api/providers/local/test"),
    locals: opts.locals ?? {},
    request: new Request("http://localhost/api/providers/local/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    }),
  } as any;
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
    vi.mocked(resolveAndValidateHostname).mockReset();
    vi.mocked(resolveAndValidateHostname).mockResolvedValue({ ok: true });
  });

  test("rejects 401 when locals.user is missing", async () => {
    let res: Response | undefined;
    try {
      await POST(makeEvent({ body: { baseUrl: "https://api.example.com", modelId: "m" } }));
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(401);
  });

  test("rejects 403 when caller is not admin", async () => {
    let res: Response | undefined;
    try {
      await POST(
        makeEvent({
          locals: memberUser,
          body: { baseUrl: "https://api.example.com", modelId: "m" },
        }),
      );
      expect.fail("should have thrown");
    } catch (thrown) {
      expect(thrown).toBeInstanceOf(Response);
      res = thrown as Response;
    }
    expect(res!.status).toBe(403);
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

  test("rejects 400 when baseUrl points at loopback (SSRF guard)", async () => {
    const res = await POST(
      makeEvent({
        locals: adminUser,
        body: { baseUrl: "http://127.0.0.1:8080", modelId: "m" },
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toContain("private or loopback");
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
  });

  test("rejects 400 when DNS resolution returns private address", async () => {
    vi.mocked(resolveAndValidateHostname).mockResolvedValueOnce({
      ok: false,
      reason: "hostname resolves to private/loopback",
    });
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

  test("rejects 400 when DNS lookup throws", async () => {
    vi.mocked(resolveAndValidateHostname).mockRejectedValueOnce(
      new Error("ENOTFOUND"),
    );
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
