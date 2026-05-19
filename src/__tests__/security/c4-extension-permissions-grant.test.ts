// Regression test for sec-C4: PUT /api/extensions/[id]/permissions must be
// gated on requireRole(locals, "admin") AND must clamp the submitted
// permission set to the intersection of what the extension's manifest
// actually declared. Pre-fix the route was only gated by
// `requireScope(locals, "extensions")` — a no-op for cookie auth — and the
// submitted permissions were written verbatim via updateExtension.
//
// Exploit narrative: a normal "member" user could PUT
//
//   { permissions: { shell: true, filesystem: ["/"],
//     network: ["*"], grantedAt: {...} } }
//
// against any installed extension (even a benign one whose manifest only
// asked for `{ storage: true }`), and then invoke that extension's tools
// via POST /api/tool-invoke — executing shell as the server-process user.
//
// Fix (d3ec58e):
//   - requireRole(locals, "admin") on PUT
//   - clamp the submitted permission set to the intersection of
//     ext.manifest.permissions — anything beyond the manifest is dropped
//   - caller cannot elevate beyond what the extension author declared
//
// Strategy: handler-level probe. Mock getExtension to return a stubbed
// extension with a constrained manifest, mock updateExtension to capture
// the `grantedPermissions` argument it was actually handed, then drive
// PUT with:
//   1. member user + malicious perms  → 403, updateExtension not called
//   2. unauthenticated                → 401, updateExtension not called
//   3. admin + malicious perms against a manifest that only asked for
//      `{storage: true}`              → 200, stored perms == {storage: true}
//      (shell, filesystem, network dropped)
//   4. admin + subset of manifest     → 200, stored perms match the subset
//   5. admin + exactly manifest perms → 200, stored perms match manifest
//
// Tests fix(sec-C4): d3ec58e

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

describe("sec-C4: PUT /api/extensions/[id]/permissions role gate", () => {
  test("member role + malicious perms → 403, updateExtension NOT called", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: { permissions: MALICIOUS_PERMISSIONS },
      user: MEMBER_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(403);
    // Pre-fix, the member's payload would have been written verbatim.
    expect(updateCalls.length).toBe(0);
  });

  test("unauthenticated → 401, updateExtension NOT called", async () => {
    currentManifestPerms = { storage: true };
    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: { permissions: MALICIOUS_PERMISSIONS },
      // no user
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(401);
    expect(updateCalls.length).toBe(0);
  });
});

describe("sec-C4: submitted permissions are clamped to manifest", () => {
  test("admin + malicious perms vs storage-only manifest → 200, only storage stored", async () => {
    // Fixture: a benign extension that only ever asked for persistent storage.
    currentManifestPerms = { storage: true };

    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: { permissions: MALICIOUS_PERMISSIONS },
      user: ADMIN_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBe(1);
    const stored = updateCalls[0]!.data.grantedPermissions as Record<
      string,
      unknown
    >;

    // Everything the manifest did NOT declare must have been dropped.
    expect(stored.shell).toBeUndefined();
    expect(stored.filesystem).toBeUndefined();
    expect(stored.network).toBeUndefined();
    expect(stored.env).toBeUndefined();

    // storage survives (manifest asked for it, admin granted it).
    expect(stored.storage).toBe(true);

    // grantedAt sentinel exists.
    expect(stored.grantedAt).toBeDefined();
  });

  test("admin + subset of manifest → 200, stored perms == that subset", async () => {
    // Fixture: manifest requests shell + network, admin grants only network.
    currentManifestPerms = {
      shell: true,
      network: ["api.example.com", "cdn.example.com"],
    };

    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: {
        permissions: {
          network: ["api.example.com"], // admin grants just one domain
          grantedAt: { network: 1700000000000 },
        },
      },
      user: ADMIN_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(200);

    expect(updateCalls.length).toBe(1);
    const stored = updateCalls[0]!.data.grantedPermissions as Record<
      string,
      unknown
    >;

    expect(stored.shell).toBeUndefined(); // not granted, even though manifest asked
    expect(stored.network).toEqual(["api.example.com"]);
  });

  test("admin + exact manifest perms → 200, stored perms match manifest", async () => {
    // Fixture: manifest requests filesystem + env; admin grants exactly those.
    currentManifestPerms = {
      filesystem: ["/var/data", "/var/cache"],
      env: ["API_TOKEN", "LOG_LEVEL"],
    };

    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: {
        permissions: {
          filesystem: ["/var/data", "/var/cache"],
          env: ["API_TOKEN", "LOG_LEVEL"],
          grantedAt: {
            filesystem: 1700000000000,
            env: 1700000000000,
          },
        },
      },
      user: ADMIN_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(200);

    const stored = updateCalls[0]!.data.grantedPermissions as Record<
      string,
      unknown
    >;
    expect(stored.filesystem).toEqual(["/var/data", "/var/cache"]);
    expect(stored.env).toEqual(["API_TOKEN", "LOG_LEVEL"]);
  });

  test("admin + network subset (some domains in, some not) → only manifest-listed survive", async () => {
    // Fixture: manifest only whitelists one domain. Admin submits that domain
    // plus an attacker-chosen wildcard; the wildcard must be dropped.
    currentManifestPerms = { network: ["api.example.com"] };

    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: {
        permissions: {
          network: ["api.example.com", "evil.attacker.com", "*"],
        },
      },
      user: ADMIN_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(200);

    const stored = updateCalls[0]!.data.grantedPermissions as Record<
      string,
      unknown
    >;
    expect(stored.network).toEqual(["api.example.com"]);
  });

  test("admin + empty-manifest extension + malicious perms → 200, nothing granted", async () => {
    // Hardest case: a benign extension that declared NO permissions at all.
    // Pre-fix, a member could elevate it to full-shell. Post-fix, even an
    // admin cannot grant it anything.
    currentManifestPerms = {};

    const event = createMockEvent({
      method: "PUT",
      url: "http://localhost/api/extensions/ext-1/permissions",
      params: { id: "ext-1" },
      body: { permissions: MALICIOUS_PERMISSIONS },
      user: ADMIN_USER,
    });
    const res = await call(PUT, event);
    expect(res.status).toBe(200);

    const stored = updateCalls[0]!.data.grantedPermissions as Record<
      string,
      unknown
    >;
    expect(stored.shell).toBeUndefined();
    expect(stored.filesystem).toBeUndefined();
    expect(stored.network).toBeUndefined();
    expect(stored.env).toBeUndefined();
    expect(stored.storage).toBeUndefined();
  });
});
