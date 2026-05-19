/**
 * `installFromLocal({ preloadedManifest })` — proves the new
 * skip-internal-loadManifest opt avoids a second top-level evaluation
 * of the extension's entrypoint.
 *
 * Motivation: the extension-author install endpoint loads the manifest
 * once for pre-install validation, then renames the draft dir, then
 * calls `installFromLocal`. The second internal `loadManifest` call
 * re-imports `ezcorp.config.ts`, which transitively re-evaluates the
 * scaffolded `index.ts` whose top-level
 * `Bun.stdin.stream().getReader()` then throws
 * `TypeError: ReadableStream is locked` (the first reader is still
 * locked; Bun's import cache misses after the rename).
 *
 * Tests:
 *   - `preloadedManifest` provided → no second `loadManifest` import.
 *     Proven by deleting `ezcorp.config.ts` from disk BEFORE the call;
 *     if the installer tried to load it, the call would throw "No
 *     ezcorp.config.ts found at ...".
 *   - Result row is equivalent to the no-opt path (same name / version
 *     / checksum keyed off the same on-disk entrypoint).
 *   - Backward compat: no opts → internal load still happens (proven
 *     by deleting the manifest from disk and expecting a throw).
 */

import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
} from "../extensions/types";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtemp } from "node:fs/promises";
import { writeConfig } from "./helpers/write-config";

// ── Mock DB queries ─────────────────────────────────────────────────

const mockExtensions = new Map<string, unknown>();
let createExtensionCalled: { name: string; version: string; manifest: unknown } | null = null;

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: { name: string; version: string; manifest: unknown }) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    createExtensionCalled = ext;
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtension: async (id: string) => mockExtensions.get(id) ?? null,
  getExtensionByName: async () => null,
  listExtensions: async () => Array.from(mockExtensions.values()),
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");

// ── Fixture ─────────────────────────────────────────────────────────

const fixtureManifest: ExtensionManifestV2 = {
  schemaVersion: 2,
  name: "preloaded-fixture",
  version: "1.0.0",
  description: "Preloaded manifest fixture",
  author: { name: "Test" },
  entrypoint: "index.ts",
  tools: [
    {
      name: "noop",
      description: "noop",
      inputSchema: { type: "object" },
    },
  ],
  permissions: {},
};

const granted: ExtensionPermissions = { grantedAt: {} };

// ── Tests ───────────────────────────────────────────────────────────

describe("installFromLocal — preloadedManifest opt", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "ext-preload-"));
    createExtensionCalled = null;
    mockExtensions.clear();
  });

  test("preloadedManifest skips internal loadManifest call", async () => {
    // Write the entrypoint (installer needs it for checksum) but
    // NOT the ezcorp.config.ts. If `installFromLocal` tried to load
    // it internally, it would throw "No ezcorp.config.ts found at ...".
    await Bun.write(join(dir, "index.ts"), 'console.log("hi");');

    const result = await installFromLocal(dir, granted, false, {
      preloadedManifest: fixtureManifest,
    });

    expect(result.name).toBe("preloaded-fixture");
    expect(result.version).toBe("1.0.0");
    expect(createExtensionCalled).not.toBeNull();
    expect(createExtensionCalled?.name).toBe("preloaded-fixture");
  });

  test("no opts → internal loadManifest still runs (backward compat)", async () => {
    // No ezcorp.config.ts on disk. Without `preloadedManifest`, the
    // installer falls back to its internal `loadManifest` call, which
    // throws.
    await Bun.write(join(dir, "index.ts"), 'console.log("hi");');

    await expect(installFromLocal(dir, granted, false)).rejects.toThrow(
      /No ezcorp\.config\.ts/,
    );
  });

  test("preloadedManifest + valid on-disk config → equivalent result", async () => {
    // Both paths see the same on-disk content. Result row must be
    // identical except for the auto-assigned id / timestamps.
    await writeConfig(dir, fixtureManifest);
    await Bun.write(join(dir, "index.ts"), 'console.log("hi");');

    const withPreload = await installFromLocal(dir, granted, false, {
      preloadedManifest: fixtureManifest,
    });

    // Re-run sans-opt to compare. We reset state between calls so the
    // second create still fires.
    createExtensionCalled = null;
    mockExtensions.clear();
    const sansOpt = await installFromLocal(dir, granted, false);

    expect(withPreload.name).toBe(sansOpt.name);
    expect(withPreload.version).toBe(sansOpt.version);
    // Manifest checksum is the same (both paths compute it from the
    // same on-disk index.ts).
    const wp = withPreload.manifest as { checksum?: string };
    const so = sansOpt.manifest as { checksum?: string };
    expect(wp.checksum).toBe(so.checksum!);
    expect(wp.checksum).toMatch(/^[a-f0-9]{64}$/);
  });

  test("preloadedManifest is trusted — caller responsibility", async () => {
    // Trust contract: the installer does NOT cross-check the
    // preloaded manifest against on-disk content. Caller (the install
    // endpoint) is the sole validator. This documents the choice.
    await Bun.write(join(dir, "index.ts"), 'console.log("hi");');

    const trustedAs = "any-name-the-caller-says";
    const result = await installFromLocal(dir, granted, false, {
      preloadedManifest: { ...fixtureManifest, name: trustedAs },
    });
    expect(result.name).toBe(trustedAs);
  });
});
