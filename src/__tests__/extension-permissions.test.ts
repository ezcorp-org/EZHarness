import { test, expect, describe, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  checkPermission,
  getRequiredPermissions,
  diffPermissions,
  isSensitiveOperation,
  checkSensitiveConfirmation,
  setSensitiveAlwaysAllow,
} from "../extensions/permissions";
import type { ExtensionPermissions, ExtensionManifestV2 } from "../extensions/types";

// Mock settings store for sensitive confirmation tests
const mockSettings = new Map<string, unknown>();
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings.get(key),
  upsertSetting: async (key: string, value: unknown) => { mockSettings.set(key, value); },
  getAllSettings: async () => Object.fromEntries(mockSettings),
  deleteSetting: async (key: string) => mockSettings.delete(key),
  isListingInstalled: async () => false,
}));

afterAll(() => restoreModuleMocks());

describe("checkPermission", () => {
  const granted: ExtensionPermissions = {
    network: ["api.weather.com", "api.github.com"],
    filesystem: ["/home/user/docs", "/tmp"],
    shell: true,
    env: ["API_KEY", "HOME"],
    grantedAt: {},
  };

  test("allows network access for granted domain", () => {
    expect(checkPermission("network", "api.weather.com", granted)).toBe(true);
  });

  test("denies network access for non-granted domain", () => {
    expect(checkPermission("network", "evil.com", granted)).toBe(false);
  });

  test("allows filesystem access for path within granted prefix", () => {
    expect(checkPermission("filesystem", "/home/user/docs/file.txt", granted)).toBe(true);
  });

  test("denies filesystem access for path outside granted prefix", () => {
    expect(checkPermission("filesystem", "/etc/passwd", granted)).toBe(false);
  });

  test("allows shell when shell is granted", () => {
    expect(checkPermission("shell", true, granted)).toBe(true);
  });

  test("denies shell when shell is not granted", () => {
    const noShell: ExtensionPermissions = { ...granted, shell: false };
    expect(checkPermission("shell", true, noShell)).toBe(false);
  });

  test("allows env access for granted variable", () => {
    expect(checkPermission("env", "API_KEY", granted)).toBe(true);
  });

  test("denies env access for non-granted variable", () => {
    expect(checkPermission("env", "SECRET_TOKEN", granted)).toBe(false);
  });

  test("denies network when no network permissions granted", () => {
    const noNet: ExtensionPermissions = { grantedAt: {} };
    expect(checkPermission("network", "api.weather.com", noNet)).toBe(false);
  });
});

describe("getRequiredPermissions", () => {
  test("extracts flat permission list from manifest", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "Test",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {
        network: ["api.example.com"],
        shell: true,
        filesystem: ["/tmp"],
        env: ["MY_KEY"],
      },
    };

    const perms = getRequiredPermissions(manifest);
    expect(perms.length).toBe(4);
    expect(perms.some((p) => p.type === "network" && p.value === "api.example.com")).toBe(true);
    expect(perms.some((p) => p.type === "shell" && p.value === true)).toBe(true);
    expect(perms.some((p) => p.type === "filesystem" && p.value === "/tmp")).toBe(true);
    expect(perms.some((p) => p.type === "env" && p.value === "MY_KEY")).toBe(true);
  });

  test("returns empty list for no permissions", () => {
    const manifest: ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "Test",
      author: { name: "Test" },
      entrypoint: "index.ts",
      tools: [],
      permissions: {},
    };
    expect(getRequiredPermissions(manifest)).toEqual([]);
  });
});

describe("diffPermissions", () => {
  test("returns permissions requested but not granted", () => {
    const requested: ExtensionPermissions = {
      network: ["api.example.com", "api.other.com"],
      shell: true,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["api.example.com"],
      grantedAt: {},
    };

    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["api.other.com"]);
    expect(diff.shell).toBe(true);
  });

  test("returns empty when all granted", () => {
    const perms: ExtensionPermissions = {
      network: ["a.com"],
      shell: true,
      grantedAt: {},
    };
    const diff = diffPermissions(perms, perms);
    expect(diff.network).toBeUndefined();
    expect(diff.shell).toBeUndefined();
  });
});

describe("isSensitiveOperation", () => {
  test("shell is always sensitive", () => {
    expect(isSensitiveOperation("shell")).toBe(true);
  });

  test("filesystem is always sensitive", () => {
    expect(isSensitiveOperation("filesystem")).toBe(true);
  });
});

describe("checkSensitiveConfirmation", () => {
  beforeEach(() => {
    mockSettings.clear();
  });

  test("returns needs_confirmation when no always-allow set", async () => {
    const result = await checkSensitiveConfirmation("ext-1", "shell");
    expect(result).toBe("needs_confirmation");
  });

  test("returns allowed after always-allow is set", async () => {
    await setSensitiveAlwaysAllow("ext-1", "shell", true);
    const result = await checkSensitiveConfirmation("ext-1", "shell");
    expect(result).toBe("allowed");
  });

  test("returns needs_confirmation after always-allow is revoked", async () => {
    await setSensitiveAlwaysAllow("ext-1", "filesystem", true);
    await setSensitiveAlwaysAllow("ext-1", "filesystem", false);
    const result = await checkSensitiveConfirmation("ext-1", "filesystem");
    expect(result).toBe("needs_confirmation");
  });

  test("always-allow is per extension", async () => {
    await setSensitiveAlwaysAllow("ext-1", "shell", true);
    const result = await checkSensitiveConfirmation("ext-2", "shell");
    expect(result).toBe("needs_confirmation");
  });
});
