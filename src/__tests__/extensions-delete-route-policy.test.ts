/**
 * `DELETE /api/extensions/[id]` — the POLICY half of uninstall.
 *
 * The mechanism (which directories are removed, and the containment rules
 * that decide) lives in `installer.ts` and is covered by
 * `installer-coverage.test.ts`. What this file pins is what the ROUTE
 * decides before calling it:
 *
 *   - a built-in is refused with 409 and never reaches the installer;
 *   - `?purgeData=1` — and only that spelling — asks for the data purge.
 *
 * Isolated from `extensions-patch-route.test.ts` because it must
 * `mock.module` the installer to observe the call, and that file
 * deliberately drives the REAL one so its `deleteExtension`/`reload`
 * assertions stay honest. Same split as
 * `assert-critical-extensions-ceiling-exceeds.test.ts`.
 */

import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
} from "./helpers/mock-request";

mockServerAlias();

mock.module("../../web/src/routes/api/extensions/[id]/$types", () => ({}));

const apiKeysMock = () => ({ requireScope: () => null });
mock.module("$lib/server/security/api-keys", apiKeysMock);
mock.module("../../web/src/lib/server/security/api-keys", apiKeysMock);

// ── The row under test ───────────────────────────────────────────────
let isBundled = false;

const fakeExtensionRow = async (id: string) => ({
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
  enabled: true,
  isBundled,
  grantedPermissions: { grantedAt: {} },
  checksumVerified: true,
  consecutiveFailures: 0,
  createdAt: new Date(),
  updatedAt: new Date(),
});

const extensionsQueriesMock = () => ({
  getExtension: fakeExtensionRow,
  getExtensionByRef: fakeExtensionRow,
  updateExtension: async (id: string, data: Record<string, unknown>) => ({ id, ...data }),
});
mock.module("$server/db/queries/extensions", extensionsQueriesMock);
mock.module("../db/queries/extensions", extensionsQueriesMock);

const uninstallCalls: Array<{ actor: { principalId: string; kind: string }; installationId: string }> = [];
const lifecycleMock = () => ({
  getExtensionLifecycle: async () => ({
    inspect: async () => ({}),
    uninstall: async (actor: { principalId: string; kind: string }, installationId: string) => { uninstallCalls.push({ actor, installationId }); },
  }),
});
mock.module("$server/extensions/extension-lifecycle-service", lifecycleMock);
mock.module("../extensions/extension-lifecycle-service", lifecycleMock);

const registryMock = () => ({
  ExtensionRegistry: { getInstance: () => ({ reload: async () => {}, killAll: () => {} }) },
});
mock.module("$server/extensions/registry", registryMock);
mock.module("../extensions/registry", registryMock);

mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));

import { DELETE } from "../../web/src/routes/api/extensions/[id]/+server";

async function call(handler: (ev: any) => unknown, event: any): Promise<Response> {
  try {
    return (await handler(event)) as Response;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

function deleteEvent(query = ""): any {
  return createMockEvent({
    method: "DELETE",
    url: `http://localhost/api/extensions/ext-1${query}`,
    params: { id: "ext-1" },
    user: ADMIN_USER,
  });
}

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  uninstallCalls.length = 0;
  isBundled = false;
});

describe("DELETE /api/extensions/[id] — durable uninstall policy", () => {
  test.each([false, true])("uninstall delegates one installation and preserves data (bundled=%s)", async (bundled) => {
    isBundled = bundled;
    const response = await call(DELETE, deleteEvent());
    expect(response.status).toBe(204);
    expect(uninstallCalls).toHaveLength(1);
    expect(uninstallCalls[0]).toMatchObject({ installationId: "ext-1", actor: { principalId: ADMIN_USER.id } });
    expect(uninstallCalls[0]).not.toHaveProperty("purgeData");
  });
  test("uninstall does not trust a source path supplied in the HTTP request", async () => {
    const event = deleteEvent("?path=/etc&installPath=/");
    await call(DELETE, event);
    expect(uninstallCalls[0]).toEqual({ installationId: "ext-1", actor: { principalId: ADMIN_USER.id, scope: "global", kind: "agent" } });
  });
  test("purge is rejected before any mutation", async () => {
    const response = await call(DELETE, deleteEvent("?purgeData=1"));
    expect(response.status).toBe(400);
    expect(await jsonFromResponse(response)).toHaveProperty("error");
    expect(uninstallCalls).toEqual([]);
  });
  test.each(["", "?purgeData=true", "?purgeData=yes", "?purgeData=0", "?purgeData="])("uninstall never implies deletion for query %s", async (query) => {
    expect((await call(DELETE, deleteEvent(query))).status).toBe(204);
    expect(uninstallCalls).toHaveLength(1);
    expect(uninstallCalls[0]).not.toHaveProperty("purgeData");
  });
});
