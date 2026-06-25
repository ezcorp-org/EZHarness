/**
 * Integration tests for phase 28: TypeScript manifest migration.
 *
 * Covers:
 * 1. Installer + loadManifest integration (installFromLocal roundtrip)
 * 2. Init + Template + loadManifest roundtrip (all 4 template types)
 * 3. Production code no longer references manifest.json
 */

import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { writeConfig } from "./helpers/write-config";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp } from "fs/promises";

// ── Mock DB layer ────────────────────────────────────────────────────

const mockExtensions = new Map<string, any>();
let lastCreateCall: any = null;

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = { id: crypto.randomUUID(), ...data, createdAt: new Date(), updatedAt: new Date() };
    lastCreateCall = ext;
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtension: async (id: string) => mockExtensions.get(id) ?? null,
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) if (ext.name === name) return ext;
    return null;
  },
  updateExtension: async (id: string, data: any) => {
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => mockExtensions.delete(id),
  listExtensions: async () => Array.from(mockExtensions.values()),
  incrementFailures: async () => 0,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

afterAll(() => restoreModuleMocks());

const { installFromLocal } = await import("../extensions/installer");

const defaultPerms = { network: ["api.example.com"], grantedAt: { network: Date.now() } };

async function setupExtDir(manifest: Record<string, unknown>, entryContent = 'console.log("ext");') {
  const dir = await mkdtemp(join(tmpdir(), "ts-manifest-integ-"));
  await writeConfig(dir, manifest);
  if (manifest.entrypoint) {
    const ep = (manifest.entrypoint as string).replace(/^\.\//, "");
    await Bun.write(join(dir, ep), entryContent);
  }
  return dir;
}

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    name: "integ-test-ext",
    version: "1.0.0",
    description: "Integration test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: {},
    ...overrides,
  };
}

// ── 1. Installer + loadManifest integration ──────────────────────────

describe("installer + loadManifest integration", () => {
  beforeEach(() => {
    lastCreateCall = null;
    mockExtensions.clear();
  });

  test("installFromLocal reads ezcorp.config.ts and stores in DB", async () => {
    const dir = await setupExtDir(validManifest());
    const result = await installFromLocal(dir, defaultPerms);

    expect(result.name).toBe("integ-test-ext");
    expect(result.version).toBe("1.0.0");
    // Phase 1: loadManifest auto-promotes v2 to v3 with _inheritedFromV2.
    expect(lastCreateCall.manifest.schemaVersion).toBe(3);
    expect(lastCreateCall.manifest._inheritedFromV2).toBe(true);
  });

  test("installFromLocal fails when ezcorp.config.ts is missing", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ts-manifest-integ-empty-"));

    await expect(installFromLocal(dir, defaultPerms)).rejects.toThrow(/No ezcorp\.config\.ts found/);
  });

  test("installFromLocal strips handler functions before storing in DB", async () => {
    // writeConfig serializes to JSON which drops functions automatically,
    // but loadManifest's stripFunctions handles the case where the config
    // is a real TS module with function props. We verify no function props in stored manifest.
    const dir = await setupExtDir(validManifest());
    await installFromLocal(dir, defaultPerms);

    const stored = lastCreateCall.manifest;

    // Walk stored manifest recursively — no value should be a function
    function assertNoFunctions(obj: any, path = "manifest") {
      for (const [k, v] of Object.entries(obj)) {
        if (typeof v === "function") {
          throw new Error(`Found function at ${path}.${k}`);
        }
        if (v && typeof v === "object" && !Array.isArray(v)) {
          assertNoFunctions(v, `${path}.${k}`);
        }
        if (Array.isArray(v)) {
          v.forEach((item, i) => {
            if (typeof item === "object" && item !== null) {
              assertNoFunctions(item, `${path}.${k}[${i}]`);
            }
            expect(typeof item).not.toBe("function");
          });
        }
      }
    }

    assertNoFunctions(stored);
  });

  test("stored manifest includes checksum from entrypoint", async () => {
    const dir = await setupExtDir(validManifest());
    await installFromLocal(dir, defaultPerms);

    expect(lastCreateCall.manifest.checksum).toMatch(/^[a-f0-9]{64}$/);
  });
});

// ── 2. Init + Template + loadManifest roundtrip ──────────────────────

describe("template generates valid ezcorp.config.ts", () => {
  const templateTypes = ["tool", "skill", "agent", "multi"] as const;

  for (const type of templateTypes) {
    describe(`${type} template`, () => {
      test("generates source containing defineExtension import", async () => {
        const mod = await import(`../extensions/sdk/templates/${type}`);
        const manifestFn = mod[`${type}Manifest`] as (name: string, desc: string) => string;
        const source = manifestFn("test-ext", "A test extension");

        expect(source).toContain("defineExtension");
        expect(source).toContain('from "@ezcorp/sdk"');
      });

      test("generated source is syntactically valid TypeScript", async () => {
        const mod = await import(`../extensions/sdk/templates/${type}`);
        const manifestFn = mod[`${type}Manifest`] as (name: string, desc: string) => string;
        const source = manifestFn("test-ext", "A test extension");

        // Strip imports and export default, eval with shims to check syntax
        const transformed = source
          .replace(/import\s*\{[^}]*\}\s*from\s*["'][^"']*["'];?\n?/g, "")
          .replace(/import\s+\w+\s+from\s*["'][^"']*["'];?\n?/g, "")
          .replace("export default", "return");
        const noop = () => {};

        // Should not throw — valid JS/TS after transform
        const result = new Function("defineExtension", "handleRequest", transformed)(
          (x: any) => x,
          noop,
        );
        expect(result).toBeDefined();
        expect(result.schemaVersion).toBe(2);
      });

      test("generated config references correct entrypoint pattern", async () => {
        const mod = await import(`../extensions/sdk/templates/${type}`);
        const manifestFn = mod[`${type}Manifest`] as (name: string, desc: string) => string;
        const source = manifestFn("test-ext", "A test extension");

        if (type === "tool" || type === "multi") {
          // Tool and multi templates have entrypoints
          expect(source).toContain('entrypoint: "./index.ts"');
          expect(source).toContain('import { handleRequest } from "./index"');
        } else {
          // Skill and agent templates should NOT have an entrypoint
          expect(source).not.toContain("entrypoint");
        }
      });
    });
  }
});

// ── 3. Production code no longer references manifest.json ────────────

describe("no manifest.json references in production code", () => {
  test("src/extensions/ has zero manifest.json references in non-test, non-comment code", async () => {
    const proc = Bun.spawnSync(
      [
        "grep",
        "-rn",
        "manifest\\.json",
        "--include=*.ts",
        "--include=*.tsx",
        // Exclude test files and comments
        "--exclude=*.test.ts",
        "--exclude=*.test.tsx",
        "--exclude-dir=__tests__",
        "--exclude-dir=node_modules",
      ],
      { cwd: join(import.meta.dir, "..", "extensions") },
    );
    const stdout = proc.stdout.toString().trim();

    // Filter out comment-only lines (// or /* or *)
    const codeLines = stdout
      .split("\n")
      .filter(Boolean)
      .filter((line) => {
        const content = line.split(":").slice(2).join(":").trim();
        return !content.startsWith("//") && !content.startsWith("*") && !content.startsWith("/*");
      })
      // The file-organizer's QUARANTINE bookkeeping file is `.trash/manifest.json`
      // — a per-folder trash index built from `trashRoot`, categorically distinct
      // from the deprecated *extension* manifest.json this phase-28 gate guards
      // against. Allow those references (always under `.trash/` / `trashRoot`);
      // any OTHER `manifest.json` reference still fails the gate.
      .filter((line) => {
        const content = line.split(":").slice(2).join(":");
        return !/(?:trashRoot|\.trash)/.test(content);
      });

    expect(codeLines).toEqual([]);
  });

  test("all loader call sites use loadManifest or loadManifestFresh", async () => {
    // Verify installer.ts imports from loader
    const installerSrc = await Bun.file(
      join(import.meta.dir, "..", "extensions", "installer.ts"),
    ).text();
    expect(installerSrc).toContain('import { loadManifest } from "./loader"');

    // Verify sdk/dev.ts uses loadManifestFresh
    const devSrc = await Bun.file(
      join(import.meta.dir, "..", "extensions", "sdk", "dev.ts"),
    ).text();
    expect(devSrc).toMatch(/loadManifestFresh|loadManifest/);

    // Verify sdk/publish.ts uses loadManifest
    const publishSrc = await Bun.file(
      join(import.meta.dir, "..", "extensions", "sdk", "publish.ts"),
    ).text();
    expect(publishSrc).toMatch(/loadManifest/);

    // Verify sdk/test-runner.ts uses loadManifest
    const testRunnerSrc = await Bun.file(
      join(import.meta.dir, "..", "extensions", "sdk", "test-runner.ts"),
    ).text();
    expect(testRunnerSrc).toMatch(/loadManifest/);
  });

  test("no direct JSON.parse of manifest.json in extensions/", async () => {
    const proc = Bun.spawnSync(
      [
        "grep",
        "-rn",
        "JSON\\.parse.*manifest",
        "--include=*.ts",
        "--exclude=*.test.ts",
        "--exclude-dir=__tests__",
        "--exclude-dir=node_modules",
      ],
      { cwd: join(import.meta.dir, "..", "extensions") },
    );
    const stdout = proc.stdout.toString().trim();
    expect(stdout).toBe("");
  });
});
