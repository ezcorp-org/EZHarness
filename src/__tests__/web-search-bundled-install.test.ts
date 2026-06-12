/**
 * Integration test for the bundled-install path of the `web-search`
 * extension. Stubs the DB queries used by `ensureBundledExtensions` and
 * `installFromLocal` so we can exercise the install logic against an
 * in-memory extension row without spinning up PGlite.
 *
 * What this test locks in:
 *   - A `web-search` DB row is created on first startup.
 *   - The row is `enabled = true`.
 *   - `grantedPermissions` includes every manifest-declared hostname and
 *     env var (guarantees the bundled entry in `src/extensions/bundled.ts`
 *     stays in lockstep with the manifest).
 *   - `grantedAt.network` and `grantedAt.env` are numeric timestamps
 *     (the shape `buildAllowedEnv` relies on in `registry.ts:37-51`).
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

  test("grants every manifest-declared network host", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    const expected = [
      "r.jina.ai",
      "s.jina.ai",
      "api.tavily.com",
      "api.search.brave.com",
      "api.exa.ai",
      "serpapi.com",
      // Keyless defaults (DDG scrape + SearXNG sidecar) — removing any
      // of these grants silently breaks zero-setup search, so pin them.
      "lite.duckduckgo.com",
      "html.duckduckgo.com",
      "duckduckgo.com",
      "searxng",
      "localhost",
      "127.0.0.1",
    ];
    for (const host of expected) expect(row.grantedPermissions.network).toContain(host);
  });

  test("grants every optional API-key env var (plus the SearXNG base URL)", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    const expected = [
      "TAVILY_API_KEY",
      "BRAVE_API_KEY",
      "EXA_API_KEY",
      "SERPAPI_API_KEY",
      "JINA_API_KEY",
      // Not credential-shaped — base URL pointing at the SearXNG sidecar.
      "SEARXNG_BASE_URL",
    ];
    for (const key of expected) expect(row.grantedPermissions.env).toContain(key);
  });

  test("grantedAt carries numeric timestamps for network and env", async () => {
    await ensureBundledExtensions();
    const row = store.get("web-search")!;
    expect(typeof row.grantedPermissions.grantedAt.network).toBe("number");
    expect(typeof row.grantedPermissions.grantedAt.env).toBe("number");
    expect(row.grantedPermissions.grantedAt.network).toBeGreaterThan(0);
    expect(row.grantedPermissions.grantedAt.env).toBeGreaterThan(0);
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
