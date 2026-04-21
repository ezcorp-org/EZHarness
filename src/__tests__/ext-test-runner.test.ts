import { test, describe, expect, beforeEach, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { ToolCallResult } from "../extensions/types";

// ── Mocks ────────────────────────────────────────────────────────────

mock.module("../../src/db/connection", () => ({
  initDb: async () => {},
  getDb: () => ({}),
}));

let lastSpawnArgs: string[] = [];
let lastSpawnOpts: Record<string, unknown> = {};
let mockSpawnExitCode = 0;

// We can't easily mock Bun.spawn globally, so we test the args-building
// and env-filtering functions directly.

mock.module("../../src/extensions/registry", () => ({
  buildAllowedEnv: (manifest: unknown, perms: unknown, id: string) => ({
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: process.env.HOME ?? "/home/test",
    NODE_ENV: "test",
    TMPDIR: `/tmp/pi-ext/${id}`,
  }),
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
      killAll: () => {},
    }),
  },
}));

mock.module("../../src/extensions/manifest", () => ({
  validateManifestV2: () => ({ valid: true, errors: [] }),
}));

afterAll(() => restoreModuleMocks());

import {
  buildTestSpawnArgs,
  buildTestEnv,
  type TestRunnerOptions,
} from "../../src/extensions/sdk/test-runner";
import {
  createTestExtension,
  callTool,
  assertToolResult,
} from "../../src/extensions/sdk/test-helpers";
import { parseArgs } from "../../src/cli";

const TEST_MANIFEST = {
  schemaVersion: 2,
  name: "test-ext",
  version: "1.0.0",
  description: "Test extension",
  author: { name: "Test" },
  entrypoint: "./index.ts",
  permissions: {},
  resources: { memory: "256MB" },
  tools: [{ name: "hello", description: "Say hello", inputSchema: { type: "object" } }],
};

describe("ezcorp ext test", () => {
  test("parseArgs routes 'ext test' to ext:test command", () => {
    const result = parseArgs(["ext", "test"]);
    expect(result.command).toBe("ext:test");
  });

  test("parseArgs passes --filter to ext:test", () => {
    const result = parseArgs(["ext", "test", "--filter", "my-test"]);
    expect(result.command).toBe("ext:test");
    expect(result.filter).toBe("my-test");
  });

  test("buildTestSpawnArgs includes prlimit and bun test", () => {
    const args = buildTestSpawnArgs();
    expect(args[0]).toBe("prlimit");
    expect(args).toContain("bun");
    expect(args).toContain("test");
  });

  test("buildTestSpawnArgs adds --filter when specified", () => {
    const args = buildTestSpawnArgs({ filter: "my-test" });
    expect(args).toContain("--filter");
    expect(args).toContain("my-test");
  });

  test("buildTestSpawnArgs adds --timeout when specified", () => {
    const args = buildTestSpawnArgs({ timeout: 10000 });
    expect(args).toContain("--timeout");
    expect(args).toContain("10000");
  });

  test("buildTestSpawnArgs uses default memory limit", () => {
    const args = buildTestSpawnArgs();
    // Should contain prlimit --rss= with a memory value
    const prlimitArg = args.find((a: string) => a.startsWith("--rss="));
    expect(prlimitArg).toBeDefined();
    // Default is 512MB = 536870912 bytes
    const bytes = parseInt(prlimitArg!.replace("--rss=", ""), 10);
    expect(bytes).toBeGreaterThanOrEqual(128 * 1024 * 1024); // at least 128MB
  });

  test("buildTestEnv includes PATH, HOME, TMPDIR and NODE_ENV=test", () => {
    const env = buildTestEnv();
    expect(env.PATH).toBeDefined();
    expect(env.HOME).toBeDefined();
    expect(env.TMPDIR).toBeDefined();
    expect(env.NODE_ENV).toBe("test");
    expect(env.BUN_ENV).toBe("test");
  });

  test("buildTestEnv excludes random env vars", () => {
    // Save and set a random var
    const prevVal = process.env.RANDOM_SECRET;
    process.env.RANDOM_SECRET = "should-not-appear";
    try {
      const env = buildTestEnv();
      expect(env.RANDOM_SECRET).toBeUndefined();
    } finally {
      if (prevVal === undefined) delete process.env.RANDOM_SECRET;
      else process.env.RANDOM_SECRET = prevVal;
    }
  });
});

describe("SDK test helpers", () => {
  test("assertToolResult passes when result matches expected", () => {
    const result: ToolCallResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    };
    // Should not throw
    assertToolResult(result, { text: "hello", isError: false });
  });

  test("assertToolResult throws on isError mismatch", () => {
    const result: ToolCallResult = {
      content: [{ type: "text", text: "hello" }],
      isError: false,
    };
    expect(() => assertToolResult(result, { isError: true })).toThrow();
  });

  test("assertToolResult throws on text mismatch", () => {
    const result: ToolCallResult = {
      content: [{ type: "text", text: "goodbye" }],
      isError: false,
    };
    expect(() => assertToolResult(result, { text: "hello" })).toThrow();
  });

  test("assertToolResult passes when only checking text", () => {
    const result: ToolCallResult = {
      content: [{ type: "text", text: "hello world" }],
      isError: false,
    };
    assertToolResult(result, { text: "hello" });
  });

  test("callTool delegates to proc.callTool", async () => {
    const mockResult: ToolCallResult = {
      content: [{ type: "text", text: "result" }],
      isError: false,
    };
    const mockProc = {
      callTool: async (name: string, args: Record<string, unknown>) => {
        expect(name).toBe("hello");
        expect(args).toEqual({ input: "test" });
        return mockResult;
      },
    };

    const result = await callTool(mockProc as any, "hello", { input: "test" });
    expect(result).toEqual(mockResult);
  });
});
