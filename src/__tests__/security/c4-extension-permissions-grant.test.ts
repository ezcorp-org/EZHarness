import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "../helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  ADMIN_USER,
  MEMBER_USER,
} from "../helpers/mock-request";

// ── Module-level mocks (BEFORE handler imports) ──────────────────
mockServerAlias();

// SvelteKit generated $types stub — not present at test time.
mock.module(
  "../../../web/src/routes/api/extensions/[id]/permissions/$types",
  () => ({}),
);

// requireScope must stay a no-op passthrough — we're exercising the NEW
// requireRole gate, not an api-key scope check.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// ── Stub extension record & capture writes ──────────────────────
// The handler reads ext.manifest.permissions to clamp. Tests reconfigure
// `currentManifestPerms` before each call to drive the fixture shape.
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
      enabled: true,
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
      grantedPermissions: data.grantedPermissions,
    };
  },
});
mock.module("$server/db/queries/extensions", extensionsQueriesMock);
mock.module("../../db/queries/extensions", extensionsQueriesMock);

// Audit log — capture for (optional) assertion, but don't require it.
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
import { PUT } from "../../../web/src/routes/api/extensions/[id]/permissions/+server";

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
});

// Attacker-chosen payload the pre-fix route handed straight to updateExtension.
// Real attackers would ask for everything — storage included — to maximise
// capability once the grant lands.
const MALICIOUS_PERMISSIONS = {
  shell: true,
  filesystem: ["/"],
  network: ["*"],
  env: ["SECRET_KEY"],
  storage: true,
  grantedAt: {
    shell: 1700000000000,
    filesystem: 1700000000000,
    network: 1700000000000,
    storage: 1700000000000,
  },
};

describe("sec-C4: retired grant mutation cannot become a shell escalation path", () => {
  test("unauthenticated caller cannot mutate grants", async () => {
    const response = await call(PUT, createMockEvent({ method: "PUT", url: "http://localhost/api/extensions/ext-1/permissions", params: { id: "ext-1" }, body: { permissions: MALICIOUS_PERMISSIONS } }));
    expect(response.status).toBe(401);
    expect(updateCalls).toHaveLength(0);
  });

  for (const [name, permissions] of [
    ["all capabilities", MALICIOUS_PERMISSIONS],
    ["network subset", { network: ["api.example.com"] }],
    ["exact file and secret grants", { filesystem: ["/var/data"], env: ["API_TOKEN"] }],
    ["wildcard network", { network: ["api.example.com", "evil.attacker.com", "*"] }],
    ["empty grant", {}],
    ["deputy escalation", { acceptsCallerCaps: true, escalateChildCaps: true }],
  ] as const) test(`admin and member cannot submit ${name} through the retired endpoint`, async () => {
    for (const user of [ADMIN_USER, MEMBER_USER]) {
      currentManifestPerms = { storage: true, network: ["api.example.com"] };
      const response = await call(PUT, createMockEvent({ method: "PUT", url: "http://localhost/api/extensions/ext-1/permissions", params: { id: "ext-1" }, body: { permissions }, user }));
      expect(response.status).toBe(410);
      expect(await response.json()).toMatchObject({ code: "extension_v4_required" });
    }
    expect(updateCalls).toHaveLength(0);
    expect(auditCalls).toHaveLength(0);
  });
});
