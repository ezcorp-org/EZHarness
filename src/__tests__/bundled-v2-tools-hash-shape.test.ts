/**
 * S9 tool-list gate must compare LIKE WITH LIKE across manifest schema
 * versions.
 *
 * `loadManifestFresh` always returns v3 shape: `migrateManifestV2ToV3`
 * stamps a host-DERIVED per-tool `capabilities` block onto every tool
 * that didn't author its own (manifest.ts:migrateManifestV2ToV3). A row
 * installed before that migration shipped still stores the v2-shaped
 * manifest — same tools, no `capabilities` key.
 *
 * `detectVersionBumpRequiringReapproval` hashed the two tool arrays
 * as-stored, so the derived field alone flipped `toolListChanged` → the
 * gate disabled the extension fail-closed on the FIRST boot after the
 * v3 migration landed. Worse, the disable path `continue`s BEFORE the
 * manifest-refresh block that would rewrite the stored manifest in v3
 * shape — so the drift could never clear and every subsequent boot
 * re-detected it. 14 bundled extensions were stuck disabled on the live
 * host this way (claude-design among them: its `open-canvas` tool never
 * reached the LLM, so the design canvas silently never rendered).
 *
 * Contract:
 *   - v2-shaped stored manifest whose tools are otherwise IDENTICAL to
 *     disk ⇒ NOT a tool-list change. No disable; the normal path
 *     re-enables the row.
 *   - A GENUINE tool-list change (tool added/removed/schema edited) ⇒
 *     still disables fail-closed. The shape fix must not blunt the gate.
 *
 * Drives the real `ensureBundledExtensions` through the same in-memory
 * store mock pattern as `bundled-drift-disable-idempotent.test.ts`.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ToolDefinition } from "../extensions/types";
// Bound to the REAL implementation before `mock.module` swaps the module
// below — the hashing under test must not be stubbed.
import { canonicalizeAndHash } from "../extensions/bundled-lock";

// ── Captured audit rows ─────────────────────────────────────────────
const auditActions: string[] = [];
mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async (_u: string | null, action: string) => {
    auditActions.push(action);
    return `audit-${auditActions.length}`;
  },
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

// ── In-memory extensions store + updateExtension call tracking ──────
import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "name" });
const store = extStore.store;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: extStore.getExtensionByName,
  createExtension: extStore.createExtension,
  listExtensions: extStore.listExtensions,
  updateExtension: async (id: string, patch: Record<string, unknown>) => {
    updateCalls.push({ id, patch });
    return extStore.updateExtension(id, patch);
  },
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
}));

// Task-tracking migration pulls the real PGlite driver — stub it.
mock.module("../extensions/migrations/task-tracking-storage", () => ({
  migrateBuiltinTaskStorage: async () => {},
}));

// Keep the REAL `canonicalizeAndHash` (it is the subject of this test)
// but neutralize the lockfile gate: a checked-in `manifest.lock.json`
// that lags disk for an unrelated extension would otherwise disable the
// row further down the same loop and mask the behavior under test.
mock.module("../extensions/bundled-lock", () => ({
  canonicalizeAndHash,
  verifyManifestAgainstLock: async () => ({ ok: true }),
  loadManifestLock: async () => ({ schemaVersion: 1, generatedAt: "", extensions: {} }),
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  extStore.reset();
  auditActions.length = 0;
  updateCalls.length = 0;
});

const SEED_ID = "seed-markdown-utils";
const SEED_NAME = "markdown-utils";
const SEED_PATH = "docs/extensions/examples/markdown-utils";

/**
 * The live-repro shape: take the REAL on-disk manifest and downgrade it
 * to how a pre-migration install stored it — `schemaVersion: 2` and no
 * per-tool `capabilities`. Everything an author actually writes (name,
 * description, inputSchema, version, permissions) is untouched, so the
 * ONLY difference from disk is the host-derived field.
 */
async function seedV2ShapedRow(
  opts: {
    /** Live-repro default: a prior boot already fail-closed the row. */
    enabled?: boolean;
    mutateTools?: (tools: ToolDefinition[]) => ToolDefinition[];
  } = {},
): Promise<void> {
  const { enabled = false, mutateTools } = opts;
  const { loadManifestFresh } = await import("../extensions/loader");
  const { getProjectRoot } = await import("../extensions/bundled");
  const { join } = await import("node:path");
  const disk = await loadManifestFresh(join(getProjectRoot(), SEED_PATH));

  const stripped: ToolDefinition[] = (disk.tools ?? []).map((t) => {
    const { capabilities: _derived, ...rest } = t as ToolDefinition & {
      capabilities?: unknown;
    };
    return rest as ToolDefinition;
  });

  store.set(SEED_NAME, {
    id: SEED_ID,
    name: SEED_NAME,
    description: disk.description ?? "",
    enabled,
    isBundled: true,
    installPath: SEED_PATH,
    version: disk.version,
    manifest: {
      ...disk,
      schemaVersion: 2,
      tools: mutateTools ? mutateTools(stripped) : stripped,
    },
    grantedPermissions: { grantedAt: {} },
  });
}

function disableWrites(): number {
  return updateCalls.filter(
    (c) => c.id === SEED_ID && c.patch.enabled === false,
  ).length;
}

describe("S9 tool-list gate — v2/v3 manifest shape", () => {
  test("v2-shaped stored manifest with identical tools is NOT a tool-list change", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedV2ShapedRow();

    // Guard: the raw arrays really do hash differently — i.e. this test
    // exercises the bug and not a no-op.
    const seededTools = (store.get(SEED_NAME)!.manifest as { tools: ToolDefinition[] }).tools;
    const { loadManifestFresh } = await import("../extensions/loader");
    const { getProjectRoot } = await import("../extensions/bundled");
    const { join } = await import("node:path");
    const disk = await loadManifestFresh(join(getProjectRoot(), SEED_PATH));
    expect(canonicalizeAndHash(seededTools)).not.toBe(
      canonicalizeAndHash(disk.tools ?? []),
    );

    await ensureBundledExtensions();

    // The gate must not fire: no fail-closed disable, no blocked audit.
    expect(disableWrites()).toBe(0);
    expect(auditActions).not.toContain("ext:update-blocked");
    // …and the normal path re-enables the row that a prior boot stranded.
    expect(store.get(SEED_NAME)?.enabled).toBe(true);
  }, 30_000);

  test("the stranded row's stored manifest is refreshed to v3 shape", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedV2ShapedRow();

    await ensureBundledExtensions();

    // Reaching the refresh block is what breaks the every-boot loop: the
    // stored manifest now carries the derived field, so the next boot
    // compares equal even without normalization.
    const refreshed = store.get(SEED_NAME)?.manifest as {
      schemaVersion?: number;
      tools?: ToolDefinition[];
    };
    expect(refreshed.schemaVersion).toBe(3);
    expect(refreshed.tools?.length).toBeGreaterThan(0);
    for (const tool of refreshed.tools ?? []) {
      expect(tool).toHaveProperty("capabilities");
    }
  }, 30_000);

  test("a GENUINE tool-list change still disables fail-closed", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    // Same v2 shape, but the stored manifest is missing a tool that disk
    // declares — exactly the "extension gained a tool" case the gate
    // exists to catch (the live `orchestration` row's real state).
    // Seeded ENABLED so the disable TRANSITION is observable: D4 skips
    // the redundant write on a row that is already disabled.
    await seedV2ShapedRow({ enabled: true, mutateTools: (tools) => tools.slice(1) });
    expect(
      (store.get(SEED_NAME)!.manifest as { tools: ToolDefinition[] }).tools.length,
    ).toBeGreaterThan(0);

    await ensureBundledExtensions();

    expect(disableWrites()).toBe(1);
    expect(auditActions).toContain("ext:update-blocked");
    expect(store.get(SEED_NAME)?.enabled).toBe(false);
  }, 30_000);
});
