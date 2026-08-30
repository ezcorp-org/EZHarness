/**
 * Registry-level resolution of a BUNDLED extension's install path
 * (src/extensions/registry.ts `loadFromDb`).
 *
 * Root cause this regresses: `ensureBundledExtensions()` used to persist
 * `install_path` as an ABSOLUTE path baked in by whichever environment ran
 * the install (`/app/docs/extensions/examples/web-search` in the shipped
 * container). A host-side process reading the SAME database cannot resolve
 * that path — `/app` doesn't exist there — which is exactly what produced
 * the "Failed to scan extension workflows" ENOENT warnings and, via the
 * subprocess spawn failures they share a root cause with, two permanently
 * auto-disabled extensions.
 *
 * The fix stores a bundled row's `install_path` PROJECT-ROOT-RELATIVE
 * (`src/extensions/bundled.ts` `persistPath: entry.path`,
 * `src/extensions/installer.ts`) and reconstructs the absolute path at
 * `loadFromDb` time via `resolveInstallPath()` (`./install-roots.ts`), so
 * EVERY consumer that reads through `registry.getInstallPath()` — the
 * subprocess spawn args, the workflow-asset scanner, the fs-handler
 * permission checks — gets a path that resolves from THIS process's own
 * root, whatever that root is.
 *
 * Uses a real PGlite DB (same pattern as registry-npm-deps-boot.test.ts) so
 * `loadFromDb` runs end-to-end against real rows.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { closeTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { useTempProjectRoot } from "./helpers/temp-project-root";

mockDbConnection();

import { createExtension } from "../db/queries/extensions";
import { ExtensionRegistry } from "../extensions/registry";

const TMP_ROOT = useTempProjectRoot("registry-bundled-install-path-");

beforeAll(async () => {
  await setupTestDb();
});

afterEach(() => {
  ExtensionRegistry.resetInstance();
});

afterAll(async () => {
  ExtensionRegistry.resetInstance();
  await closeTestDb();
  TMP_ROOT.cleanup();
});

function makeRow(
  name: string,
  installPath: string | null,
  isBundled: boolean,
) {
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
      permissions: {},
    },
    source: installPath ? `local:${installPath}` : "bundled",
    installPath,
    isBundled,
    enabled: true,
    grantedPermissions: { grantedAt: {} },
    checksumVerified: false,
    consecutiveFailures: 0,
  };
}

describe("registry loadFromDb — bundled install-path resolution", () => {
  test("a bundled row's RELATIVE install_path resolves against getProjectRoot()", async () => {
    await createExtension(
      makeRow("resolve-bundled-relative", "docs/extensions/examples/web-search", true),
    );

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const [id] = [...registry.getAllManifests()].find(
      ([, m]) => m.name === "resolve-bundled-relative",
    )!;
    expect(registry.getInstallPath(id)).toBe(
      join(TMP_ROOT.root, "docs/extensions/examples/web-search"),
    );
  });

  test("a bundled row's LEGACY ABSOLUTE install_path (pre-migration) is passed through unchanged", async () => {
    // resolveInstallPath is a no-op for an already-absolute path — a row
    // that hasn't been touched by the migration yet (or was written under a
    // foreign root the migration didn't match) still resolves to SOMETHING,
    // even if that something is wrong for THIS process. The install-path
    // pre-check in subprocess.ts is what keeps that case safe.
    await createExtension(
      makeRow("resolve-bundled-legacy-absolute", "/some/other/root/docs/extensions/examples/x", true),
    );

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const [id] = [...registry.getAllManifests()].find(
      ([, m]) => m.name === "resolve-bundled-legacy-absolute",
    )!;
    expect(registry.getInstallPath(id)).toBe("/some/other/root/docs/extensions/examples/x");
  });

  test("a NON-bundled row's install_path is left exactly as stored, even if relative", async () => {
    // Downloaded (git/github) extensions already persist a cwd-relative
    // install_path by design (install-roots.ts `downloadedExtensionsDir`).
    // Only bundled rows go through resolveInstallPath — this must not
    // change for anyone else.
    await createExtension(
      makeRow("resolve-nonbundled-relative", "data/extensions/some-ext", false),
    );

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const [id] = [...registry.getAllManifests()].find(
      ([, m]) => m.name === "resolve-nonbundled-relative",
    )!;
    expect(registry.getInstallPath(id)).toBe("data/extensions/some-ext");
  });

  test("a NULL install_path (MCP-only row) never enters the install-path map", async () => {
    await createExtension(makeRow("resolve-null-install-path", null, true));

    const registry = ExtensionRegistry.getInstance();
    await registry.loadFromDb();

    const [id] = [...registry.getAllManifests()].find(
      ([, m]) => m.name === "resolve-null-install-path",
    )!;
    expect(registry.getInstallPath(id)).toBeNull();
  });
});
