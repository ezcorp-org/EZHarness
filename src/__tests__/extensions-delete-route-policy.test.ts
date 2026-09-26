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

import { test, expect, describe, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks, webLibModule, serverModule } from "./helpers/mock-cleanup";
import { ExtensionRegistry } from "../extensions/registry";
import type { LifecycleActor } from "../extensions/v4/types";
import {
  mockServerAlias,
  createMockEvent,
  jsonFromResponse,
  ADMIN_USER,
} from "./helpers/mock-request";

mockServerAlias();

mock.module("../../web/src/routes/api/extensions/[id]/$types", () => ({}));

const apiKeysMock = webLibModule("server/security/api-keys", { requireScope: () => null });
mock.module("$lib/server/security/api-keys", () => apiKeysMock);
mock.module("../../web/src/lib/server/security/api-keys", () => apiKeysMock);

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

// `$server/db/queries/extensions` cannot be withdrawn either (same reason as
// the lifecycle-service alias below). Scoped to THIS test's own fixture id
// ("ext-1") and falls through to the real, DB-backed functions for anything
// else — so whichever OTHER file's route module gets frozen on this
// registration during the load phase still reads its OWN real rows for its
// OWN ids. installer-idempotent-local.test.ts and phase-2b-e2e.test.ts both
// read their own real extensions this way.
// Snapshot the specific real functions as standalone values (not a live
// object reference) — mock.module() on the same relative specifier updates
// properties in place, so a captured object reference would see the
// override too, not just a specifier that resolves to it.
const realExtensions = require("../db/queries/extensions");
const realGetExtensionByRef = realExtensions.getExtensionByRef as (id: string) => unknown;
const realUpdateExtension = realExtensions.updateExtension as (id: string, data: Record<string, unknown>) => unknown;
const FIXTURE_ID = "ext-1";
const gatedExtensionRow = (id: string) => id !== FIXTURE_ID ? realGetExtensionByRef(id) : fakeExtensionRow(id);
const extensionsQueriesMock = serverModule("db/queries/extensions", {
  getExtension: gatedExtensionRow,
  getExtensionByRef: gatedExtensionRow,
  updateExtension: (id: string, data: Record<string, unknown>) => id !== FIXTURE_ID ? realUpdateExtension(id, data) : Promise.resolve({ id, ...data }),
});
mock.module("$server/db/queries/extensions", () => extensionsQueriesMock);
mock.module("../db/queries/extensions", () => extensionsQueriesMock);

const uninstallCalls: Array<{ actor: LifecycleActor; installationId: string }> = [];
// `$server/extensions/extension-lifecycle-service` cannot be withdrawn once
// registered — restoreModuleMocks() only restores the relative-path snapshot
// in MODULE_PATHS, never a `$server/*` alias (removed as actively harmful;
// see mock-cleanup.ts). Capture the real module here so any OTHER file's
// route module that freezes on this registration during the load phase
// still reaches the REAL lifecycle for any method this test does not
// override (e.g. `.list()`, which installer-idempotent-local.test.ts's
// author-loader needs, by then backed by that file's own real test DB) —
// only inspect/uninstall, this test's own concern, are faked.
// Snapshot the specific real function as a standalone value, same reason as
// realGetExtensionByRef above.
const realGetExtensionLifecycle = require("../extensions/extension-lifecycle-service").getExtensionLifecycle as () => Promise<Record<string, (...a: unknown[]) => unknown>>;
const lifecycleFake = {
  inspect: async () => ({}),
  uninstall: async (actor: LifecycleActor, installationId: string) => { uninstallCalls.push({ actor, installationId }); },
};
const lifecycleProxy = new Proxy(lifecycleFake, {
  get(target, prop, receiver) {
    // `typeof prop !== "string"` excludes symbols. `prop === "then"` is
    // separate — see extensions-patch-route.test.ts's comment for why a
    // lazy-delegate "then" makes this object look like a thenable and
    // infinite-loops getExtensionLifecycle()'s own promise resolution.
    if (Reflect.has(target, prop) || typeof prop !== "string" || prop === "then") return Reflect.get(target, prop, receiver);
    return async (...args: unknown[]) => {
      const real = await realGetExtensionLifecycle();
      return real[prop]?.(...args);
    };
  },
});
const lifecycleMock = serverModule("extensions/extension-lifecycle-service", {
  getExtensionLifecycle: async () => lifecycleProxy,
});
mock.module("$server/extensions/extension-lifecycle-service", () => lifecycleMock);
mock.module("../extensions/extension-lifecycle-service", () => lifecycleMock);

// ExtensionRegistry.getInstance() is a cheap in-memory singleton (no I/O) —
// never replace the class/module: any OTHER file's already-loaded consumer
// (scoped-tools.ts, context.ts, …) shares the SAME singleton object either
// way, and a module-level mock.module() override freezes on whichever file
// bound it first for the rest of the process, breaking every other
// consumer's real methods (tool scoping, workflow loading, …). spyOn() the
// real instance's two methods instead; restoreModuleMocks()'s mock.restore()
// undoes it for everyone, from wherever they got their reference.
const registryInstance = ExtensionRegistry.getInstance();
const reloadSpy = spyOn(registryInstance, "reload").mockImplementation(async () => {});
const killAllSpy = spyOn(registryInstance, "killAll").mockImplementation(() => {});

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

afterAll(() => {
  // Hand the claimed alias back to the real module before the generic
  // restore, which cannot reach it (see the comment above).
  mock.module("$server/extensions/extension-lifecycle-service", () => require("../extensions/extension-lifecycle-service"));
  restoreModuleMocks();
  // Un-spy BEFORE resetInstance(): resetInstance() calls the instance's own
  // killAll(), and leaving the spy in place would leave the spied instance
  // active for every later file that reaches the same shared singleton.
  reloadSpy.mockRestore();
  killAllSpy.mockRestore();
  ExtensionRegistry.resetInstance();
});

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
