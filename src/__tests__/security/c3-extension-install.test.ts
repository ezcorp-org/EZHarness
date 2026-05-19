// Regression test for sec-C3: POST /api/extensions must be gated on
// requireRole(locals, "admin") AND must ignore caller-supplied
// grantedPermissions on first install. Pre-fix the route was only gated by
// `requireScope(locals, "extensions")`, which is a no-op for cookie auth —
// so any logged-in "member" could POST an install body like:
//
//   { source: "local", path: "...", permissions: { shell: true,
//     filesystem: ["/"], grantedAt: {...} } }
//
// and the installer was handed those exact permissions and `enabled=true`.
// Combined with POST /api/tool-invoke this was an RCE primitive: the
// attacker-installed extension could shell out as the server-process user.
//
// Fix (f6ee69e):
//   - requireRole(locals, "admin") as the first line of POST
//   - caller-supplied `permissions` is dropped; installer gets `{ grantedAt: {} }`
//   - installer is called with `enabled=false`
//
// Strategy: handler-level probe. Mock the installer so we capture the
// (path, permissions, enabled) triple it was called with, then drive the
// POST handler with a member and an admin user and assert:
//   1. member POST with malicious permissions → 403, installer not called
//   2. admin POST with malicious permissions → 201, installer called with
//      EMPTY permissions and enabled=false (caller permissions ignored)
//   3. admin POST happy path → 201, enabled=false
//
// Tests fix(sec-C3): f6ee69e

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
mock.module("../../../web/src/routes/api/extensions/$types", () => ({}));

// $lib/server/security/validation is already wired by mockServerAlias.
// requireScope must be a no-op passthrough so we're exercising the *new*
// requireRole gate, not a stub of the old scope check.
mock.module("$lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));
mock.module("../../../web/src/lib/server/security/api-keys", () => ({
  requireScope: () => null,
}));

// cache-utils is imported at the top of the handler (used only in GET) —
// stub it so the module graph loads cleanly without pulling in real deps.
const cacheUtilsMock = () => ({
  cacheableResponse: (_req: Request, body: unknown, _opts?: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }),
});
mock.module("$server/lib/cache-utils", cacheUtilsMock);
mock.module("../../lib/cache-utils", cacheUtilsMock);

// The install-body schema uses `z.record(z.unknown())` for `permissions`,
// which is broken in zod v4 (pre-existing bug, out of scope for sec-C3 —
// tracked separately). Stub the schema with a permissive pass-through so
// we can exercise the handler with malicious-permissions bodies without
// tripping zod's record parser. We still want `source`+`path`/`repo` to be
// required enough to reach the installer call site.
const schemaMock = () => ({
  installExtensionSchema: {
    safeParse: (data: unknown) => {
      const d = data as Record<string, unknown>;
      if (!d || (d.source !== "local" && d.source !== "github")) {
        return { success: false, error: { issues: [{ message: "bad source" }] } };
      }
      if (d.source === "local" && !d.path) {
        return { success: false, error: { issues: [{ message: "path required" }] } };
      }
      if (d.source === "github" && !d.repo) {
        return { success: false, error: { issues: [{ message: "repo required" }] } };
      }
      return { success: true, data: d };
    },
  },
});
mock.module("../../../web/src/routes/api/extensions/schema", schemaMock);
mock.module("./schema", schemaMock);

// ── Capture installer arguments ──────────────────────────────────
// Recorded by the mocked installer on each call. Tests inspect these to
// prove the caller's permissions were dropped and enabled=false was forced.
type InstallCall = {
  fn: "installFromLocal" | "installFromGitHub";
  arg0: string;
  permissions: unknown;
  enabled: boolean | undefined;
};
let installCalls: InstallCall[] = [];

const installerMock = () => ({
  installFromLocal: async (
    localPath: string,
    permissions: unknown,
    enabled?: boolean,
  ) => {
    installCalls.push({
      fn: "installFromLocal",
      arg0: localPath,
      permissions,
      enabled,
    });
    return {
      id: "ext-local-1",
      name: "fake-local-ext",
      version: "1.0.0",
      source: `local:${localPath}`,
      installPath: localPath,
      enabled: enabled ?? false,
      grantedPermissions: permissions,
    };
  },
  installFromGitHub: async (
    repoSpec: string,
    permissions: unknown,
    enabled?: boolean,
  ) => {
    installCalls.push({
      fn: "installFromGitHub",
      arg0: repoSpec,
      permissions,
      enabled,
    });
    return {
      id: "ext-gh-1",
      name: "fake-gh-ext",
      version: "1.0.0",
      source: `github:${repoSpec}`,
      installPath: "data/extensions/fake-gh-ext",
      enabled: enabled ?? false,
      grantedPermissions: permissions,
    };
  },
});
mock.module("$server/extensions/installer", installerMock);
mock.module("../../extensions/installer", installerMock);

// ExtensionRegistry.getInstance().reload() is called after a successful
// install — stub it to a no-op so we don't touch the real registry / DB.
const registryMock = () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
});
mock.module("$server/extensions/registry", registryMock);
mock.module("../../extensions/registry", registryMock);

// listExtensions is GET-only but it's still imported at top level.
const extQueriesMock = () => ({
  listExtensions: async () => [],
});
mock.module("$server/db/queries/extensions", extQueriesMock);
mock.module("../../db/queries/extensions", extQueriesMock);

// ── Handler import (AFTER mocks) ─────────────────────────────────
import { POST } from "../../../web/src/routes/api/extensions/+server";

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
  installCalls = [];
});

// The attacker-chosen permission payload the pre-fix route handed straight
// to the installer. The shape matches the pre-fix exploit narrative in the
// validation report: arbitrary shell + full-filesystem read.
const MALICIOUS_PERMISSIONS = {
  shell: true,
  filesystem: ["/"],
  network: ["*"],
  grantedAt: { shell: 1700000000000, filesystem: 1700000000000 },
};

describe("sec-C3: POST /api/extensions role gate", () => {
  test("member role → 403, installer NOT called (role gate blocks the whole request)", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "local",
        path: "/tmp/fake-extension",
        permissions: MALICIOUS_PERMISSIONS,
      },
      user: MEMBER_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(403);
    // The installer MUST NOT have been reached at all. Pre-fix, the member's
    // call would fall through to installFromLocal with the malicious perms.
    expect(installCalls.length).toBe(0);
  });

  test("member role targeting GitHub install → 403, installer NOT called", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "github",
        repo: "attacker/evil-ext",
        permissions: MALICIOUS_PERMISSIONS,
      },
      user: MEMBER_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(403);
    expect(installCalls.length).toBe(0);
  });

  test("unauthenticated → 401, installer NOT called", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "local",
        path: "/tmp/fake-extension",
      },
      // no user
    });
    const res = await call(POST, event);
    expect(res.status).toBe(401);
    expect(installCalls.length).toBe(0);
  });
});

describe("sec-C3: caller-supplied permissions are ignored", () => {
  test("admin POST local + malicious permissions → 201, installer gets EMPTY perms", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "local",
        path: "/tmp/fake-extension",
        permissions: MALICIOUS_PERMISSIONS,
      },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(201);

    expect(installCalls.length).toBe(1);
    const callRec = installCalls[0]!;
    expect(callRec.fn).toBe("installFromLocal");
    expect(callRec.arg0).toBe("/tmp/fake-extension");

    // The caller's permissions MUST have been dropped. The only key allowed
    // on first install is the empty-skeleton `grantedAt: {}` sentinel.
    const perms = callRec.permissions as Record<string, unknown>;
    expect(perms).toBeDefined();
    expect(perms.shell).toBeUndefined();
    expect(perms.filesystem).toBeUndefined();
    expect(perms.network).toBeUndefined();
    // grantedAt exists and is empty (no pre-stamped approvals).
    expect(perms.grantedAt).toBeDefined();
    expect(Object.keys(perms.grantedAt as Record<string, unknown>)).toEqual([]);

    // And the install must be disabled by default — admin confirms separately.
    expect(callRec.enabled).toBe(false);
  });

  test("admin POST GitHub + malicious permissions → 201, installer gets EMPTY perms", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "github",
        repo: "someone/some-ext",
        permissions: MALICIOUS_PERMISSIONS,
      },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(201);

    expect(installCalls.length).toBe(1);
    const callRec = installCalls[0]!;
    expect(callRec.fn).toBe("installFromGitHub");
    expect(callRec.arg0).toBe("someone/some-ext");

    const perms = callRec.permissions as Record<string, unknown>;
    expect(perms.shell).toBeUndefined();
    expect(perms.filesystem).toBeUndefined();
    expect(perms.network).toBeUndefined();
    expect(Object.keys(perms.grantedAt as Record<string, unknown>)).toEqual([]);
    expect(callRec.enabled).toBe(false);
  });
});

describe("sec-C3: happy path (admin, no permissions in body)", () => {
  test("admin POST local with no permissions → 201, installer gets empty perms and enabled=false", async () => {
    const event = createMockEvent({
      method: "POST",
      url: "http://localhost/api/extensions",
      body: {
        source: "local",
        path: "/tmp/benign-extension",
      },
      user: ADMIN_USER,
    });
    const res = await call(POST, event);
    expect(res.status).toBe(201);

    const body = await jsonFromResponse(res);
    expect(body.name).toBe("fake-local-ext");

    expect(installCalls.length).toBe(1);
    const callRec = installCalls[0]!;
    const perms = callRec.permissions as Record<string, unknown>;
    expect(Object.keys(perms.grantedAt as Record<string, unknown>)).toEqual([]);
    expect(callRec.enabled).toBe(false);
  });
});
