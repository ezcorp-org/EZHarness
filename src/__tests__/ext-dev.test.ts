import { test, describe, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../../src/db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
}));

let mockInstallFromLocalCalls: unknown[][] = [];
let mockDeleteExtensionCalls: string[] = [];
let mockListExtensionsResult: unknown[] = [];
let mockReloadCalls = 0;
let mockKillAllCalls = 0;

mock.module("../../src/extensions/installer", () => ({
  installFromLocal: async (...args: unknown[]) => {
    mockInstallFromLocalCalls.push(args);
    return { id: "dev-ext-id", name: "test-ext", version: "1.0.0", source: `dev:local:${args[0]}` };
  },
}));

mock.module("../../src/db/queries/extensions", () => ({
  listExtensions: async () => mockListExtensionsResult,
  deleteExtension: async (id: string) => { mockDeleteExtensionCalls.push(id); return true; },
  createExtension: async (data: unknown) => ({ id: "dev-ext-id", ...(data as object) }),
}));

mock.module("../../src/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => { mockReloadCalls++; },
      killAll: () => { mockKillAllCalls++; },
      getProcess: async () => ({
        kill: () => {},
        ensureRunning: () => {},
        isRunning: true,
      }),
    }),
  },
  buildAllowedEnv: () => ({ PATH: "/usr/bin", HOME: "/home/test" }),
}));

mock.module("../../src/extensions/manifest", () => ({
  validateManifestV2: () => ({ valid: true, errors: [] }),
}));

afterAll(() => restoreModuleMocks());

import { startDevServer } from "../../src/extensions/sdk/dev";
import { parseArgs } from "../../src/cli";

const TEST_MANIFEST = {
  schemaVersion: 2,
  name: "test-ext",
  version: "1.0.0",
  description: "Test extension",
  author: { name: "Test" },
  entrypoint: "./index.ts",
  permissions: {},
  tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object" } }],
};

beforeEach(() => {
  mockInstallFromLocalCalls = [];
  mockDeleteExtensionCalls = [];
  mockListExtensionsResult = [];
  mockReloadCalls = 0;
  mockKillAllCalls = 0;
});

async function createTempExtDir(): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(`${tmpdir()}/ext-dev-test-`);
  await Bun.write(`${dir}/ezcorp.config.ts`, `export default ${JSON.stringify(TEST_MANIFEST, null, 2)};\n`);
  await Bun.write(`${dir}/index.ts`, 'console.log("hello");');
  return dir;
}

async function cleanup(dir: string): Promise<void> {
  const { rm } = await import("node:fs/promises");
  await rm(dir, { recursive: true, force: true }).catch(() => {});
}

describe("ezcorp ext dev", () => {
  test("parseArgs routes 'ext dev' to ext:dev command", () => {
    const result = parseArgs(["ext", "dev"]);
    expect(result.command).toBe("ext:dev");
  });

  test("parseArgs routes 'ext dev /some/path' to ext:dev with extDir", () => {
    const result = parseArgs(["ext", "dev", "/some/path"]);
    expect(result.command).toBe("ext:dev");
    expect(result.extDir).toBe("/some/path");
  });

  test("parseArgs routes 'ext test' to ext:test command", () => {
    const result = parseArgs(["ext", "test"]);
    expect(result.command).toBe("ext:test");
  });

  test("cleans up stale dev: entries on startup", async () => {
    const tmpDir = await createTempExtDir();
    try {
      mockListExtensionsResult = [
        { id: "stale-1", name: "old-dev", source: "dev:local:/old/path", enabled: true },
        { id: "prod-1", name: "real-ext", source: "git:https://example.com/ext", enabled: true },
        { id: "stale-2", name: "old-dev-2", source: "dev:local:/another/path", enabled: true },
      ];

      const controller = new AbortController();
      const promise = startDevServer({ extDir: tmpDir, _signal: controller.signal });
      await new Promise(r => setTimeout(r, 50));
      controller.abort();
      await promise.catch(() => {});

      expect(mockDeleteExtensionCalls).toContain("stale-1");
      expect(mockDeleteExtensionCalls).toContain("stale-2");
      expect(mockDeleteExtensionCalls).not.toContain("prod-1");
    } finally {
      await cleanup(tmpDir);
    }
  });

  test("registers extension on startup", async () => {
    const tmpDir = await createTempExtDir();
    try {
      const controller = new AbortController();
      const promise = startDevServer({ extDir: tmpDir, _signal: controller.signal });
      await new Promise(r => setTimeout(r, 50));
      controller.abort();
      await promise.catch(() => {});

      expect(mockInstallFromLocalCalls.length).toBeGreaterThanOrEqual(1);
      expect(mockInstallFromLocalCalls[0]![0]).toBe(tmpDir);
    } finally {
      await cleanup(tmpDir);
    }
  });

  test("file watcher triggers reload on source file change", async () => {
    const tmpDir = await createTempExtDir();
    try {
      const controller = new AbortController();
      const promise = startDevServer({ extDir: tmpDir, _signal: controller.signal });
      await new Promise(r => setTimeout(r, 100));

      await Bun.write(`${tmpDir}/index.ts`, 'console.log("changed");');
      await new Promise(r => setTimeout(r, 300));

      expect(mockReloadCalls).toBeGreaterThanOrEqual(1);

      controller.abort();
      await promise.catch(() => {});
    } finally {
      await cleanup(tmpDir);
    }
  });

  test("debounces rapid file changes within 100ms", async () => {
    const tmpDir = await createTempExtDir();
    try {
      const controller = new AbortController();
      const reloadsBefore = mockReloadCalls;
      const promise = startDevServer({ extDir: tmpDir, _signal: controller.signal });
      await new Promise(r => setTimeout(r, 100));

      for (let i = 0; i < 5; i++) {
        await Bun.write(`${tmpDir}/index.ts`, `console.log("change-${i}");`);
        await new Promise(r => setTimeout(r, 20));
      }
      await new Promise(r => setTimeout(r, 300));

      const reloadsTriggered = mockReloadCalls - reloadsBefore;
      expect(reloadsTriggered).toBeLessThan(5);
      expect(reloadsTriggered).toBeGreaterThanOrEqual(1);

      controller.abort();
      await promise.catch(() => {});
    } finally {
      await cleanup(tmpDir);
    }
  });

  test("ignores changes in node_modules and dotfiles", async () => {
    const tmpDir = await createTempExtDir();
    try {
      const { mkdirSync } = await import("node:fs");
      mkdirSync(`${tmpDir}/node_modules`, { recursive: true });
      mkdirSync(`${tmpDir}/.hidden`, { recursive: true });

      const controller = new AbortController();
      const reloadsBefore = mockReloadCalls;
      const promise = startDevServer({ extDir: tmpDir, _signal: controller.signal });
      await new Promise(r => setTimeout(r, 100));

      await Bun.write(`${tmpDir}/node_modules/foo.js`, "ignored");
      await Bun.write(`${tmpDir}/.hidden/bar.js`, "ignored");
      await new Promise(r => setTimeout(r, 300));

      const reloadsTriggered = mockReloadCalls - reloadsBefore;
      expect(reloadsTriggered).toBe(0);

      controller.abort();
      await promise.catch(() => {});
    } finally {
      await cleanup(tmpDir);
    }
  });
});
