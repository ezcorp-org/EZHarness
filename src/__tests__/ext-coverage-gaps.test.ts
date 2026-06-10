/**
 * Coverage gap tests for extension modules:
 *   - permissions.ts: checkFilesystemPermission (realpath-based)
 *   - permissions.ts: diffPermissions shell branch, alwaysAllowKey format
 *   - checksum.ts: computePackageChecksums (dotfile inclusion/exclusion edge cases)
 *   - subprocess.ts: ExtensionProcess constructor options, getSpawnArgs with custom limits
 *   - sdk/test-runner.ts: runExtensionTests (end-to-end with temp dir)
 *   - sdk/test-helpers.ts: createTestExtension, callTool wrapper
 */

import { test, expect, describe, beforeEach, afterEach, mock, afterAll } from "bun:test";
import { mkdtemp, rm, mkdir, writeFile, symlink } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// Mock DB modules before any imports that depend on them
const mockSettings = new Map<string, unknown>();
mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => mockSettings.get(key),
  upsertSetting: async (key: string, value: unknown) => { mockSettings.set(key, value); },
  getAllSettings: async () => Object.fromEntries(mockSettings),
  deleteSetting: async (key: string) => mockSettings.delete(key),
  isListingInstalled: async () => false,
}));

let failureCount = 0;
mock.module("../db/queries/extensions", () => ({
  incrementFailures: async () => ++failureCount,
  disableExtension: async () => {},
  resetFailures: async () => { failureCount = 0; },
  listExtensions: async () => [],
}));

afterAll(() => restoreModuleMocks());

import { checkFilesystemPermission, diffPermissions } from "../extensions/permissions";
import type { ExtensionPermissions } from "../extensions/types";
import { computePackageChecksums, verifyPackageChecksums } from "../extensions/checksum";
import { ExtensionProcess, DEFAULT_MEMORY_LIMIT_MB } from "../extensions/subprocess";
import { JsonRpcTransport } from "../extensions/json-rpc";
import { runExtensionTests } from "../extensions/sdk/test-runner";
import { createTestExtension, callTool } from "../extensions/sdk/test-helpers";

// ================================================================
// 1. checkFilesystemPermission (realpath-based, lines 49-94)
// ================================================================

describe("checkFilesystemPermission", () => {
  let tempDir: string;
  let installDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "fs-perm-test-"));
    installDir = join(tempDir, "extension");
    await mkdir(installDir, { recursive: true });
    await writeFile(join(installDir, "index.ts"), "// extension code");
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("allows path inside extension install dir", async () => {
    const filePath = join(installDir, "index.ts");
    const result = await checkFilesystemPermission(filePath, { grantedAt: {} }, installDir);
    expect(result.allowed).toBe(true);
    expect(result.resolvedPath).toBe(filePath);
  });

  test("allows exact match of install dir itself", async () => {
    const result = await checkFilesystemPermission(installDir, { grantedAt: {} }, installDir);
    expect(result.allowed).toBe(true);
  });

  test("denies path outside all granted prefixes", async () => {
    const outsidePath = join(tempDir, "outside.txt");
    await writeFile(outsidePath, "outside");
    const result = await checkFilesystemPermission(outsidePath, { grantedAt: {} }, installDir);
    expect(result.allowed).toBe(false);
  });

  test("denies non-existent path", async () => {
    const fakePath = join(tempDir, "does-not-exist.txt");
    const result = await checkFilesystemPermission(fakePath, { grantedAt: {} }, installDir);
    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe(fakePath);
  });

  test("allows path matching a granted absolute prefix", async () => {
    const grantedDir = join(tempDir, "data");
    await mkdir(grantedDir, { recursive: true });
    const dataFile = join(grantedDir, "file.txt");
    await writeFile(dataFile, "data");

    const granted: ExtensionPermissions = {
      filesystem: [grantedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(dataFile, granted, installDir);
    expect(result.allowed).toBe(true);
  });

  test("allows exact match of granted prefix", async () => {
    const grantedDir = join(tempDir, "exact-match");
    await mkdir(grantedDir, { recursive: true });

    const granted: ExtensionPermissions = {
      filesystem: [grantedDir],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(grantedDir, granted, installDir);
    expect(result.allowed).toBe(true);
  });

  test("resolves relative prefix against installDir", async () => {
    // Create a "data" subdirectory inside installDir
    const dataDir = join(installDir, "data");
    await mkdir(dataDir, { recursive: true });
    const dataFile = join(dataDir, "file.txt");
    await writeFile(dataFile, "relative data");

    const granted: ExtensionPermissions = {
      filesystem: ["data"], // relative -- should resolve against installDir
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(dataFile, granted, installDir);
    expect(result.allowed).toBe(true);
  });

  test("denies when granted prefix is unresolvable", async () => {
    // Grant a prefix that doesn't exist on disk
    const outsideFile = join(tempDir, "some-file.txt");
    await writeFile(outsideFile, "content");

    const granted: ExtensionPermissions = {
      filesystem: ["/nonexistent/fake/path"],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(outsideFile, granted, installDir);
    expect(result.allowed).toBe(false);
  });

  test("prevents symlink traversal outside granted prefix", async () => {
    // Create a directory outside installDir
    const secretDir = join(tempDir, "secret");
    await mkdir(secretDir, { recursive: true });
    const secretFile = join(secretDir, "passwords.txt");
    await writeFile(secretFile, "secret data");

    // Create a symlink inside installDir that points to the secret dir
    const symlinkPath = join(installDir, "sneaky-link");
    await symlink(secretDir, symlinkPath);

    // The symlink target resolves outside installDir, with no granted prefixes
    const traversalPath = join(symlinkPath, "passwords.txt");
    const result = await checkFilesystemPermission(traversalPath, { grantedAt: {} }, installDir);
    // realpath resolves the symlink, revealing the path is outside installDir
    expect(result.allowed).toBe(false);
    expect(result.resolvedPath).toBe(secretFile);
  });

  test("allows symlink that resolves within install dir", async () => {
    // Create a real subdir
    const subDir = join(installDir, "real-data");
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, "ok.txt"), "ok");

    // Create a symlink inside installDir pointing to the subdir
    const linkPath = join(installDir, "link-to-data");
    await symlink(subDir, linkPath);

    const result = await checkFilesystemPermission(
      join(linkPath, "ok.txt"),
      { grantedAt: {} },
      installDir,
    );
    expect(result.allowed).toBe(true);
  });

  test("handles installDir that does not exist gracefully", async () => {
    const fakeInstallDir = join(tempDir, "nonexistent-install-dir");
    const realFile = join(tempDir, "outside.txt");
    await writeFile(realFile, "data");

    // installDir can't be resolved, falls back to raw value
    const result = await checkFilesystemPermission(realFile, { grantedAt: {} }, fakeInstallDir);
    expect(result.allowed).toBe(false);
  });

  test("empty filesystem grants array denies access", async () => {
    const realFile = join(tempDir, "outside.txt");
    await writeFile(realFile, "data");

    const granted: ExtensionPermissions = {
      filesystem: [],
      grantedAt: {},
    };
    const result = await checkFilesystemPermission(realFile, granted, installDir);
    expect(result.allowed).toBe(false);
  });
});

// ================================================================
// 2. diffPermissions -- shell handling (line 157-158)
// ================================================================

describe("diffPermissions shell handling", () => {
  test("includes shell in diff when requested but not granted", () => {
    const requested: ExtensionPermissions = {
      shell: true,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.shell).toBe(true);
  });

  test("excludes shell from diff when shell=false is requested", () => {
    const requested: ExtensionPermissions = {
      shell: false,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.shell).toBeUndefined();
  });

  test("excludes shell from diff when already granted", () => {
    const requested: ExtensionPermissions = {
      shell: true,
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      shell: true,
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.shell).toBeUndefined();
  });

  test("diff with all permission types mixed", () => {
    const requested: ExtensionPermissions = {
      network: ["a.com", "b.com"],
      filesystem: ["/tmp", "/data"],
      shell: true,
      env: ["KEY_A", "KEY_B"],
      grantedAt: {},
    };
    const granted: ExtensionPermissions = {
      network: ["a.com"],
      filesystem: ["/data"],
      shell: true,
      env: ["KEY_A"],
      grantedAt: {},
    };
    const diff = diffPermissions(requested, granted);
    expect(diff.network).toEqual(["b.com"]);
    expect(diff.filesystem).toEqual(["/tmp"]);
    expect(diff.shell).toBeUndefined(); // already granted
    expect(diff.env).toEqual(["KEY_B"]);
  });
});

// ================================================================
// 3. computePackageChecksums -- additional edge cases
// ================================================================

describe("computePackageChecksums additional edge cases", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "pkg-checksum-gaps-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("includes dotfiles not in the exclusion set (they affect runtime behavior)", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await writeFile(join(tempDir, ".hidden"), "hidden file");
    await writeFile(join(tempDir, ".env"), "SECRET=123");

    const checksums = await computePackageChecksums(tempDir);
    expect(Object.keys(checksums).sort()).toEqual([".env", ".hidden", "index.ts"]);
  });

  test("includes files inside dot-directories not in the exclusion set", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await mkdir(join(tempDir, ".hidden-dir"), { recursive: true });
    await writeFile(join(tempDir, ".hidden-dir", "secret.ts"), "secret");

    const checksums = await computePackageChecksums(tempDir);
    expect(Object.keys(checksums).sort()).toEqual([".hidden-dir/secret.ts", "index.ts"]);
  });

  test("excludes node_modules at any depth", async () => {
    await writeFile(join(tempDir, "index.ts"), "code");
    await mkdir(join(tempDir, "lib", "node_modules", "pkg"), { recursive: true });
    await writeFile(join(tempDir, "lib", "node_modules", "pkg", "index.js"), "dep");

    const checksums = await computePackageChecksums(tempDir);
    expect(Object.keys(checksums)).toEqual(["index.ts"]);
  });

  test("produces deterministic checksums for same content", async () => {
    await writeFile(join(tempDir, "file.ts"), "constant content");
    const first = await computePackageChecksums(tempDir);
    const second = await computePackageChecksums(tempDir);
    expect(first).toEqual(second);
  });
});

describe("verifyPackageChecksums additional edge cases", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "verify-gaps-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("valid with empty expected and empty directory", async () => {
    const result = await verifyPackageChecksums(tempDir, {});
    expect(result.valid).toBe(true);
    expect(result.mismatched).toEqual([]);
  });

  test("detects all three types of mismatch simultaneously", async () => {
    await writeFile(join(tempDir, "keep.ts"), "keep");
    await writeFile(join(tempDir, "modify.ts"), "original");
    await writeFile(join(tempDir, "remove.ts"), "gone");

    const expected = await computePackageChecksums(tempDir);

    // Modify, remove, and add
    await writeFile(join(tempDir, "modify.ts"), "changed");
    await rm(join(tempDir, "remove.ts"));
    await writeFile(join(tempDir, "added.ts"), "new");

    const result = await verifyPackageChecksums(tempDir, expected);
    expect(result.valid).toBe(false);
    expect(result.mismatched.sort()).toEqual(["added.ts", "modify.ts", "remove.ts"]);
  });
});

// ================================================================
// 4. ExtensionProcess -- constructor options and getSpawnArgs
// ================================================================

describe("ExtensionProcess constructor and getSpawnArgs", () => {
  test("default options without overrides", () => {
    const ep = new ExtensionProcess("test-id", "/path/ext.ts", {});
    expect(ep.isRunning).toBe(false);
    expect(ep.memoryLimitBytes).toBe(DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024);
    expect(ep.extensionId).toBe("test-id");
  });

  test("getSpawnArgs with default memory limit", () => {
    // updated for sec-SB2/SB3: --preload slot moved AFTER `run` — Bun's CLI
    // parser rejects `bun --preload <path> run <ext>` (prints help + exits).
    const ep = new ExtensionProcess("test-id", "/path/ext.ts", {});
    const args = ep.getSpawnArgs();
    expect(args[0]).toBe("prlimit");
    expect(args[1]).toBe(`--rss=${DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024}`);
    expect(args[2]).toBe("bun");
    expect(args[3]).toBe("run");
    expect(args[4]).toBe("--preload");
    // Absolute path to sandbox-preload.ts — blocks network/shell imports.
    expect(args[5]).toMatch(/\/extensions\/runtime\/sandbox-preload\.ts$/);
    expect(args[6]).toBe("/path/ext.ts");
  });

  test("getSpawnArgs with custom memory limit", () => {
    const oneGB = 1024 * 1024 * 1024;
    const ep = new ExtensionProcess("test-id", "/path/ext.ts", {}, {
      memoryLimitBytes: oneGB,
    });
    const args = ep.getSpawnArgs();
    expect(args[1]).toBe(`--rss=${oneGB}`);
  });

  test("memory limit floor is enforced", () => {
    const tinyLimit = 32 * 1024 * 1024; // 32MB
    const ep = new ExtensionProcess("test-id", "/path/ext.ts", {}, {
      memoryLimitBytes: tinyLimit,
    });
    expect(ep.memoryLimitBytes).toBe(512 * 1024 * 1024); // MIN is 512MB
  });

  test("isRunning false before spawn and after kill without spawn", () => {
    const ep = new ExtensionProcess("test-id", "/path/ext.ts", {});
    expect(ep.isRunning).toBe(false);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });
});

// ================================================================
// 5. ExtensionProcess -- real subprocess tests with echo extension
// ================================================================

describe("ExtensionProcess subprocess (echo extension)", () => {
  const echoPath = join(import.meta.dir, "helpers", "echo-extension.ts");
  const slowPath = join(import.meta.dir, "helpers", "slow-extension.ts");
  const allowedEnv: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
  };

  let ep: ExtensionProcess;

  // Workaround for Bun JIT bug (same as subprocess.test.ts)
  ExtensionProcess.prototype.ensureRunning = function (this: any) {
    if (this.proc && !this.killed) return;
    this.killed = false;
    this.proc = Bun.spawn(["bun", "run", this.extensionPath], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: this.allowedEnv,
    });
    this.transport = new JsonRpcTransport(
      this.proc.stdin as any,
      this.proc.stdout as ReadableStream<Uint8Array>,
    );
    this.transport.startReading();
    this.wireRequestHandler();
    this.resetIdleTimer();
    this.proc.exited.then(async (_exitCode: number) => {
      if (this.killed) return;
      this.proc = null;
      this.transport = null;
      try {
        const { incrementFailures, disableExtension } = await import(
          "../db/queries/extensions"
        );
        const count = await incrementFailures(this.extensionId);
        if (count >= 3) await disableExtension(this.extensionId);
      } catch {}
    });
  };

  afterEach(() => {
    ep?.kill();
  });

  test("multiple calls in sequence return correct responses", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);

    const r1 = await ep.call("method-1", { key: "one" });
    expect(r1.result).toBeDefined();
    const text1 = (r1.result as any).content[0].text;
    expect(text1).toContain("method-1");

    const r2 = await ep.call("method-2", { key: "two" });
    const text2 = (r2.result as any).content[0].text;
    expect(text2).toContain("method-2");

    const r3 = await ep.call("method-3");
    const text3 = (r3.result as any).content[0].text;
    expect(text3).toContain("method-3");
  });

  test("callTool returns ToolCallResult with isError=false", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    const result = await ep.callTool("test-tool", { arg: "val" });
    expect(result.isError).toBe(false);
    expect(result.content).toBeArray();
    expect(result.content[0]!.text).toContain("tools/call");
    expect(result.content[0]!.text).toContain("test-tool");
  });

  test("kill stops process and isRunning transitions correctly", () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv);
    expect(ep.isRunning).toBe(false);
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);
    ep.kill();
    expect(ep.isRunning).toBe(false);
  });

  test("call timeout rejects and kills process", async () => {
    ep = new ExtensionProcess("test-ext", slowPath, allowedEnv, {
      callTimeoutMs: 100,
    });

    await expect(ep.call("anything")).rejects.toThrow("timed out");
    expect(ep.isRunning).toBe(false);
  });

  test("persistent=true prevents idle timeout", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv, {
      idleTimeoutMs: 100,
      persistent: true,
    });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(ep.isRunning).toBe(true);
  });

  test("non-persistent process gets killed after idle timeout", async () => {
    ep = new ExtensionProcess("test-ext", echoPath, allowedEnv, {
      idleTimeoutMs: 100,
      persistent: false,
    });
    ep.ensureRunning();
    expect(ep.isRunning).toBe(true);

    await new Promise((r) => setTimeout(r, 250));
    expect(ep.isRunning).toBe(false);
  });
});

// ================================================================
// 6. sdk/test-runner.ts: runExtensionTests
// ================================================================

describe("runExtensionTests", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "test-runner-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("throws when ezcorp.config.ts is missing", async () => {
    await expect(runExtensionTests({ extDir: tempDir })).rejects.toThrow("No ezcorp.config.ts");
  });

  test("throws when manifest is invalid", async () => {
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify({ bad: true })};\n`);
    await expect(runExtensionTests({ extDir: tempDir })).rejects.toThrow("Invalid manifest");
  });

  test("runs tests and returns exit code for valid extension", async () => {
    const manifest = {
      schemaVersion: 2,
      name: "test-runner-ext",
      version: "1.0.0",
      description: "Test extension",
      author: { name: "Test" },
      permissions: {},
    };
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);

    // Create a simple passing test file
    await writeFile(join(tempDir, "index.test.ts"), `
import { test, expect } from "bun:test";
test("pass", () => { expect(1 + 1).toBe(2); });
`);

    const exitCode = await runExtensionTests({ extDir: tempDir, timeout: 30000 });
    expect(exitCode).toBe(0);
  }, 30_000);
});

// ================================================================
// 7. sdk/test-helpers.ts: createTestExtension, callTool wrapper
// ================================================================

describe("createTestExtension", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "test-helper-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("throws when manifest does not exist", async () => {
    await expect(createTestExtension(tempDir)).rejects.toThrow("Manifest not found");
  });

  test("throws when manifest is invalid", async () => {
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify({ bad: true })};\n`);
    await expect(createTestExtension(tempDir)).rejects.toThrow("Invalid manifest");
  });

  test("throws when manifest has no entrypoint", async () => {
    const manifest = {
      schemaVersion: 2,
      name: "no-entry",
      version: "1.0.0",
      description: "No entrypoint",
      author: { name: "Test" },
      permissions: {},
      // No entrypoint field
    };
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
    await expect(createTestExtension(tempDir)).rejects.toThrow("must declare an entrypoint");
  });

  test("creates ExtensionProcess with valid manifest and entrypoint", async () => {
    // Write a valid echo extension
    const echoCode = `
const decoder = new TextDecoder();
async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const response = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "echo: " + req.method }], isError: false } };
        process.stdout.write(JSON.stringify(response) + "\\n");
      } catch {}
    }
  }
}
main();
`;
    await writeFile(join(tempDir, "index.ts"), echoCode);

    const manifest = {
      schemaVersion: 2,
      name: "test-echo",
      version: "1.0.0",
      description: "Echo extension",
      author: { name: "Test" },
      entrypoint: "./index.ts",
      tools: [{ name: "echo", description: "Echo tool", inputSchema: { type: "object" } }],
      permissions: {},
    };
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);

    const proc = await createTestExtension(tempDir);
    try {
      expect(proc).toBeDefined();
      expect(proc.extensionId).toBe("test-test-echo");
      expect(proc.isRunning).toBe(false); // Not started yet
    } finally {
      proc.kill();
    }
  });
});

describe("callTool wrapper", () => {
  let tempDir: string;
  let proc: ExtensionProcess;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "calltool-test-"));

    // Write echo extension
    const echoCode = `
const decoder = new TextDecoder();
async function main() {
  const reader = Bun.stdin.stream().getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    const lines = decoder.decode(value).split("\\n");
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const req = JSON.parse(line);
        const response = { jsonrpc: "2.0", id: req.id, result: { content: [{ type: "text", text: "echo: " + req.method + " " + JSON.stringify(req.params) }], isError: false } };
        process.stdout.write(JSON.stringify(response) + "\\n");
      } catch {}
    }
  }
}
main();
`;
    await writeFile(join(tempDir, "index.ts"), echoCode);

    const manifest = {
      schemaVersion: 2,
      name: "calltool-echo",
      version: "1.0.0",
      description: "Echo for callTool test",
      author: { name: "Test" },
      entrypoint: "./index.ts",
      tools: [{ name: "echo", description: "Echo", inputSchema: { type: "object" } }],
      permissions: {},
    };
    await writeFile(join(tempDir, "ezcorp.config.ts"), `export default ${JSON.stringify(manifest, null, 2)};\n`);
  });

  afterEach(async () => {
    proc?.kill();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("callTool wrapper returns ToolCallResult", async () => {
    proc = await createTestExtension(tempDir, { sandbox: false });

    // Apply the same JIT workaround
    const _origEnsure = proc.ensureRunning;
    (proc as any).ensureRunning = function (this: any) {
      if (this.proc && !this.killed) return;
      this.killed = false;
      this.proc = Bun.spawn(["bun", "run", this.extensionPath], {
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: this.allowedEnv,
      });
      this.transport = new JsonRpcTransport(
        this.proc.stdin as any,
        this.proc.stdout as ReadableStream<Uint8Array>,
      );
      this.transport.startReading();
      this.wireRequestHandler();
      this.resetIdleTimer();
      this.proc.exited.then(async (_exitCode: number) => {
        if (this.killed) return;
        this.proc = null;
        this.transport = null;
      });
    }.bind(proc);

    const result = await callTool(proc, "my-tool", { arg: "value" });
    expect(result.isError).toBe(false);
    expect(result.content).toBeArray();
    expect(result.content[0]!.text).toContain("tools/call");
    expect(result.content[0]!.text).toContain("my-tool");
  });
});
