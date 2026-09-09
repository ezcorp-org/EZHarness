
import { test, expect, describe, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { join } from "path";
import type { ExtensionManifestV2 } from "../extensions/types";

// ── Mock DB layer ─────────────────────────────────────────────────────

import { createMockExtensionsStore } from "./helpers/mock-extensions-store";

const extStore = createMockExtensionsStore({ keyBy: "id", timestamps: true, generateId: () => crypto.randomUUID() });
const mockExtensions = extStore.store;

mock.module("../db/queries/extensions", () => ({
  createExtension: extStore.createExtension,
  getExtensionByName: extStore.getExtensionByName,
  updateExtension: extStore.updateExtension,
  deleteExtension: extStore.deleteExtension,
  listExtensions: extStore.listExtensions,
  getExtension: extStore.getExtension,
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

const stagedSources: string[] = [];
mock.module("../extensions/cli-control", () => ({
  initCliExtension: async () => "/source",
  verifyCliExtension: async () => ({ state: "succeeded" }),
  stageCliExtension: async (source: string) => {
    stagedSources.push(source);
    return { workspace: { id: "draft" }, openUrl: "/extensions/author?workspace=draft" };
  },
  removeCliExtension: async (name: string) => {
    if (!await extStore.getExtensionByName(name)) throw new Error("Extension not found.");
  },
  updateCliExtension: async () => { throw new Error("Extension not found."); },
}));

// Import after mocks
const { parseArgs, cli } = await import("../cli");

// ── Test fixtures ─────────────────────────────────────────────────────

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

const bareRepoDir = "/source";
const installBase = "/extensions";

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  mockExtensions.clear();
  stagedSources.length = 0;
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
  test("ext install without source rejects", async () => {
    await expect(cli(["ext", "install"])).rejects.toThrow("source");
  });

  test("ext remove without name rejects", async () => {
    await expect(cli(["ext", "remove"])).rejects.toThrow("name");
  });

  test("ext info without name prints error", async () => {
    const logs: string[] = [];
    const spy = spyOn(console, "error").mockImplementation((...args) => logs.push(args.join(" ")));
    const exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

    await expect(cli(["ext", "info"])).rejects.toThrow("exit");

    expect(logs.some(l => l.includes("name"))).toBe(true);
    spy.mockRestore();
    exitSpy.mockRestore();
  });
});

// ── CLI integration tests (full lifecycle) ──────────────────────────

describe("cli - ext integration lifecycle", () => {
  test("ext install stages source without activation", async () => {
    const spy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await cli(["ext", "install", "./source"]);
      expect(stagedSources).toEqual(["./source"]);
      expect(JSON.parse(spy.mock.calls[0]![0])).toEqual({
        workspace: { id: "draft" }, openUrl: "/extensions/author?workspace=draft",
      });
      expect(mockExtensions.size).toBe(0);
    } finally { spy.mockRestore(); }
  });

  test("ext install refuses automatic approval before staging", async () => {
    await expect(cli(["ext", "install", "./source", "--yes"])).rejects.toThrow("human session");
    expect(stagedSources).toHaveLength(0);
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

    await expect(cli(["ext", "info", "nonexistent"])).rejects.toThrow("exit");

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

  test("ext remove non-existent extension rejects", async () => {
    await expect(cli(["ext", "remove", "nonexistent"])).rejects.toThrow("not found");
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
  test("ext update non-existent extension rejects", async () => {
    await expect(cli(["ext", "update", "nonexistent-extension"])).rejects.toThrow("not found");
  });

  test("ext update requires an explicit extension", async () => {
    await expect(cli(["ext", "update"])).rejects.toThrow("explicit review");
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
