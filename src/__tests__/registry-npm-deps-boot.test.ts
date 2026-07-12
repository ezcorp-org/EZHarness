/**
 * Registry boot-visibility for the extension npm-dependency contract
 * (src/extensions/registry.ts `loadFromDb`): an enabled extension whose
 * declared `npmDependencies` can't be resolved from its install path logs
 * an error at load — VISIBILITY ONLY (never disabled, never throws; the
 * per-call spawn pre-check owns enforcement). A resolvable declaration is
 * silent. Uses a real PGlite DB so the load path runs end-to-end.
 *
 * Spec: tasks/extension-npm-deps.md (section 8).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { closeTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";

mockDbConnection();

import { createExtension } from "../db/queries/extensions";
import { ExtensionRegistry } from "../extensions/registry";

// Both extensions resolve from the repo root: `yaml` is a real root
// dependency (resolvable); `nonexistent-boot-xyz` is not (missing).
const REPO_ROOT = resolve(import.meta.dir, "..", "..");

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
});

function makeRow(name: string, npmDependencies: Record<string, string>) {
  return {
    name,
    version: "1.0.0",
    description: "d",
    manifest: {
      schemaVersion: 2 as const,
      name,
      version: "1.0.0",
      description: "d",
      author: { name: "t" },
      entrypoint: "./index.ts",
      tools: [{ name: "noop", description: "d", inputSchema: { type: "object" } }],
      npmDependencies,
      permissions: {},
    },
    source: `local:${REPO_ROOT}`,
    installPath: REPO_ROOT,
    enabled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: false,
    consecutiveFailures: 0,
  };
}

describe("registry loadFromDb — npm-dependency boot visibility", () => {
  test("logs unresolvable declarations, stays silent for resolvable ones, never disables", async () => {
    const bad = await createExtension(makeRow("boot-npmdep-bad", { "nonexistent-boot-xyz": "^1.0.0" }));
    await createExtension(makeRow("boot-npmdep-good", { yaml: "^2.8.2" }));

    const stderrLines: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    (process.stderr as unknown as { write: (c: unknown) => boolean }).write = (chunk) => {
      stderrLines.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    };
    const registry = ExtensionRegistry.getInstance();
    try {
      // Must NOT throw — config drift never nukes state at boot.
      await registry.loadFromDb();
    } finally {
      (process.stderr as unknown as { write: typeof realWrite }).write = realWrite;
    }

    // Both extensions are still registered (visibility only, no disable).
    expect(registry.getManifestByName("boot-npmdep-bad")).toBeDefined();
    expect(registry.getManifestByName("boot-npmdep-good")).toBeDefined();

    const badLines = stderrLines.filter((l) => l.includes("extension npm dependencies unresolvable"));
    // Exactly the BAD extension logged an unresolvable error…
    const badLine = badLines.find((l) => l.includes("boot-npmdep-bad"));
    expect(badLine).toBeTruthy();
    const parsed = JSON.parse(badLine!) as { extension?: string; remedy?: string };
    expect(parsed.extension).toBe("boot-npmdep-bad");
    expect(parsed.remedy).toContain("cannot resolve");
    expect(parsed.remedy).toContain("nonexistent-boot-xyz");
    // …and the GOOD one did NOT (resolvable → the if(!ok) false branch).
    expect(badLines.some((l) => l.includes("boot-npmdep-good"))).toBe(false);
    // The extension id is threaded for operator correlation.
    expect((JSON.parse(badLine!) as { extensionId?: string }).extensionId).toBe(bad.id);
  });
});
