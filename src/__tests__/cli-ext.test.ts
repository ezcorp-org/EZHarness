/**
 * Integration tests for `pi ext` CLI commands.
 *
 * Tests parseArgs for all ext subcommands and integration tests using
 * local bare git repos (same pattern as git-install.test.ts).
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

// Mock registry reload to no-op
mock.module("../extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      reload: async () => {},
    }),
  },
}));

// Mock initDb to no-op (we use in-memory mocks)
mock.module("../db/connection", () => ({
  initDb: async () => {},
  getDb: () => { throw new Error("DB not available in test"); },
}));

// Import after mocks
const { parseArgs, cli } = await import("../cli");

// ── Test fixtures ─────────────────────────────────────────────────────

const env = { ...process.env };
const spawn = (cmd: string[], opts?: { cwd?: string }) =>
  Bun.spawnSync(cmd, { ...opts, env });

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-cli-ext",
    version: "1.0.0",
    description: "A CLI test extension",
    author: { name: "Tester" },
    entrypoint: "index.ts",
    tools: [{ name: "greet", description: "Say hi", inputSchema: { type: "object" } }],
    permissions: { network: ["api.example.com"] },
    ...overrides,
  };
}

let tempBase: string;
let bareRepoDir: string;
let installBase: string;

beforeAll(async () => {
  tempBase = await mkdtemp(join(tmpdir(), "cli-ext-test-"));
  bareRepoDir = join(tempBase, "bare.git");
  installBase = join(tempBase, "extensions");
  await mkdir(installBase, { recursive: true });

  spawn(["git", "init", "--bare", bareRepoDir]);

  const workDir = join(tempBase, "work");
  spawn(["git", "clone", bareRepoDir, workDir]);
  spawn(["git", "config", "user.email", "test@test.com"], { cwd: workDir });
  spawn(["git", "config", "user.name", "Test"], { cwd: workDir });

  const manifest = makeManifest();
  await Bun.write(join(workDir, "ezcorp.config.ts"), configContent(manifest));
  await Bun.write(join(workDir, "index.ts"), 'console.log("cli ext");');

  spawn(["git", "add", "."], { cwd: workDir });
  spawn(["git", "commit", "-m", "v1.0.0"], { cwd: workDir });
  spawn(["git", "tag", "v1.0.0"], { cwd: workDir });
  spawn(["git", "push", "origin", "HEAD", "--tags"], { cwd: workDir });

  // Create v1.1.0 tag
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

// ── parseArgs tests ─────────────────────────────────────────────────

describe("parseArgs - ext subcommands", () => {
  test("ext install with source", () => {
    const result = parseArgs(["ext", "install", "github:user/repo"]);
    expect(result.command).toBe("ext:install");
    expect(result.source).toBe("github:user/repo");
  });

  test("ext install with source and --yes", () => {
    const result = parseArgs(["ext", "install", "github:user/repo@v1.0", "--yes"]);
    expect(result.command).toBe("ext:install");
    expect(result.source).toBe("github:user/repo@v1.0");
    expect(result.autoApprove).toBe(true);
  });

  test("ext update with name", () => {
    const result = parseArgs(["ext", "update", "my-ext"]);
    expect(result.command).toBe("ext:update");
    expect(result.extName).toBe("my-ext");
  });

  test("ext update without name (update all)", () => {
    const result = parseArgs(["ext", "update"]);
    expect(result.command).toBe("ext:update");
    expect(result.extName).toBeUndefined();
  });

  test("ext list", () => {
    const result = parseArgs(["ext", "list"]);
    expect(result.command).toBe("ext:list");
  });

  test("ext remove with name", () => {
    const result = parseArgs(["ext", "remove", "my-ext"]);
    expect(result.command).toBe("ext:remove");
    expect(result.extName).toBe("my-ext");
  });

  test("ext info with name", () => {
    const result = parseArgs(["ext", "info", "my-ext"]);
    expect(result.command).toBe("ext:info");
    expect(result.extName).toBe("my-ext");
  });

  test("ext without subcommand shows help", () => {
    const result = parseArgs(["ext"]);
    expect(result.command).toBe("help");
  });
});

// ── CLI error handling tests ────────────────────────────────────────

describe("cli - ext error cases", () => {
  test("ext install without source prints error", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "install"]);
    } catch {}

    expect(logs.some(l => l.includes("source"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  test("ext remove without name prints error", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "remove"]);
    } catch {}

    expect(logs.some(l => l.includes("name"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  test("ext info without name prints error", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "info"]);
    } catch {}

    expect(logs.some(l => l.includes("name"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── CLI integration tests (full lifecycle) ──────────────────────────

describe("cli - ext integration lifecycle", () => {
  test("ext install from local bare repo", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    // We need to set the extensionsDir env for test — the CLI will use default.
    // Actually, the CLI calls installFromGit without extensionsDir, so the install
    // will go to data/extensions/. For test isolation, we override via env.
    process.env.__EZCORP_TEST_EXTENSIONS_DIR = installBase;

    await cli(["ext", "install", `file://${bareRepoDir}`, "--yes"]);

    expect(logs.some(l => l.includes("Installed") && l.includes("test-cli-ext"))).toBe(true);
    spy.mockRestore();
    delete process.env.__EZCORP_TEST_EXTENSIONS_DIR;
  });

  test("ext list shows installed extension", async () => {
    // Pre-install an extension in the mock
    mockExtensions.set("test-id", {
      id: "test-id",
      name: "test-cli-ext",
      version: "1.0.0",
      description: "A CLI test extension",
      source: `file://${bareRepoDir}@v1.0.0`,
      installPath: join(installBase, "test-cli-ext"),
      enabled: true,
      manifest: makeManifest(),
      grantedPermissions: { grantedAt: {} },
    });

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    const output = logs.join("\n");
    expect(output).toContain("test-cli-ext");
    expect(output).toContain("1.0.0");
    spy.mockRestore();
  });

  test("ext list with no extensions shows message", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "list"]);

    expect(logs.some(l => l.includes("No extensions installed"))).toBe(true);
    spy.mockRestore();
  });

  test("ext info shows extension details", async () => {
    mockExtensions.set("info-id", {
      id: "info-id",
      name: "test-cli-ext",
      version: "1.0.0",
      description: "A CLI test extension",
      source: `file://${bareRepoDir}`,
      installPath: join(installBase, "test-cli-ext"),
      enabled: true,
      manifest: makeManifest(),
      grantedPermissions: { network: ["api.example.com"], grantedAt: { network: Date.now() } },
    });

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "test-cli-ext"]);

    const output = logs.join("\n");
    expect(output).toContain("test-cli-ext");
    expect(output).toContain("1.0.0");
    expect(output).toContain("A CLI test extension");
    spy.mockRestore();
  });

  test("ext info for non-existent extension errors", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "info", "nonexistent"]);
    } catch {}

    expect(logs.some(l => l.includes("not found"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  test("ext remove removes installed extension", async () => {
    // Pre-install
    mockExtensions.set("rm-id", {
      id: "rm-id",
      name: "test-cli-ext",
      version: "1.0.0",
      description: "A CLI test extension",
      source: `file://${bareRepoDir}`,
      installPath: join(installBase, "test-cli-ext"),
      enabled: true,
      manifest: makeManifest(),
      grantedPermissions: { grantedAt: {} },
    });

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "remove", "test-cli-ext"]);

    expect(logs.some(l => l.includes("Removed") && l.includes("test-cli-ext"))).toBe(true);
    spy.mockRestore();
  });

  test("ext remove non-existent extension errors", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "remove", "nonexistent"]);
    } catch {}

    expect(logs.some(l => l.includes("not found"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── Additional edge case tests ───────────────────────────────────────

describe("parseArgs - ext --force flag", () => {
  test("ext remove with --force returns force: true", () => {
    const result = parseArgs(["ext", "remove", "my-ext", "--force"]);
    expect(result.command).toBe("ext:remove");
    expect(result.extName).toBe("my-ext");
    expect(result.force).toBe(true);
  });

  test("ext remove without --force returns force: false", () => {
    const result = parseArgs(["ext", "remove", "my-ext"]);
    expect(result.command).toBe("ext:remove");
    expect(result.extName).toBe("my-ext");
    expect(result.force).toBe(false);
  });
});

describe("cli - ext update edge cases", () => {
  test("ext update non-existent extension prints error", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    try {
      await cli(["ext", "update", "nonexistent-extension"]);
    } catch {}

    expect(logs.some(l => l.includes("not found") || l.includes("nonexistent-extension"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });

  test("ext update all with no extensions prints message", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "update"]);

    expect(logs.some(l => l.includes("No extensions installed"))).toBe(true);
    spy.mockRestore();
  });
});

describe("cli - ext info tools/skills output", () => {
  test("ext info shows tools section from manifest", async () => {
    mockExtensions.set("tools-id", {
      id: "tools-id",
      name: "ext-with-tools",
      version: "2.0.0",
      description: "Extension with tools",
      source: "github:user/ext-with-tools@v2.0.0",
      installPath: join(installBase, "ext-with-tools"),
      enabled: true,
      manifest: makeManifest({
        name: "ext-with-tools",
        version: "2.0.0",
        description: "Extension with tools",
        tools: [
          { name: "greet", description: "Say hi", inputSchema: { type: "object" } },
          { name: "farewell", description: "Say bye", inputSchema: { type: "object" } },
        ],
      }),
      grantedPermissions: { grantedAt: {} },
    });

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "ext-with-tools"]);

    const output = logs.join("\n");
    expect(output).toContain("Tools:");
    expect(output).toContain("greet");
    expect(output).toContain("Say hi");
    expect(output).toContain("farewell");
    expect(output).toContain("Say bye");
    spy.mockRestore();
  });

  test("ext info shows skills section from manifest", async () => {
    mockExtensions.set("skills-id", {
      id: "skills-id",
      name: "ext-with-skills",
      version: "1.0.0",
      description: "Extension with skills",
      source: "github:user/ext-with-skills@v1.0.0",
      installPath: join(installBase, "ext-with-skills"),
      enabled: true,
      manifest: makeManifest({
        name: "ext-with-skills",
        version: "1.0.0",
        description: "Extension with skills",
        tools: [],
        skills: [
          { name: "summarize", description: "Summarize text" },
          { name: "translate", description: "Translate between languages" },
        ],
      }),
      grantedPermissions: { grantedAt: {} },
    });

    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["ext", "info", "ext-with-skills"]);

    const output = logs.join("\n");
    expect(output).toContain("Skills:");
    expect(output).toContain("summarize");
    expect(output).toContain("Summarize text");
    expect(output).toContain("translate");
    expect(output).toContain("Translate between languages");
    spy.mockRestore();
  });
});

// ── Help output test ────────────────────────────────────────────────

describe("cli - help includes ext commands", () => {
  test("help output mentions ext subcommands", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));

    await cli(["help"]);

    const output = logs.join("\n");
    expect(output).toContain("ext install");
    expect(output).toContain("ext update");
    expect(output).toContain("ext list");
    expect(output).toContain("ext remove");
    expect(output).toContain("ext info");
    spy.mockRestore();
  });
});
