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

// ── Installer stub — capture what the route asked for ────────────────
const uninstallCalls: Array<{ id: string; purgeData: boolean | undefined }> = [];
const installerMock = () => ({
  uninstallExtension: async (
    ext: { id: string },
    opts?: { purgeData?: boolean },
  ) => {
    uninstallCalls.push({ id: ext.id, purgeData: opts?.purgeData });
    return { installPathRemoved: true, dataRemoved: opts?.purgeData === true };
  },
});
mock.module("$server/extensions/installer", installerMock);
mock.module("../extensions/installer", installerMock);

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

describe("DELETE /api/extensions/[id] — built-in guard", () => {
  test("a bundled extension is refused with 409 and never uninstalled", async () => {
    // The UI has never shown the button for a built-in, but the API did
    // allow it — and the delete was worse than a no-op: the next boot
    // reinstalls the row with DEFAULT grants, so the only lasting effect
    // was silently discarding the admin's permission narrowing.
    isBundled = true;

    const res = await call(DELETE, deleteEvent());

    expect(res.status).toBe(409);
    const body = await jsonFromResponse(res);
    expect(body.error).toContain("disable it instead");
    expect(uninstallCalls).toEqual([]);
  });

  test("a user-installed extension is uninstalled normally", async () => {
    const res = await call(DELETE, deleteEvent());

    expect(res.status).toBe(204);
    expect(uninstallCalls).toHaveLength(1);
    expect(uninstallCalls[0]!.id).toBe("ext-1");
  });
});

describe("DELETE /api/extensions/[id] — purgeData", () => {
  test("?purgeData=1 asks the installer to delete the stored data", async () => {
    const res = await call(DELETE, deleteEvent("?purgeData=1"));

    expect(res.status).toBe(204);
    expect(uninstallCalls[0]!.purgeData).toBe(true);
  });

  test("no query parameter keeps the data", async () => {
    await call(DELETE, deleteEvent());

    expect(uninstallCalls[0]!.purgeData).toBe(false);
  });

  test("any other spelling keeps the data — the parse fails SAFE", async () => {
    // `=1` is the documented spelling (`src/api-registry.ts`). A caller
    // that guesses wrong must lose nothing; the failure direction for an
    // irreversible delete is "did not delete".
    for (const query of ["?purgeData=true", "?purgeData=yes", "?purgeData=0", "?purgeData="]) {
      uninstallCalls.length = 0;
      await call(DELETE, deleteEvent(query));
      expect(uninstallCalls[0]!.purgeData).toBe(false);
    }
  });
});
