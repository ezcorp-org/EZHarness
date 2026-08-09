/**
 * S9 tool-list gate must ignore PRESENTATION-only tool fields.
 *
 * `suggestExamples` is authored example phrasing consumed only by the
 * composer's suggestion ranker (`src/suggest/` — embedding anchors +
 * training export). It never reaches the model as part of the tool
 * definition and cannot widen what a tool is able to do.
 *
 * `detectVersionBumpRequiringReapproval` hashed the whole tool object,
 * so merely AUTHORING `suggestExamples` flipped `toolListChanged` and the
 * gate disabled the extension "pending re-approval". That exit `continue`s
 * BEFORE both the manifest-refresh block and the re-enable branch, so the
 * stored manifest could never catch up and every subsequent boot
 * re-detected the same phantom drift — the row stayed disabled forever.
 *
 * On the live host this stranded `web-search`: its `search-web` /
 * `read-url` tools were never registered, so web search silently did not
 * work for ANY agent. Same stranding class as the v2→v3 `capabilities`
 * phantom drift (see `bundled-v2-tools-hash-shape.test.ts`).
 *
 * Contract:
 *   - Stored manifest differing from disk ONLY by `suggestExamples`
 *     ⇒ NOT a tool-list change. No disable; the normal path re-enables.
 *   - A GENUINE tool-list change still disables fail-closed.
 *   - The LOCKFILE hash keeps full fidelity — tamper detection must
 *     still notice a `suggestExamples` edit.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionPermissions, ToolDefinition } from "../extensions/types";
// Bound to the REAL implementations before `mock.module` swaps the module
// below — the hashing under test must not be stubbed.
import { canonicalizeAndHash, canonicalizeAndHashForReapproval } from "../extensions/bundled-lock";

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
interface StoredExtension {
  id: string;
  name: string;
  description?: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
  version?: string;
}
let store: Map<string, StoredExtension>;
let nextId = 0;
const updateCalls: Array<{ id: string; patch: Record<string, unknown> }> = [];

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
    updateCalls.push({ id, patch: patch as Record<string, unknown> });
    for (const row of store.values()) {
      if (row.id === id) {
        Object.assign(row, patch);
        return row;
      }
    }
    return null;
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

// Keep the REAL hashing (it is the subject of this test) but neutralize
// the lockfile gate: a checked-in `manifest.lock.json` that lags disk for
// an unrelated extension would otherwise disable the row further down the
// same loop and mask the behavior under test.
mock.module("../extensions/bundled-lock", () => ({
  canonicalizeAndHash,
  canonicalizeAndHashForReapproval,
  verifyManifestAgainstLock: async () => ({ ok: true }),
  loadManifestLock: async () => ({ schemaVersion: 1, generatedAt: "", extensions: {} }),
}));

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  store = new Map();
  nextId = 0;
  auditActions.length = 0;
  updateCalls.length = 0;
});

const SEED_ID = "seed-web-search";
const SEED_NAME = "web-search";
const SEED_PATH = "docs/extensions/examples/web-search";

async function loadDiskManifest() {
  const { loadManifestFresh } = await import("../extensions/loader");
  const { getProjectRoot } = await import("../extensions/bundled");
  const { join } = await import("node:path");
  return loadManifestFresh(join(getProjectRoot(), SEED_PATH));
}

/**
 * The live-repro shape: the REAL on-disk manifest as a pre-`suggestExamples`
 * install stored it. Everything that defines the tool contract (name,
 * description, inputSchema, capabilities, version, permissions) is
 * untouched, so the ONLY difference from disk is the presentation field.
 */
async function seedRowWithoutSuggestExamples(
  opts: {
    /** Live-repro default: a prior boot already fail-closed the row. */
    enabled?: boolean;
    mutateTools?: (tools: ToolDefinition[]) => ToolDefinition[];
  } = {},
): Promise<void> {
  const { enabled = false, mutateTools } = opts;
  const disk = await loadDiskManifest();

  const stripped: ToolDefinition[] = (disk.tools ?? []).map((t) => {
    const { suggestExamples: _authored, ...rest } = t as ToolDefinition & {
      suggestExamples?: string[];
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
    manifest: { ...disk, tools: mutateTools ? mutateTools(stripped) : stripped },
    grantedPermissions: { search: "inherit", grantedAt: { search: 1 } },
  });
}

function disableWrites(): number {
  return updateCalls.filter((c) => c.id === SEED_ID && c.patch.enabled === false).length;
}

describe("canonicalizeAndHashForReapproval", () => {
  const base: ToolDefinition = {
    name: "search-web",
    description: "Search the web for a query.",
    inputSchema: { type: "object", properties: { query: { type: "string" } } },
  } as ToolDefinition;

  test("ignores suggestExamples — authoring one is not a capability change", () => {
    const withExamples = { ...base, suggestExamples: ["search the web for bun"] };
    expect(canonicalizeAndHashForReapproval([withExamples as ToolDefinition])).toBe(
      canonicalizeAndHashForReapproval([base]),
    );
  });

  test("the LOCKFILE hash still notices suggestExamples (tamper fidelity)", () => {
    const withExamples = { ...base, suggestExamples: ["search the web for bun"] };
    expect(canonicalizeAndHash([withExamples as ToolDefinition])).not.toBe(
      canonicalizeAndHash([base]),
    );
  });

  test.each([
    ["description", { ...base, description: "Something else entirely." }],
    ["name", { ...base, name: "search-web-v2" }],
    [
      "inputSchema",
      { ...base, inputSchema: { type: "object", properties: { q: { type: "string" } } } },
    ],
    ["capabilities", { ...base, capabilities: { network: { hosts: ["evil.example"] } } }],
  ])("still flips on a real %s change", (_field, mutated) => {
    expect(canonicalizeAndHashForReapproval([mutated as ToolDefinition])).not.toBe(
      canonicalizeAndHashForReapproval([base]),
    );
  });

  test("still flips when a tool is added or removed", () => {
    const second = { ...base, name: "read-url" } as ToolDefinition;
    expect(canonicalizeAndHashForReapproval([base, second])).not.toBe(
      canonicalizeAndHashForReapproval([base]),
    );
  });
});

describe("S9 tool-list gate — authored suggestExamples", () => {
  test("a suggestExamples-only difference is NOT a tool-list change", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedRowWithoutSuggestExamples();

    // Guard: the raw arrays really do hash differently — i.e. this test
    // exercises the bug and not a no-op.
    const seededTools = (store.get(SEED_NAME)!.manifest as { tools: ToolDefinition[] }).tools;
    const disk = await loadDiskManifest();
    expect(canonicalizeAndHash(seededTools)).not.toBe(canonicalizeAndHash(disk.tools ?? []));

    await ensureBundledExtensions();

    // The gate must not fire: no fail-closed disable, no blocked audit.
    expect(disableWrites()).toBe(0);
    expect(auditActions).not.toContain("ext:update-blocked");
    // …and the normal path re-enables the row that a prior boot stranded,
    // which is what puts search-web / read-url back in front of agents.
    expect(store.get(SEED_NAME)?.enabled).toBe(true);
  }, 30_000);

  test("the stranded row's stored manifest is refreshed to carry suggestExamples", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    await seedRowWithoutSuggestExamples();

    await ensureBundledExtensions();

    // Reaching the refresh block is what breaks the every-boot loop: the
    // stored manifest now matches disk, so the next boot compares equal
    // even under the full-fidelity hash.
    const refreshed = store.get(SEED_NAME)?.manifest as { tools?: ToolDefinition[] };
    expect(refreshed.tools?.length).toBeGreaterThan(0);
    for (const tool of refreshed.tools ?? []) {
      expect(tool).toHaveProperty("suggestExamples");
    }
    const disk = await loadDiskManifest();
    expect(canonicalizeAndHash(refreshed.tools ?? [])).toBe(canonicalizeAndHash(disk.tools ?? []));
  }, 30_000);

  test("a GENUINE tool-list change still disables fail-closed", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");
    // Same seed, but the stored manifest is missing a tool that disk
    // declares — exactly the "extension gained a tool" case the gate
    // exists to catch. Seeded ENABLED so the disable TRANSITION is
    // observable: D4 skips the redundant write on an already-disabled row.
    await seedRowWithoutSuggestExamples({
      enabled: true,
      mutateTools: (tools) => tools.slice(1),
    });
    expect(
      (store.get(SEED_NAME)!.manifest as { tools: ToolDefinition[] }).tools.length,
    ).toBeGreaterThan(0);

    await ensureBundledExtensions();

    expect(disableWrites()).toBe(1);
    expect(auditActions).toContain("ext:update-blocked");
    expect(store.get(SEED_NAME)?.enabled).toBe(false);
  }, 30_000);
});
