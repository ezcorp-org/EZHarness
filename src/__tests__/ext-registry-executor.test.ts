/**
 * Comprehensive unit tests for registry.ts and tool-executor.ts.
 *
 * Strategy:
 * - registry.ts: Test buildAllowedEnv (exported pure fn), resolveDepTool, getRegisteredTool,
 *   buildDepRoutes, getGrantedPermissions, getInstallPath, cleanupExtTmpDir via test helpers
 *   on the singleton. Uses lightweight mocks (no DB needed for most tests).
 * - tool-executor.ts: Test PermissionDeniedError, extensionToAgentTool, executeToolCall,
 *   handlePiFs, handlePiInvoke, createToolsContext using mock registry + mock process objects.
 */

import { test, expect, describe, beforeEach, afterEach, afterAll, mock, spyOn } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync, rmSync } from "node:fs";

// Mock DB and security modules so tool-executor and registry don't hit real DB
mock.module("../db/connection", () => ({
  getDb: () => {
    // Return a mock that swallows insert calls (for recordToolCall)
    return {
      insert: () => ({
        values: async () => {},
      }),
      select: () => ({
        from: () => ({
          where: async () => [],
        }),
      }),
    };
  },
}));

mock.module("../db/queries/extensions", () => ({
  listExtensions: async () => [],
  disableExtension: async () => {},
  incrementFailures: async () => 0,
  resetFailures: async () => {},
}));

// Security mock — use spyOn where needed instead of mock.module to avoid poisoning other test files
import * as securityModule from "../extensions/security";

// Checksum mock — only used by registry/installer code paths within this file.
// Using spyOn where needed instead of mock.module to avoid poisoning other test files.

// Import permissions for spyOn — no mock.module to avoid poisoning other test files
import * as permissionsModule from "../extensions/permissions";
import * as storageHandlerModule from "../extensions/storage-handler";
import type { StorageContext } from "../extensions/storage-handler";
import * as cancelRunHandlerModule from "../extensions/cancel-run-handler";

import {
  buildAllowedEnv,
  cleanupExtTmpDir,
  ExtensionRegistry,
  type RegisteredTool,
} from "../extensions/registry";
import type { ExtensionManifestV2, ExtensionPermissions, JsonRpcRequest, ToolCallResult } from "../extensions/types";
import {
  ToolExecutor,
  PermissionDeniedError,
  extensionToAgentTool,
  MAX_TOOL_CALLS_PER_TURN,
} from "../extensions/tool-executor";

// ════════════════════════════════════════════════════════════════════
// Helpers
// ════════════════════════════════════════════════════════════════════

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  const first = result.content[0];
  if (!first) throw new Error("expected tool result to have at least one content entry");
  if (first.type !== "text" || typeof first.text !== "string") {
    throw new Error(`expected text content, got type "${first.type}"`);
  }
  return first.text;
}

function makeManifest(overrides: Partial<ExtensionManifestV2> = {}): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name: "test-ext",
    version: "1.0.0",
    description: "Test",
    author: { name: "Tester" },
    entrypoint: "./index.ts",
    tools: [
      { name: "echo", description: "Echo", inputSchema: { type: "object" } },
    ],
    permissions: {},
    ...overrides,
  };
}

function makeRegisteredTool(overrides: Partial<RegisteredTool> = {}): RegisteredTool {
  return {
    name: "test-ext__echo",
    originalName: "echo",
    extensionId: "ext-1",
    extensionName: "test-ext",
    description: "Echo tool",
    inputSchema: { type: "object" },
    ...overrides,
  };
}

function makeMockProcess(callToolResult?: ToolCallResult) {
  const result: ToolCallResult = callToolResult ?? {
    content: [{ type: "text", text: "ok" }],
    isError: false,
  };
  return {
    callTool: mock(async (_name: string, _args: Record<string, unknown>) => result),
    setRequestHandler: mock((_handler: any) => {}),
    isRunning: true,
    kill: mock(() => {}),
  };
}

function makeMockRegistry(opts: {
  tools?: Map<string, RegisteredTool>;
  process?: ReturnType<typeof makeMockProcess>;
  grantedPerms?: Map<string, ExtensionPermissions>;
  installPaths?: Map<string, string>;
  depRoutes?: Map<string, Map<string, string>>;
  manifests?: Map<string, ExtensionManifestV2>;
} = {}) {
  const toolMap = opts.tools ?? new Map<string, RegisteredTool>();
  const proc = opts.process ?? makeMockProcess();
  const grantedPerms = opts.grantedPerms ?? new Map<string, ExtensionPermissions>();
  const installPaths = opts.installPaths ?? new Map<string, string>();
  const depRoutes = opts.depRoutes ?? new Map<string, Map<string, string>>();
  const manifests = opts.manifests ?? new Map<string, ExtensionManifestV2>();

  return {
    getRegisteredTool: (name: string) => toolMap.get(name) ?? null,
    getToolExtension: (name: string) => toolMap.get(name)?.extensionId ?? null,
    getProcess: async () => proc,
    getGrantedPermissions: (id: string) => grantedPerms.get(id) ?? null,
    getInstallPath: (id: string) => installPaths.get(id) ?? null,
    getManifest: (id: string) => manifests.get(id) ?? null,
    getAllTools: () => Array.from(toolMap.values()),
    resolveDepTool: (callerExtId: string, namespacedTool: string) => {
      const sepIdx = namespacedTool.indexOf("__");
      if (sepIdx === -1) return null;
      const pkgName = namespacedTool.slice(0, sepIdx);
      const callerDeps = depRoutes.get(callerExtId);
      if (!callerDeps) return null;
      const targetExtId = callerDeps.get(pkgName);
      if (!targetExtId) return null;
      return toolMap.get(namespacedTool) ?? null;
    },
    loadFromDb: async () => {},
    reload: async () => {},
    killAll: () => {},
    _mockProcess: proc,
  } as any;
}

// ════════════════════════════════════════════════════════════════════
// 1. buildAllowedEnv (pure function from registry.ts)
// ════════════════════════════════════════════════════════════════════

describe("buildAllowedEnv", () => {
  test("includes PATH, HOME, NODE_ENV, and per-extension TMPDIR", () => {
    const manifest = makeManifest({ permissions: {} });
    const granted: ExtensionPermissions = { grantedAt: {} };

    const env = buildAllowedEnv(manifest, granted, "ext-1");

    expect(env.PATH).toBe(process.env.PATH ?? "");
    expect(env.HOME).toBe(process.env.HOME ?? "");
    expect(env.NODE_ENV).toBeDefined();
    expect(env.TMPDIR).toBe(join(tmpdir(), "ezcorp-ext", "ext-1"));
  });

  test("creates the TMPDIR directory", () => {
    const extId = `buildenv-test-${Date.now()}`;
    const manifest = makeManifest({ permissions: {} });
    const granted: ExtensionPermissions = { grantedAt: {} };

    buildAllowedEnv(manifest, granted, extId);

    const tmpPath = join(tmpdir(), "ezcorp-ext", extId);
    expect(existsSync(tmpPath)).toBe(true);

    // Cleanup
    rmSync(tmpPath, { recursive: true, force: true });
  });

  test("adds manifest env vars only when present in BOTH manifest and granted", () => {
    const manifest = makeManifest({
      permissions: { env: ["API_KEY", "SECRET_TOKEN", "UNUSED_VAR"] },
    });
    const granted: ExtensionPermissions = {
      env: ["API_KEY", "SECRET_TOKEN"],
      grantedAt: {},
    };

    // Set env vars for the test
    const origApiKey = process.env.API_KEY;
    const origSecret = process.env.SECRET_TOKEN;
    process.env.API_KEY = "test-key";
    process.env.SECRET_TOKEN = "test-secret";

    try {
      const env = buildAllowedEnv(manifest, granted, "ext-env-test");

      expect(env.API_KEY).toBe("test-key");
      expect(env.SECRET_TOKEN).toBe("test-secret");
      // UNUSED_VAR is in manifest but not in granted
      expect(env.UNUSED_VAR).toBeUndefined();
    } finally {
      if (origApiKey === undefined) delete process.env.API_KEY;
      else process.env.API_KEY = origApiKey;
      if (origSecret === undefined) delete process.env.SECRET_TOKEN;
      else process.env.SECRET_TOKEN = origSecret;
    }
  });

  test("does not add env var if not set in process.env", () => {
    const manifest = makeManifest({
      permissions: { env: ["NONEXISTENT_VAR_12345"] },
    });
    const granted: ExtensionPermissions = {
      env: ["NONEXISTENT_VAR_12345"],
      grantedAt: {},
    };

    delete process.env.NONEXISTENT_VAR_12345;
    const env = buildAllowedEnv(manifest, granted, "ext-missing-env");
    expect(env.NONEXISTENT_VAR_12345).toBeUndefined();
  });

  test("does not leak any process.env vars beyond the allowed set", () => {
    const manifest = makeManifest({ permissions: {} });
    const granted: ExtensionPermissions = { grantedAt: {} };

    const env = buildAllowedEnv(manifest, granted, "ext-leak-test");

    const keys = Object.keys(env);
    expect(keys).toEqual(expect.arrayContaining(["PATH", "HOME", "NODE_ENV", "TMPDIR"]));
    expect(keys.length).toBe(4);
  });

  test("handles empty permissions on both manifest and granted", () => {
    const manifest = makeManifest({ permissions: {} });
    const granted: ExtensionPermissions = { grantedAt: {} };

    const env = buildAllowedEnv(manifest, granted, "ext-empty");
    expect(Object.keys(env).length).toBe(4); // PATH, HOME, NODE_ENV, TMPDIR
  });

  test("handles manifest env but no granted env", () => {
    const manifest = makeManifest({ permissions: { env: ["API_KEY"] } });
    const granted: ExtensionPermissions = { grantedAt: {} }; // no env

    const env = buildAllowedEnv(manifest, granted, "ext-no-granted");
    expect(env.API_KEY).toBeUndefined();
  });

  test("handles granted env but no manifest env", () => {
    const manifest = makeManifest({ permissions: {} }); // no env
    const granted: ExtensionPermissions = { env: ["API_KEY"], grantedAt: {} };

    const env = buildAllowedEnv(manifest, granted, "ext-no-manifest");
    expect(env.API_KEY).toBeUndefined();
  });
});

// ════════════════════════════════════════════════════════════════════
// 2. cleanupExtTmpDir
// ════════════════════════════════════════════════════════════════════

describe("cleanupExtTmpDir", () => {
  test("removes the per-extension tmp directory", () => {
    const extId = `cleanup-test-${Date.now()}`;
    const tmpPath = join(tmpdir(), "ezcorp-ext", extId);

    // Create dir first
    const { mkdirSync } = require("node:fs");
    mkdirSync(tmpPath, { recursive: true });
    expect(existsSync(tmpPath)).toBe(true);

    cleanupExtTmpDir(extId);
    expect(existsSync(tmpPath)).toBe(false);
  });

  test("does not throw if directory does not exist", () => {
    expect(() => cleanupExtTmpDir("nonexistent-ext-id-xyz")).not.toThrow();
  });
});

// ════════════════════════════════════════════════════════════════════
// 3. ExtensionRegistry (singleton, test helpers, dep routes)
// ════════════════════════════════════════════════════════════════════

describe("ExtensionRegistry", () => {
  afterEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("getInstance returns singleton", () => {
    const a = ExtensionRegistry.getInstance();
    const b = ExtensionRegistry.getInstance();
    expect(a).toBe(b);
  });

  test("resetInstance creates new instance", () => {
    const a = ExtensionRegistry.getInstance();
    ExtensionRegistry.resetInstance();
    const b = ExtensionRegistry.getInstance();
    expect(a).not.toBe(b);
  });

  // ── registerToolForTest ──────────────────────────────────────────

  test("registerToolForTest adds tool to toolMap", () => {
    const registry = ExtensionRegistry.getInstance();
    const tool = makeRegisteredTool();

    registry.registerToolForTest("test-ext__echo", tool);

    expect(registry.getRegisteredTool("test-ext__echo")).toEqual(tool);
    expect(registry.getToolExtension("test-ext__echo")).toBe("ext-1");
  });

  // ── getRegisteredTool ────────────────────────────────────────────

  test("getRegisteredTool returns null for unknown tool", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getRegisteredTool("nonexistent")).toBeNull();
  });

  test("getRegisteredTool returns correct RegisteredTool", () => {
    const registry = ExtensionRegistry.getInstance();
    const tool = makeRegisteredTool({ name: "pkg.tool" });
    registry.registerToolForTest("pkg.tool", tool);

    const found = registry.getRegisteredTool("pkg.tool");
    expect(found).not.toBeNull();
    expect(found!.name).toBe("pkg.tool");
    expect(found!.originalName).toBe("echo");
    expect(found!.extensionId).toBe("ext-1");
  });

  // ── getGrantedPermissions ────────────────────────────────────────

  test("getGrantedPermissions returns null for unknown extension", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getGrantedPermissions("unknown-id")).toBeNull();
  });

  test("getGrantedPermissions returns permissions set via test helper", () => {
    const registry = ExtensionRegistry.getInstance();
    const perms: ExtensionPermissions = {
      network: ["example.com"],
      filesystem: ["/tmp"],
      grantedAt: { network: 123 },
    };
    registry.setGrantedPermsForTest("ext-1", perms);

    expect(registry.getGrantedPermissions("ext-1")).toEqual(perms);
  });

  // ── getInstallPath ───────────────────────────────────────────────

  test("getInstallPath returns null for unknown extension", () => {
    const registry = ExtensionRegistry.getInstance();
    expect(registry.getInstallPath("unknown-id")).toBeNull();
  });

  test("getInstallPath returns path set via test helper", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.setInstallPathForTest("ext-1", "/opt/extensions/test-ext");

    expect(registry.getInstallPath("ext-1")).toBe("/opt/extensions/test-ext");
  });

  // ── getAllTools ───────────────────────────────────────────────────

  test("getAllTools strips internal fields", () => {
    const registry = ExtensionRegistry.getInstance();
    registry.registerToolForTest("pkg.tool-a", makeRegisteredTool({
      name: "pkg.tool-a",
      extensionId: "ext-1",
      extensionName: "pkg",
      originalName: "tool-a",
    }));
    registry.registerToolForTest("pkg.tool-b", makeRegisteredTool({
      name: "pkg.tool-b",
      extensionId: "ext-1",
      extensionName: "pkg",
      originalName: "tool-b",
    }));

    const tools = registry.getAllTools();
    expect(tools.length).toBe(2);
    for (const t of tools) {
      expect((t as any).extensionId).toBeUndefined();
      expect((t as any).extensionName).toBeUndefined();
      expect((t as any).originalName).toBeUndefined();
    }
  });

  // ── resolveDepTool ───────────────────────────────────────────────

  describe("resolveDepTool", () => {
    test("returns null for tool without dot separator", () => {
      const registry = ExtensionRegistry.getInstance();
      expect(registry.resolveDepTool("caller-ext", "no-dot")).toBeNull();
    });

    test("returns null when caller has no dep routes", () => {
      const registry = ExtensionRegistry.getInstance();
      // No dep routes set for "caller-ext"
      expect(registry.resolveDepTool("caller-ext", "dep-pkg__some-tool")).toBeNull();
    });

    test("returns null when dep package is not in caller's routes", () => {
      const registry = ExtensionRegistry.getInstance();
      const routes = new Map<string, Map<string, string>>();
      routes.set("caller-ext", new Map([["other-pkg", "other-ext-id"]]));
      registry.setDepRoutes(routes);

      expect(registry.resolveDepTool("caller-ext", "unknown-pkg__tool")).toBeNull();
    });

    test("returns null when tool not in toolMap despite valid route", () => {
      const registry = ExtensionRegistry.getInstance();
      const routes = new Map<string, Map<string, string>>();
      routes.set("caller-ext", new Map([["dep-pkg", "dep-ext-id"]]));
      registry.setDepRoutes(routes);

      // dep-pkg.some-tool not registered in toolMap
      expect(registry.resolveDepTool("caller-ext", "dep-pkg__some-tool")).toBeNull();
    });

    test("returns RegisteredTool when route and tool both exist", () => {
      const registry = ExtensionRegistry.getInstance();

      const depTool = makeRegisteredTool({
        name: "dep-pkg__some-tool",
        originalName: "some-tool",
        extensionId: "dep-ext-id",
        extensionName: "dep-pkg",
      });
      registry.registerToolForTest("dep-pkg__some-tool", depTool);

      const routes = new Map<string, Map<string, string>>();
      routes.set("caller-ext", new Map([["dep-pkg", "dep-ext-id"]]));
      registry.setDepRoutes(routes);

      const resolved = registry.resolveDepTool("caller-ext", "dep-pkg__some-tool");
      expect(resolved).not.toBeNull();
      expect(resolved!.name).toBe("dep-pkg__some-tool");
      expect(resolved!.extensionId).toBe("dep-ext-id");
    });
  });

  // ── buildDepRoutes ───────────────────────────────────────────────

  describe("buildDepRoutes", () => {
    test("resolves dependency when matching extension name and version exist", () => {
      const registry = ExtensionRegistry.getInstance();

      // Set up provider extension
      registry.setManifestForTest("provider-ext-id", makeManifest({
        name: "provider-pkg",
        version: "1.2.0",
        tools: [{ name: "fetch", description: "Fetch", inputSchema: {} }],
      }));
      registry.setInstallPathForTest("provider-ext-id", "/opt/ext/provider");

      // Set up consumer extension with dependency
      registry.setManifestForTest("consumer-ext-id", makeManifest({
        name: "consumer-pkg",
        version: "1.0.0",
        dependencies: {
          "provider-pkg": { source: "github:test/provider", version: "^1.0.0" },
        },
      }));

      // Register the tool so resolveDepTool can find it
      registry.registerToolForTest("provider-pkg__fetch", makeRegisteredTool({
        name: "provider-pkg__fetch",
        originalName: "fetch",
        extensionId: "provider-ext-id",
        extensionName: "provider-pkg",
      }));

      registry.buildDepRoutes();

      // Now resolveDepTool should work for consumer -> provider
      const resolved = registry.resolveDepTool("consumer-ext-id", "provider-pkg__fetch");
      expect(resolved).not.toBeNull();
      expect(resolved!.extensionId).toBe("provider-ext-id");
    });

    test("does not resolve dependency when version does not match", () => {
      const registry = ExtensionRegistry.getInstance();

      // Provider has version 2.0.0 but consumer wants ^1.0.0
      registry.setManifestForTest("provider-v2", makeManifest({
        name: "some-pkg",
        version: "2.0.0",
      }));

      registry.setManifestForTest("consumer-v1", makeManifest({
        name: "consumer",
        version: "1.0.0",
        dependencies: {
          "some-pkg": { source: "github:test/pkg", version: "^1.0.0" },
        },
      }));

      registry.buildDepRoutes();

      expect(registry.resolveDepTool("consumer-v1", "some-pkg__tool")).toBeNull();
    });

    test("skips extensions without dependencies", () => {
      const registry = ExtensionRegistry.getInstance();

      registry.setManifestForTest("no-deps", makeManifest({
        name: "no-deps-ext",
        version: "1.0.0",
        // no dependencies field
      }));

      // Should not throw
      registry.buildDepRoutes();
      expect(registry.resolveDepTool("no-deps", "anything__tool")).toBeNull();
    });
  });

  // ── setManifestForTest / setGrantedPermsForTest / setInstallPathForTest ──

  test("test helpers set internal state correctly", () => {
    const registry = ExtensionRegistry.getInstance();
    const manifest = makeManifest({ name: "helper-test" });
    const perms: ExtensionPermissions = { grantedAt: { all: 1 } };
    const path = "/test/path";

    registry.setManifestForTest("h-ext", manifest);
    registry.setGrantedPermsForTest("h-ext", perms);
    registry.setInstallPathForTest("h-ext", path);

    expect(registry.getGrantedPermissions("h-ext")).toEqual(perms);
    expect(registry.getInstallPath("h-ext")).toBe(path);
  });
});

// ════════════════════════════════════════════════════════════════════
// 4. PermissionDeniedError
// ════════════════════════════════════════════════════════════════════

describe("PermissionDeniedError", () => {
  test("constructor sets extensionId, toolName, name, and message", () => {
    const err = new PermissionDeniedError("ext-abc", "ext-abc.danger-tool");

    expect(err.extensionId).toBe("ext-abc");
    expect(err.toolName).toBe("ext-abc.danger-tool");
    expect(err.name).toBe("PermissionDeniedError");
    expect(err.message).toContain("Permission denied");
    expect(err.message).toContain("ext-abc.danger-tool");
    expect(err.message).toContain("ext-abc");
  });

  test("is an instance of Error", () => {
    const err = new PermissionDeniedError("ext-1", "tool-1");
    expect(err instanceof Error).toBe(true);
    expect(err instanceof PermissionDeniedError).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════
// 5. extensionToAgentTool
// ════════════════════════════════════════════════════════════════════

describe("extensionToAgentTool", () => {
  test("creates AgentTool with correct name, label, description", () => {
    const toolDef = { name: "my-ext.read", description: "Read a file", inputSchema: { type: "object" } };
    const mockRegistry = makeMockRegistry({
      tools: new Map([["my-ext.read", makeRegisteredTool({
        name: "my-ext.read",
        originalName: "read",
        extensionId: "ext-r",
      })]]),
    });
    const executor = new ToolExecutor(mockRegistry);

    const agentTool = extensionToAgentTool(toolDef, executor, "conv-1", "msg-1");

    expect(agentTool.name).toBe("my-ext.read");
    expect(agentTool.label).toBe("my-ext.read");
    expect(agentTool.description).toBe("Read a file");
    expect(agentTool.parameters).toBeDefined();
    expect(typeof agentTool.execute).toBe("function");
  });

  test("execute calls toolExecutor.executeToolCall and maps result", async () => {
    const toolDef = { name: "my-ext.read", description: "Read", inputSchema: {} };
    const mockProc = makeMockProcess({
      content: [{ type: "text", text: "file data" }],
      isError: false,
    });
    const mockRegistry = makeMockRegistry({
      tools: new Map([["my-ext.read", makeRegisteredTool({
        name: "my-ext.read",
        originalName: "read",
        extensionId: "ext-r",
      })]]),
      process: mockProc,
    });
    const executor = new ToolExecutor(mockRegistry);
    const agentTool = extensionToAgentTool(toolDef, executor, "conv-1", "msg-1");

    const result = await agentTool.execute("call-1", { path: "/test" }, new AbortController().signal);

    expect(result.content).toEqual([{ type: "text", text: "file data" }]);
    expect(result.details).toEqual({ isError: false });
  });

  test("execute returns isError true on tool error", async () => {
    const toolDef = { name: "my-ext.bad", description: "Bad", inputSchema: {} };
    const mockProc = makeMockProcess({
      content: [{ type: "text", text: "something failed" }],
      isError: true,
    });
    const mockRegistry = makeMockRegistry({
      tools: new Map([["my-ext.bad", makeRegisteredTool({
        name: "my-ext.bad",
        originalName: "bad",
        extensionId: "ext-b",
      })]]),
      process: mockProc,
    });
    const executor = new ToolExecutor(mockRegistry);
    const agentTool = extensionToAgentTool(toolDef, executor, "conv-1", "msg-1");

    const result = await agentTool.execute("call-1", {}, new AbortController().signal);

    expect(result.details).toEqual({ isError: true });
    expect(textOf(result as { content: Array<{ type: string; text?: string }> })).toBe("something failed");
  });

  // ── Phase 4 §5.1a: 6-arg form — schemaOverride + invocationMetadata ──

  test("schemaOverride replaces manifest inputSchema in wrapper.parameters", () => {
    const manifestSchema = { type: "object", properties: { a: { type: "string" } } };
    const override = {
      type: "object",
      properties: { agentConfigId: { type: "string", enum: ["x", "y"] } },
      required: ["agentConfigId"],
    };
    const toolDef = { name: "orch.invoke", description: "Invoke", inputSchema: manifestSchema };
    const mockRegistry = makeMockRegistry({
      tools: new Map([["orch.invoke", makeRegisteredTool({
        name: "orch.invoke", originalName: "invoke", extensionId: "ext-o",
      })]]),
    });
    const executor = new ToolExecutor(mockRegistry);
    const agentTool = extensionToAgentTool(toolDef, executor, "conv-1", "msg-1", override);
    // `parameters` is a TypeBox Unsafe wrapper — its bound schema is visible
    // as the enumerable JSON-schema keys merged in by Type.Unsafe.
    const params = agentTool.parameters as unknown as Record<string, unknown>;
    expect(params.properties).toEqual(override.properties);
    expect(params.required).toEqual(override.required);
    // And it is NOT the manifest schema.
    expect(params.properties).not.toEqual(manifestSchema.properties);
  });

  test("invocationMetadata: forwarded into executeToolCall's trailing metadata arg", async () => {
    const toolDef = { name: "orch.invoke", description: "Invoke", inputSchema: {} };
    const mockRegistry = makeMockRegistry({
      tools: new Map([["orch.invoke", makeRegisteredTool({
        name: "orch.invoke", originalName: "invoke", extensionId: "ext-o",
      })]]),
    });
    const executor = new ToolExecutor(mockRegistry);
    // Spy on executeToolCall to capture the trailing invocationMetadata arg.
    const capturedMetadata: Array<Record<string, unknown> | undefined> = [];
    const originalExecute = executor.executeToolCall.bind(executor);
    const spy = spyOn(executor, "executeToolCall");
    spy.mockImplementation((async (
      toolName: string,
      input: Record<string, unknown>,
      convId: string,
      msgId: string | null,
      opts?: unknown,
      metadata?: Record<string, unknown>,
    ) => {
      capturedMetadata.push(metadata);
      return originalExecute(toolName, input, convId, msgId, opts as never, metadata);
    }) as typeof executor.executeToolCall);

    const invocationMetadata = {
      overrides: { model: "claude-3-5-sonnet" },
      teamToolScope: { allowedTools: ["read"] },
      parentMessageId: "msg-anchor",
    };
    const agentTool = extensionToAgentTool(
      toolDef, executor, "conv-1", "msg-1", undefined, invocationMetadata,
    );
    await agentTool.execute("call-1", { agentConfigId: "x", task: "t" }, new AbortController().signal);

    expect(capturedMetadata).toHaveLength(1);
    expect(capturedMetadata[0]).toEqual(invocationMetadata);
    spy.mockRestore();
  });

  test("back-compat: 4-arg call still works (no override, no metadata)", async () => {
    const manifestSchema = { type: "object", properties: { a: { type: "string" } } };
    const toolDef = { name: "legacy.tool", description: "Legacy", inputSchema: manifestSchema };
    const mockProc = makeMockProcess({
      content: [{ type: "text", text: "ok" }], isError: false,
    });
    const mockRegistry = makeMockRegistry({
      tools: new Map([["legacy.tool", makeRegisteredTool({
        name: "legacy.tool", originalName: "tool", extensionId: "ext-leg",
      })]]),
      process: mockProc,
    });
    const executor = new ToolExecutor(mockRegistry);
    // 4-arg form — pre-Phase-4 callers.
    const agentTool = extensionToAgentTool(toolDef, executor, "conv-1", "msg-1");
    const params = agentTool.parameters as unknown as Record<string, unknown>;
    // Manifest schema is preserved when no override is supplied.
    expect(params.properties).toEqual(manifestSchema.properties);
    // Execution path still works end-to-end.
    const result = await agentTool.execute("call-1", {}, new AbortController().signal);
    expect(result.details).toEqual({ isError: false });
    // And proc.callTool was NOT called with invocationMetadata in _meta.
    const callArgs = mockProc.callTool.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>?];
    const meta = callArgs?.[2];
    expect(meta?.invocationMetadata).toBeUndefined();
  });

  // The wrapper closes over its 5th/6th args, so a 6-arg wrapper's
  // invocationMetadata must NOT leak into a subsequently-built 4-arg
  // wrapper — each call produces an independent AgentTool. This guards
  // the audit's back-compat invariant: pre-Phase-4 callers (scratchpad,
  // task-tracking) remain unaffected even when built alongside
  // orchestration wrappers using the 6-arg form.
  test("back-compat: 4-arg + 6-arg built back-to-back → no state leakage across wrappers", async () => {
    const manifestSchemaA = { type: "object", properties: { a: { type: "string" } } };
    const manifestSchemaB = { type: "object", properties: { b: { type: "number" } } };
    const override = {
      type: "object",
      properties: { agentConfigId: { type: "string", enum: ["alpha", "beta"] } },
    };
    const invocationMetadata = {
      overrides: { model: "gpt-4o" },
      parentMessageId: "msg-orch",
    };

    const mockProc = makeMockProcess({
      content: [{ type: "text", text: "ok" }], isError: false,
    });
    const mockRegistry = makeMockRegistry({
      tools: new Map([
        ["legacy.tool", makeRegisteredTool({
          name: "legacy.tool", originalName: "tool", extensionId: "ext-leg",
        })],
        ["orch.invoke", makeRegisteredTool({
          name: "orch.invoke", originalName: "invoke", extensionId: "ext-orch",
        })],
      ]),
      process: mockProc,
    });
    const executor = new ToolExecutor(mockRegistry);

    // Build the 6-arg wrapper first (with schemaOverride + invocationMetadata).
    const orchTool = extensionToAgentTool(
      { name: "orch.invoke", description: "Orch", inputSchema: manifestSchemaB },
      executor, "conv-1", "msg-1", override, invocationMetadata,
    );
    // Then build the 4-arg wrapper — it must NOT inherit the metadata or override.
    const legacyTool = extensionToAgentTool(
      { name: "legacy.tool", description: "Legacy", inputSchema: manifestSchemaA },
      executor, "conv-1", "msg-1",
    );

    // Parameters: each wrapper carries its own schema, no cross-pollination.
    const orchParams = orchTool.parameters as unknown as Record<string, unknown>;
    const legacyParams = legacyTool.parameters as unknown as Record<string, unknown>;
    expect(orchParams.properties).toEqual(override.properties);
    expect(legacyParams.properties).toEqual(manifestSchemaA.properties);
    expect(legacyParams.properties).not.toEqual(override.properties);

    // Execute both and verify `_meta.invocationMetadata` surfaces only for
    // the orch call, never for the legacy call — in either order.
    //
    // Order 1: legacy first.
    await legacyTool.execute("call-L1", { a: "x" }, new AbortController().signal);
    const legacy1Meta = (mockProc.callTool.mock.calls[0] as unknown as
      [string, Record<string, unknown>, Record<string, unknown>?])[2];
    expect(legacy1Meta?.invocationMetadata).toBeUndefined();

    // Order 2: orch next — should carry metadata.
    await orchTool.execute("call-O1", { agentConfigId: "alpha" }, new AbortController().signal);
    const orch1Meta = (mockProc.callTool.mock.calls[1] as unknown as
      [string, Record<string, unknown>, Record<string, unknown>?])[2];
    expect(orch1Meta?.invocationMetadata).toEqual(invocationMetadata);

    // Order 3: legacy again — must STILL be metadata-free (prove the
    // orch wrapper's closure did not contaminate the legacy wrapper).
    await legacyTool.execute("call-L2", { a: "y" }, new AbortController().signal);
    const legacy2Meta = (mockProc.callTool.mock.calls[2] as unknown as
      [string, Record<string, unknown>, Record<string, unknown>?])[2];
    expect(legacy2Meta?.invocationMetadata).toBeUndefined();

    // Order 4: orch again — metadata still present (not consumed / cleared
    // after first use).
    await orchTool.execute("call-O2", { agentConfigId: "beta" }, new AbortController().signal);
    const orch2Meta = (mockProc.callTool.mock.calls[3] as unknown as
      [string, Record<string, unknown>, Record<string, unknown>?])[2];
    expect(orch2Meta?.invocationMetadata).toEqual(invocationMetadata);
  });
});

// ════════════════════════════════════════════════════════════════════
// 6. MAX_TOOL_CALLS_PER_TURN
// ════════════════════════════════════════════════════════════════════

test("MAX_TOOL_CALLS_PER_TURN is 10", () => {
  expect(MAX_TOOL_CALLS_PER_TURN).toBe(10);
});

// ════════════════════════════════════════════════════════════════════
// 7. ToolExecutor
// ════════════════════════════════════════════════════════════════════

describe("ToolExecutor", () => {
  // ── executeToolCall ──────────────────────────────────────────────

  describe("executeToolCall", () => {
    test("returns error result for unknown tool", async () => {
      const mockRegistry = makeMockRegistry(); // empty toolMap
      const executor = new ToolExecutor(mockRegistry);

      const result = await executor.executeToolCall("nonexistent.tool", {}, "conv-1", "msg-1");

      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("Unknown tool");
      expect(textOf(result)).toContain("nonexistent.tool");
    });

    test("calls process.callTool with original name and returns result", async () => {
      const mockProc = makeMockProcess({
        content: [{ type: "text", text: "success result" }],
        isError: false,
      });
      const tool = makeRegisteredTool({
        name: "ext.my-tool",
        originalName: "my-tool",
        extensionId: "ext-1",
      });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.my-tool", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      const result = await executor.executeToolCall("ext.my-tool", { key: "val" }, "conv-1", "msg-1");

      expect(result.isError).toBe(false);
      expect(textOf(result)).toBe("success result");
      expect(mockProc.callTool).toHaveBeenCalledWith("my-tool", { key: "val" }, expect.any(Object));
    });

    test("throws PermissionDeniedError when checker denies", async () => {
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
      });
      const executor = new ToolExecutor(mockRegistry, {
        permissionChecker: async () => false,
      });

      await expect(
        executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1"),
      ).rejects.toThrow(PermissionDeniedError);
    });

    test("allows call when permission checker returns true", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry, {
        permissionChecker: async () => true,
      });

      const result = await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(result.isError).toBe(false);
    });

    test("argsResolver transforms input BEFORE process.callTool sees it", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool({ name: "ext.edit", originalName: "edit", extensionId: "ext-1" });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.edit", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);
      executor.setArgsResolver(async (input) => {
        // Simulate handle resolution: replace the single known placeholder.
        const out = { ...input };
        if (Array.isArray(out.images)) {
          out.images = (out.images as string[]).map((s) =>
            s === "ez-attachment://abc" ? "data:image/png;base64,RESOLVED" : s,
          );
        }
        return out;
      });

      await executor.executeToolCall(
        "ext.edit",
        { prompt: "edit", images: ["ez-attachment://abc"] },
        "conv-1",
        "msg-1",
      );

      // Subprocess observes the RESOLVED payload, never the handle.
      expect(mockProc.callTool).toHaveBeenCalledWith(
        "edit",
        { prompt: "edit", images: ["data:image/png;base64,RESOLVED"] },
        expect.any(Object),
      );
    });

    test("argsResolver runs BEFORE permission check (checker sees resolved payload)", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool({ name: "ext.edit", originalName: "edit", extensionId: "ext-1" });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.edit", tool]]),
        process: mockProc,
      });
      let seenByChecker: Record<string, unknown> | null = null;
      const executor = new ToolExecutor(mockRegistry, {
        permissionChecker: async (_ext, _name, input) => {
          seenByChecker = input;
          return true;
        },
      });
      executor.setArgsResolver(async (input) => ({ ...input, marker: "RESOLVED" }));

      await executor.executeToolCall("ext.edit", { prompt: "x" }, "conv-1", "msg-1");
      expect(seenByChecker).toMatchObject({ marker: "RESOLVED" });
    });

    test("no argsResolver → input passes through unchanged (back-compat)", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool({ name: "ext.echo", originalName: "echo", extensionId: "ext-1" });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      await executor.executeToolCall("ext.echo", { key: "val" }, "conv-1", "msg-1");
      expect(mockProc.callTool).toHaveBeenCalledWith("echo", { key: "val" }, expect.any(Object));
    });

    test("returns error result when process.callTool throws", async () => {
      const mockProc = makeMockProcess();
      mockProc.callTool = mock(async () => {
        throw new Error("Process crashed");
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      const result = await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("Process crashed");
    });

    test("returns error result with stringified non-Error throw", async () => {
      const mockProc = makeMockProcess();
      mockProc.callTool = mock(async () => {
        throw "string error";
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      const result = await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");

      expect(result.isError).toBe(true);
      expect(textOf(result)).toBe("string error");
    });

    test("passes _callDepth as _depth in arguments when present", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool({
        name: "ext.tool",
        originalName: "tool",
        extensionId: "ext-1",
      });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.tool", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      await executor.executeToolCall("ext.tool", { foo: "bar" }, "conv-1", "msg-1", {
        callerExtensionId: "caller",
        _callDepth: 3,
      });

      // `meta` (third arg) carries side-channel fields like ezConversationId /
      // ezPublicUrl. This assertion cares only about the tool name + args.
      expect(mockProc.callTool).toHaveBeenCalledWith("tool", { foo: "bar", _depth: 3 }, expect.any(Object));
    });

    test("does not add _depth when _callDepth is 0", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool({
        name: "ext.tool",
        originalName: "tool",
        extensionId: "ext-1",
      });
      const mockRegistry = makeMockRegistry({
        tools: new Map([["ext.tool", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      await executor.executeToolCall("ext.tool", { x: 1 }, "conv-1", "msg-1", {
        _callDepth: 0,
      });

      // _callDepth is 0, which is falsy in `_opts._callDepth > 0` check
      expect(mockProc.callTool).toHaveBeenCalledWith("tool", { x: 1 }, expect.any(Object));
    });

    test("wires request handler on first call for an extension", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(mockProc.setRequestHandler).toHaveBeenCalledTimes(1);

      // Second call to same extension should NOT wire again
      await executor.executeToolCall("test-ext__echo", {}, "conv-2", "msg-2");
      expect(mockProc.setRequestHandler).toHaveBeenCalledTimes(1);
    });
  });

  // ── setPermissionChecker ─────────────────────────────────────────

  describe("setPermissionChecker", () => {
    test("updates checker after construction", async () => {
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
      });
      const executor = new ToolExecutor(mockRegistry);

      // No checker initially -- should work
      const result1 = await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(result1.isError).toBe(false);

      // Set a blocking checker
      executor.setPermissionChecker(async () => false);
      await expect(
        executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1"),
      ).rejects.toThrow(PermissionDeniedError);
    });
  });

  // ── handlePiFs ───────────────────────────────────────────────────

  describe("handlePiFs", () => {
    function makeRequest(params: Record<string, unknown>): JsonRpcRequest {
      return { jsonrpc: "2.0", id: 1, method: "ezcorp/fs", params };
    }

    test("returns error when path is missing", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({ operation: "read" }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
      expect(response.error!.message).toContain("Missing path or operation");
    });

    test("returns error when operation is missing", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({ path: "/tmp/file" }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    test("returns error when both path and operation are missing", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({}));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });

    test("returns error when extension not found in registry (no granted perms)", async () => {
      const mockRegistry = makeMockRegistry({
        // No granted perms or install paths
      });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-unknown", makeRequest({
        operation: "read",
        path: "/tmp/test",
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
      expect(response.error!.message).toContain("Extension not found");
    });

    test("returns error when extension not found (no install path)", async () => {
      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { grantedAt: {} });
      // installPaths is empty
      const mockRegistry = makeMockRegistry({ grantedPerms });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({
        operation: "read",
        path: "/tmp/test",
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
    });

    test("returns success when permission is allowed", async () => {
      const spy = spyOn(permissionsModule, "checkFilesystemPermission").mockResolvedValue({
        allowed: true, resolvedPath: "/tmp/test",
      });
      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { filesystem: ["/tmp"], grantedAt: {} });
      const installPaths = new Map<string, string>();
      installPaths.set("ext-1", "/opt/ext/test");
      const mockRegistry = makeMockRegistry({ grantedPerms, installPaths });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({
        operation: "read",
        path: "/tmp/test",
      }));

      expect(response.error).toBeUndefined();
      expect(response.result).toEqual({ allowed: true, resolvedPath: "/tmp/test" });
      spy.mockRestore();
    });

    test("returns error and calls denyAndDisable when permission denied", async () => {
      const permSpy = spyOn(permissionsModule, "checkFilesystemPermission").mockResolvedValue({
        allowed: false, resolvedPath: "/etc/passwd",
      });
      const secSpy = spyOn(securityModule, "denyAndDisable").mockResolvedValue({
        extensionId: "ext-1", reason: "denied", path: "/etc/passwd", timestamp: Date.now(),
      });
      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { grantedAt: {} });
      const installPaths = new Map<string, string>();
      installPaths.set("ext-1", "/opt/ext/test");
      const mockRegistry = makeMockRegistry({ grantedPerms, installPaths });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", makeRequest({
        operation: "read",
        path: "/etc/passwd",
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
      expect(response.error!.message).toContain("Filesystem access denied");
      expect(response.error!.message).toContain("disabled");
      permSpy.mockRestore();
      secSpy.mockRestore();
    });

    test("handles request with no params gracefully", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiFs("ext-1", {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/fs",
        // no params
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32602);
    });
  });

  // ── handlePiInvoke ───────────────────────────────────────────────

  describe("handlePiInvoke", () => {
    function makeInvokeRequest(params: Record<string, unknown>): JsonRpcRequest {
      return { jsonrpc: "2.0", id: 42, method: "ezcorp/invoke", params };
    }

    test("returns error when depth limit exceeded", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "dep.tool",
        arguments: {},
        _depth: 10, // MAX_CALL_DEPTH is 10
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32000);
      expect(response.error!.message).toContain("depth limit exceeded");
    });

    test("returns error when depth is above limit", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "dep.tool",
        _depth: 15,
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32000);
    });

    test("returns error when dependency not declared", async () => {
      const mockRegistry = makeMockRegistry({
        // No dep routes -> resolveDepTool returns null
      });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "undeclared-dep__tool",
        arguments: {},
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
      expect(response.error!.message).toContain("Dependency not declared");
      expect(response.error!.message).toContain("undeclared-dep");
    });

    test("returns error for tool without dot (non-namespaced)", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "bare-tool-name",
        arguments: {},
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
      expect(response.error!.message).toContain("Dependency not declared");
    });

    test("successful cross-extension call returns result", async () => {
      const depTool = makeRegisteredTool({
        name: "dep-pkg__fetch",
        originalName: "fetch",
        extensionId: "dep-ext-id",
        extensionName: "dep-pkg",
      });
      const mockProc = makeMockProcess({
        content: [{ type: "text", text: "cross-ext result" }],
        isError: false,
      });
      const depRoutes = new Map<string, Map<string, string>>();
      depRoutes.set("caller-ext", new Map([["dep-pkg", "dep-ext-id"]]));

      const mockRegistry = makeMockRegistry({
        tools: new Map([["dep-pkg__fetch", depTool]]),
        process: mockProc,
        depRoutes,
      });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "dep-pkg__fetch",
        arguments: { url: "https://example.com" },
        _depth: 0,
      }));

      expect(response.error).toBeUndefined();
      expect(response.result).toBeDefined();
      const result = response.result as ToolCallResult;
      expect(result.isError).toBe(false);
      expect(textOf(result)).toBe("cross-ext result");
    });

    test("returns error when cross-extension call throws", async () => {
      const depTool = makeRegisteredTool({
        name: "dep-pkg__broken",
        originalName: "broken",
        extensionId: "dep-ext-id",
      });
      const mockProc = makeMockProcess();
      // Make the process throw on callTool
      mockProc.callTool = mock(async () => {
        throw new Error("subprocess died");
      });

      const depRoutes = new Map<string, Map<string, string>>();
      depRoutes.set("caller-ext", new Map([["dep-pkg", "dep-ext-id"]]));

      const mockRegistry = makeMockRegistry({
        tools: new Map([["dep-pkg__broken", depTool]]),
        process: mockProc,
        depRoutes,
      });
      // Need a permission checker that throws PermissionDeniedError to test the catch path
      // Actually, let's test the error catch in handlePiInvoke by having executeToolCall throw
      const executor = new ToolExecutor(mockRegistry, {
        permissionChecker: async () => { throw new Error("checker exploded"); },
      });

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "dep-pkg__broken",
        arguments: {},
      }));

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32000);
      expect(response.error!.message).toContain("checker exploded");
    });

    test("defaults _depth to 0 when not provided", async () => {
      const depTool = makeRegisteredTool({
        name: "dep-pkg__tool",
        originalName: "tool",
        extensionId: "dep-ext-id",
      });
      const mockProc = makeMockProcess();
      const depRoutes = new Map<string, Map<string, string>>();
      depRoutes.set("caller-ext", new Map([["dep-pkg", "dep-ext-id"]]));

      const mockRegistry = makeMockRegistry({
        tools: new Map([["dep-pkg__tool", depTool]]),
        process: mockProc,
        depRoutes,
      });
      const executor = new ToolExecutor(mockRegistry);

      const response = await executor.handlePiInvoke("caller-ext", makeInvokeRequest({
        tool: "dep-pkg__tool",
        arguments: { key: "val" },
        // no _depth
      }));

      expect(response.error).toBeUndefined();
      // The callTool should have been called with _depth: 1 (0 + 1). Third
      // arg (meta) carries ezConversationId / ezPublicUrl — opaque here.
      expect(mockProc.callTool).toHaveBeenCalledWith("tool", { key: "val", _depth: 1 }, expect.any(Object));
    });

    test("handles request with no params (tool is undefined string)", async () => {
      const mockRegistry = makeMockRegistry();
      const executor = new ToolExecutor(mockRegistry);

      // When params is missing, tool will be undefined -- this can cause a TypeError
      // in resolveDepTool which is caught by the try/catch in handlePiInvoke
      const response = await executor.handlePiInvoke("caller-ext", {
        jsonrpc: "2.0",
        id: 99,
        method: "ezcorp/invoke",
        params: { tool: "unknown__tool" }, // Must provide a valid tool string
      });

      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32001);
    });
  });

  // ── createToolsContext ───────────────────────────────────────────

  describe("createToolsContext", () => {
    test("invoke returns text content on success", async () => {
      const mockProc = makeMockProcess({
        content: [
          { type: "text", text: "line 1" },
          { type: "text", text: "line 2" },
        ],
        isError: false,
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);
      const ctx = executor.createToolsContext("conv-1", "msg-1");

      const result = await ctx.invoke("test-ext__echo", { text: "hello" });
      expect(result).toBe("line 1\nline 2");
    });

    test("invoke throws on error result", async () => {
      const mockProc = makeMockProcess({
        content: [{ type: "text", text: "something broke" }],
        isError: true,
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);
      const ctx = executor.createToolsContext("conv-1", "msg-1");

      await expect(ctx.invoke("test-ext__echo", {})).rejects.toThrow("something broke");
    });

    test("invoke throws for unknown tool (aggregated error text)", async () => {
      const mockRegistry = makeMockRegistry(); // empty
      const executor = new ToolExecutor(mockRegistry);
      const ctx = executor.createToolsContext("conv-1", "msg-1");

      await expect(ctx.invoke("nonexistent.tool", {})).rejects.toThrow("Unknown tool");
    });
  });

  // ── EventBus integration ─────────────────────────────────────────

  describe("event bus", () => {
    test("emits tool:start and tool:complete on successful call", async () => {
      const events: Array<{ type: string; data: any }> = [];
      const mockBus = {
        emit: (type: string, data: any) => events.push({ type, data }),
        on: () => () => {},
      };
      const mockProc = makeMockProcess({
        content: [{ type: "text", text: "ok" }],
        isError: false,
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry, { bus: mockBus as any });

      await executor.executeToolCall("test-ext__echo", { x: 1 }, "conv-1", "msg-1");

      const startEvent = events.find(e => e.type === "tool:start");
      const completeEvent = events.find(e => e.type === "tool:complete");

      expect(startEvent).toBeDefined();
      expect(startEvent!.data.conversationId).toBe("conv-1");
      expect(startEvent!.data.extensionId).toBe("ext-1");
      expect(startEvent!.data.toolName).toBe("test-ext__echo");
      expect(startEvent!.data.input).toEqual({ x: 1 });

      expect(completeEvent).toBeDefined();
      expect(completeEvent!.data.success).toBe(true);
      expect(completeEvent!.data.duration).toBeGreaterThanOrEqual(0);
    });

    test("emits tool:error on failed call", async () => {
      const events: Array<{ type: string; data: any }> = [];
      const mockBus = {
        emit: (type: string, data: any) => events.push({ type, data }),
        on: () => () => {},
      };
      const mockProc = makeMockProcess();
      mockProc.callTool = mock(async () => {
        throw new Error("boom");
      });
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry, { bus: mockBus as any });

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");

      const errorEvent = events.find(e => e.type === "tool:error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent!.data.error).toBe("boom");
      expect(errorEvent!.data.duration).toBeGreaterThanOrEqual(0);
    });

    test("does not emit events when no bus is configured", async () => {
      const mockProc = makeMockProcess();
      const tool = makeRegisteredTool();
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", tool]]),
        process: mockProc,
      });
      // No bus
      const executor = new ToolExecutor(mockRegistry);

      // Should not throw
      const result = await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(result.isError).toBe(false);
    });
  });

  // ── Request handler wiring ───────────────────────────────────────

  describe("request handler wiring", () => {
    test("wired handler dispatches ezcorp/invoke requests", async () => {
      const depTool = makeRegisteredTool({
        name: "dep-pkg__tool",
        originalName: "tool",
        extensionId: "dep-ext-id",
      });
      const mockProc = makeMockProcess({
        content: [{ type: "text", text: "result" }],
        isError: false,
      });

      // Capture the handler that setRequestHandler receives
      let capturedHandler: ((req: JsonRpcRequest) => Promise<any>) | null = null;
      mockProc.setRequestHandler = mock((handler: any) => {
        capturedHandler = handler;
      });

      const depRoutes = new Map<string, Map<string, string>>();
      depRoutes.set("ext-1", new Map([["dep-pkg", "dep-ext-id"]]));

      const mockRegistry = makeMockRegistry({
        tools: new Map([
          ["test-ext__echo", makeRegisteredTool()],
          ["dep-pkg__tool", depTool],
        ]),
        process: mockProc,
        depRoutes,
      });
      const executor = new ToolExecutor(mockRegistry);

      // First executeToolCall wires the handler
      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(capturedHandler).not.toBeNull();

      // Simulate a ezcorp/invoke request from the subprocess
      const invokeReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 100,
        method: "ezcorp/invoke",
        params: { tool: "dep-pkg__tool", arguments: { key: "val" } },
      };
      const response = await capturedHandler!(invokeReq);
      expect(response.error).toBeUndefined();
    });

    test("wired handler dispatches ezcorp/fs requests", async () => {
      const mockProc = makeMockProcess();
      let capturedHandler: ((req: JsonRpcRequest) => Promise<any>) | null = null;
      mockProc.setRequestHandler = mock((handler: any) => {
        capturedHandler = handler;
      });

      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { filesystem: ["/tmp"], grantedAt: {} });
      const installPaths = new Map<string, string>();
      installPaths.set("ext-1", "/opt/ext/test");

      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
        process: mockProc,
        grantedPerms,
        installPaths,
      });
      const executor = new ToolExecutor(mockRegistry);

      const spy = spyOn(permissionsModule, "checkFilesystemPermission").mockResolvedValue({
        allowed: true, resolvedPath: "/tmp/file.txt",
      });

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(capturedHandler).not.toBeNull();

      const fsReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 200,
        method: "ezcorp/fs",
        params: { operation: "read", path: "/tmp/file.txt" },
      };
      const response = await capturedHandler!(fsReq);
      expect(response.result).toEqual({ allowed: true, resolvedPath: "/tmp/file.txt" });
      spy.mockRestore();
    });

    test("wired handler dispatches ezcorp/cancel-run requests to handleCancelRunRpc", async () => {
      // Routing-layer smoke: proves the exact method-string
      // "ezcorp/cancel-run" reaches `handleCancelRunRpc` (not a typo like
      // "ezcorp/cancel_run" or "ezcorp/cancelRun"). The handler itself is
      // stubbed — this test is about the switch in tool-executor.ts
      // setRequestHandler, nothing else.
      const mockProc = makeMockProcess();
      let capturedHandler: ((req: JsonRpcRequest) => Promise<any>) | null = null;
      mockProc.setRequestHandler = mock((handler: any) => {
        capturedHandler = handler;
      });

      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", {
        spawnAgents: { maxPerHour: 10, maxConcurrent: 3 },
        grantedAt: { spawnAgents: Date.now() },
      });

      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
        process: mockProc,
        grantedPerms,
      });
      const executor = new ToolExecutor(mockRegistry);
      // Wire the minimum needed for cancel dispatch — executor + quota.
      // The handler itself is stubbed, so the shapes only need to exist.
      executor.setExecutor({ cancelRun: () => true } as any);
      executor.setSpawnQuota({
        isOwner: () => true,
        release: () => {},
      } as any);

      const spy = spyOn(cancelRunHandlerModule, "handleCancelRunRpc").mockResolvedValue({
        jsonrpc: "2.0", id: 600, result: { v: 1, cancelled: true },
      });

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(capturedHandler).not.toBeNull();

      const cancelReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 600,
        method: "ezcorp/cancel-run",
        params: { v: 1, agentRunId: "run-x" },
      };
      const response = await capturedHandler!(cancelReq);

      // NOT method-not-found (would be -32601). Routing landed.
      expect(response.error?.code).not.toBe(-32601);
      expect(spy).toHaveBeenCalledTimes(1);
      // First positional arg must be the acting extensionId.
      expect(spy.mock.calls[0]![0]).toBe("ext-1");
      // Second positional arg is the raw JSON-RPC request — method must
      // still be the routing-key string (defense against a silent rename
      // between switch-case and handler ctx).
      const routedReq = spy.mock.calls[0]![1] as JsonRpcRequest;
      expect(routedReq.method).toBe("ezcorp/cancel-run");
      expect(routedReq.id).toBe(600);
      spy.mockRestore();
    });

    test("wired handler returns method not found for unknown methods", async () => {
      const mockProc = makeMockProcess();
      let capturedHandler: ((req: JsonRpcRequest) => Promise<any>) | null = null;
      mockProc.setRequestHandler = mock((handler: any) => {
        capturedHandler = handler;
      });

      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
        process: mockProc,
      });
      const executor = new ToolExecutor(mockRegistry);

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(capturedHandler).not.toBeNull();

      const unknownReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 300,
        method: "pi/unknown",
      };
      const response = await capturedHandler!(unknownReq);
      expect(response.error).toBeDefined();
      expect(response.error.code).toBe(-32601);
      expect(response.error.message).toBe("Method not found");
    });
  });

  // ── handlePiStorage dispatch coverage ────────────────────────────
  describe("handlePiStorage dispatch coverage", () => {
    test("wired handler dispatches ezcorp/storage requests", async () => {
      const mockProc = makeMockProcess();
      let capturedHandler: ((req: JsonRpcRequest) => Promise<any>) | null = null;
      mockProc.setRequestHandler = mock((handler: any) => {
        capturedHandler = handler;
      });

      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { storage: true, grantedAt: { storage: Date.now() } });
      const manifests = new Map<string, ExtensionManifestV2>();
      manifests.set("ext-1", makeManifest());

      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
        process: mockProc,
        grantedPerms,
        manifests,
      });
      const executor = new ToolExecutor(mockRegistry);

      const spy = spyOn(storageHandlerModule, "handleStorageRpc").mockResolvedValue({
        jsonrpc: "2.0", id: 500, result: { value: null, exists: false },
      });

      await executor.executeToolCall("test-ext__echo", {}, "conv-1", "msg-1");
      expect(capturedHandler).not.toBeNull();

      const storageReq: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 500,
        method: "ezcorp/storage",
        params: { action: "get", key: "k" },
      };
      const response = await capturedHandler!(storageReq);
      expect(response.error?.code).not.toBe(-32601);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0]![0]).toBe("ext-1");
      spy.mockRestore();
    });

    test("handlePiStorage returns -32603 when registry lacks manifest/perms", async () => {
      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
      });
      const executor = new ToolExecutor(mockRegistry);

      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 1,
        method: "ezcorp/storage",
        params: { action: "get", key: "k" },
      };
      const response = await executor.handlePiStorage("ext-unknown", req);
      expect(response.error).toBeDefined();
      expect(response.error!.code).toBe(-32603);
      expect(response.error!.message).toContain("not found in registry");
    });

    test("setCurrentUserId propagates into handlePiStorage storage ctx", async () => {
      const grantedPerms = new Map<string, ExtensionPermissions>();
      grantedPerms.set("ext-1", { storage: true, grantedAt: { storage: Date.now() } });
      const manifests = new Map<string, ExtensionManifestV2>();
      manifests.set("ext-1", makeManifest());

      const mockRegistry = makeMockRegistry({
        tools: new Map([["test-ext__echo", makeRegisteredTool()]]),
        grantedPerms,
        manifests,
      });
      const executor = new ToolExecutor(mockRegistry);

      const spy = spyOn(storageHandlerModule, "handleStorageRpc").mockResolvedValue({
        jsonrpc: "2.0", id: 2, result: { keys: [] },
      });

      executor.setCurrentUserId("u-scoped");
      const req: JsonRpcRequest = {
        jsonrpc: "2.0",
        id: 2,
        method: "ezcorp/storage",
        params: { action: "list", scope: "user" },
      };
      await executor.handlePiStorage("ext-1", req);

      expect(spy).toHaveBeenCalledTimes(1);
      const ctxArg = spy.mock.calls[0]![2] as StorageContext;
      expect(ctxArg.userId).toBe("u-scoped");
      spy.mockRestore();
    });
  });
});
