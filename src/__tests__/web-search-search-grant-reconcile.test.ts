/**
 * Bundled-grant self-heal for the `search` HOST CAPABILITY — the
 * web-search "Web search is disabled for this extension." regression.
 *
 * Production bug reproduced here:
 *   - Shared-search Phase 1 turned `web-search` into a thin shim over the
 *     host `ctx.search` capability: its bundled entry (`bundled.ts`) and
 *     ceiling (`bundled-ceiling.ts`) now declare `search: "inherit"`, and
 *     it DROPPED its old `network`/`env` grants.
 *   - A web-search row INSTALLED BEFORE the capability existed carries a
 *     grant with NO `search` key. `ensureBundledExtensions()`'s existing-row
 *     branch runs the S6 drift WARN (which does NOT disable — it only
 *     checks network/fs/shell/env/storage/lifecycleHooks and never mutates
 *     the grant) and the S9 version gate (web-search version is unchanged),
 *     so the row stays ENABLED.
 *   - `search-handler.ts:84` denies when `granted.search === undefined`
 *     (`isSearchGrantAbsent`) → soft-fail -32101 → the SDK throws
 *     `SearchDisabledError` → the shim (`docs/extensions/examples/web-search/
 *     index.ts:57`) reports "Web search is disabled for this extension."
 *     Every search fails until the grant carries `search`.
 *
 * Fix under test: `reconcileBundledGrant` in `bundled.ts` backfills the
 * stored grant toward the bundled entry's DECLARED-WITHIN-CEILING set
 * (it already healed `extension-author`'s `custom.drafts.kinds` — this
 * proves the SAME mechanism grants the `search` capability), clamps to the
 * ceiling (hard bound), is idempotent, and audits via `BUNDLED_REGRANTED`.
 *
 * Harness mirrors `bundled-grant-reconcile-drafts.test.ts` (mock
 * `db/queries/extensions` + `db/queries/audit-log`, seed a stale row,
 * drive the real `ensureBundledExtensions`).
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type {
  ExtensionPermissions,
  ExtensionManifestV2,
} from "../extensions/types";

interface StoredExtension {
  id: string;
  name: string;
  manifest: {
    schemaVersion: 2;
    name: string;
    version: string;
    permissions?: Record<string, unknown>;
  } & Record<string, unknown>;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  consecutiveFailures?: number;
  version?: string;
  grantedPermissions: ExtensionPermissions;
}

let store: Map<string, StoredExtension>;
let nextId = 0;
let updateCalls: Array<{ id: string; patch: Partial<StoredExtension> }>;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  createExtension: async (data: Omit<StoredExtension, "id">) => {
    const id = `ext-${++nextId}`;
    const row = { id, ...data } as StoredExtension;
    store.set(data.name, row);
    return row;
  },
  listExtensions: async () => Array.from(store.values()),
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
    updateCalls.push({ id, patch });
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
  },
  deleteExtension: async (id: string) => {
    for (const [k, v] of store) if (v.id === id) store.delete(k);
  },
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

interface AuditCall {
  action: string;
  target?: string;
  metadata?: Record<string, unknown>;
}
const auditCalls: AuditCall[] = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (
    _userId: string | null,
    action: string,
    target?: string,
    metadata?: Record<string, unknown>,
  ) => {
    auditCalls.push({
      action,
      ...(target !== undefined ? { target } : {}),
      ...(metadata !== undefined ? { metadata } : {}),
    });
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

afterAll(() => restoreModuleMocks());

import { join } from "node:path";
import { ensureBundledExtensions, getProjectRoot } from "../extensions/bundled";
import { loadManifestFresh } from "../extensions/loader";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";
import { handlePiSearch } from "../extensions/search-handler";
import type { JsonRpcRequest } from "../extensions/types";

// Seed the stored manifest === on-disk manifest verbatim so neither S6
// drift nor the S9 version/tool-list gate fires — that isolates the
// GRANT-vs-declared divergence (the same isolation trick the drafts +
// eventSubscriptions self-heal tests use).
let DISK_WEBSEARCH_MANIFEST: ExtensionManifestV2;

beforeEach(() => {
  store = new Map();
  nextId = 0;
  updateCalls = [];
  auditCalls.length = 0;
});

/**
 * Seed a "stale" web-search row that mimics a pre-capability install:
 *  - ENABLED (the broken-across-restart case the user hit)
 *  - stored manifest === on-disk manifest verbatim so S6/S9 do NOT engage
 *  - grant is MISSING the `search` key entirely (the bug) — i.e. exactly
 *    what `search-handler.ts`'s `isSearchGrantAbsent` rejects.
 */
function seedStaleWebSearch(
  overrides: Partial<StoredExtension> = {},
): StoredExtension {
  const row: StoredExtension = {
    id: "ext-stale-websearch",
    name: "web-search",
    installPath: "docs/extensions/examples/web-search",
    enabled: true,
    isBundled: true,
    version: DISK_WEBSEARCH_MANIFEST.version,
    manifest: JSON.parse(
      JSON.stringify(DISK_WEBSEARCH_MANIFEST),
    ) as StoredExtension["manifest"],
    // The pre-capability grant: NO `search` key. (A real legacy row also
    // carried `network`/`env`; those are out-of-ceiling now and the
    // reconcile drops them — covered by the ceiling-clamp assertion.)
    grantedPermissions: { grantedAt: {} },
    ...overrides,
  };
  store.set(row.name, row);
  return row;
}

function reconcileAudits(): AuditCall[] {
  return auditCalls.filter(
    (c) =>
      c.action === EXT_AUDIT_ACTIONS.BUNDLED_REGRANTED &&
      (c.metadata as { permission?: string })?.permission === "grant-reconcile",
  );
}

function webSearchGrantWrites(): Array<{
  id: string;
  patch: Partial<StoredExtension>;
}> {
  return updateCalls.filter(
    (u) => u.id === "ext-stale-websearch" && "grantedPermissions" in u.patch,
  );
}

describe("ensureBundledExtensions — web-search `search` capability self-heal", () => {
  beforeAll(async () => {
    DISK_WEBSEARCH_MANIFEST = await loadManifestFresh(
      join(getProjectRoot(), "docs/extensions/examples/web-search"),
    );
    // Guard: the on-disk web-search manifest must actually declare the
    // search capability, else this whole regression is vacuous.
    expect(
      (DISK_WEBSEARCH_MANIFEST.permissions as ExtensionPermissions | undefined)
        ?.search,
    ).toBe("inherit");
  });

  test("stale ENABLED row missing `search` → backfilled to `inherit` + regrant audit + stays enabled", async () => {
    seedStaleWebSearch();
    await ensureBundledExtensions();

    const row = store.get("web-search")!;
    // The capability grant is healed → the handler's absent-grant deny no
    // longer fires.
    expect(row.grantedPermissions.search).toBe("inherit");
    // Out-of-ceiling legacy grants (none seeded here) never reappear; the
    // healed grant is exactly the within-ceiling declared set.
    expect(row.grantedPermissions.network).toBeUndefined();
    expect(row.grantedPermissions.env).toBeUndefined();
    // The row stays enabled (S6 warns but never disables; reconcile heals).
    expect(row.enabled).toBe(true);

    // A grant-reconcile audit row was written, targeting the row.
    const audits = reconcileAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target).toBe("ext-stale-websearch");
    const meta = audits[0]!.metadata as {
      oldValue: ExtensionPermissions;
      newValue: ExtensionPermissions;
      actor: string;
    };
    expect(meta.actor).toBe("system");
    expect(meta.oldValue.search).toBeUndefined();
    expect(meta.newValue.search).toBe("inherit");
  }, 30_000);

  test("second boot does NOT re-write the grant nor re-audit (idempotent)", async () => {
    seedStaleWebSearch();
    await ensureBundledExtensions();
    expect(webSearchGrantWrites()).toHaveLength(1);
    expect(reconcileAudits()).toHaveLength(1);

    updateCalls = [];
    auditCalls.length = 0;
    await ensureBundledExtensions();

    expect(webSearchGrantWrites()).toHaveLength(0);
    expect(reconcileAudits()).toHaveLength(0);
    expect(store.get("web-search")!.grantedPermissions.search).toBe("inherit");
  }, 30_000);

  test("a row that already holds `search` → no write, no audit (idempotent on first boot)", async () => {
    seedStaleWebSearch({
      grantedPermissions: { search: "inherit", grantedAt: { search: 1 } },
    });
    await ensureBundledExtensions();
    expect(webSearchGrantWrites()).toHaveLength(0);
    expect(reconcileAudits()).toHaveLength(0);
  }, 30_000);

  test("an out-of-ceiling legacy grant (network/env) is dropped while `search` is granted", async () => {
    // A faithful legacy web-search grant: the old network/env hosts (now
    // out-of-ceiling) PLUS no search. Reconcile must drop the stale grants
    // AND add the capability.
    seedStaleWebSearch({
      grantedPermissions: {
        network: ["html.duckduckgo.com", "lite.duckduckgo.com"],
        env: ["TAVILY_API_KEY"],
        grantedAt: { network: 1, env: 1 },
      } as ExtensionPermissions,
    });
    await ensureBundledExtensions();

    const g = store.get("web-search")!.grantedPermissions;
    expect(g.search).toBe("inherit");
    expect(g.network).toBeUndefined();
    expect(g.env).toBeUndefined();
  }, 30_000);

  test("S6 manifest-drift (stored manifest still declares old network/env) WARNS but does NOT block the heal", async () => {
    // The faithful production scenario: the DB-stored manifest still has
    // the PRE-capability permission block (network/env) because the boot
    // refresh preserves stored `permissions` — so on-disk (search) vs DB
    // (network/env) trips the S6 drift WARN. S6 only checks
    // network/fs/shell/env/storage/lifecycleHooks and NEVER disables, so
    // the row stays enabled and reconcile still backfills `search`.
    const driftManifest = JSON.parse(
      JSON.stringify(DISK_WEBSEARCH_MANIFEST),
    ) as StoredExtension["manifest"];
    driftManifest.permissions = {
      network: ["html.duckduckgo.com"],
      env: ["TAVILY_API_KEY"],
    };
    seedStaleWebSearch({ manifest: driftManifest });

    await ensureBundledExtensions();

    const row = store.get("web-search")!;
    // Proof the S6 drift WARN fired (network/env diverged) yet never disabled.
    const driftAudits = auditCalls.filter(
      (c) => c.action === EXT_AUDIT_ACTIONS.MANIFEST_DRIFTED,
    );
    expect(driftAudits.length).toBeGreaterThanOrEqual(1);
    expect(row.enabled).toBe(true);
    // The capability is still healed despite the drift WARN.
    expect(row.grantedPermissions.search).toBe("inherit");
  }, 30_000);
});

// ── Handler boundary: the reconciled grant unblocks ctx.search, and the
//    pre-fix grant reproduces the user's exact -32101 deny. ─────────────
describe("search-handler — the `search` grant is what gates ctx.search", () => {
  const req: JsonRpcRequest = {
    jsonrpc: "2.0",
    id: 1,
    method: "ezcorp/search",
    params: { action: "web", query: "latest food trends 2025", maxResults: 5 },
  };
  // Host-stamped provenance meta (mirrors tool-executor's `_meta`).
  const rpcMeta = { ezOnBehalfOf: "user-1", ezConversationId: "conv-1" };

  test("PRE-fix grant (no `search` key) → -32101 'search disabled' (the web-search symptom)", async () => {
    const resp = await handlePiSearch(
      req,
      {
        granted: { grantedAt: {} }, // exactly seedStaleWebSearch's broken grant
        registeredTool: { extensionId: "ext-stale-websearch" },
      },
      rpcMeta,
    );
    expect(resp.error?.code).toBe(-32101);
    expect(resp.error?.message).toMatch(/search disabled/i);
  });

  test("POST-reconcile grant (`search: 'inherit'`) → allowed: search runs, no -32101", async () => {
    let searched = false;
    const resp = await handlePiSearch(
      req,
      {
        granted: { search: "inherit", grantedAt: { search: 1 } },
        registeredTool: { extensionId: "ext-stale-websearch" },
        // Inject the seams so the handler resolves/enforces without a DB
        // round-trip and runs over a stub instead of the live providers.
        resolvePolicy: async () => ({
          denied: false,
          quota: 100,
          maxResults: 5,
          providers: "all",
        }),
        consumeQuota: () => ({ ok: true, remaining: 99 }),
        search: async (query: string) => {
          searched = true;
          expect(query).toBe("latest food trends 2025");
          return {
            markdown: "1. Result",
            providerName: "searxng",
            cached: false,
          } as Awaited<ReturnType<typeof import("../search/index").performSearch>>;
        },
      },
      rpcMeta,
    );
    expect(searched).toBe(true);
    expect(resp.error?.code).not.toBe(-32101);
  });
});
