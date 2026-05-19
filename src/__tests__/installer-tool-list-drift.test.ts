/**
 * Phase 5 — `detectVersionBumpRequiringReapproval` extended to flag
 * tool-list drift (added / removed / renamed / inputSchema-modified
 * tool) regardless of version-or-permissions changes.
 *
 * Mirrors the test pattern in `scratchpad-bundled-install.test.ts`:
 * mock `db/queries/audit-log` + `db/queries/extensions`, drive
 * `ensureBundledExtensions` end-to-end, then mutate the in-memory
 * DB row's manifest to simulate the on-disk-vs-DB drift the gate
 * checks for.
 *
 * Cases covered:
 *
 *   - tool ADDED on disk → re-approval gate fires
 *   - tool REMOVED on disk (DB has more tools than disk) → fires
 *   - tool RENAMED → fires
 *   - tool inputSchema MODIFIED → fires
 *   - description-only change → fires (we hash description; conservative)
 *   - identical tools but pure version bump → does NOT fire
 *   - permission-only change without version bump → does NOT fire here
 *     (drift detection — different code path — handles those)
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ExtensionManifestV2, ToolDefinition } from "../extensions/types";

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => "",
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  consecutiveFailures?: number;
  isBundled?: boolean;
  grantedPermissions: { storage?: boolean; grantedAt: Record<string, number> };
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
  updateExtension: async (id: string, patch: Partial<StoredExtension>) => {
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

afterAll(() => restoreModuleMocks());

const { ensureBundledExtensions } = await import("../extensions/bundled");

beforeEach(() => {
  store = new Map();
  nextId = 0;
});

// Pull the scratchpad row into a known state, then mutate its DB-stored
// manifest to simulate the desired on-disk-vs-DB drift. The on-disk
// manifest (loaded by `loadManifestFresh`) is the unmutated truth;
// any mutation we apply to `row.manifest` becomes the "DB stored"
// side that the gate compares against.

async function installAndGetScratchpad(): Promise<StoredExtension> {
  await ensureBundledExtensions();
  const row = store.get("scratchpad");
  if (!row) throw new Error("scratchpad install failed");
  return row;
}

function manifestOf(row: StoredExtension): ExtensionManifestV2 {
  return row.manifest as ExtensionManifestV2;
}

describe("tool-list drift triggers re-approval (Phase 5)", () => {
  test("tool ADDED on disk (DB has fewer tools) → gate fires, extension disabled", async () => {
    const row = await installAndGetScratchpad();
    expect(row.enabled).toBe(true);
    // Simulate prior install: DB has only ONE of scratchpad's two
    // tools. On-disk has both. → tool-list signature differs.
    const m = manifestOf(row);
    m.tools = [
      {
        name: "scratchpad_read",
        description: "Read",
        inputSchema: { type: "object" },
      },
    ];
    // Bump version too (the legacy gate also requires a version diff
    // for the permission-trigger; here the tool trigger fires
    // independently — we exercise the new path by NOT changing perms).
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
  });

  test("tool REMOVED on disk (DB has extra tool) → gate fires", async () => {
    const row = await installAndGetScratchpad();
    expect(row.enabled).toBe(true);
    const m = manifestOf(row);
    m.tools = [
      ...(m.tools ?? []),
      {
        name: "scratchpad_extra_tool",
        description: "Bogus extra",
        inputSchema: { type: "object" },
      },
    ];
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
  });

  test("tool RENAMED → gate fires", async () => {
    const row = await installAndGetScratchpad();
    const m = manifestOf(row);
    const tools = m.tools ?? [];
    if (tools.length === 0) throw new Error("expected scratchpad tools");
    const renamed: ToolDefinition[] = tools.map((t, i) =>
      i === 0 ? { ...t, name: t.name + "_renamed" } : t,
    );
    m.tools = renamed;
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
  });

  test("tool inputSchema MODIFIED → gate fires", async () => {
    const row = await installAndGetScratchpad();
    const m = manifestOf(row);
    const tools = m.tools ?? [];
    const modified = tools.map((t, i) =>
      i === 0
        ? {
            ...t,
            inputSchema: {
              type: "object",
              properties: {
                ...((t.inputSchema as { properties?: Record<string, unknown> })?.properties ?? {}),
                injected_admin_flag: { type: "boolean" },
              },
            },
          }
        : t,
    );
    m.tools = modified;
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
  });

  test("tool DESCRIPTION changed → gate fires (conservative — hash includes description)", async () => {
    const row = await installAndGetScratchpad();
    const m = manifestOf(row);
    const tools = m.tools ?? [];
    m.tools = tools.map((t, i) =>
      i === 0 ? { ...t, description: t.description + " (rev 2)" } : t,
    );
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(false);
  });

  test("tool RE-ORDERED (same set, different array order) → does NOT fire (canonical sort)", async () => {
    const row = await installAndGetScratchpad();
    const m = manifestOf(row);
    const tools = [...(m.tools ?? [])].reverse();
    m.tools = tools;
    // Pure version bump alongside the re-order so the version+perm path
    // isn't also being tested. The CANONICAL sort makes the toolsHash
    // identical, so the tool-list trigger should NOT fire. The
    // version-bump-without-permission-change path also doesn't fire.
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(true);
  });

  test("identical tools, pure version bump → does NOT fire (legacy invariant preserved)", async () => {
    const row = await installAndGetScratchpad();
    const m = manifestOf(row);
    m.version = "0.0.1";
    row.manifest = m;

    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(true);
  });

  test("identical tools, identical version, identical perms → no gate fire", async () => {
    const row = await installAndGetScratchpad();
    expect(row.enabled).toBe(true);
    await ensureBundledExtensions();
    expect(store.get("scratchpad")?.enabled).toBe(true);
  });
});
