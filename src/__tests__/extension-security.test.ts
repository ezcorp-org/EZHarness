import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdirSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import type { ExtensionPermissions } from "../extensions/types";

// ── Mocks ────────────────────────────────────────────────────────

let disableExtensionCalls: string[] = [];

mock.module("../db/queries/extensions", () => ({
  disableExtension: async (id: string) => {
    disableExtensionCalls.push(id);
  },
  // stubs for other imports
  listExtensions: async () => [],
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

const mockSettings = new Map<string, unknown>();

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings.get(key) ?? null,
  upsertSetting: async (key: string, value: unknown) => { mockSettings.set(key, value); },
  getAllSettings: async () => Object.fromEntries(mockSettings),
  deleteSetting: async (key: string) => mockSettings.delete(key),
  isListingInstalled: async () => false,
}));

afterAll(() => restoreModuleMocks());

// ── Imports (after mock) ─────────────────────────────────────────

import { denyAndDisable, hasSecurityViolation, getSecurityViolations, clearSecurityViolations } from "../extensions/security";
import { checkFilesystemPermission } from "../extensions/permissions";
import { buildAllowedEnv, cleanupExtTmpDir } from "../extensions/registry";

// ── Fixtures ─────────────────────────────────────────────────────

let testDir: string;
let installDir: string;
let allowedDir: string;
let outsideDir: string;

beforeEach(() => {
  disableExtensionCalls = [];
  mockSettings.clear();
  testDir = join(tmpdir(), `pi-security-test-${randomUUID()}`);
  installDir = join(testDir, "ext-install");
  allowedDir = join(testDir, "allowed");
  outsideDir = join(testDir, "outside");

  mkdirSync(join(installDir, "data"), { recursive: true });
  mkdirSync(allowedDir, { recursive: true });
  mkdirSync(outsideDir, { recursive: true });
  writeFileSync(join(allowedDir, "ok.txt"), "ok");
  writeFileSync(join(outsideDir, "secret.txt"), "secret");
  writeFileSync(join(installDir, "data", "local.txt"), "local");
});

afterEach(() => {
  rmSync(testDir, { recursive: true, force: true });
});

// ── denyAndDisable ───────────────────────────────────────────────

describe("deny and disable", () => {
  test("calls disableExtension and returns structured violation event", async () => {
    const before = Date.now();
    const violation = await denyAndDisable("ext-bad", "path traversal detected", "/etc/passwd");
    expect(disableExtensionCalls).toEqual(["ext-bad"]);
    expect(violation.extensionId).toBe("ext-bad");
    expect(violation.reason).toBe("path traversal detected");
    expect(violation.path).toBe("/etc/passwd");
    expect(violation.timestamp).toBeGreaterThanOrEqual(before);
    expect(violation.timestamp).toBeLessThanOrEqual(Date.now());
  });

  test("records violation in settings store", async () => {
    await denyAndDisable("ext-tracked", "unauthorized access", "/etc/shadow");
    const violations = await getSecurityViolations("ext-tracked");
    expect(violations).toHaveLength(1);
    expect(violations[0]!.reason).toBe("unauthorized access");
    expect(violations[0]!.path).toBe("/etc/shadow");
  });

  test("accumulates multiple violations", async () => {
    await denyAndDisable("ext-multi", "violation 1", "/path1");
    await denyAndDisable("ext-multi", "violation 2", "/path2");
    const violations = await getSecurityViolations("ext-multi");
    expect(violations).toHaveLength(2);
  });
});

// ── hasSecurityViolation ─────────────────────────────────────────

describe("hasSecurityViolation", () => {
  test("returns false when no violations exist", async () => {
    expect(await hasSecurityViolation("ext-clean")).toBe(false);
  });

  test("returns true after denyAndDisable", async () => {
    await denyAndDisable("ext-flagged", "bad behavior", "/secret");
    expect(await hasSecurityViolation("ext-flagged")).toBe(true);
  });
});

// ── clearSecurityViolations ──────────────────────────────────────

describe("clearSecurityViolations", () => {
  test("clears all violations for an extension", async () => {
    await denyAndDisable("ext-clear", "first violation", "/a");
    await denyAndDisable("ext-clear", "second violation", "/b");
    expect(await hasSecurityViolation("ext-clear")).toBe(true);

    await clearSecurityViolations("ext-clear");
    expect(await hasSecurityViolation("ext-clear")).toBe(false);
    expect(await getSecurityViolations("ext-clear")).toEqual([]);
  });
});

// ── checkFilesystemPermission ────────────────────────────────────

describe("filesystem permission - path traversal", () => {
  test("resolves ../ in paths and denies access outside declared prefixes", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    // Try to escape allowed dir via ../
    const traversalPath = join(allowedDir, "..", "outside", "secret.txt");
    const result = await checkFilesystemPermission(traversalPath, granted, installDir);
    expect(result.allowed).toBe(false);
  });

  test("allows access within declared prefix after realpath resolution", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(join(allowedDir, "ok.txt"), granted, installDir);
    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(join(allowedDir, "ok.txt"));
  });
});

describe("filesystem permission - symlink defense", () => {
  test("resolves symlinks and denies if target is outside declared prefixes", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    // Create symlink inside allowed dir pointing outside
    const symlinkPath = join(allowedDir, "escape-link");
    symlinkSync(join(outsideDir, "secret.txt"), symlinkPath);

    const result = await checkFilesystemPermission(symlinkPath, granted, installDir);
    expect(result.allowed).toBe(false);
    // Resolved path should be the real target
    expect(result.resolvedPath).toBe(join(outsideDir, "secret.txt"));
  });

  test("allows symlink when target is within declared prefix", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    // Symlink inside allowed dir pointing to another file in allowed dir
    const symlinkPath = join(allowedDir, "good-link");
    symlinkSync(join(allowedDir, "ok.txt"), symlinkPath);

    const result = await checkFilesystemPermission(symlinkPath, granted, installDir);
    expect(result.allowed).toBe(true);
  });
});

describe("filesystem permission - implicit install dir access", () => {
  test("allows access to extension's own install directory without explicit permission", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [], // No explicit filesystem permissions
      grantedAt: {},
    };
    const filePath = join(installDir, "data", "local.txt");
    const result = await checkFilesystemPermission(filePath, granted, installDir);
    expect(result.allowed).toBe(true);
  });

  test("allows access to install directory itself", async () => {
    const granted: ExtensionPermissions = { grantedAt: {} };
    const result = await checkFilesystemPermission(installDir, granted, installDir);
    expect(result.allowed).toBe(true);
  });
});

describe("filesystem permission - non-existent paths", () => {
  test("returns false for non-existent paths (realpath fails)", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission("/nonexistent/path/file.txt", granted, installDir);
    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe("/nonexistent/path/file.txt");
  });
});

describe("filesystem permission - relative manifest paths", () => {
  test("relative paths in granted permissions resolve relative to installDir", async () => {
    const granted: ExtensionPermissions = {
      filesystem: ["./data"], // relative path
      grantedAt: {},
    };
    const filePath = join(installDir, "data", "local.txt");
    const result = await checkFilesystemPermission(filePath, granted, installDir);
    expect(result.allowed).toBe(true);
  });

  test("relative path without ./ prefix also resolves relative to installDir", async () => {
    const granted: ExtensionPermissions = {
      filesystem: ["data"], // no ./ prefix, still relative
      grantedAt: {},
    };
    const filePath = join(installDir, "data", "local.txt");
    const result = await checkFilesystemPermission(filePath, granted, installDir);
    expect(result.allowed).toBe(true);
  });
});

describe("filesystem permission - realpath failure on installDir", () => {
  test("falls back to string comparison when installDir does not exist", async () => {
    const nonExistentInstallDir = join(testDir, "does-not-exist-install");
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    // Request a valid path in allowedDir -- should still be allowed via granted prefix
    const result = await checkFilesystemPermission(join(allowedDir, "ok.txt"), granted, nonExistentInstallDir);
    expect(result.allowed).toBe(true);
  });

  test("denies access to non-existent installDir subtree when no grants match", async () => {
    const nonExistentInstallDir = join(testDir, "does-not-exist-install");
    const granted: ExtensionPermissions = {
      filesystem: [],
      grantedAt: {},
    };
    // Request a valid path outside any grant -- should be denied
    const result = await checkFilesystemPermission(join(allowedDir, "ok.txt"), granted, nonExistentInstallDir);
    expect(result.allowed).toBe(false);
  });
});

describe("filesystem permission - unresolvable manifest prefix paths", () => {
  test("silently skips unresolvable prefixes without crashing", async () => {
    const granted: ExtensionPermissions = {
      filesystem: ["/nonexistent/bogus/path", "/another/fake/prefix"],
      grantedAt: {},
    };
    // Valid path but no resolvable prefix matches -- should deny without throwing
    const result = await checkFilesystemPermission(join(allowedDir, "ok.txt"), granted, installDir);
    expect(result.allowed).toBe(false);
  });

  test("valid resolvable prefix still works alongside unresolvable ones", async () => {
    const granted: ExtensionPermissions = {
      filesystem: ["/nonexistent/bogus/path", allowedDir, "/another/fake/prefix"],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(join(allowedDir, "ok.txt"), granted, installDir);
    expect(result.allowed).toBe(true);
  });
});

// ── Environment Isolation ────────────────────────────────────────

describe("env isolation - buildAllowedEnv", () => {
  const baseManifest = {
    schemaVersion: 2 as const,
    name: "test-ext",
    version: "1.0.0",
    description: "Test",
    author: { name: "Test" },
    entrypoint: "index.ts",
    tools: [],
    permissions: {} as { network?: string[]; filesystem?: string[]; shell?: boolean; env?: string[] },
  };

  test("includes only PATH, HOME, TMPDIR, NODE_ENV by default", () => {
    const manifest = { ...baseManifest, permissions: {} };
    const granted: ExtensionPermissions = { grantedAt: {} };
    const env = buildAllowedEnv(manifest, granted, "test-ext-id");

    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TMPDIR).toBeDefined();
    expect(env.NODE_ENV).toBeDefined();
    // Should NOT contain other process env vars
    const keys = Object.keys(env);
    expect(keys).toEqual(["PATH", "HOME", "NODE_ENV", "TMPDIR"]);
  });

  test("creates per-extension TMPDIR under platform temp base", () => {
    const manifest = { ...baseManifest, permissions: {} };
    const granted: ExtensionPermissions = { grantedAt: {} };
    const env = buildAllowedEnv(manifest, granted, "my-ext-123");

    expect(env.TMPDIR).toContain("ezcorp-ext");
    expect(env.TMPDIR).toContain("my-ext-123");
    // Directory should exist on disk
    expect(existsSync(env.TMPDIR!)).toBe(true);
  });

  test("per-extension TMPDIR directory is created on disk", () => {
    const manifest = { ...baseManifest, permissions: {} };
    const granted: ExtensionPermissions = { grantedAt: {} };
    const env = buildAllowedEnv(manifest, granted, `tmpdir-test-${randomUUID()}`);

    expect(existsSync(env.TMPDIR!)).toBe(true);
    // Clean up
    rmSync(env.TMPDIR!, { recursive: true, force: true });
  });

  test("only adds env vars that appear in BOTH manifest.permissions.env AND grantedPermissions.env", () => {
    const original = process.env.TEST_GRANTED_VAR;
    process.env.TEST_GRANTED_VAR = "secret-value";
    process.env.TEST_UNGRANT_VAR = "other-value";

    try {
      const manifest = {
        ...baseManifest,
        permissions: { env: ["TEST_GRANTED_VAR", "TEST_UNGRANT_VAR"] },
      };
      const granted: ExtensionPermissions = {
        env: ["TEST_GRANTED_VAR"], // Only grant one of the two
        grantedAt: {},
      };
      const env = buildAllowedEnv(manifest, granted, "test-ext-env");

      expect(env.TEST_GRANTED_VAR).toBe("secret-value");
      expect(env.TEST_UNGRANT_VAR).toBeUndefined();
    } finally {
      if (original === undefined) delete process.env.TEST_GRANTED_VAR;
      else process.env.TEST_GRANTED_VAR = original;
      delete process.env.TEST_UNGRANT_VAR;
    }
  });

  test("env vars in manifest.permissions.env but NOT in grantedPermissions.env are excluded", () => {
    process.env.MANIFEST_ONLY_VAR = "should-not-appear";

    try {
      const manifest = {
        ...baseManifest,
        permissions: { env: ["MANIFEST_ONLY_VAR"] },
      };
      const granted: ExtensionPermissions = {
        // No env granted
        grantedAt: {},
      };
      const env = buildAllowedEnv(manifest, granted, "test-ext-no-grant");

      expect(env.MANIFEST_ONLY_VAR).toBeUndefined();
    } finally {
      delete process.env.MANIFEST_ONLY_VAR;
    }
  });
});

describe("env isolation - buildAllowedEnv TMPDIR idempotency", () => {
  const baseManifest2 = {
    schemaVersion: 2 as const,
    name: "test-ext",
    version: "1.0.0",
    description: "Test",
    author: { name: "Test" },
    entrypoint: "index.ts",
    tools: [],
    permissions: {} as { network?: string[]; filesystem?: string[]; shell?: boolean; env?: string[] },
  };

  test("calling buildAllowedEnv twice with same extensionId does not throw (mkdirSync recursive)", () => {
    const granted: ExtensionPermissions = { grantedAt: {} };
    const extId = `idempotent-test-${randomUUID()}`;

    // First call creates the directory
    const env1 = buildAllowedEnv(baseManifest2, granted, extId);
    expect(existsSync(env1.TMPDIR!)).toBe(true);

    // Second call with same extensionId should not throw
    const env2 = buildAllowedEnv(baseManifest2, granted, extId);
    expect(env2.TMPDIR).toBe(env1.TMPDIR);
    expect(existsSync(env2.TMPDIR!)).toBe(true);

    // Clean up
    rmSync(env1.TMPDIR!, { recursive: true, force: true });
  });
});

describe("env isolation - cleanupExtTmpDir", () => {
  test("removes per-extension TMPDIR", () => {
    const extId = `cleanup-test-${randomUUID()}`;
    const extTmpDir = join(tmpdir(), "ezcorp-ext", extId);
    mkdirSync(extTmpDir, { recursive: true });
    writeFileSync(join(extTmpDir, "temp.txt"), "data");

    cleanupExtTmpDir(extId);
    expect(existsSync(extTmpDir)).toBe(false);
  });
});
