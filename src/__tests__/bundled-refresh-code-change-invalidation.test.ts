/**
 * H1.1 — a bundled extension's CODE change must invalidate its live
 * subprocess.
 *
 * `installFromLocal` stamps `checksum` + `packageChecksums` onto the
 * persisted manifest, which is why editing an AUTHORED extension's
 * `index.ts` moves the runtime signature `ExtensionRegistry.reload()`
 * compares. The BUNDLED refresh path used to rebuild the stored manifest
 * from `ezcorp.config.ts` alone, so a bundled extension whose code
 * changed without a config change produced a byte-identical manifest:
 * no signature change, no process kill, and the pre-edit subprocess kept
 * answering tool calls until its idle timeout. `extension-author` is the
 * canonical victim — its tool list churns every boot, so it always takes
 * the critical auto-reapprove branch, which had the same gap.
 *
 * This drives the REAL `ensureBundledExtensions` against a temp project
 * root (a copy of the repo's bundled-extension tree), edits scratchpad's
 * entrypoint on disk, and asserts the live subprocess is killed.
 */

import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { cp, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ExtensionManifestV2, ExtensionPermissions } from "../extensions/types";
import type { ExtensionProcess } from "../extensions/subprocess";

// ── mocks (registered before the modules under test are imported) ────

mock.module("../db/queries/audit-log", () => ({
  insertAuditEntry: async () => "audit-1",
  listAuditLog: async () => [],
  listAuditForExtension: async () => [],
}));

mock.module("../db/queries/settings", () => ({
  getSetting: async () => undefined,
  setSetting: async () => undefined,
}));

interface StoredExtension {
  id: string;
  name: string;
  manifest: unknown;
  installPath: string;
  enabled: boolean;
  description?: string;
  version?: string;
  isBundled?: boolean;
  grantedPermissions: ExtensionPermissions;
}

const store = new Map<string, StoredExtension>();
let nextId = 0;

mock.module("../db/queries/extensions", () => ({
  getExtensionByName: async (name: string) => store.get(name) ?? null,
  getExtension: async (id: string) => Array.from(store.values()).find((r) => r.id === id) ?? null,
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
  deleteExtension: async () => undefined,
  incrementFailures: async () => 0,
  resetFailures: async () => undefined,
  disableExtension: async () => undefined,
  rehydrateMcpServerSecrets: async (_n: string, s: unknown) => s,
}));

// ── temp project root ────────────────────────────────────────────────

/**
 * Trees the temp root links straight back at the worktree. Every
 * `ezcorp.config.ts` under `docs/extensions/examples/` imports the SDK
 * through a repo-relative path (`../../../../src/extensions/sdk/define`)
 * and resolves `@ezcorp/sdk` through the root `node_modules`, so those
 * have to resolve identically from the temp root. Only the tree we edit
 * is a real copy.
 */
const LINKED_TREES = ["src", "packages", "extensions", "node_modules"];

let tempRoot: string;
const repoRoot = join(import.meta.dir, "..", "..");

beforeAll(async () => {
  tempRoot = await mkdtemp(join(tmpdir(), "bundled-code-change-"));
  await cp(join(repoRoot, "docs/extensions/examples"), join(tempRoot, "docs/extensions/examples"), {
    recursive: true,
  });
  for (const tree of LINKED_TREES) {
    await symlink(join(repoRoot, tree), join(tempRoot, tree));
  }
  await cp(join(repoRoot, "manifest.lock.json"), join(tempRoot, "manifest.lock.json"));
  await cp(join(repoRoot, "package.json"), join(tempRoot, "package.json"));
  // `getProjectRoot()` reads this first and memoizes; the assertion in the
  // test body proves nothing resolved the root before we got here (which
  // would silently point the on-disk EDIT below at the real worktree).
  process.env.EZCORP_PROJECT_ROOT = tempRoot;
});

afterAll(async () => {
  const { ExtensionRegistry } = await import("../extensions/registry");
  ExtensionRegistry.resetInstance();
  delete process.env.EZCORP_PROJECT_ROOT;
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  restoreModuleMocks();
});

interface RegistryInternals {
  processes: Map<string, ExtensionProcess>;
}

describe("bundled refresh carries on-disk code checksums", () => {
  test("an entrypoint edit with an unchanged config kills the live subprocess", async () => {
    const { ensureBundledExtensions, getProjectRoot } = await import("../extensions/bundled");
    const { ExtensionRegistry } = await import("../extensions/registry");

    // Safety: if anything resolved the project root before beforeAll ran,
    // the edit below would hit the real worktree. Fail loudly instead.
    expect(getProjectRoot()).toBe(tempRoot);

    // Boot twice: the first pass installs, the second lets the grant
    // self-heal / description sync settle so a third pass is a true no-op.
    await ensureBundledExtensions();
    await ensureBundledExtensions();

    const row = store.get("scratchpad");
    expect(row).toBeDefined();
    const baseline = row!.manifest as ExtensionManifestV2;
    // The bundled refresh must persist the on-disk code hashes.
    expect(typeof baseline.checksum).toBe("string");
    expect(baseline.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(baseline.packageChecksums?.["index.ts"]).toBe(baseline.checksum!);

    const registry = ExtensionRegistry.getInstance();
    const generationBefore = registry.generation;
    await registry.reload();
    expect(registry.getManifest(row!.id)).toBeDefined();
    // The load generation moves on every reload — that counter is what
    // tells a live run's toolset it needs re-assembling.
    expect(registry.generation).toBe(generationBefore + 1);

    const killed: string[] = [];
    const fakeProcess = {
      isRunning: true,
      inFlightCallCount: 0,
      kill: () => killed.push(row!.id),
    } as unknown as ExtensionProcess;
    (registry as unknown as RegistryInternals).processes.set(row!.id, fakeProcess);

    // Control: a boot with no source change leaves the subprocess alone.
    await ensureBundledExtensions();
    await registry.reload();
    expect(killed).toEqual([]);
    expect((registry as unknown as RegistryInternals).processes.has(row!.id)).toBe(true);

    // Edit the ENTRYPOINT only. `ezcorp.config.ts` is untouched, so the
    // manifest the loader produces is byte-identical to the stored one —
    // this is exactly the change the old refresh path could not see.
    const entrypoint = join(tempRoot, "docs/extensions/examples/scratchpad/index.ts");
    const original = await readFile(entrypoint, "utf8");
    await writeFile(entrypoint, `${original}\n// code edit made after install\n`);

    await ensureBundledExtensions();
    const refreshed = store.get("scratchpad")!.manifest as ExtensionManifestV2;
    expect(refreshed.checksum).not.toBe(baseline.checksum);
    expect(refreshed.packageChecksums?.["index.ts"]).toBe(refreshed.checksum!);
    // The rest of the manifest is unchanged — only the code moved.
    expect(refreshed.version).toBe(baseline.version);
    expect(JSON.stringify(refreshed.tools)).toBe(JSON.stringify(baseline.tools));

    await registry.reload();
    expect(killed).toEqual([row!.id]);
    expect((registry as unknown as RegistryInternals).processes.has(row!.id)).toBe(false);
  }, 120_000);

  test("an unhashable entrypoint still lands the refreshed manifest", async () => {
    const { ensureBundledExtensions } = await import("../extensions/bundled");

    // The manifest lives in `ezcorp.config.ts`, which does NOT import the
    // entrypoint — so removing `index.ts` leaves the manifest loadable but
    // makes the entrypoint hash impossible. The refresh must degrade to a
    // checksum-less manifest rather than skipping the boot refresh.
    const entrypoint = join(tempRoot, "docs/extensions/examples/scratchpad/index.ts");
    const saved = await readFile(entrypoint, "utf8");
    await rm(entrypoint);
    try {
      await ensureBundledExtensions();
    } finally {
      await writeFile(entrypoint, saved);
    }

    const manifest = store.get("scratchpad")!.manifest as ExtensionManifestV2;
    expect(manifest.name).toBe("scratchpad");
    expect(manifest.checksum).toBeUndefined();
    expect(manifest.packageChecksums).toBeUndefined();
  }, 120_000);
});
