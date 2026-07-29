/**
 * Bundled-grant self-heal for the namespaced `custom.drafts.kinds`
 * permission — the `extension-author` "custom.drafts.kinds not granted"
 * regression.
 *
 * Production bug reproduced here:
 *   - The bundled `extension-author` entry declares
 *     `permissions.custom.drafts.kinds = ["extension"]`
 *     (`src/extensions/bundled.ts`) and the bundled CEILING includes the
 *     same (`src/extensions/bundled-ceiling.ts`).
 *   - `ensureBundledExtensions()`'s EXISTING-row branch runs S6 drift +
 *     S9 version gate + manifest refresh but DELIBERATELY never touches
 *     the `grantedPermissions` DB column. A row seeded BEFORE that grant
 *     existed (or one previously clamped/stripped) is therefore never
 *     reconciled — it stays broken across every restart.
 *   - `src/extensions/drafts-handler.ts:184-187` reads
 *     `granted.custom.drafts.kinds`; missing/malformed → `rpcError(
 *     -32603, "custom.drafts.kinds not granted")`. Every scaffold fails.
 *
 * Fix under test: `reconcileBundledGrant` in `bundled.ts` backfills the
 * stored grant toward the bundled entry's DECLARED-WITHIN-CEILING set,
 * clamps to the ceiling (hard bound), is idempotent, and audits via the
 * existing `BUNDLED_REGRANTED` action.
 *
 * Harness mirrors `bundled-grant-event-subscriptions.test.ts` exactly
 * (mock `db/queries/extensions` + `db/queries/audit-log`, seed a stale
 * row, drive the real `ensureBundledExtensions`). The DB-backed
 * integration test mirrors `src/extensions/__tests__/drafts-handler.test.ts`.
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

// ── Mock the DB-queries module so ensureBundledExtensions sees a
// pre-seeded "extension-author" row whose grant lacks custom.drafts.
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

import { ensureBundledExtensions, getProjectRoot } from "../extensions/bundled";
import { loadManifestFresh } from "../extensions/loader";
import { EXT_AUDIT_ACTIONS } from "../extensions/audit-actions";

// The seeded stored manifest must mirror the ON-DISK extension-author
// manifest EXACTLY (version + full tools list + permissions block) so
// neither the S6 drift gate nor the S9 version/tool-list gate fires —
// that isolates the GRANT-vs-declared divergence (same isolation trick
// as `seedStaleClaudeDesign`'s version-match in the eventSubscriptions
// test). We load it once from disk so the test never drifts from the
// repo's real manifest.
let DISK_AUTHOR_MANIFEST: ExtensionManifestV2;

beforeEach(() => {
  store = new Map();
  nextId = 0;
  updateCalls = [];
  auditCalls.length = 0;
});

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Seed a "stale" extension-author row that mimics a pre-grant install:
 *  - ENABLED (the broken-across-restart case)
 *  - stored manifest === on-disk manifest verbatim so S6/S9 do NOT
 *    engage (isolates the grant-vs-declared divergence)
 *  - grant has the declared filesystem path but is MISSING
 *    `custom.drafts.kinds` (the bug).
 */
function seedStaleAuthor(
  overrides: Partial<StoredExtension> = {},
): StoredExtension {
  const row: StoredExtension = {
    id: "ext-stale-author",
    name: "extension-author",
    installPath: "docs/extensions/examples/extension-author",
    enabled: true,
    isBundled: true,
    version: DISK_AUTHOR_MANIFEST.version,
    manifest: JSON.parse(
      JSON.stringify(DISK_AUTHOR_MANIFEST),
    ) as StoredExtension["manifest"],
    grantedPermissions: {
      filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
      // custom.drafts.kinds intentionally MISSING — the bug.
      grantedAt: { filesystem: 1 },
    },
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

function authorUpdateCalls(): Array<{
  id: string;
  patch: Partial<StoredExtension>;
}> {
  return updateCalls.filter(
    (u) => u.id === "ext-stale-author" && "grantedPermissions" in u.patch,
  );
}

// ── 1. Stale ENABLED row → backfilled + audited ──────────────────────

describe("ensureBundledExtensions — extension-author custom.drafts.kinds self-heal", () => {
  beforeAll(async () => {
    DISK_AUTHOR_MANIFEST = await loadManifestFresh(
      join(getProjectRoot(), "docs/extensions/examples/extension-author"),
    );
  });

  test("stale ENABLED row missing custom.drafts.kinds → backfilled to ['extension'] + regrant audit", async () => {
    seedStaleAuthor();
    await ensureBundledExtensions();

    const row = store.get("extension-author")!;
    expect(row.grantedPermissions.custom?.drafts?.kinds).toEqual(["extension"]);
    // Pre-existing within-ceiling grant preserved (not clobbered).
    expect(row.grantedPermissions.filesystem).toEqual([
      "$CWD/.ezcorp/extension-data/extension-author/drafts/$USER",
    ]);
    // grantedAt preserved for the surviving stored field.
    expect(typeof row.grantedPermissions.grantedAt?.filesystem).toBe("number");
    expect(row.grantedPermissions.grantedAt?.filesystem).toBe(1);

    // A grant-reconcile audit row was written, targeting the row.
    const audits = reconcileAudits();
    expect(audits).toHaveLength(1);
    expect(audits[0]!.target).toBe("ext-stale-author");
    const meta = audits[0]!.metadata as {
      oldValue: ExtensionPermissions;
      newValue: ExtensionPermissions;
      actor: string;
    };
    expect(meta.actor).toBe("system");
    expect(meta.oldValue.custom?.drafts).toBeUndefined();
    expect(meta.newValue.custom?.drafts?.kinds).toEqual(["extension"]);

    // The row stays enabled (S6/S9 untouched, reconciliation does not
    // disable).
    expect(row.enabled).toBe(true);
  }, 30_000);

  // ── 2. Idempotency ────────────────────────────────────────────────

  test("second boot does NOT re-write the grant nor re-audit (idempotent)", async () => {
    seedStaleAuthor();
    await ensureBundledExtensions();
    // First boot reconciled exactly once.
    expect(authorUpdateCalls()).toHaveLength(1);
    expect(reconcileAudits()).toHaveLength(1);

    // Clear capture, run again — grant now already satisfies declared.
    updateCalls = [];
    auditCalls.length = 0;
    await ensureBundledExtensions();

    expect(authorUpdateCalls()).toHaveLength(0);
    expect(reconcileAudits()).toHaveLength(0);
    // Grant unchanged.
    expect(
      store.get("extension-author")!.grantedPermissions.custom?.drafts?.kinds,
    ).toEqual(["extension"]);
  }, 30_000);

  test("a row that already satisfies the declared set → no write, no audit on first boot", async () => {
    seedStaleAuthor({
      grantedPermissions: {
        filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
        custom: { drafts: { kinds: ["extension"] } },
        grantedAt: { filesystem: 1, custom: 2 },
      },
    });
    await ensureBundledExtensions();
    expect(authorUpdateCalls()).toHaveLength(0);
    expect(reconcileAudits()).toHaveLength(0);
  }, 30_000);

  // ── 3. Within-ceiling guard ───────────────────────────────────────

  test("stored grant with perms BEYOND the ceiling is NOT widened/preserved (reconciled ⊆ ceiling)", async () => {
    // Row carries a bogus extra `shell:true` + an out-of-ceiling
    // network grant + a `custom.drafts.kinds` that includes a kind the
    // ceiling does NOT allow ("agent"). Reconciliation must drop every
    // out-of-ceiling perm — the ceiling for extension-author is
    // { filesystem: [<the one path>], custom:{drafts:{kinds:["extension"]}} }.
    seedStaleAuthor({
      grantedPermissions: {
        filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
        shell: true,
        network: ["evil.example.com"],
        custom: { drafts: { kinds: ["extension", "agent"] } },
        grantedAt: { filesystem: 1, shell: 1, network: 1, custom: 1 },
      } as ExtensionPermissions,
    });
    await ensureBundledExtensions();

    const g = store.get("extension-author")!.grantedPermissions;
    // Out-of-ceiling boolean / array perms dropped.
    expect(g.shell).toBeUndefined();
    expect(g.network).toBeUndefined();
    // custom.drafts.kinds intersected down to the ceiling's ["extension"]
    // — the bogus "agent" kind is NOT preserved.
    expect(g.custom?.drafts?.kinds).toEqual(["extension"]);
    // The legitimate within-ceiling filesystem grant survives.
    expect(g.filesystem).toEqual([
      "$CWD/.ezcorp/extension-data/extension-author/drafts/$USER",
    ]);
  }, 30_000);

  // ── 5. Regression: S9 still disables a version-bump+perms-change ───

  test("regression: S9 version-bump WITH perms change on a NON-critical bundled ext still disables (reconciliation does not mask S9)", async () => {
    // Mirrors `bundled-critical-s9.test.ts`'s non-critical regression.
    // `scratchpad` is NOT critical and has ceiling { storage:true }.
    // Seed it STALE: old version + an S9-tracked perm (network) the
    // on-disk manifest lacks → detectVersionBumpRequiringReapproval
    // fires. Non-critical ⇒ S9 disables it and `continue`s BEFORE the
    // reconcile call site, so reconcileBundledGrant must NEVER run for
    // this row even though `scratchpad`'s declared `storage:true` is
    // within ceiling.
    store.set("scratchpad", {
      id: "ext-stale-scratchpad",
      name: "scratchpad",
      installPath: "docs/extensions/examples/scratchpad",
      enabled: true,
      isBundled: true,
      version: "0.0.1",
      manifest: {
        schemaVersion: 2,
        name: "scratchpad",
        version: "0.0.1",
        // S9-tracked perm (network) absent from the on-disk scratchpad
        // manifest → forces the version+perms gate.
        permissions: { storage: true, network: ["evil.example.com"] },
      },
      grantedPermissions: { grantedAt: {} },
    });
    await ensureBundledExtensions();

    const row = store.get("scratchpad")!;
    // S9 floor preserved — non-critical row disabled pending re-approval.
    expect(row.enabled).toBe(false);
    // Reconciliation did NOT run for this row (no grant write, no
    // reconcile audit targeting it).
    const scratchpadGrantWrites = updateCalls.filter(
      (u) => u.id === "ext-stale-scratchpad" && "grantedPermissions" in u.patch,
    );
    expect(scratchpadGrantWrites).toHaveLength(0);
    const scratchpadReconAudits = auditCalls.filter(
      (c) =>
        c.target === "ext-stale-scratchpad" &&
        (c.metadata as { permission?: string })?.permission ===
          "grant-reconcile",
    );
    expect(scratchpadReconAudits).toHaveLength(0);
    // The grant was NOT silently healed behind the S9 disable.
    expect(row.grantedPermissions.storage).toBeUndefined();
  }, 30_000);

  // ── 6. Regression: critical-S9 auto-reapprove path STILL reconciles ─
  //
  // The production "custom.drafts.kinds not granted" regression. A
  // stale extension-author row whose stored manifest's tool list has
  // drifted from disk (its tools churn every boot as the feature is
  // built) trips the S9 gate; because the entry is `critical` and its
  // on-disk perms are within ceiling, it takes the auto-reapprove
  // `continue` — which is BEFORE the normal reconcile site. Before the
  // fix the grant was therefore NEVER healed on this path and every
  // scaffold failed forever. Assert the grant IS backfilled with
  // custom.drafts.kinds on that path and the row stays enabled.
  test("regression: critical-S9 auto-reapprove (tool-list drift) STILL backfills custom.drafts.kinds + stays enabled", async () => {
    // Stored manifest tools = [] ≠ on-disk tools → S9 toolListChanged
    // fires (version matches, so the trigger is purely the tool-list
    // drift — extension-author's real every-boot state). Grant is the
    // broken filesystem-only shape from seedStaleAuthor().
    const driftManifest = JSON.parse(
      JSON.stringify(DISK_AUTHOR_MANIFEST),
    ) as StoredExtension["manifest"];
    driftManifest.tools = [];
    seedStaleAuthor({ manifest: driftManifest });

    await ensureBundledExtensions();

    const row = store.get("extension-author")!;

    // Proof we took the CRITICAL-S9 auto-reapprove path (not the
    // normal no-gate fall-through): its audit row was written.
    const criticalAudits = auditCalls.filter(
      (c) => c.action === EXT_AUDIT_ACTIONS.BUNDLED_CRITICAL_AUTO_REAPPROVED,
    );
    expect(criticalAudits.length).toBeGreaterThanOrEqual(1);

    // The bug is fixed: the grant was reconciled on that path.
    expect(row.grantedPermissions.custom?.drafts?.kinds).toEqual([
      "extension",
    ]);
    expect(row.grantedPermissions.filesystem).toEqual([
      "$CWD/.ezcorp/extension-data/extension-author/drafts/$USER",
    ]);
    // Critical auto-reapprove keeps the row enabled.
    expect(row.enabled).toBe(true);

    // A grant-reconcile audit targeting the row was emitted.
    const recon = reconcileAudits();
    expect(recon).toHaveLength(1);
    expect(recon[0]!.target).toBe("ext-stale-author");
    const meta = recon[0]!.metadata as {
      oldValue: ExtensionPermissions;
      newValue: ExtensionPermissions;
    };
    expect(meta.oldValue.custom?.drafts).toBeUndefined();
    expect(meta.newValue.custom?.drafts?.kinds).toEqual(["extension"]);
  }, 30_000);
});

// ── 4. Integration: drafts RPC create succeeds post-reconcile ────────
//
// Mirrors src/extensions/__tests__/drafts-handler.test.ts mocking
// (real PGlite + drizzle, mock only db/connection). We assert the
// RECONCILED grant shape (the exact object the registry would hand the
// drafts handler) no longer trips the `custom.drafts.kinds not granted`
// gate and that `create` lands a draft row + materialized files.

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized — call setupTestDb() first");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

import {
  setupTestDb,
  closeTestDb,
  getTestPglite,
} from "./helpers/test-pglite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const RECON_USER = "user-recon-drafts";
let _prevCwd = "";
let _tmpRoot = "";

describe("integration — reconciled grant unblocks ezcorp/drafts create", () => {
  beforeAll(async () => {
    _tmpRoot = mkdtempSync(join(tmpdir(), "bundled-grant-recon-"));
    _prevCwd = process.cwd();
    process.chdir(_tmpRoot);
    await setupTestDb();
    const { getDb } = await import("../db/connection");
    const { users } = await import("../db/schema");
    await getDb()
      .insert(users)
      .values({
        id: RECON_USER,
        email: `${RECON_USER}@t.local`,
        passwordHash: "x",
        name: RECON_USER,
      } as never)
      .onConflictDoNothing();
  });

  afterAll(async () => {
    await closeTestDb();
    if (_prevCwd) try { process.chdir(_prevCwd); } catch { /* */ }
    if (_tmpRoot) try { rmSync(_tmpRoot, { recursive: true, force: true }); } catch { /* */ }
  });

  test("PRE-fix grant (no custom.drafts.kinds) → -32603 'custom.drafts.kinds not granted'", async () => {
    const { handleDraftsRpc } = await import("../extensions/drafts-handler");
    // The exact broken stored grant from seedStaleAuthor().
    const brokenGrant: ExtensionPermissions = {
      filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
      grantedAt: { filesystem: 1 },
    };
    const resp = await handleDraftsRpc(
      "extension-author",
      {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/drafts",
        params: {
          action: "create",
          kind: "extension",
          payload: { x: 1 },
          files: { "ezcorp.config.ts": "export default {};\n" },
        },
      },
      { userId: RECON_USER, grantedPermissions: brokenGrant },
    );
    expect(resp.error?.code).toBe(-32603);
    expect(resp.error?.message).toMatch(/custom\.drafts\.kinds not granted/);
  });

  test("POST-reconcile grant → create succeeds (no 'not granted' error, draftId returned)", async () => {
    // Build the reconciled grant exactly as reconcileBundledGrant
    // would: declared-within-ceiling backfill of the broken grant.
    const { clampToBundledCeiling } = await import(
      "../extensions/bundled-ceiling"
    );
    const stored: ExtensionPermissions = {
      filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
      grantedAt: { filesystem: 1 },
    };
    const declared: ExtensionPermissions = {
      filesystem: ["$CWD/.ezcorp/extension-data/extension-author/drafts/$USER"],
      custom: { drafts: { kinds: ["extension"] } },
      grantedAt: { filesystem: Date.now(), custom: Date.now() },
    };
    const merged: ExtensionPermissions = {
      ...stored,
      ...declared,
      custom: { ...(stored.custom ?? {}), ...(declared.custom ?? {}) },
      grantedAt: {
        ...(stored.grantedAt ?? {}),
        ...(declared.grantedAt ?? {}),
      },
    };
    const { effective: reconciled } = clampToBundledCeiling(
      "extension-author",
      merged,
    );
    // Sanity: the reconciled grant carries the gate-passing field.
    expect(reconciled.custom?.drafts?.kinds).toEqual(["extension"]);

    const { handleDraftsRpc } = await import("../extensions/drafts-handler");
    const resp = await handleDraftsRpc(
      "extension-author",
      {
        jsonrpc: "2.0",
        id: 2,
        method: "ezcorp/drafts",
        params: {
          action: "create",
          kind: "extension",
          payload: { name: "demo", type: "tool" },
          files: {
            "ezcorp.config.ts": "export default {};\n",
            "index.ts": "// scaffold\n",
          },
        },
      },
      { userId: RECON_USER, grantedPermissions: reconciled },
    );

    expect(resp.error).toBeUndefined();
    const result = resp.result as { draftId?: string } | undefined;
    expect(typeof result?.draftId).toBe("string");
    expect((result?.draftId ?? "").length).toBeGreaterThan(0);
  });
});
