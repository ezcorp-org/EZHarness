/**
 * Unit tests for `src/extensions/network-handler.ts` —
 *   - `handleNetworkInternalRpc` (the JSON-RPC handler) with all error
 *     branches + happy path + size cap
 *   - `isInternalHost` matrix (every documented internal pattern + a
 *     few public-IP rejections)
 *
 * Strategy: pass a stub `PermissionEngine` (allow / deny variants) and
 * a stub `fetchImpl` so we don't need a real localhost server or DB.
 * The PDP gate is exercised with both decisions; the upstream fetch is
 * exercised with a 200 OK, an error throw, and an oversized body.
 */

import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Audit-log writes go through the DB layer; mock so we don't need a
// real connection. The PDP stub below short-circuits the audit path
// anyway, but the registry / db mocks keep the import graph satisfied.
mock.module("../db/queries/extensions", () => ({
  disableExtension: async () => {},
  listExtensions: async () => [],
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));
mock.module("../db/queries/settings", () => ({
  getSetting: async () => null,
  upsertSetting: async () => {},
  getAllSettings: async () => ({}),
  deleteSetting: async () => false,
  isListingInstalled: async () => false,
}));
mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: () => Promise.resolve() }),
  }),
}));
afterAll(() => restoreModuleMocks());

import {
  handleNetworkInternalRpc,
  isInternalHost,
  type NetworkInternalContext,
} from "../extensions/network-handler";
import type { JsonRpcRequest } from "../extensions/types";

// ── Stub builders ────────────────────────────────────────────────

function makeAllowEngine(): NetworkInternalContext["engine"] {
  return {
    authorize: async () => ({ decision: "allow", auditId: "stub-allow" }),
    resolvePrompt: async () => {},
    _resetCacheForTests: () => {},
  };
}

function makeDenyEngine(reason = "no host capability"): NetworkInternalContext["engine"] {
  return {
    authorize: async () => ({ decision: "deny", reason, auditId: "stub-deny" }),
    resolvePrompt: async () => {},
    _resetCacheForTests: () => {},
  };
}

function makeRegistryStub(): NetworkInternalContext["registry"] {
  // The handler doesn't touch the registry directly in Phase 2 — it's
  // reserved for future use (Phase 4 cross-ext attribution). A bare
  // object satisfies the type.
  return {} as NetworkInternalContext["registry"];
}

function makeCtx(overrides: Partial<NetworkInternalContext> = {}): NetworkInternalContext {
  return {
    extensionId: "ext-1",
    conversationId: "conv-1",
    userId: "user-1",
    engine: makeAllowEngine(),
    registry: makeRegistryStub(),
    ...overrides,
  };
}

function makeReq(params: Record<string, unknown> = {}): JsonRpcRequest {
  return { jsonrpc: "2.0", id: 42, method: "ezcorp/network.internal", params };
}

// ── handleNetworkInternalRpc — input validation ──────────────────

describe("handleNetworkInternalRpc — input validation", () => {
  test("missing url param → -32602 Missing url", async () => {
    const resp = await handleNetworkInternalRpc(makeReq(), makeCtx());
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toBe("Missing url");
  });

  test("non-string url param → -32602 Missing url", async () => {
    const resp = await handleNetworkInternalRpc(makeReq({ url: 42 }), makeCtx());
    expect(resp.error?.code).toBe(-32602);
  });

  test("malformed url string → -32602 Invalid url", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "not a url" }),
      makeCtx(),
    );
    expect(resp.error?.code).toBe(-32602);
    expect(resp.error?.message).toBe("Invalid url");
  });

  test("response carries the request id (numeric)", async () => {
    const resp = await handleNetworkInternalRpc(
      { jsonrpc: "2.0", id: 99, method: "x" },
      makeCtx(),
    );
    expect(resp.id).toBe(99);
  });

  test("response carries the request id (string)", async () => {
    const resp = await handleNetworkInternalRpc(
      { jsonrpc: "2.0", id: "abc", method: "x" },
      makeCtx(),
    );
    expect(resp.id).toBe("abc");
  });
});

// ── handleNetworkInternalRpc — PDP gate ──────────────────────────

describe("handleNetworkInternalRpc — PDP gate", () => {
  test("PDP returns deny → -32001 Network denied with reason", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost:5432/" }),
      makeCtx({ engine: makeDenyEngine("missing capability network (localhost)") }),
    );
    expect(resp.error?.code).toBe(-32001);
    expect(resp.error?.message).toContain("Network denied");
    expect(resp.error?.message).toContain("missing capability network");
  });

  test("PDP receives lowercased hostname (normalization)", async () => {
    let captured: { value?: string } | undefined;
    const engine: NetworkInternalContext["engine"] = {
      authorize: async (_ctx, needed) => {
        captured = needed[0] as { value?: string } | undefined;
        return { decision: "allow", auditId: "x" };
      },
      resolvePrompt: async () => {},
      _resetCacheForTests: () => {},
    };
    await handleNetworkInternalRpc(
      makeReq({ url: "http://LOCALHOST:5432/" }),
      makeCtx({
        engine,
        // stub fetch so we don't try to dial localhost
      }),
      {
        fetchImpl: async () =>
          new Response("ok", { status: 200, statusText: "OK" }),
      },
    );
    expect(captured?.value).toBe("localhost");
  });

  test("PDP receives correct ctx fields", async () => {
    let capturedCtx: { extensionId?: string; userId?: string; conversationId?: string } | undefined;
    const engine: NetworkInternalContext["engine"] = {
      authorize: async (ctx) => {
        capturedCtx = ctx;
        return { decision: "allow", auditId: "x" };
      },
      resolvePrompt: async () => {},
      _resetCacheForTests: () => {},
    };
    await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/" }),
      makeCtx({
        engine,
        extensionId: "my-ext",
        userId: "alice",
        conversationId: "conv-9",
      }),
      {
        fetchImpl: async () => new Response("ok", { status: 200, statusText: "OK" }),
      },
    );
    expect(capturedCtx?.extensionId).toBe("my-ext");
    expect(capturedCtx?.userId).toBe("alice");
    expect(capturedCtx?.conversationId).toBe("conv-9");
  });
});

// ── handleNetworkInternalRpc — happy path ────────────────────────

describe("handleNetworkInternalRpc — happy path", () => {
  test("allow + 200 OK → result with status, statusText, headers, base64 body", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost:3000/v1/healthz" }),
      makeCtx(),
      {
        fetchImpl: async () =>
          new Response("hello", {
            status: 200,
            statusText: "OK",
            headers: { "x-trace": "abc", "content-type": "text/plain" },
          }),
      },
    );
    expect(resp.error).toBeUndefined();
    const result = resp.result as {
      status: number;
      statusText: string;
      headers: Record<string, string>;
      body: string;
    };
    expect(result.status).toBe(200);
    expect(result.statusText).toBe("OK");
    expect(result.headers["x-trace"]).toBe("abc");
    expect(result.headers["content-type"]).toBe("text/plain");
    // base64 of "hello" is "aGVsbG8="
    expect(result.body).toBe("aGVsbG8=");
  });

  test("non-200 status echoes through unchanged", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/broken" }),
      makeCtx(),
      {
        fetchImpl: async () => new Response("nope", { status: 500, statusText: "Internal Server Error" }),
      },
    );
    const result = resp.result as { status: number; statusText: string };
    expect(result.status).toBe(500);
    expect(result.statusText).toBe("Internal Server Error");
  });

  test("init params (method, headers, body) are forwarded to fetch", async () => {
    let captured: { url?: string; init?: RequestInit } | undefined;
    const fetchImpl: typeof fetch = (async (url: string, init?: RequestInit) => {
      captured = { url, init };
      return new Response("", { status: 204, statusText: "No Content" });
    }) as typeof fetch;
    await handleNetworkInternalRpc(
      makeReq({
        url: "http://localhost/api",
        init: {
          method: "POST",
          headers: { "x-foo": "bar" },
          body: '{"k":"v"}',
        },
      }),
      makeCtx(),
      { fetchImpl },
    );
    expect(captured?.url).toBe("http://localhost/api");
    expect(captured?.init?.method).toBe("POST");
    expect((captured?.init?.headers as Record<string, string>)["x-foo"]).toBe("bar");
    expect(captured?.init?.body).toBe('{"k":"v"}');
  });

  test("init=undefined still works (no shape error)", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/" }),
      makeCtx(),
      { fetchImpl: async () => new Response("", { status: 200, statusText: "OK" }) },
    );
    expect(resp.error).toBeUndefined();
  });
});

// ── handleNetworkInternalRpc — error & cap branches ──────────────

describe("handleNetworkInternalRpc — error & cap branches", () => {
  test("upstream fetch throws → -32000 Upstream error: <message>", async () => {
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost:1/dead" }),
      makeCtx(),
      {
        fetchImpl: (async () => {
          throw new Error("ECONNREFUSED");
        }) as typeof fetch,
      },
    );
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toBe("Upstream error: ECONNREFUSED");
  });

  test("response > 10MB → -32000 Response exceeds 10MB internal-fetch cap", async () => {
    // Build a 10MB+1 byte body.
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/big" }),
      makeCtx(),
      {
        fetchImpl: async () => new Response(big, { status: 200, statusText: "OK" }),
      },
    );
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toContain("10MB");
  });

  test("response exactly 10MB is allowed (boundary)", async () => {
    const exact = new Uint8Array(10 * 1024 * 1024);
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/exact" }),
      makeCtx(),
      {
        fetchImpl: async () => new Response(exact, { status: 200, statusText: "OK" }),
      },
    );
    expect(resp.error).toBeUndefined();
  });

  test("body read failure → -32000 Body read error: <message>", async () => {
    // Mock a Response whose arrayBuffer() rejects.
    const badResponse = {
      arrayBuffer: () => Promise.reject(new Error("read failed")),
      status: 200,
      statusText: "OK",
      headers: { forEach: () => {} },
    };
    const resp = await handleNetworkInternalRpc(
      makeReq({ url: "http://localhost/" }),
      makeCtx(),
      { fetchImpl: (async () => badResponse) as unknown as typeof fetch },
    );
    expect(resp.error?.code).toBe(-32000);
    expect(resp.error?.message).toBe("Body read error: read failed");
  });
});

// ── isInternalHost — matrix ─────────────────────────────────────

describe("isInternalHost", () => {
  test("matches every documented internal pattern", () => {
    const internal = [
      "localhost",
      "LOCALHOST",
      "127.0.0.1",
      "127.255.255.254",
      "::1",
      "10.0.0.1",
      "10.255.255.254",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.254",
      "169.254.169.254",
      "fc00::1",
      "fd00::1",
      "fe80::1",
    ];
    for (const h of internal) {
      expect(isInternalHost(h)).toBe(true);
    }
  });

  test("rejects public IPs", () => {
    const external = [
      "8.8.8.8",
      "1.1.1.1",
      "api.foo.com",
      "11.0.0.1",
      "172.15.0.1", // boundary (just outside RFC-1918 class B)
      "172.32.0.1", // boundary (just outside)
      "200.0.0.1",
    ];
    for (const h of external) {
      expect(isInternalHost(h)).toBe(false);
    }
  });

  test("case-insensitive match", () => {
    expect(isInternalHost("Fe80::1")).toBe(true);
    expect(isInternalHost("FC00::1")).toBe(true);
  });
});
