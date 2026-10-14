import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB, } from "../extensions/subprocess";

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
    const { HostExtensionProcess } = await import("./helpers/host-extension-process");

    const proc = new HostExtensionProcess("reset-test", "/path/to/ext.ts", { PATH: "/usr/bin" }, {
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
