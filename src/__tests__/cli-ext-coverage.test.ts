/**
 * Comprehensive coverage tests for `pi ext` CLI commands.
 *
 * Covers uncovered branches in ext:update, ext:install error,
 * ext:info display variations, ext:list formatting, and parseArgs edge cases.
 */

import { test, expect, describe, afterAll, beforeEach, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
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

const stage = mock(async (source: string) => ({ source, openUrl: "/extensions/author?installation=staged" }));
const update = mock(async (name: string) => ({ name, openUrl: "/extensions/author?workspace=fork" }));
const init = mock(async (_name: string, _type?: string) => "/tmp/source");
mock.module("../extensions/cli-control", () => ({
  stageCliExtension: stage, updateCliExtension: update, removeCliExtension: async () => {},
  initCliExtension: init, verifyCliExtension: async () => ({ state: "succeeded" }),
}));

// Import after mocks
const { parseArgs, cli } = await import("../cli");

// ── Helpers ───────────────────────────────────────────────────────────

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

afterAll(() => restoreModuleMocks());

beforeEach(() => {
  mockExtensions.clear();
});

// ── parseArgs edge cases ────────────────────────────────────────────

describe("parseArgs - ext edge cases", () => {
  test("init distinguishes absent, explicit, and missing type values", async () => {
    const output = spyOn(console, "log").mockImplementation(() => {});
    try {
      for (const [options, type] of [[[], undefined], [["--type", "skill"], "skill"], [["--type"], ""]] as const) {
        const args = ["ext", "init", "extension", ...options];
        expect(parseArgs(args)).toMatchObject({ command: "ext:init", extName: "extension", type });
        await cli(args);
        expect(init).toHaveBeenLastCalledWith("extension", type);
      }
    } finally { output.mockRestore(); }
  });
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

describe("CLI release control", () => {
  test("source failures propagate without claiming installation success", async () => {
    stage.mockRejectedValueOnce(new Error("source fetch denied"));
    await expect(cli(["ext", "install", "github:owner/repo"])).rejects.toThrow("source fetch denied");
  });

  test("a named update opens a source fork rather than replacing active code", async () => {
    const logs: string[] = [];
    const output = spyOn(console, "log").mockImplementation((...args) => logs.push(args.join(" ")));
    try {
      await cli(["ext", "update", "extension"]);
      expect(update).toHaveBeenCalledWith("extension");
      expect(JSON.parse(logs.at(-1)!)).toMatchObject({ openUrl: "/extensions/author?workspace=fork" });
    } finally { output.mockRestore(); }
  });

  test("a failed update does not print success", async () => {
    update.mockRejectedValueOnce(new Error("owner denied"));
    await expect(cli(["ext", "update", "extension"])).rejects.toThrow("owner denied");
  });

  test("bulk updates cannot bypass per-release review", async () => {
    await expect(cli(["ext", "update"])).rejects.toThrow("Each release needs an explicit review");
  });

  test("automatic approval flags fail before source import", async () => {
    const previousCalls = stage.mock.calls.length;
    await expect(cli(["ext", "install", "github:owner/repo", "--yes"])).rejects.toThrow("cannot approve");
    expect(stage.mock.calls.length).toBe(previousCalls);
  });
});

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
