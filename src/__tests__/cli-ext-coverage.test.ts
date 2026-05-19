/**
 * Comprehensive coverage tests for `pi ext` CLI commands.
 *
 * Covers uncovered branches in ext:update, ext:install error,
 * ext:info display variations, ext:list formatting, and parseArgs edge cases.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { mkdtemp, rm, mkdir } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import type { ExtensionManifestV2 } from "../extensions/types";
import { configContent } from "./helpers/write-config";

// ── Mock DB layer ─────────────────────────────────────────────────────

const mockExtensions = new Map<string, any>();

mock.module("../db/queries/extensions", () => ({
  createExtension: async (data: any) => {
    const ext = {
      id: crypto.randomUUID(),
      ...data,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    mockExtensions.set(ext.id, ext);
    return ext;
  },
  getExtensionByName: async (name: string) => {
    for (const ext of mockExtensions.values()) {
      if (ext.name === name) return ext;
    }
    return null;
  },
  updateExtension: async (id: string, data: any) => {
    const ext = mockExtensions.get(id);
    if (!ext) return null;
    Object.assign(ext, data, { updatedAt: new Date() });
    return ext;
  },
  deleteExtension: async (id: string) => {
    return mockExtensions.delete(id);
  },
  listExtensions: async () => Array.from(mockExtensions.values()),
  getExtension: async (id: string) => mockExtensions.get(id) ?? null,
  incrementFailures: async () => 0,
  resetFailures: async () => {},
  disableExtension: async () => {},
}));

mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
}));

mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => { throw new Error("DB not available in test"); },
}));

// Import after mocks
const { parseArgs, cli } = await import("../cli");

// ── Helpers ───────────────────────────────────────────────────────────

const env = { ...process.env };
const spawn = (cmd: string[], opts?: { cwd?: string }) =>
  Bun.spawnSync(cmd, { ...opts, env });

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-cov-ext",
    version: "1.0.0",
    description: "Coverage test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: { network: ["api.example.com"] },
    ...overrides,
  };
}

function makeExtEntry(id: string, overrides: Record<string, any> = {}) {
  return {
    id,
    name: overrides.name ?? "test-cov-ext",
    version: overrides.version ?? "1.0.0",
    description: overrides.description ?? "Coverage test extension",
    source: overrides.source ?? "file:///tmp/fake.git@v1.0.0",
    installPath: overrides.installPath ?? "/tmp/ext/test-cov-ext",
    enabled: overrides.enabled ?? true,
    manifest: overrides.manifest ?? makeManifest(),
    grantedPermissions: overrides.grantedPermissions ?? { grantedAt: {} },
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

let tempBase: string;
let bareRepoDir: string;
let installBase: string;

beforeAll(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "cli-ext-cov-"));
  bareRepoDir = join(tempBase, "bare.git");
  installBase = join(tempBase, "extensions");
  await mkdir(installBase, { recursive: true });

  // Create a bare repo with v1.0.0 and v1.1.0 tags
  spawn(["git", "init", "--bare", bareRepoDir]);

  const workDir = join(tempBase, "work");
  spawn(["git", "clone", bareRepoDir, workDir]);
  spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
  spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

  const manifest = makeManifest();
  await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
  await Bun.write(join(workDir, "index.ts"), 'console.log("cov ext");');

  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
  spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

  const updatedManifest = makeManifest({ version: "1.1.0" });
  await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(updatedManifest));
  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "v1.1.0"], { cwd: workDir });
  spawn(["git", "tag", "v1.1.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });
});

afterAll(async () => {
  restoreModuleMocks();
  await rm(tempBase, { recursive: true, force: true }).catch(() => {});
});

beforeEach(() => {
  mockExtensions.clear();
});

// ── parseArgs edge cases ────────────────────────────────────────────

describe("parseArgs - ext edge cases", () => {
  test("ext install without source parses with undefined source", () => {
    const result = parseArgs(["ext", "install"]);
    expect(result.command).toBe("ext:install");
    expect(result.source).toBeUndefined();
  });

  test("autoApprove defaults to false when --yes not present", () => {
    const result = parseArgs(["ext", "install", "github:user/repo"]);
    expect(result.autoApprove).toBe(false);
  });
});

// ── ext:install error path ──────────────────────────────────────────

describe("cli - ext:install error paths", () => {
  test("install error (clone fails) prints error and exits", async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    process.env.__EZCORP_TEST_EXTENSIONS_DIR = installBase;

    try {
      await cli(["ext", "install", "file:///nonexistent/repo.git"]);
    } catch {}

    expect(errors.some(l => l.startsWith("Error:"))).toBe(true);
    errSpy.mockRestore();
    exitSpy.mockRestore();
    delete process.env.__EZCORP_TEST_EXTENSIONS_DIR;
  });
});

// ── ext:update CLI paths ────────────────────────────────────────────

describe("cli - ext:update paths", () => {
  test("single named update success prints from -> to", async () => {
    // Install first so updateExtension can find it
    process.env.__EZCORP_TEST_EXTENSIONS_DIR = installBase;
    const logs: string[] = [];

    // Install v1.0.0
    await cli(["ext", "install", `file://${bareRepoDir}@v1.0.0`, "--yes"]);

    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "update", "test-cov-ext"]);

    expect(logs.some(l => l.includes("Updated test-cov-ext:") && l.includes("->"))).toBe(true);
    logSpy.mockRestore();
    delete process.env.__EZCORP_TEST_EXTENSIONS_DIR;
  });

  test("single named update failure prints error and exits", async () => {
    const errors: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "update", "nonexistent-ext"]);
    } catch {}

    expect(errors.some(l => l.startsWith("Error:"))).toBe(true);
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  test("update all with no extensions prints 'No extensions installed.'", async () => {
    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "update"]);

    expect(logs.some(l => l.includes("No extensions installed."))).toBe(true);
    logSpy.mockRestore();
  });

  test("update all with extensions that are up to date prints message", async () => {
    // Pre-populate with an extension that has a local source (no updates available)
    mockExtensions.set("uptodate-id", makeExtEntry("uptodate-id", {
      source: "local:/tmp/fake",
      version: "1.0.0",
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "update"]);

    expect(logs.some(l => l.includes("All extensions are up to date."))).toBe(true);
    logSpy.mockRestore();
  });

  test("update all with extension that has update available", async () => {
    // Install v1.0.0 so it can be updated to v1.1.0
    process.env.__EZCORP_TEST_EXTENSIONS_DIR = installBase;

    // Clear and install fresh
    mockExtensions.clear();
    await cli(["ext", "install", `file://${bareRepoDir}@v1.0.0`, "--yes"]);

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "update"]);

    expect(logs.some(l => l.includes("Updated test-cov-ext:") && l.includes("->"))).toBe(true);
    logSpy.mockRestore();
    delete process.env.__EZCORP_TEST_EXTENSIONS_DIR;
  });

  test("update all with extension update failure prints error and continues", async () => {
    // Use real bare repo (so checkForUpdates finds v1.1.0 > v1.0.0)
    // but set installPath to nonexistent dir so git fetch/checkout fails in updateExt
    mockExtensions.set("bad-id", makeExtEntry("bad-id", {
      name: "bad-ext",
      source: `file://${bareRepoDir}@v1.0.0`,
      version: "1.0.0",
      installPath: "/tmp/nonexistent-ext-path-for-test",
    }));

    const errors: string[] = [];
    const logs: string[] = [];
    const errSpy = spyOn(console, "error").mockImplementation((...args) => errors.push(args.join(" ")));
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    // Should not throw -- errors are caught per-extension
    await cli(["ext", "update"]);

    expect(errors.some(l => l.includes("Failed to update bad-ext:"))).toBe(true);
    // Also prints "All extensions are up to date." since updated count remains 0
    expect(logs.some(l => l.includes("All extensions are up to date."))).toBe(true);
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});

// ── ext:info comprehensive display ──────────────────────────────────

describe("cli - ext:info display variations", () => {
  test("extension with skills array prints Skills section", async () => {
    mockExtensions.set("skills-id", makeExtEntry("skills-id", {
      name: "skills-ext",
      manifest: makeManifest({
        name: "skills-ext",
        skills: [
          { name: "summarize", description: "Summarize text" },
          { name: "translate", description: "Translate text" },
        ],
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "skills-ext"]);

    const output = logs.join("\n");
    expect(output).toContain("Skills:");
    expect(output).toContain("summarize: Summarize text");
    expect(output).toContain("translate: Translate text");
    logSpy.mockRestore();
  });

  test("extension with mcpServers does NOT show MCP Servers section in info", async () => {
    mockExtensions.set("servers-id", makeExtEntry("servers-id", {
      name: "servers-ext",
      manifest: makeManifest({
        name: "servers-ext",
        mcpServers: [
          { transport: "stdio", name: "my-server", description: "A server", command: "node", args: ["srv.ts"] },
        ],
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "servers-ext"]);

    const output = logs.join("\n");
    // ext:info displays tools, skills, agent, permissions -- but NOT mcpServers
    expect(output).not.toContain("MCP Servers:");
    expect(output).not.toContain("mcpServers");
    logSpy.mockRestore();
  });

  test("extension with agent and category prints Agent section", async () => {
    mockExtensions.set("agent-id", makeExtEntry("agent-id", {
      name: "agent-ext",
      manifest: makeManifest({
        name: "agent-ext",
        agent: { prompt: "You are helpful", category: "Development" },
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "agent-ext"]);

    const output = logs.join("\n");
    expect(output).toContain("Agent: yes (Development)");
    logSpy.mockRestore();
  });

  test("extension with agent but no category prints uncategorized", async () => {
    mockExtensions.set("agent-nocat-id", makeExtEntry("agent-nocat-id", {
      name: "agent-nocat",
      manifest: makeManifest({
        name: "agent-nocat",
        agent: { prompt: "You are helpful" },
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "agent-nocat"]);

    const output = logs.join("\n");
    expect(output).toContain("Agent: yes (uncategorized)");
    logSpy.mockRestore();
  });

  test("extension with no permissions shows no Permissions section", async () => {
    mockExtensions.set("noperm-id", makeExtEntry("noperm-id", {
      name: "noperm-ext",
      manifest: makeManifest({
        name: "noperm-ext",
        permissions: {},
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "noperm-ext"]);

    const output = logs.join("\n");
    expect(output).not.toContain("Permissions:");
    logSpy.mockRestore();
  });

  test("extension with no tools shows no Tools section", async () => {
    mockExtensions.set("notool-id", makeExtEntry("notool-id", {
      name: "notool-ext",
      manifest: makeManifest({
        name: "notool-ext",
        tools: [],
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "notool-ext"]);

    const output = logs.join("\n");
    expect(output).not.toContain("Tools:");
    logSpy.mockRestore();
  });

  test("extension with empty description shows (none)", async () => {
    mockExtensions.set("nodesc-id", makeExtEntry("nodesc-id", {
      name: "nodesc-ext",
      description: "",
      manifest: makeManifest({
        name: "nodesc-ext",
        description: "",
      }),
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "nodesc-ext"]);

    const output = logs.join("\n");
    expect(output).toContain("(none)");
    logSpy.mockRestore();
  });

  test("extension with no author shows (unknown)", async () => {
    const manifestNoAuthor = makeManifest({ name: "noauthor-ext" });
    // Remove author to test fallback
    (manifestNoAuthor as any).author = undefined;

    mockExtensions.set("noauthor-id", makeExtEntry("noauthor-id", {
      name: "noauthor-ext",
      manifest: manifestNoAuthor,
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "noauthor-ext"]);

    const output = logs.join("\n");
    expect(output).toContain("(unknown)");
    logSpy.mockRestore();
  });
});

// ── ext:list formatting ─────────────────────────────────────────────

describe("cli - ext:list formatting", () => {
  test("long source string is truncated with ellipsis", async () => {
    const longSource = "file:///very/long/path/to/a/repository/that/exceeds/thirty/three/characters.git@v1.0.0";
    mockExtensions.set("long-id", makeExtEntry("long-id", {
      source: longSource,
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("...");
    // The truncated source should be 30 chars + "..."
    expect(output).not.toContain(longSource);
    logSpy.mockRestore();
  });

  test("disabled extension shows disabled status", async () => {
    mockExtensions.set("disabled-id", makeExtEntry("disabled-id", {
      enabled: false,
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("disabled");
    logSpy.mockRestore();
  });

  test("enabled extension shows enabled status", async () => {
    mockExtensions.set("enabled-id", makeExtEntry("enabled-id", {
      enabled: true,
    }));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("enabled");
    logSpy.mockRestore();
  });

  test("list prints header and separator line", async () => {
    mockExtensions.set("hdr-id", makeExtEntry("hdr-id"));

    const logs: string[] = [];
    const logSpy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("Name");
    expect(output).toContain("Version");
    expect(output).toContain("Source");
    expect(output).toContain("Status");
    expect(output).toContain("-".repeat(82));
    logSpy.mockRestore();
  });
});
