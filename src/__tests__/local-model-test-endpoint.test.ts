import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mockServerAlias, createMockEvent, jsonFromResponse, ADMIN_USER, MEMBER_USER } from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────

// updated for sec-H1: baseUrl validation (localhost → non-loopback mock URL,
// requireAuth → requireRole, and requireRole-aware role gating)
const mockRequireAuth = mock(() => ADMIN_USER);
const mockRequireRole = mock((_locals: any, _role: string) => ADMIN_USER);

const mockCheckLocalModel = mock(async () => ({
  reachable: true,
  modelAvailable: true,
  inferenceOk: true,
  endpointType: "openai-compatible" as const,
  latencyMs: 42,
}));

mock.module("../auth/middleware", () => ({
  requireAuth: mockRequireAuth,
  requireRole: mockRequireRole,
}));

mock.module("../providers/local-model-check", () => ({
  checkLocalModel: mockCheckLocalModel,
}));

// Register $server aliases
mockServerAlias();

// Override $server aliases with mock implementations
mock.module("$server/auth/middleware", () => ({
  requireAuth: mockRequireAuth,
  requireRole: mockRequireRole,
}));
mock.module("$server/providers/local-model-check", () => ({
  checkLocalModel: mockCheckLocalModel,
}));

// Mock $lib/server/security/api-keys to allow admin scope by default
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// Mock $types for the route
mock.module("../../web/src/routes/api/providers/local/test/$types", () => ({}));

// sec-H1 DNS-pinning follow-up: the route now calls node:dns/promises'
// `lookup(host, {all:true})` after the sync loopback check. Fake it to
// return public IPs for this file's test hostnames so we're not making
// real network lookups (and so `.invalid` TLDs resolve cleanly).
mock.module("node:dns/promises", () => ({
  lookup: async (hostname: string) => {
    if (/^\d{1,3}(\.\d{1,3}){3}$/.test(hostname)) {
      return [{ address: hostname, family: 4 as const }];
    }
    // Any hostname exercised in this file is a non-loopback mock → public IP.
    return [{ address: "203.0.113.10", family: 4 as const }];
  },
}));

// ── Handler import ──────────────────────────────────────────────

const { POST } = await import("../../web/src/routes/api/providers/local/test/+server");

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  mockRequireAuth.mockClear();
  mockRequireAuth.mockImplementation(() => ADMIN_USER);
  mockRequireRole.mockClear();
  mockRequireRole.mockImplementation(() => ADMIN_USER);
  mockCheckLocalModel.mockClear();
  mockCheckLocalModel.mockImplementation(async () => ({
    reachable: true,
    modelAvailable: true,
    inferenceOk: true,
    endpointType: "openai-compatible" as const,
    latencyMs: 42,
  }));
});

// ── Tests ────────────────────────────────────────────────────────

describe("POST /api/providers/local/test", () => {
  test("valid request returns structured LocalModelCheckResult", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      // updated for sec-H1: baseUrl validation rejects loopback
      body: { baseUrl: "http://mock-llm.example.invalid:11434", modelId: "llama3" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(data.reachable).toBe(true);
    expect(data.modelAvailable).toBe(true);
    expect(data.inferenceOk).toBe(true);
    expect(data.endpointType).toBe("openai-compatible");
    expect(data.latencyMs).toBe(42);
  });

  test("missing baseUrl returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      // updated for sec-H1: modelId-only body (no baseUrl) still 400s before new check
      body: { modelId: "llama3" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("baseUrl");
  });

  test("missing modelId returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      // updated for sec-H1: baseUrl validation rejects loopback
      body: { baseUrl: "http://mock-llm.example.invalid:11434" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("modelId");
  });

  test("invalid URL (not http/https) returns 400", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      body: { baseUrl: "ftp://localhost:11434", modelId: "llama3" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(400);
    expect(data.error).toContain("http");
  });

  test("checkLocalModel throws returns 500 with error", async () => {
    mockCheckLocalModel.mockImplementation(async () => {
      throw new Error("Connection refused");
    });

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      // updated for sec-H1: baseUrl validation rejects loopback
      body: { baseUrl: "http://mock-llm.example.invalid:11434", modelId: "llama3" },
      user: ADMIN_USER,
    });
    const res = await POST(event as any);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(500);
    expect(data.error).toContain("Connection refused");
  });

  test("non-admin API key returns 403", async () => {
    // Re-mock requireScope to enforce scope check for this test
    const { requireScope: realRequireScope } = await import("../../web/src/lib/server/security/api-keys");

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      // updated for sec-H1: baseUrl validation rejects loopback
      body: { baseUrl: "http://mock-llm.example.invalid:11434", modelId: "llama3" },
      user: MEMBER_USER,
    });
    // Simulate API key auth with read-only scope
    (event.locals as any).apiKeyScopes = ["read"];

    // Call requireScope directly since the mock returns null
    const scopeErr = realRequireScope(event.locals, "admin");
    expect(scopeErr).not.toBeNull();
    expect(scopeErr!.status).toBe(403);
  });
});

// ── Mock argument verification ──────────────────────────────────

describe("POST /api/providers/local/test - argument verification", () => {
  test("checkLocalModel is called with correct baseUrl and modelId", async () => {
    mockCheckLocalModel.mockClear();

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/providers/local/test",
      body: { baseUrl: "https://my-server:8080", modelId: "codellama" },
      user: ADMIN_USER,
    });
    await POST(event as any);

    expect(mockCheckLocalModel).toHaveBeenCalledTimes(1);
    expect(mockCheckLocalModel).toHaveBeenCalledWith("https://my-server:8080", "codellama");
  });
});
