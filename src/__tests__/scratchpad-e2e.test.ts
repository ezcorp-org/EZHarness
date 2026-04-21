/**
 * End-to-end test for the Phase 1 scratchpad conversion.
 *
 * Covers the "full stack minus HTTP" path:
 *   1. A fresh PGlite DB + `ensureBundledExtensions()` installs scratchpad
 *      with the expected row shape (enabled=true, storage granted).
 *   2. `GET /api/mentions/search?type=ext` returns scratchpad so the
 *      composer's `!scratchpad` mention picker surfaces it.
 *   3. `GET /api/extensions/[id]/audit` returns the install audit row
 *      that the bundled-install path wrote.
 *   4. Disabling the row removes it from mention-picker results.
 *
 * We do NOT spin up the Bun HTTP server — the SvelteKit routes are
 * called as function handlers with a fabricated RequestEvent. This
 * mirrors the project's existing API-route test style (e.g.
 * mention-search-cmd-api.test.ts) and keeps the test fast + stable.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

// NOTE: we do NOT mock `$server/auth/middleware`. The real `requireAuth`
// inspects `locals.user`; injecting an admin user there via `makeRequest()`
// is enough to satisfy the gate without replacing the real module.

mock.module("$lib/server/context", () => ({
  getExecutor: () => ({ listAgents: () => [] }),
  getBus: () => ({ emit: () => {}, on: () => () => {} }),
  getCommandRegistry: () => ({ listCommands: async () => [] }),
  ensureInitialized: async () => {},
}));

mock.module("$server/db/connection", async () => {
  const { getDb } = await import("../db/connection");
  return { getDb };
});

// $types is a SvelteKit-generated ambient module — no-op at test time.
mock.module("../../web/src/routes/api/mentions/search/$types", () => ({}));
mock.module("../../web/src/routes/api/extensions/[id]/audit/$types", () => ({}));
mock.module("../../web/src/routes/api/extensions/[id]/$types", () => ({}));

import { ensureBundledExtensions } from "../extensions/bundled";
import { updateExtension } from "../db/queries/extensions";
import { getExtensionByName } from "../db/queries/extensions";
import { GET as mentionsSearchGet } from "../../web/src/routes/api/mentions/search/+server";
import { GET as extensionAuditGet } from "../../web/src/routes/api/extensions/[id]/audit/+server";

const ADMIN_USER = { id: "admin-user-0001", role: "admin", email: "a@t", name: "Admin" };

function makeRequest(url: string, params?: Record<string, string>): any {
  const u = new URL(url, "http://test");
  return {
    url: u,
    locals: { user: ADMIN_USER },
    params: params ?? Object.fromEntries(u.searchParams.entries()),
    request: new Request(u.toString()),
  };
}

async function jsonFromResponse(res: Response): Promise<unknown> {
  return res.json();
}

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
});

beforeEach(() => {
  // Nothing — PGlite persists across tests so we check idempotence explicitly.
});

describe("scratchpad e2e: install → mention-picker → audit → toggle", () => {
  test("ensureBundledExtensions creates the scratchpad row with correct shape", async () => {
    await ensureBundledExtensions();
    const row = await getExtensionByName("scratchpad");
    expect(row).not.toBeNull();
    expect(row!.enabled).toBe(true);
    expect((row!.grantedPermissions as { storage?: boolean }).storage).toBe(true);
  });

  test("mention-picker (type=ext) surfaces scratchpad as an extension", async () => {
    await ensureBundledExtensions();
    const event = makeRequest("/api/mentions/search?type=ext&q=scratch");
    const res = await mentionsSearchGet(event);
    const body = await jsonFromResponse(res) as Array<{ name: string; kind: string }>;
    const hit = body.find((r) => r.name === "scratchpad");
    expect(hit).toBeDefined();
    expect(hit!.kind).toBe("extension");
  });

  test("mention-picker (type=ext) no longer shows scratchpad as a built-in category", async () => {
    // Phase 1 removed scratchpad from `getBuiltInCategories()`. The
    // composer should show exactly ONE scratchpad entry — the extension
    // row — not duplicated as a built-in category.
    await ensureBundledExtensions();
    const event = makeRequest("/api/mentions/search?type=ext&q=scratchpad");
    const res = await mentionsSearchGet(event);
    const body = await jsonFromResponse(res) as Array<{ name: string; kind: string }>;
    const scratchpadRows = body.filter((r) => r.name === "scratchpad");
    expect(scratchpadRows).toHaveLength(1);
  });

  test("audit endpoint returns the install row for the scratchpad extension", async () => {
    await ensureBundledExtensions();
    const row = await getExtensionByName("scratchpad");
    const event = {
      params: { id: row!.id },
      locals: { user: ADMIN_USER },
      url: new URL(`http://test/api/extensions/${row!.id}/audit`),
    } as any;
    const res = await extensionAuditGet(event);
    expect(res.status).toBe(200);
    const body = await jsonFromResponse(res) as { entries: Array<{ action: string; target: string }> };
    expect(Array.isArray(body.entries)).toBe(true);
    // Bundled install writes `ext:bundled-installed` rows (one per granted
    // permission). First install should have at least one row.
    const installRows = body.entries.filter((e) => e.action === "ext:bundled-installed");
    expect(installRows.length).toBeGreaterThanOrEqual(1);
    for (const r of installRows) expect(r.target).toBe(row!.id);
  });

  test("disabling scratchpad in DB drops it from the mention-picker", async () => {
    await ensureBundledExtensions();
    const row = await getExtensionByName("scratchpad");
    await updateExtension(row!.id, { enabled: false });
    try {
      const event = makeRequest("/api/mentions/search?type=ext&q=scratch");
      const res = await mentionsSearchGet(event);
      const body = await jsonFromResponse(res) as Array<{ name: string }>;
      // Only enabled=true extensions appear in the picker
      // (per web/src/routes/api/mentions/search/+server.ts:282).
      expect(body.some((r) => r.name === "scratchpad")).toBe(false);
    } finally {
      // Leave the DB in the state the next test expects: re-enabling
      // happens on the next ensureBundledExtensions() via the bundled
      // "source of truth" invariant.
      await updateExtension(row!.id, { enabled: true });
    }
  });
});
