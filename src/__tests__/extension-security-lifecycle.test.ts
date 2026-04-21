import { test, expect, describe, beforeEach, afterAll } from "bun:test";
import { mockDbConnection, mockRealSettings, setupTestDb, closeTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Must mock DB connection before importing modules that use it
mockDbConnection();
mockRealSettings();

import {
  createExtension,
  getExtension,
  listExtensions,
  deleteExtension,
  incrementFailures,
  resetFailures,
} from "../db/queries/extensions";
import { denyAndDisable } from "../extensions/security";
import type { SecurityViolation } from "../extensions/security";
import {
  checkPermission,
  diffPermissions,
  getRequiredPermissions,
  isSensitiveOperation,
} from "../extensions/permissions";
import {
  computePackageChecksums,
  verifyPackageChecksums,
} from "../extensions/checksum";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";
import type { NewExtension } from "../db/schema";
import { join } from "path";
import { tmpdir } from "os";
import { mkdtemp, rm } from "fs/promises";

// ── Helpers ──────────────────────────────────────────────────────────

function makeExtensionData(overrides: Partial<NewExtension> = {}): NewExtension {
  return {
    name: `test-ext-${crypto.randomUUID().slice(0, 8)}`,
    version: "1.0.0",
    description: "Test extension",
    manifest: {
      schemaVersion: 2,
      name: "test-ext",
      version: "1.0.0",
      description: "Test extension",
      author: { name: "Tester" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {},
    } as unknown as ExtensionManifestV2,
    source: "local:/tmp/test",
    installPath: "/tmp/test",
    enabled: true,
    grantedPermissions: { grantedAt: {} } as ExtensionPermissions,
    checksumVerified: true,
    consecutiveFailures: 0,
    ...overrides,
  };
}

// ── Setup ────────────────────────────────────────────────────────────

beforeEach(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

// ── 1. Extension Enable/Disable Filtering ────────────────────────────

describe("extension enable/disable filtering", () => {
  test("listExtensions(true) returns only enabled extensions", async () => {
    // DB is seeded with "Built-in Tools" (enabled) by migration
    const baseline = await listExtensions(true);
    const baselineCount = baseline.length;

    await createExtension(makeExtensionData({ enabled: true, name: "enabled-ext" }));
    await createExtension(makeExtensionData({ enabled: false, name: "disabled-ext" }));

    const enabledOnly = await listExtensions(true);
    expect(enabledOnly).toHaveLength(baselineCount + 1);
    expect(enabledOnly.some((e) => e.name === "enabled-ext")).toBe(true);
    expect(enabledOnly.some((e) => e.name === "disabled-ext")).toBe(false);
    expect(enabledOnly.every((e) => e.enabled)).toBe(true);
  });

  test("listExtensions() returns both enabled and disabled", async () => {
    const baseline = await listExtensions();
    const baselineCount = baseline.length;

    await createExtension(makeExtensionData({ enabled: true, name: "ext-a" }));
    await createExtension(makeExtensionData({ enabled: false, name: "ext-b" }));

    const all = await listExtensions();
    expect(all).toHaveLength(baselineCount + 2);
    const names = all.map((e) => e.name);
    expect(names).toContain("ext-a");
    expect(names).toContain("ext-b");
  });
});

// ── 2. Security Violation Tracking ───────────────────────────────────

describe("security violation tracking", () => {
  test("denyAndDisable disables extension and returns SecurityViolation", async () => {
    const ext = await createExtension(makeExtensionData({ enabled: true, name: "sec-ext" }));
    expect(ext.enabled).toBe(true);

    const before = Date.now();
    const violation: SecurityViolation = await denyAndDisable(
      ext.id,
      "unauthorized network access",
      "/api/secret",
    );
    const after = Date.now();

    // Verify violation structure
    expect(violation.extensionId).toBe(ext.id);
    expect(violation.reason).toBe("unauthorized network access");
    expect(violation.path).toBe("/api/secret");
    expect(violation.timestamp).toBeGreaterThanOrEqual(before);
    expect(violation.timestamp).toBeLessThanOrEqual(after);

    // Verify extension is disabled in DB
    const updated = await getExtension(ext.id);
    expect(updated).not.toBeNull();
    expect(updated!.enabled).toBe(false);
  });
});

// ── 3. Failure Threshold Auto-Disable ────────────────────────────────

describe("failure threshold tracking", () => {
  test("incrementFailures increments count and returns new value", async () => {
    const ext = await createExtension(
      makeExtensionData({ consecutiveFailures: 2, name: "fail-ext" }),
    );
    expect(ext.consecutiveFailures).toBe(2);

    const newCount = await incrementFailures(ext.id);
    expect(newCount).toBe(3);

    // Verify in DB
    const updated = await getExtension(ext.id);
    expect(updated!.consecutiveFailures).toBe(3);
  });
});

// ── 4. Failure Reset on Success ──────────────────────────────────────

describe("failure reset on success", () => {
  test("resetFailures sets count to 0", async () => {
    const ext = await createExtension(
      makeExtensionData({ consecutiveFailures: 3, name: "reset-ext" }),
    );
    expect(ext.consecutiveFailures).toBe(3);

    await resetFailures(ext.id);

    const updated = await getExtension(ext.id);
    expect(updated!.consecutiveFailures).toBe(0);
  });
});

// ── 5. Extension Deletion Cleanup ────────────────────────────────────

describe("extension deletion cleanup", () => {
  test("deleteExtension removes record and getExtension returns null", async () => {
    const ext = await createExtension(makeExtensionData({ name: "delete-ext" }));
    expect(await getExtension(ext.id)).not.toBeNull();

    const deleted = await deleteExtension(ext.id);
    expect(deleted).toBe(true);

    const gone = await getExtension(ext.id);
    expect(gone).toBeNull();
  });
});

// ── 6. Permission Diff Calculation ───────────────────────────────────

describe("permission diff calculation", () => {
  test("diffPermissions returns ungranted permissions", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com"],
      shell: true,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      shell: false,
      grantedAt: {},
    };

    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com"]);
    expect(diff.shell).toBe(true);
  });

  test("diffPermissions with empty requested returns empty diff", () => {
    const requested: ExtensionPermissions = { grantedAt: {} };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      shell: true,
      grantedAt: {},
    };

    const diff = diffPermissions(requested, granted);
    expect(diff.network).toBeUndefined();
    expect(diff.shell).toBeUndefined();
    expect(diff.filesystem).toBeUndefined();
    expect(diff.env).toBeUndefined();
  });

  test("diffPermissions with all already granted returns empty diff", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com"],
      shell: true,
      filesystem: ["/home"],
      env: ["API_KEY"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      shell: true,
      filesystem: ["/home"],
      env: ["API_KEY"],
      grantedAt: {},
    };

    const diff = diffPermissions(requested, granted);
    expect(diff.network).toBeUndefined();
    expect(diff.shell).toBeUndefined();
    expect(diff.filesystem).toBeUndefined();
    expect(diff.env).toBeUndefined();
  });
});

// ── 7. Required Permissions Extraction ───────────────────────────────

describe("required permissions extraction", () => {
  test("getRequiredPermissions returns all permission items", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "perm-ext",
      version: "1.0.0",
      description: "Perms test",
      author: { name: "Tester" },
      permissions: {
        network: ["api.example.com"],
        filesystem: ["/data"],
        shell: true,
        env: ["SECRET_KEY"],
      },
    };

    const items = getRequiredPermissions(manifest);

    expect(items).toHaveLength(4);

    const network = items.find((i) => i.type === "network");
    expect(network).toBeDefined();
    expect(network!.value).toBe("api.example.com");
    expect(network!.description).toContain("api.example.com");

    const fs = items.find((i) => i.type === "filesystem");
    expect(fs).toBeDefined();
    expect(fs!.value).toBe("/data");
    expect(fs!.description).toContain("/data");

    const shell = items.find((i) => i.type === "shell");
    expect(shell).toBeDefined();
    expect(shell!.value).toBe(true);
    expect(shell!.description).toContain("shell");

    const env = items.find((i) => i.type === "env");
    expect(env).toBeDefined();
    expect(env!.value).toBe("SECRET_KEY");
    expect(env!.description).toContain("SECRET_KEY");
  });
});

// ── 8. Sensitive Operation Detection ─────────────────────────────────

describe("sensitive operation detection", () => {
  test("shell is a sensitive operation", () => {
    expect(isSensitiveOperation("shell")).toBe(true);
  });

  test("filesystem is a sensitive operation", () => {
    expect(isSensitiveOperation("filesystem")).toBe(true);
  });
});

// ── 9. Checksum Integrity Verification ───────────────────────────────

describe("checksum integrity verification", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "ext-checksum-lifecycle-"));
  });

  test("detects modified file", async () => {
    await Bun.write(join(tempDir, "index.ts"), "original content");
    await Bun.write(join(tempDir, "utils.ts"), "helper code");

    const checksums = await computePackageChecksums(tempDir);
    expect(Object.keys(checksums)).toHaveLength(2);

    // Modify a file
    await Bun.write(join(tempDir, "index.ts"), "TAMPERED content");

    const result = await verifyPackageChecksums(tempDir, checksums);
    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("index.ts");
  });

  test("detects added file", async () => {
    await Bun.write(join(tempDir, "index.ts"), "original content");

    const checksums = await computePackageChecksums(tempDir);

    // Add a new file
    await Bun.write(join(tempDir, "backdoor.ts"), "malicious code");

    const result = await verifyPackageChecksums(tempDir, checksums);
    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("backdoor.ts");
  });

  test("detects removed file", async () => {
    await Bun.write(join(tempDir, "index.ts"), "content");
    await Bun.write(join(tempDir, "utils.ts"), "helper");

    const checksums = await computePackageChecksums(tempDir);

    // Remove a file
    await rm(join(tempDir, "utils.ts"));

    const result = await verifyPackageChecksums(tempDir, checksums);
    expect(result.valid).toBe(false);
    expect(result.mismatched).toContain("utils.ts");
  });

  test("passes when nothing changed", async () => {
    await Bun.write(join(tempDir, "index.ts"), "stable content");

    const checksums = await computePackageChecksums(tempDir);
    const result = await verifyPackageChecksums(tempDir, checksums);
    expect(result.valid).toBe(true);
    expect(result.mismatched).toHaveLength(0);
  });
});

// ── 10. Edge Cases ───────────────────────────────────────────────────

describe("permission check edge cases", () => {
  test("no network permissions → returns false", () => {
    const result = checkPermission("network", "evil.com", { grantedAt: {} });
    expect(result).toBe(false);
  });

  test("filesystem path outside granted prefix → returns false", () => {
    const result = checkPermission("filesystem", "/etc/passwd", {
      grantedAt: {},
      filesystem: ["/home"],
    });
    expect(result).toBe(false);
  });

  test("shell not granted → returns false", () => {
    const result = checkPermission("shell", true, {
      grantedAt: {},
      shell: false,
    });
    expect(result).toBe(false);
  });

  test("env variable not in granted list → returns false", () => {
    const result = checkPermission("env", "SECRET_KEY", {
      grantedAt: {},
      env: ["PUBLIC_KEY"],
    });
    expect(result).toBe(false);
  });

  test("network permission granted → returns true", () => {
    const result = checkPermission("network", "api.example.com", {
      grantedAt: {},
      network: ["api.example.com"],
    });
    expect(result).toBe(true);
  });

  test("filesystem path within granted prefix → returns true", () => {
    const result = checkPermission("filesystem", "/home/user/file.txt", {
      grantedAt: {},
      filesystem: ["/home"],
    });
    expect(result).toBe(true);
  });

  test("shell granted → returns true", () => {
    const result = checkPermission("shell", true, {
      grantedAt: {},
      shell: true,
    });
    expect(result).toBe(true);
  });

  test("env variable in granted list → returns true", () => {
    const result = checkPermission("env", "PUBLIC_KEY", {
      grantedAt: {},
      env: ["PUBLIC_KEY"],
    });
    expect(result).toBe(true);
  });
});
