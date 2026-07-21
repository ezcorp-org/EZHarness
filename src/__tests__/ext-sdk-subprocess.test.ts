/**
 * Tests for SDK utility modules and subprocess helpers.
 *
 * Covers:
 *   - src/extensions/sdk/config.ts        (readConfig, writeConfig, getPublishToken)
 *   - src/extensions/sdk/test-runner.ts    (buildTestSpawnArgs, buildTestEnv)
 *   - src/extensions/subprocess.ts         (parseMemoryLimit, ExtensionProcess statics)
 *   - src/extensions/sdk/test-helpers.ts   (assertToolResult)
 *   - src/extensions/checksum.ts           (computeChecksum, verifyChecksum)
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, writeFile, stat, } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { existsSync } from "fs";

// ────────────────────────────────────────────────────────────────
// Module 1: sdk/config.ts
// ────────────────────────────────────────────────────────────────

import { readConfig, writeConfig, getPublishToken } from "../extensions/sdk/config";

describe("sdk/config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pi-config-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("readConfig", () => {
    test("returns empty object when config file does not exist", async () => {
      const config = await readConfig(tempDir);
      expect(config).toEqual({});
    });

    test("reads existing config file", async () => {
      const configPath = join(tempDir, "config.json");
      await writeFile(configPath, JSON.stringify({ publishToken: "tok_abc" }));

      const config = await readConfig(tempDir);
      expect(config).toEqual({ publishToken: "tok_abc" });
    });
  });

  describe("writeConfig", () => {
    test("writes config and readConfig round-trips", async () => {
      const data = { publishToken: "tok_xyz", custom: "value" };
      await writeConfig(data, tempDir);

      const result = await readConfig(tempDir);
      expect(result).toEqual(data);
    });

    test("creates directory if it does not exist", async () => {
      const nested = join(tempDir, "nested", "dir");
      await writeConfig({ publishToken: "tok_new" }, nested);

      expect(existsSync(join(nested, "config.json"))).toBe(true);
      const result = await readConfig(nested);
      expect(result.publishToken).toBe("tok_new");
    });

    test("sets 0600 permissions on config file", async () => {
      await writeConfig({ publishToken: "secret" }, tempDir);

      const s = await stat(join(tempDir, "config.json"));
      // 0600 = 0o600 = 384 decimal; mask to file-permission bits
      expect(s.mode & 0o777).toBe(0o600);
    });
  });

  describe("getPublishToken", () => {
    test("prefers flag token over config", async () => {
      await writeConfig({ publishToken: "from_config" }, tempDir);
      const token = await getPublishToken("from_flag", tempDir);
      expect(token).toBe("from_flag");
    });

    test("reads from config when no flag provided", async () => {
      await writeConfig({ publishToken: "from_config" }, tempDir);
      const token = await getPublishToken(undefined, tempDir);
      expect(token).toBe("from_config");
    });

    test("returns null when neither flag nor config token exists", async () => {
      const token = await getPublishToken(undefined, tempDir);
      expect(token).toBeNull();
    });

    test("returns null when config has no publishToken key", async () => {
      await writeConfig({ other: "stuff" } as any, tempDir);
      const token = await getPublishToken(undefined, tempDir);
      expect(token).toBeNull();
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Module 2: sdk/test-runner.ts
// ────────────────────────────────────────────────────────────────

import { buildTestSpawnArgs, buildTestEnv } from "../extensions/sdk/test-runner";
import { DEFAULT_MEMORY_LIMIT_MB } from "../extensions/subprocess";

describe("sdk/test-runner", () => {
  describe("buildTestSpawnArgs", () => {
    test("returns defaults with no options", () => {
      const args = buildTestSpawnArgs();
      const expectedBytes = DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;
      expect(args).toEqual(["prlimit", `--rss=${expectedBytes}`, "bun", "test"]);
    });

    test("includes --filter when filter is provided", () => {
      const args = buildTestSpawnArgs({ filter: "my-test" });
      expect(args).toContain("--filter");
      expect(args).toContain("my-test");
    });

    test("includes --timeout when timeout is provided", () => {
      const args = buildTestSpawnArgs({ timeout: 5000 });
      expect(args).toContain("--timeout");
      expect(args).toContain("5000");
    });

    test("uses custom memoryLimit", () => {
      const args = buildTestSpawnArgs({ memoryLimit: "1GB" });
      const expectedBytes = 1 * 1024 * 1024 * 1024;
      expect(args[1]).toBe(`--rss=${expectedBytes}`);
    });

    test("includes both filter and timeout together", () => {
      const args = buildTestSpawnArgs({ filter: "foo", timeout: 10000 });
      expect(args).toEqual([
        "prlimit",
        `--rss=${DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024}`,
        "bun",
        "test",
        "--filter",
        "foo",
        "--timeout",
        "10000",
      ]);
    });
  });

  describe("buildTestEnv", () => {
    test("returns exactly 5 keys", () => {
      const env = buildTestEnv("test-ext");
      expect(Object.keys(env).sort()).toEqual(
        ["BUN_ENV", "HOME", "NODE_ENV", "PATH", "TMPDIR"].sort(),
      );
    });

    test("NODE_ENV and BUN_ENV are 'test'", () => {
      const env = buildTestEnv();
      expect(env.NODE_ENV).toBe("test");
      expect(env.BUN_ENV).toBe("test");
    });

    test("creates TMPDIR directory", () => {
      const env = buildTestEnv("tmpdir-check");
      expect(existsSync(env.TMPDIR as string)).toBe(true);
    });

    test("uses 'default' extension id when none provided", () => {
      const env = buildTestEnv();
      expect(env.TMPDIR).toContain("default");
    });

    test("uses provided extension id in TMPDIR path", () => {
      const env = buildTestEnv("my-ext-123");
      expect(env.TMPDIR).toContain("my-ext-123");
    });

    test("PATH and HOME come from process.env", () => {
      const env = buildTestEnv();
      expect(env.PATH).toBe(process.env.PATH ?? "");
      expect(env.HOME).toBe(process.env.HOME ?? "");
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Module 3: subprocess.ts (parseMemoryLimit, ExtensionProcess statics)
// ────────────────────────────────────────────────────────────────

import {
  parseMemoryLimit,
  MIN_MEMORY_LIMIT_MB,
  ExtensionProcess,
  killActiveExtensionProcesses,
  _addActiveProcessForTest,
} from "../extensions/subprocess";

describe("subprocess", () => {
  describe("parseMemoryLimit", () => {
    test("parses MB value", () => {
      expect(parseMemoryLimit("256MB")).toBe(256 * 1024 * 1024);
    });

    test("parses GB value", () => {
      expect(parseMemoryLimit("1GB")).toBe(1 * 1024 * 1024 * 1024);
    });

    test("is case insensitive", () => {
      expect(parseMemoryLimit("256mb")).toBe(256 * 1024 * 1024);
      expect(parseMemoryLimit("2gb")).toBe(2 * 1024 * 1024 * 1024);
      expect(parseMemoryLimit("512Mb")).toBe(512 * 1024 * 1024);
    });

    test("returns default for invalid string", () => {
      const defaultBytes = DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;
      expect(parseMemoryLimit("invalid")).toBe(defaultBytes);
      expect(parseMemoryLimit("")).toBe(defaultBytes);
      expect(parseMemoryLimit("256")).toBe(defaultBytes);
      expect(parseMemoryLimit("256KB")).toBe(defaultBytes);
      expect(parseMemoryLimit("MB256")).toBe(defaultBytes);
    });
  });

  describe("ExtensionProcess.getSpawnArgs", () => {
    test("returns prlimit + bun run --preload + extension path", () => {
      // updated for sec-SB2/SB3: --preload MUST come AFTER the `run`
      // subcommand — `bun --preload <path> run <ext>` is rejected by Bun's
      // CLI parser (prints `bun run` help and exits immediately).
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {});
      const args = ep.getSpawnArgs();
      const expectedBytes = DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;
      expect(args[0]).toBe("prlimit");
      expect(args[1]).toBe(`--rss=${expectedBytes}`);
      expect(args[2]).toBe("bun");
      expect(args[3]).toBe("run");
      expect(args[4]).toBe("--preload");
      // Absolute path to the sandbox preload script — resolved at module load.
      expect(args[5]).toMatch(/\/extensions\/runtime\/sandbox-preload\.ts$/);
      expect(args[6]).toBe("/path/to/ext.ts");
    });

    test("uses custom memoryLimitBytes", () => {
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {}, {
        memoryLimitBytes: 1024 * 1024 * 1024,
      });
      const args = ep.getSpawnArgs();
      expect(args[1]).toBe(`--rss=${1024 * 1024 * 1024}`);
    });
  });

  describe("ExtensionProcess.memoryLimitBytes", () => {
    test("enforces MIN_MEMORY_LIMIT_MB floor", () => {
      const tooSmall = 64 * 1024 * 1024; // 64MB, below 512MB floor
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {}, {
        memoryLimitBytes: tooSmall,
      });
      expect(ep.memoryLimitBytes).toBe(MIN_MEMORY_LIMIT_MB * 1024 * 1024);
    });

    test("allows value above the floor", () => {
      const bigLimit = 2 * 1024 * 1024 * 1024; // 2GB
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {}, {
        memoryLimitBytes: bigLimit,
      });
      expect(ep.memoryLimitBytes).toBe(bigLimit);
    });

    test("uses default when no option provided", () => {
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {});
      expect(ep.memoryLimitBytes).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
    });
  });

  describe("ExtensionProcess.isRunning", () => {
    test("is false before ensureRunning", () => {
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {});
      expect(ep.isRunning).toBe(false);
    });

    test("is false after kill (without spawning)", () => {
      const ep = new ExtensionProcess("test-id", "/path/to/ext.ts", {});
      ep.kill();
      expect(ep.isRunning).toBe(false);
    });
  });

  describe("killActiveExtensionProcesses (process 'exit' cleanup)", () => {
    test("kills every process in the active set", () => {
      // The real handler is registered as process.on('exit', ...) — seed the
      // active set via the test-only helper and invoke the exported cleanup
      // directly so the kill-all contract is verified without a real exit.
      const killed: string[] = [];
      const a = { kill: () => killed.push("a") };
      const b = { kill: () => killed.push("b") };
      const removeA = _addActiveProcessForTest(a);
      const removeB = _addActiveProcessForTest(b);
      try {
        killActiveExtensionProcesses();
        expect(killed).toContain("a");
        expect(killed).toContain("b");
      } finally {
        removeA();
        removeB();
      }
    });

    test("is a no-op when no processes are active", () => {
      // Disposers above remove the seeded fakes; the set is empty again.
      expect(() => killActiveExtensionProcesses()).not.toThrow();
    });
  });
});

// ────────────────────────────────────────────────────────────────
// Module 4: sdk/test-helpers.ts (assertToolResult)
// ────────────────────────────────────────────────────────────────

import { assertToolResult } from "../extensions/sdk/test-helpers";
import type { ToolCallResult } from "../extensions/types";

describe("sdk/test-helpers assertToolResult", () => {
  const okResult: ToolCallResult = {
    content: [{ type: "text", text: "Hello world" }],
    isError: false,
  };

  const errorResult: ToolCallResult = {
    content: [{ type: "text", text: "Something went wrong" }],
    isError: true,
  };

  test("passes when isError matches and text found", () => {
    // Should not throw
    assertToolResult(okResult, { isError: false, text: "Hello" });
  });

  test("passes when only checking isError", () => {
    assertToolResult(okResult, { isError: false });
  });

  test("passes when only checking text", () => {
    assertToolResult(okResult, { text: "world" });
  });

  test("passes with no expected values (vacuously)", () => {
    assertToolResult(okResult, {});
  });

  test("throws on isError mismatch (expected false, got true)", () => {
    expect(() => assertToolResult(errorResult, { isError: false })).toThrow(
      "Expected isError=false, got isError=true",
    );
  });

  test("throws on isError mismatch (expected true, got false)", () => {
    expect(() => assertToolResult(okResult, { isError: true })).toThrow(
      "Expected isError=true, got isError=false",
    );
  });

  test("throws when expected text not found in content", () => {
    expect(() => assertToolResult(okResult, { text: "missing-text" })).toThrow(
      'Expected content to include "missing-text"',
    );
  });

  test("searches across multiple content items", () => {
    const multi: ToolCallResult = {
      content: [
        { type: "text", text: "first" },
        { type: "text", text: "second" },
      ],
      isError: false,
    };
    // Should not throw -- "second" is in the second content item
    assertToolResult(multi, { text: "second" });
  });
});

// ────────────────────────────────────────────────────────────────
// Module 5: checksum.ts (computeChecksum, verifyChecksum -- NOT tested in existing file)
// ────────────────────────────────────────────────────────────────

import { computeChecksum, verifyChecksum } from "../extensions/checksum";

describe("checksum (computeChecksum, verifyChecksum)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "checksum-unit-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("computeChecksum returns 64-char hex string", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "hello world");
    const hash = await computeChecksum(filePath);
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
  });

  test("computeChecksum is deterministic", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "deterministic content");
    const hash1 = await computeChecksum(filePath);
    const hash2 = await computeChecksum(filePath);
    expect(hash1).toBe(hash2);
  });

  test("computeChecksum produces different hashes for different content", async () => {
    const path1 = join(tempDir, "a.txt");
    const path2 = join(tempDir, "b.txt");
    await writeFile(path1, "content A");
    await writeFile(path2, "content B");
    const hash1 = await computeChecksum(path1);
    const hash2 = await computeChecksum(path2);
    expect(hash1).not.toBe(hash2);
  });

  test("verifyChecksum returns true when hash matches", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "verify me");
    const hash = await computeChecksum(filePath);
    expect(await verifyChecksum(filePath, hash)).toBe(true);
  });

  test("verifyChecksum returns false when hash does not match", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "verify me");
    expect(await verifyChecksum(filePath, "0".repeat(64))).toBe(false);
  });

  test("verifyChecksum detects file modification", async () => {
    const filePath = join(tempDir, "test.txt");
    await writeFile(filePath, "original");
    const hash = await computeChecksum(filePath);
    await writeFile(filePath, "modified");
    expect(await verifyChecksum(filePath, hash)).toBe(false);
  });
});
