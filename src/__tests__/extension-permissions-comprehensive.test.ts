import { test, expect, describe, beforeAll, beforeEach, afterAll } from "bun:test";
import { setupTestDb, closeTestDb, mockDbConnection, restoreFetch } from "./helpers/test-pglite";
import { useTempProjectRoot, type TempProjectRoot } from "./helpers/temp-project-root";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { listExtensions } from "../db/queries/extensions";

// Must be called before importing modules that use db/connection
mockDbConnection();

beforeEach(() => {
  restoreFetch();
  mockDbConnection();
});

import {
  // Phase 6 deletes the dead `checkPermission` boolean helper. PDP unit
  // coverage lives in `permission-engine.test.ts`; this file keeps the
  // remaining helpers (diff, getRequired, sensitive-confirmation).
  getRequiredPermissions,
  diffPermissions,
  isSensitiveOperation,
  checkSensitiveConfirmation,
  setSensitiveAlwaysAllow,
} from "../extensions/permissions";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import { installFromLocal, installFromGitHub } from "../extensions/installer";
import { validateManifestV2 as validateManifest } from "../extensions/manifest";

// ── Setup ───────────────────────────────────────────────────────────

// `installFromLocal()`'s install base is the RELATIVE `data/extensions`,
// resolved against `process.cwd()` — the checkout, for a test. Run from a
// throwaway root so no install lands in the working tree.
let tmpRoot: TempProjectRoot;

beforeAll(async () => {
  tmpRoot = useTempProjectRoot("ext-perms-comprehensive-");
  restoreFetch();
  mockDbConnection();
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  tmpRoot.cleanup();
});

// ── Helpers ─────────────────────────────────────────────────────────

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test" },
    entrypoint: "./index.ts",
    tools: [
      {
        name: "my-tool",
        description: "Does something",
        inputSchema: { type: "object", properties: {} },
      },
    ],
    permissions: {},
    ...overrides,
  };
}

// ════════════════════════════════════════════════════════════════════
// 1. permissions.ts
// ════════════════════════════════════════════════════════════════════
//
// `checkPermission` (the dead sync boolean helper) was removed in
// Phase 6 — PDP coverage lives in `permission-engine.test.ts` and the
// boolean-shape edge cases (network/filesystem/shell/env subset
// matching) are exercised through the engine's `firstMissingCapability`
// + `capabilityCovers` unit tests in the same file.

// ── getRequiredPermissions ──────────────────────────────────────────

describe("getRequiredPermissions", () => {
  test("returns empty array for manifest with empty permissions", () => {
    const manifest = makeManifest({ permissions: {} });
    expect(getRequiredPermissions(manifest)).toEqual([]);
  });

  test("lists all network domains", () => {
    const manifest = makeManifest({
      permissions: { network: ["a.com", "b.com", "c.com"] },
    });
    const items = getRequiredPermissions(manifest);
    const networkItems = items.filter((i) => i.type === "network");
    expect(networkItems).toHaveLength(3);
    expect(networkItems.map((i) => i.value)).toEqual(["a.com", "b.com", "c.com"]);
  });

  test("lists all filesystem paths", () => {
    const manifest = makeManifest({
      permissions: { filesystem: ["/tmp", "/home/user"] },
    });
    const items = getRequiredPermissions(manifest);
    const fsItems = items.filter((i) => i.type === "filesystem");
    expect(fsItems).toHaveLength(2);
    expect(fsItems.map((i) => i.value)).toEqual(["/tmp", "/home/user"]);
  });

  test("lists shell permission", () => {
    const manifest = makeManifest({ permissions: { shell: true } });
    const items = getRequiredPermissions(manifest);
    const shellItems = items.filter((i) => i.type === "shell");
    expect(shellItems).toHaveLength(1);
    expect(shellItems[0]!.value).toBe(true);
  });

  test("lists all env vars", () => {
    const manifest = makeManifest({
      permissions: { env: ["TOKEN", "SECRET", "HOME"] },
    });
    const items = getRequiredPermissions(manifest);
    const envItems = items.filter((i) => i.type === "env");
    expect(envItems).toHaveLength(3);
    expect(envItems.map((i) => i.value)).toEqual(["TOKEN", "SECRET", "HOME"]);
  });

  test("returns correct descriptions for each type", () => {
    const manifest = makeManifest({
      permissions: {
        network: ["api.example.com"],
        filesystem: ["/tmp"],
        shell: true,
        env: ["MY_VAR"],
      },
    });
    const items = getRequiredPermissions(manifest);
    expect(items.find((i) => i.type === "network")!.description).toBe("Network access to api.example.com");
    expect(items.find((i) => i.type === "filesystem")!.description).toBe("Filesystem access to /tmp");
    expect(items.find((i) => i.type === "shell")!.description).toBe("Execute shell commands");
    expect(items.find((i) => i.type === "env")!.description).toBe("Read environment variable MY_VAR");
  });

  test("handles manifest with all permission types", () => {
    const manifest = makeManifest({
      permissions: {
        network: ["x.com"],
        filesystem: ["/data"],
        shell: true,
        env: ["KEY"],
      },
    });
    const items = getRequiredPermissions(manifest);
    const types = new Set(items.map((i) => i.type));
    expect(types).toEqual(new Set(["network", "filesystem", "shell", "env"]));
    expect(items).toHaveLength(4);
  });
});

// ── diffPermissions ─────────────────────────────────────────────────

describe("diffPermissions", () => {
  test("returns empty diff when all permissions already granted", () => {
    const perms: ExtensionPermissions = {
      network: ["a.com"],
      filesystem: ["/tmp"],
      shell: true,
      env: ["KEY"],
      grantedAt: {},
    };
    const diff = diffPermissions(perms, perms);
    expect(diff.network).toBeUndefined();
    expect(diff.filesystem).toBeUndefined();
    expect(diff.shell).toBeUndefined();
    expect(diff.env).toBeUndefined();
  });

  test("returns ungranted network domains", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com", "c.com"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com", "c.com"]);
  });

  test("returns ungranted filesystem paths", () => {
    const requested: ExtensionPermissions = {
      filesystem: ["/tmp", "/home", "/etc"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      filesystem: ["/tmp"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.filesystem).toEqual(["/home", "/etc"]);
  });

  test("returns shell if not yet granted", () => {
    const requested: ExtensionPermissions = { shell: true, grantedAt: {} };
    const granted: ExtensionPermissions = { grantedAt: {} };
    const diff = diffPermissions(requested, granted);
    expect(diff.shell).toBe(true);
  });

  test("returns ungranted env vars", () => {
    const requested: ExtensionPermissions = {
      env: ["A", "B", "C"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      env: ["B"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.env).toEqual(["A", "C"]);
  });

  test("handles mix of granted and ungranted", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com"],
      filesystem: ["/tmp", "/data"],
      shell: true,
      env: ["X", "Y"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      filesystem: ["/tmp"],
      shell: true,
      env: ["X"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com"]);
    expect(diff.filesystem).toEqual(["/data"]);
    expect(diff.shell).toBeUndefined(); // shell already granted
    expect(diff.env).toEqual(["Y"]);
  });
});

// ── isSensitiveOperation ────────────────────────────────────────────

describe("isSensitiveOperation", () => {
  test('returns true for "shell"', () => {
    expect(isSensitiveOperation("shell")).toBe(true);
  });

  test('returns true for "filesystem"', () => {
    expect(isSensitiveOperation("filesystem")).toBe(true);
  });
});

// ── checkSensitiveConfirmation & setSensitiveAlwaysAllow ────────────

describe("checkSensitiveConfirmation and setSensitiveAlwaysAllow", () => {
  test('returns "needs_confirmation" by default', async () => {
    const result = await checkSensitiveConfirmation("comprehensive-ext-1", "shell");
    expect(result).toBe("needs_confirmation");
  });

  test('returns "allowed" after setSensitiveAlwaysAllow(true)', async () => {
    await setSensitiveAlwaysAllow("comprehensive-ext-2", "shell", true);
    const result = await checkSensitiveConfirmation("comprehensive-ext-2", "shell");
    expect(result).toBe("allowed");
  });

  test('returns "needs_confirmation" after setSensitiveAlwaysAllow(false)', async () => {
    await setSensitiveAlwaysAllow("comprehensive-ext-3", "filesystem", true);
    await setSensitiveAlwaysAllow("comprehensive-ext-3", "filesystem", false);
    const result = await checkSensitiveConfirmation("comprehensive-ext-3", "filesystem");
    expect(result).toBe("needs_confirmation");
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. validateManifestV2
// ════════════════════════════════════════════════════════════════════

describe("validateManifest (v2)", () => {
  const validManifest = {
    schemaVersion: 2,
    name: "my-ext",
    version: "1.0.0",
    description: "A test extension",
    author: { name: "Test" },
    entrypoint: "./index.ts",
    tools: [
      { name: "tool1", description: "A tool", inputSchema: { type: "object" } },
    ],
    permissions: {},
  };

  test("valid manifest passes", () => {
    const result = validateManifest(validManifest);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  test("missing name fails", () => {
    const { name, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
  });

  test("missing version fails", () => {
    const { version, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("version"))).toBe(true);
  });

  test("tools with missing entrypoint fails", () => {
    const { entrypoint, ...rest } = validManifest;
    const result = validateManifest(rest);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("entrypoint"))).toBe(true);
  });

  test("tool without name fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ description: "A tool", inputSchema: { type: "object" } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("name"))).toBe(true);
  });

  test("tool without description fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ name: "tool1", inputSchema: { type: "object" } }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("description"))).toBe(true);
  });

  test("tool without inputSchema fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: [{ name: "tool1", description: "A tool" }],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("inputSchema"))).toBe(true);
  });

  test("null manifest fails", () => {
    const result = validateManifest(null);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("undefined manifest fails", () => {
    const result = validateManifest(undefined);
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("non-object manifest fails", () => {
    const result = validateManifest("not an object");
    expect(result.valid).toBe(false);
    expect(result.errors).toEqual(["Manifest must be a non-null object"]);
  });

  test("non-object tool element fails", () => {
    const result = validateManifest({
      ...validManifest,
      tools: ["not an object"],
    });
    expect(result.valid).toBe(false);
    expect(result.errors.some((e: string) => e.includes("tools[0]") && e.includes("must be an object"))).toBe(true);
  });

  test("multiple errors accumulated", () => {
    const result = validateManifest({});
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(4);
    expect(result.errors.some((e: string) => e.includes("name"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("version"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("schemaVersion"))).toBe(true);
    expect(result.errors.some((e: string) => e.includes("description"))).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. installer.ts — installFromLocal
// ════════════════════════════════════════════════════════════════════

describe("retired installation paths require the approved lifecycle", () => {
  const localCases = ["valid manifest", "missing manifest", "invalid manifest", "matching checksum", "explicit source path"];
  const githubCases = ["release", "tagged release", "tampered checksum", "missing tarball", "missing manifest"];
  for (const [source, cases, install] of [["local", localCases, installFromLocal], ["github", githubCases, installFromGitHub]] as const) {
    for (const name of cases) test(`${source}: ${name} cannot bypass isolated build and human approval`, async () => {
      const directory = await mkdtemp(join(tmpdir(), "retired-extension-install-"));
      let fetched = false;
      const previousFetch = globalThis.fetch;
      globalThis.fetch = (async () => { fetched = true; throw new Error("Legacy install must not fetch"); }) as unknown as typeof fetch;
      try {
        await Bun.write(join(directory, "ezcorp.config.ts"), 'throw new Error("Legacy config must not execute");');
        const before = await listExtensions();
        await expect(install(source === "local" ? directory : "testuser/testrepo@v2.0.0", { filesystem: { paths: ["/"], mode: ["read", "write"] }, shell: true }, true, { userId: "owner" })).rejects.toThrow("EXTENSION_V4_REQUIRED");
        expect(fetched).toBe(false);
        expect(await listExtensions()).toEqual(before);
        expect(await Bun.file(join(directory, "ezcorp.config.ts")).text()).toContain("must not execute");
      } finally {
        globalThis.fetch = previousFetch;
        await rm(directory, { recursive: true, force: true });
      }
    });
  }
});
