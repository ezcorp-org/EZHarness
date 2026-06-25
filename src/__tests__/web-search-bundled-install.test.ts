/**
 * Integration test for the bundled-install path of the `web-search`
 * extension. Stubs the DB queries used by `ensureBundledExtensions` and
 * `installFromLocal` so we can exercise the install logic against an
 * in-memory extension row without spinning up PGlite.
 *
 * What this test locks in:
 *   - A `web-search` DB row is created on first startup.
 *   - The row is `enabled = true`.
 *   - Post shared-search migration, the bundled entry grants ONLY the host
 *     `ctx.search` capability (`search: "inherit"`) and owns NO network
 *     hosts, NO provider API-key env vars, and NO filesystem grant — the
 *     provider chain, SSRF guard, and cache all run host-side in `src/search/`.
 *     This guarantees `src/extensions/bundled.ts` stays in lockstep with the
 *     manifest (`docs/extensions/examples/web-search/ezcorp.config.ts`).
 *   - `grantedAt.search` is a numeric timestamp (the shape the grant
 *     tracking relies on).
 */
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

interface StoredExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: unknown;
  source: string;
  installPath: string;
  enabled: boolean;
  grantedPermissions: {
    network?: string[];
    env?: string[];
    filesystem?: string[];
    shell?: boolean;
    storage?: boolean;
    search?: string;
    grantedAt: Record<string, number>;
  };
  checksumVerified: boolean;
  consecutiveFailures: number;
}

let store: Map<string, StoredExtension>;
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async () => undefined,
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

afterAll(() => restoreModuleMocks());

// Import AFTER the mock so the installer resolves to the stubbed queries.
import { ensureBundledExtensions } from "../extensions/bundled";

beforeEach(() => {
  store = new Map();
  nextId = 0;
});

describe("bundled install: web-search", () => {
  test("first run creates the web-search row", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search");
    expect(row).toBeDefined();
    expect(row!.name).toBe("web-search");
    expect(row!.enabled).toBe(true);
  });

  test("grants ONLY the shared ctx.search capability — no network/env/filesystem", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    // Shared-search migration: web-search is a thin shim over the host
    // `ctx.search` capability. The provider chain (SearXNG / DuckDuckGo /
    // BYOK), the SSRF egress guard, and the shared cache all run host-side
    // in src/search/ — so the extension owns NO network hosts, NO provider
    // API-key env vars, and NO filesystem grant. Asserting their ABSENCE is
    // the security invariant that keeps bundled.ts + the manifest honest.
    expect(row.grantedPermissions.search).toBe("inherit");
    expect(row.grantedPermissions.network).toBeUndefined();
    expect(row.grantedPermissions.env).toBeUndefined();
    expect(row.grantedPermissions.filesystem).toBeUndefined();
  });

  test("grantedAt carries a numeric timestamp for the search grant only", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    expect(typeof row.grantedPermissions.grantedAt.search).toBe("number");
    expect(row.grantedPermissions.grantedAt.search).toBeGreaterThan(0);
    // The pre-migration direct-grant timestamps are gone.
    expect(row.grantedPermissions.grantedAt.network).toBeUndefined();
    expect(row.grantedPermissions.grantedAt.env).toBeUndefined();
  });

  test("manifest declares both tools", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    const manifest = row.manifest as { tools?: Array<{ name: string }> };
    const names = (manifest.tools ?? []).map((t) => t.name).sort();
    expect(names).toEqual(["read-url", "search-web"]);
  });

  test("second run is a no-op (already installed)", async () => {
    await ensureBundledExtensions();
    const firstId = store.get("web-search")!.id;
    await ensureBundledExtensions();
    expect(store.get("web-search")!.id).toBe(firstId);
  });
});
