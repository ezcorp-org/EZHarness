// Regression tests for PATCH /api/extensions/[id] covering the response
// branches the UI depends on:
//   - disable (enabled:false) happy path → 200 and DB write
//   - enable (enabled:true) via PATCH → 400 (must use POST /:id/activate)
//   - unknown extension id → 404
//   - missing/invalid `enabled` field → 400
// Plus the side-effects the handler promises:
//   - ExtensionRegistry.reload() called on every successful mutation
//
// Mirrors c3-confirm-endpoint.test.ts's handler-level probe approach:
// mock the DB + registry modules, then drive PATCH via createMockEvent
// and assert on captured calls / status codes.

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  MEMBER_USER,
} from "./helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

mock.module(
  "../../web/src/routes/api/extensions/[id]/$types",
  () => ({}),
);

mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Stub extension record & capture mutations ────────────────────
let getExtensionReturnsNull = false;
let storedEnabled = true;
const updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
const resetFailuresCalls: string[] = [];
const deleteCalls: string[] = [];

const extensionsQueriesMock = () => ({
  getExtension: async (id: string) => {
    if (getExtensionReturnsNull) return null;
    return {
      id,
      name: "fake-ext",
      version: "1.0.0",
      description: "",
      manifest: {
        schemaVersion: 2,
        name: "fake-ext",
        version: "1.0.0",
        description: "",
        author: { name: "test" },
        permissions: {},
      },
      source: "local:/tmp/fake-ext",
      installPath: "/tmp/fake-ext",
      enabled: storedEnabled,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: true,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  },
  updateExtension: async (id: string, data: Record<string, unknown>) => {
    updateCalls.push({ id, data });
    return { id, name: "fake-ext", enabled: data.enabled };
  },
  deleteExtension: async (id: string) => {
    deleteCalls.push(id);
    return true;
  },
  resetFailures: async (id: string) => {
    resetFailuresCalls.push(id);
  },
});
mock.module("$server/db/queries/extensions", extensionsQueriesMock);
mock.module("../db/queries/extensions", extensionsQueriesMock);

// ── Security module stub — drive hasSecurityViolation per test ───
let violationFlag = false;
const securityMock = () => ({
  hasSecurityViolation: async () => violationFlag,
});
mock.module("$server/extensions/security", securityMock);
mock.module("../extensions/security", securityMock);

// ── Registry reload stub — count invocations ─────────────────────
let reloadCount = 0;
let killAllCount = 0;
const registryMock = () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => { reloadCount++; },
      killAll: () => { killAllCount++; },
    }),
  },
});
mock.module("$server/extensions/registry", registryMock);
mock.module("../extensions/registry", registryMock);

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { GET, PATCH, DELETE } from "../../web/src/routes/api/extensions/[id]/+server";

async function call(
  handler: (ev: any) => unknown,
  event: any,
): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

afterAll(() => {
  restoreModuleMocks();
});

beforeEach(() => {
  updateCalls.length = 0;
  resetFailuresCalls.length = 0;
  deleteCalls.length = 0;
  reloadCount = 0;
  killAllCount = 0;
  getExtensionReturnsNull = false;
  violationFlag = false;
  storedEnabled = true;
});

describe("PATCH /api/extensions/[id] — happy paths", () => {
  test("disable (enabled:false) → 200, updateExtension called, no resetFailures", async () => {
    storedEnabled = true;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { enabled: false },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.data.enabled).toBe(false);
    expect(resetFailuresCalls).toHaveLength(0);
    expect(reloadCount).toBe(1);
  });

  test("enable (enabled:true) via PATCH → 400 (must use /:id/activate)", async () => {
    storedEnabled = false;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { enabled: true },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(400);
    expect(String(data.error)).toContain("/activate");
    expect(updateCalls).toHaveLength(0);
    expect(resetFailuresCalls).toHaveLength(0);
    expect(reloadCount).toBe(0);
  });
});

describe("PATCH /api/extensions/[id] — sad paths", () => {
  test("unknown extension id → 404, no DB write", async () => {
    getExtensionReturnsNull = true;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/missing",
      params: { id: "missing" },
      body: { enabled: false },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(404);
    expect(String(data.error)).toContain("Not found");
    expect(updateCalls).toHaveLength(0);
    expect(reloadCount).toBe(0);
  });

  test("disable is NOT blocked by security violation (one-way gate)", async () => {
    storedEnabled = true;
    violationFlag = true;
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { enabled: false },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(200);
    expect(updateCalls[0]!.data.enabled).toBe(false);
  });

  test("body without enabled field → 400, no DB write", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { somethingElse: "ignored" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(400);
    expect(String(data.error)).toContain("No valid update fields");
    expect(updateCalls).toHaveLength(0);
    expect(reloadCount).toBe(0);
  });

  test("enabled as non-boolean (string) → 400, no DB write", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { enabled: "yes" },
      user: MEMBER_USER,
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(400);
    expect(updateCalls).toHaveLength(0);
  });

  test("no auth → 401, no DB write", async () => {
    const event = createMockEvent({
      method: "PATCH",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      body: { enabled: false },
      // no user
    });
    const res = await call(PATCH, event);
    expect(res.status).toBe(401);
    expect(updateCalls).toHaveLength(0);
  });
});

describe("GET /api/extensions/[id]", () => {
  test("existing id → 200 with extension body", async () => {
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(200);
    expect(data.id).toBe("ext-1");
    expect(data.name).toBe("fake-ext");
  });

  test("unknown id → 404", async () => {
    getExtensionReturnsNull = true;
    const event = createMockEvent({
      method: "GET",
      url: "http://localhost/api/extensions/missing",
      params: { id: "missing" },
      user: MEMBER_USER,
    });
    const res = await call(GET, event);
    expect(res.status).toBe(404);
  });
});

describe("DELETE /api/extensions/[id]", () => {
  test("existing id → 204, deleteExtension + killAll + reload called", async () => {
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/extensions/ext-1",
      params: { id: "ext-1" },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(204);
    expect(deleteCalls).toEqual(["ext-1"]);
    expect(killAllCount).toBe(1);
    expect(reloadCount).toBe(1);
  });

  test("unknown id → 404, no delete or reload", async () => {
    getExtensionReturnsNull = true;
    const event = createMockEvent({
      method: "DELETE",
      url: "http://localhost/api/extensions/missing",
      params: { id: "missing" },
      user: MEMBER_USER,
    });
    const res = await call(DELETE, event);
    expect(res.status).toBe(404);
    expect(deleteCalls).toHaveLength(0);
    expect(killAllCount).toBe(0);
    expect(reloadCount).toBe(0);
  });
});
