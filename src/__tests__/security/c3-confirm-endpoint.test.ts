// Regression test for the sec-C3 follow-up: admin-only activate endpoint
// that enables an installed extension and (optionally) grants clamped
// permissions. This closes the gap left by the sec-C3 fix (f6ee69e),
// which hard-codes enabled=false on install and ignores caller-supplied
// permissions — after that fix there was no API path to enable an
// installed extension or grant any of its declared permissions.
//
// NOTE on path: the task originally called for `[id]/confirm` but that
// route was already occupied by the runtime shell/filesystem permission
// prompt handler. The admin-activate endpoint lives at
// `[id]/activate/+server.ts` instead. Behaviour is what the task spec
// asked for.
//
// Fix semantics exercised:
//   - requireRole(locals, "admin")  → member gets 403, unauth gets 401
//   - POST with no body            → 200, enabled=true, perms untouched
//   - POST with grantedPermissions that exceed manifest → clamped
//   - POST to unknown id           → 404
//   - Success path writes an audit entry
//
// Strategy: handler-level probe. Mock getExtension / updateExtension /
// insertAuditEntry / ExtensionRegistry, then drive POST with each shape.

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stub — not present at test time.
mock.module(
  "../../../web/src/routes/api/extensions/[id]/activate/$types",
  () => ({}),
);

// requireScope no-op passthrough.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Stub extension record & capture writes ──────────────────────
let currentManifestPerms: Record<string, unknown> = {};
let updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
let getExtensionReturnsNull = false;

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
        permissions: currentManifestPerms,
      },
      source: "local:/tmp/fake-ext",
      installPath: "/tmp/fake-ext",
      enabled: false,
      grantedPermissions: { grantedAt: {} },
      checksumVerified: true,
      consecutiveFailures: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
  },
  updateExtension: async (id: string, data: Record<string, unknown>) => {
    updateCalls.push({ id, data });
    return {
      id,
      name: "fake-ext",
      enabled: data.enabled,
      grantedPermissions: data.grantedPermissions,
    };
  },
  resetFailures: async () => {},
});
mock.module("$server/db/queries/extensions", extensionsQueriesMock);
mock.module("../../db/queries/extensions", extensionsQueriesMock);

// Security module — /activate now carries the hasSecurityViolation gate
// (moved from PATCH as part of the enable-via-PATCH lockdown). Default off.
let activateViolationFlag = false;
const activateSecurityMock = () => ({
  hasSecurityViolation: async () => activateViolationFlag,
});
mock.module("$server/extensions/security", activateSecurityMock);
mock.module("../../extensions/security", activateSecurityMock);

// Audit log — capture for assertion.
const auditCalls: Array<{
  userId: string | null;
  action: string;
  target?: string;
  metadata?: unknown;
}> = [];
const auditLogMock = () => ({
  insertAuditEntry: async (
    userId: string | null,
    action: string,
    target?: string,
    metadata?: unknown,
  ) => {
    auditCalls.push({ userId, action, target, metadata });
  },
});
mock.module("$server/db/queries/audit-log", auditLogMock);
mock.module("../../db/queries/audit-log", auditLogMock);

// ExtensionRegistry.getInstance().reload() — no-op stub.
const registryMock = () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
});
mock.module("$server/extensions/registry", registryMock);
mock.module("../../extensions/registry", registryMock);

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { POST } from "../../../web/src/routes/api/extensions/[id]/activate/+server";

// SvelteKit handlers may throw a Response on auth failure; unwrap.
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
  updateCalls = [];
  auditCalls.length = 0;
  currentManifestPerms = {};
  getExtensionReturnsNull = false;
  activateViolationFlag = false;
});

describe("sec-C3 follow-up: POST /api/extensions/[id]/activate role gate", () => {
  test("member role → 403, updateExtension NOT called", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: {},
      user: MEMBER_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(403);
    expect(updateCalls.length).toBe(0);
  });

  test("unauthenticated → 401, updateExtension NOT called", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: {},
      // no user
    });
    const res = await call(POST, event);
    expect(res.status).toBe(401);
    expect(updateCalls.length).toBe(0);
  });
});

describe("sec-C3 follow-up: activate semantics", () => {
  test("admin + empty body → 200, enabled=true, grantedPermissions untouched", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: {},
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    const data = await jsonFromResponse(res);

    expect(res.status).toBe(200);
    expect(updateCalls.length).toBe(1);
    const update = updateCalls[0]!.data;
    expect(update.enabled).toBe(true);
    // No grantedPermissions key at all — omitted means "do not touch"
    expect("grantedPermissions" in update).toBe(false);
    expect(data.enabled).toBe(true);
  });

  test("admin + grantedPermissions that exceed manifest → 200, stored perms clamped", async () => {
    // Manifest only declared storage. Admin tries to grant shell + filesystem + storage.
    // Post-clamp: only storage should survive.
    currentManifestPerms = { storage: true };

    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: {
        grantedPermissions: {
          shell: true,
          filesystem: ["/"],
          network: ["*"],
          env: ["SECRET"],
          storage: true,
          grantedAt: {
            shell: 1700000000000,
            filesystem: 1700000000000,
            storage: 1700000000000,
          },
        },
      },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBe(1);
    const update = updateCalls[0]!.data;
    expect(update.enabled).toBe(true);
    const stored = update.grantedPermissions as Record<string, unknown>;

    expect(stored.shell).toBeUndefined();
    expect(stored.filesystem).toBeUndefined();
    expect(stored.network).toBeUndefined();
    expect(stored.env).toBeUndefined();
    expect(stored.storage).toBe(true);
    expect(stored.grantedAt).toBeDefined();
  });

  test("admin + grantedPermissions as non-object → 400", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: { grantedPermissions: "totally valid I promise" },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(400);
    expect(updateCalls.length).toBe(0);
  });

  test("admin + unknown extension id → 404", async () => {
    getExtensionReturnsNull = true;
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/does-not-exist/activate",
      params: { id: "does-not-exist" },
      body: {},
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    const data = await jsonFromResponse(res);
    expect(res.status).toBe(404);
    expect(String(data.error)).toContain("Not found");
    expect(updateCalls.length).toBe(0);
  });

  test("admin + successful activate → audit entry recorded", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: { grantedPermissions: { storage: true, grantedAt: { storage: 1 } } },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(200);

    expect(auditCalls.length).toBe(1);
    const entry = auditCalls[0]!;
    expect(entry.userId).toBe(ADMIN_USER.id);
    expect(entry.action).toBe("extension:confirmed");
    expect(entry.target).toBe("ext-1");
    const metadata = entry.metadata as Record<string, unknown>;
    expect(metadata.enabled).toBe(true);
    expect(metadata.grantedPermissions).toBeDefined();
  });

  test("member failures do NOT produce audit entries", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions/ext-1/activate",
      params: { id: "ext-1" },
      body: {},
      user: MEMBER_USER,
    });
    await call(POST, event);
    expect(auditCalls.length).toBe(0);
  });
});
