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

import { test, expect, describe, afterAll, beforeAll, beforeEach, mock, spyOn } from "bun:test";
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

// `$server/db/queries/extensions` cannot be withdrawn once registered, and
// OTHER files also claim it, so a relative-only mock cannot be relied on
// here the way it can for lifecycle-service/registry below. Claim it, then
// hand it BACK to the real module in afterAll (W18c's diff, cited in the
// gates file) — without that, a later route (phase-2b-e2e.test.ts) reads
// THIS file's fixture row, which has no grantedPermissions, and returns an
// empty body. Scoped to this test's own fixture id ("ext-1") on top of that,
// falling through to the real, DB-backed function for any other id, so
// installer-idempotent-local.test.ts's own real ids still read real rows in
// the window before afterAll runs.
const realExtensionQueries = serverModule("db/queries/extensions", {}) as { getExtensionByRef: (id: string) => unknown; updateExtension: (id: string, data: Record<string, unknown>) => unknown };
const FIXTURE_ID = "ext-1";
const gatedExtensionRow = (id: string) => id !== FIXTURE_ID ? realExtensionQueries.getExtensionByRef(id) : fakeExtensionRow(id);
const extensionsQueriesMock = serverModule("db/queries/extensions", {
  getExtension: gatedExtensionRow,
  getExtensionByRef: gatedExtensionRow,
  updateExtension: (id: string, data: Record<string, unknown>) => id !== FIXTURE_ID ? realExtensionQueries.updateExtension(id, data) : Promise.resolve({ id, ...data }),
});
mock.module("$server/db/queries/extensions", () => extensionsQueriesMock);
mock.module("../db/queries/extensions", () => extensionsQueriesMock);

const uninstallCalls: Array<{ actor: LifecycleActor; installationId: string }> = [];
// The lifecycle service is mocked on its RELATIVE path ONLY — no
// `$server/extensions/extension-lifecycle-service` registration at all. A
// route resolves that alias natively to the same record as the relative
// path when nothing has claimed the alias separately, so the stub still
// reaches it; but an alias registration can never be withdrawn, and once
// one exists, installer-idempotent-local.test.ts's own spyOn() on the real
// lifecycle-service namespace no longer reaches its author loader (3
// failures; W18c's diff, cited in the gates file). Spread the real module
// under the fake so no export name is ever missing.
const realLifecycleService = serverModule("extensions/extension-lifecycle-service", {});
const lifecycleMock = () => ({
  ...realLifecycleService,
  getExtensionLifecycle: async () => ({
    inspect: async () => ({}),
    uninstall: async (actor: LifecycleActor, installationId: string) => { uninstallCalls.push({ actor, installationId }); },
  }),
});
mock.module("../extensions/extension-lifecycle-service", lifecycleMock);

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

// ExtensionRegistry.getInstance() is a cheap in-memory singleton (no I/O) —
// never replace the class/module: any OTHER file's already-loaded consumer
// (scoped-tools.ts, context.ts, …) shares the SAME singleton object either
// way, and a module-level mock.module() override freezes on whichever file
// bound it first for the rest of the process, breaking every other
// consumer's real methods (tool scoping, workflow loading, …). spyOn() the
// real instance's two methods instead; restoreModuleMocks()'s mock.restore()
// undoes it for everyone, from wherever they got their reference.
//
// Fetched in beforeAll, NOT at this file's own top level: every file that
// does this same thing calls ExtensionRegistry.getInstance() during the
// SHARED LOADING PHASE (before any file's tests run), when the singleton has
// not been reset by anyone yet — so two such files capture the SAME
// instance. The first file's own afterAll then calls resetInstance(),
// discarding it; the second file's module-level reference is now stale, and
// its OWN spies point at an object getInstance() no longer returns —
// leaving its OWN afterAll's assertions silently checking nothing, and a
// LATER real caller (phase-2b-e2e.test.ts's publish(), reaching a fresh
// instance this file never spied) hitting whichever spy is STILL active
// from whoever spied last. Fetching it in beforeAll (test-execution time,
// after every earlier file's own resetInstance() has already run) gets the
// instance actually live for THIS file's own run.
let registryInstance: ExtensionRegistry;
let reloadSpy: ReturnType<typeof spyOn>;
let killAllSpy: ReturnType<typeof spyOn>;
beforeAll(() => {
  registryInstance = ExtensionRegistry.getInstance();
  reloadSpy = spyOn(registryInstance, "reload").mockImplementation(async () => {});
  killAllSpy = spyOn(registryInstance, "killAll").mockImplementation(() => {});
});

afterAll(() => {
  // Hand the claimed extensions-queries alias back to the real module
  // before the generic restore, which cannot reach a `$server/*` alias (see
  // the comment above). The lifecycle-service alias was never claimed, so
  // there is nothing to hand back for it — only its relative path, which
  // restoreModuleMocks() already covers via MODULE_PATHS.
  mock.module("$server/db/queries/extensions", () => realExtensionQueries);
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
