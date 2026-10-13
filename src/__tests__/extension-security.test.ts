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
import { cleanupExtTmpDir } from "../extensions/registry";

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

// ── Phase 3: explicit `mode` parameter ────────────────────────────
//
// `checkFilesystemPermission` was extended (Phase 3) with a fourth
// `mode: "read" | "write"` argument. Defaults to `"read"` for back-compat;
// the fs-handler RPC dispatch (`./fs-handler.ts`) passes the explicit
// mode based on the verb (read/list/stat → read, write/mkdir/unlink → write).
// The PDP gates per-tool mode separately (capability-types.ts only emits
// `fs.write` caps when the tool's manifest declared write mode); this
// function's prefix check stays the same — it just mirrors the mode
// back on the result for self-describing audit rows.

describe("filesystem permission - explicit mode parameter", () => {
  test("defaults to mode='read' for back-compat (3-arg call)", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(
      join(allowedDir, "ok.txt"),
      granted,
      installDir,
    );
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("read");
  });

  test("mirrors mode='write' back on the result", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(
      join(allowedDir, "ok.txt"),
      granted,
      installDir,
      "write",
    );
    expect(result.allowed).toBe(true);
    expect(result.mode).toBe("write");
  });

  test("mode is preserved on deny path too", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(
      join(outsideDir, "secret.txt"),
      granted,
      installDir,
      "write",
    );
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("write");
  });

  test("mode is preserved on non-existent path (realpath fails)", async () => {
    const granted: ExtensionPermissions = {
      filesystem: [allowedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(
      "/this/path/does/not/exist",
      granted,
      installDir,
      "write",
    );
    expect(result.allowed).toBe(false);
    expect(result.mode).toBe("write");
  });
});

// ── Environment Isolation ────────────────────────────────────────



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
