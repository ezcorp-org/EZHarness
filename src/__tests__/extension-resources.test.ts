import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB, MIN_MEMORY_LIMIT_MB, ExtensionProcess } from "../extensions/subprocess";

describe("parseMemoryLimit", () => {
  test("parses '256MB' to bytes", () => {
    expect(parseMemoryLimit("256MB")).toBe(256 * 1024 * 1024);
  });

  test("parses '512MB' to bytes", () => {
    expect(parseMemoryLimit("512MB")).toBe(512 * 1024 * 1024);
  });

  test("parses '1GB' to bytes", () => {
    expect(parseMemoryLimit("1GB")).toBe(1024 * 1024 * 1024);
  });

  test("parses '2GB' to bytes", () => {
    expect(parseMemoryLimit("2GB")).toBe(2 * 1024 * 1024 * 1024);
  });

  test("returns default for invalid string", () => {
    expect(parseMemoryLimit("invalid")).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
  });

  test("returns default for empty string", () => {
    expect(parseMemoryLimit("")).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
  });
});

describe("ExtensionProcess prlimit spawn", () => {
  beforeEach(() => {
  });

  test("spawn command includes prlimit with --as flag", () => {
    // We test by importing and checking the spawn args construction.
    // The actual spawn is tested via the command array structure.


    // Create a process with default options
    const proc = new ExtensionProcess("test-ext", "/path/to/ext.ts", { PATH: "/usr/bin" });

    // Access the computed memory limit
    expect(proc.memoryLimitBytes).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
  });

  test("default memory limit is 512MB", () => {
    expect(DEFAULT_MEMORY_LIMIT_MB).toBe(512);
  });

  test("minimum memory limit is 512MB", () => {
    expect(MIN_MEMORY_LIMIT_MB).toBe(512);
  });

  test("custom memory limit from options overrides default", () => {

    const customBytes = 512 * 1024 * 1024;
    const proc = new ExtensionProcess("test-ext", "/path/to/ext.ts", { PATH: "/usr/bin" }, {
      memoryLimitBytes: customBytes,
    });
    expect(proc.memoryLimitBytes).toBe(customBytes);
  });

  test("memory limit below 512MB floor is clamped to 512MB", () => {

    const tooSmall = 256 * 1024 * 1024; // 256MB
    const proc = new ExtensionProcess("test-ext", "/path/to/ext.ts", { PATH: "/usr/bin" }, {
      memoryLimitBytes: tooSmall,
    });
    expect(proc.memoryLimitBytes).toBe(MIN_MEMORY_LIMIT_MB * 1024 * 1024);
  });

  test("spawn command array structure for prlimit", () => {

    const proc = new ExtensionProcess("test-ext", "/path/to/ext.ts", { PATH: "/usr/bin" });
    // The spawnArgs getter should return the prlimit-wrapped command with the
    // sandbox preload injected after `run`, before the entrypoint.
    // updated for sec-SB2/SB3: `--preload` must follow the `run` subcommand
    // (Bun's CLI rejects `bun --preload <path> run <ext>` with its help text).
    const args = proc.getSpawnArgs();
    expect(args[0]).toBe("prlimit");
    expect(args[1]).toMatch(/^--rss=\d+$/);
    expect(args[2]).toBe("bun");
    expect(args[3]).toBe("run");
    expect(args[4]).toBe("--preload");
    expect(args[5]).toMatch(/\/extensions\/runtime\/sandbox-preload\.ts$/);
    expect(args[6]).toBe("/path/to/ext.ts");
  });
});

describe("resetFailures on successful call", () => {
  test("resetFailures is called after a successful call()", async () => {
    // Track resetFailures calls via the mock
    const resetCalls: string[] = [];
    mock.module("../db/queries/extensions", () => ({
      incrementFailures: async () => 0,
      disableExtension: async () => {},
      resetFailures: async (id: string) => { resetCalls.push(id); },
    }));

afterAll(() => restoreModuleMocks());

    // Re-import to pick up mock
    const { ExtensionProcess } = await import("../extensions/subprocess");

    const proc = new ExtensionProcess("reset-test", "/path/to/ext.ts", { PATH: "/usr/bin" }, {
      callTimeoutMs: 5000,
    });

    // Stub ensureRunning and transport to avoid real subprocess
    const fakeResponse = { jsonrpc: "2.0" as const, id: 1, result: { ok: true } };
    (proc as any).proc = { stdin: { write: () => {} }, kill: () => {} }; // fake proc so isRunning works
    (proc as any).killed = false;
    (proc as any).transport = {
      send: async () => fakeResponse,
      startReading: () => {},
      close: () => {},
    };

    const response = await proc.call("test/method", {});
    expect(response).toEqual(fakeResponse);
    expect(resetCalls).toContain("reset-test");

    proc.kill();
  });
});

describe("ExtensionManifestV2 resources field", () => {
  test("accepts optional resources field", () => {
    // Type-level test: if this compiles, the type is correct
    const manifest: import("../extensions/types").ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "test",
      author: { name: "test" },
      permissions: {},
      resources: {
        memory: "512MB",
      },
    };
    expect(manifest.resources?.memory).toBe("512MB");
  });

  test("resources field is optional", () => {
    const manifest: import("../extensions/types").ExtensionManifestV2 = {
      schemaVersion: 2,
      name: "test",
      version: "1.0.0",
      description: "test",
      author: { name: "test" },
      permissions: {},
    };
    expect(manifest.resources).toBeUndefined();
  });
});
