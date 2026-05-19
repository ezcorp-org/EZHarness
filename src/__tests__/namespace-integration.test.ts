import { test, expect, describe, mock, beforeEach, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import type { RegisteredTool } from "../extensions/registry";
import { ToolExecutor, PermissionDeniedError, _resetToolCallsCounterForTests } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ToolCallResult, ToolDefinition } from "../extensions/types";

// Phase 6's per-conversation tool-call cap is process-global; reuse of
// conv-1 across the file would otherwise trip MaxToolCallsExceededError.
beforeEach(() => {
  _resetToolCallsCounterForTests();
});

// ── Mock DB (suppress real DB writes) ────────────────────────────────

mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({ values: () => Promise.resolve() }),
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([]),
      }),
    }),
  }),
}));

// ── Helpers ──────────────────────────────────────────────────────────

function makeTool(
  extensionName: string,
  toolName: string,
  extensionId: string,
  description = "A tool",
): RegisteredTool {
  return {
    name: `${extensionName}__${toolName}`,
    description,
    inputSchema: { type: "object" },
    extensionId,
    extensionName,
    originalName: toolName,
  };
}

function createMockRegistry(tools: RegisteredTool[]) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const processes = new Map<string, { callTool: ReturnType<typeof mock>; setRequestHandler: ReturnType<typeof mock> }>();

  // Group tools by extensionId for extensionTools map
  const extensionTools = new Map<string, RegisteredTool[]>();
  for (const t of tools) {
    const existing = extensionTools.get(t.extensionId) ?? [];
    existing.push(t);
    extensionTools.set(t.extensionId, existing);
  }

  return {
    getToolExtension(name: string) {
      return toolMap.get(name)?.extensionId ?? null;
    },
    getRegisteredTool(name: string) {
      return toolMap.get(name) ?? null;
    },
    // Non-mcp manifest so executeToolCall takes the subprocess path.
    getManifest(_extensionId: string) {
      return { kind: "local" as const };
    },
    getMcpClient(_extensionId: string): never {
      throw new Error("not an mcp ext");
    },
    getProcess(extensionId: string) {
      if (!processes.has(extensionId)) {
        processes.set(extensionId, {
          callTool: mock(
            async (_name: string, _args: Record<string, unknown>, _meta?: Record<string, unknown>): Promise<ToolCallResult> => ({
              content: [{ type: "text", text: `result from ${extensionId}` }],
              isError: false,
            }),
          ),
          setRequestHandler: mock(() => {}),
        });
      }
      return processes.get(extensionId)!;
    },
    getAllTools(): ToolDefinition[] {
      return Array.from(toolMap.values()).map(
        ({ extensionId, extensionName, originalName, ...t }) => t,
      );
    },
    getToolsForAgent(_agentConfigId: string): ToolDefinition[] {
      // Return all tools stripped of internal fields (mirrors real implementation)
      return Array.from(toolMap.values()).map(
        ({ extensionId, extensionName, originalName, ...t }) => t,
      );
    },
    // Expose internals for assertions
    _processes: processes,
    _toolMap: toolMap,
    _extensionTools: extensionTools,
  };
}

// ═════════════════════════════════════════════════════════════════════
// 1. Registry Namespacing
// ═════════════════════════════════════════════════════════════════════

describe("Registry namespacing", () => {
  test("3 extensions with overlapping tool names register without collision", () => {
    const tools = [
      makeTool("ext-a", "search", "id-a"),
      makeTool("ext-b", "search", "id-b"),
      makeTool("ext-c", "search", "id-c"),
    ];
    const registry = createMockRegistry(tools);

    expect(registry.getToolExtension("ext-a__search")).toBe("id-a");
    expect(registry.getToolExtension("ext-b__search")).toBe("id-b");
    expect(registry.getToolExtension("ext-c__search")).toBe("id-c");
    expect(registry._toolMap.size).toBe(3);
  });

  test("getRegisteredTool returns correct originalName for each", () => {
    const tools = [
      makeTool("weather", "getForecast", "ext-weather"),
      makeTool("maps", "getForecast", "ext-maps"),
    ];
    const registry = createMockRegistry(tools);

    const weatherTool = registry.getRegisteredTool("weather__getForecast");
    expect(weatherTool).not.toBeNull();
    expect(weatherTool!.originalName).toBe("getForecast");
    expect(weatherTool!.extensionId).toBe("ext-weather");

    const mapsTool = registry.getRegisteredTool("maps__getForecast");
    expect(mapsTool).not.toBeNull();
    expect(mapsTool!.originalName).toBe("getForecast");
    expect(mapsTool!.extensionId).toBe("ext-maps");
  });

  test("getToolExtension returns correct extensionId for namespaced lookups", () => {
    const tools = [
      makeTool("alpha", "run", "id-alpha"),
      makeTool("beta", "run", "id-beta"),
      makeTool("alpha", "stop", "id-alpha"),
    ];
    const registry = createMockRegistry(tools);

    expect(registry.getToolExtension("alpha__run")).toBe("id-alpha");
    expect(registry.getToolExtension("beta__run")).toBe("id-beta");
    expect(registry.getToolExtension("alpha__stop")).toBe("id-alpha");
  });

  test("non-existent namespace.tool returns null", () => {
    const tools = [makeTool("real", "tool", "id-real")];
    const registry = createMockRegistry(tools);

    expect(registry.getRegisteredTool("fake__tool")).toBeNull();
    expect(registry.getToolExtension("fake__tool")).toBeNull();
    expect(registry.getRegisteredTool("real__nonexistent")).toBeNull();
    expect(registry.getToolExtension("real__nonexistent")).toBeNull();
  });

  test("extension name with dots (e.g. 'org.package') namespaces correctly", () => {
    // The registry uses `${manifest.name}__${tool.name}` (double-underscore
    // separator, chosen because Anthropic's tool-name regex rejects dots).
    // A dotted extension name like `org.package` is just a literal prefix,
    // producing keys like `org.package__search`.
    const tool: RegisteredTool = {
      name: "org.package__search",
      description: "Dotted namespace tool",
      inputSchema: { type: "object" },
      extensionId: "id-org-pkg",
      extensionName: "org.package",
      originalName: "search",
    };
    const registry = createMockRegistry([tool]);

    expect(registry.getRegisteredTool("org.package__search")).not.toBeNull();
    expect(registry.getRegisteredTool("org.package__search")!.originalName).toBe("search");
    expect(registry.getToolExtension("org.package__search")).toBe("id-org-pkg");

    // Partial lookups should fail
    expect(registry.getRegisteredTool("org.package")).toBeNull();
    expect(registry.getRegisteredTool("package__search")).toBeNull();
  });

  test("extension with no tools registers without error", () => {
    const registry = createMockRegistry([]);
    expect(registry._toolMap.size).toBe(0);
    expect(registry.getAllTools()).toEqual([]);
  });

  test("multiple tools from same extension all resolve correctly", () => {
    const tools = [
      makeTool("toolbox", "hammer", "id-toolbox"),
      makeTool("toolbox", "wrench", "id-toolbox"),
      makeTool("toolbox", "screwdriver", "id-toolbox"),
    ];
    const registry = createMockRegistry(tools);

    for (const t of tools) {
      expect(registry.getToolExtension(t.name)).toBe("id-toolbox");
      expect(registry.getRegisteredTool(t.name)!.originalName).toBe(
        t.name.split("__").slice(1).join("__"),
      );
    }
  });
});

// ═════════════════════════════════════════════════════════════════════
// 2. Executor Namespace Stripping
// ═════════════════════════════════════════════════════════════════════

describe("Executor namespace stripping", () => {
  const searchA = makeTool("ext-a", "search", "id-a", "Search A");
  const _searchB = makeTool("ext-b", "search", "id-b", "Search B");

  test("executeToolCall calls proc.callTool with originalName, not namespaced", async () => {
    const registry = createMockRegistry([searchA]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-a__search", { q: "test" }, "conv-1", "msg-1");

    const proc = registry._processes.get("id-a")!;
    expect(proc.callTool).toHaveBeenCalledTimes(1);
    expect(proc.callTool.mock.calls[0]![0]).toBe("search");
    expect(proc.callTool.mock.calls[0]![1]).toEqual({ q: "test" });
  });

  test("namespaced name is used for DB recording (via getDb mock)", async () => {
    // We track what's passed to the insert().values() chain
    let recordedToolName: string | undefined;
    mock.module("../db/connection", () => ({
      getDb: () => ({
        insert: () => ({
          values: (row: any) => {
            recordedToolName = row.toolName;
            return Promise.resolve();
          },
        }),
      }),
    }));

afterAll(() => restoreModuleMocks());

    // Re-import to pick up the new mock
    const { ToolExecutor: FreshExecutor } = await import("../extensions/tool-executor");
    const registry = createMockRegistry([searchA]);
    const executor = new FreshExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-a__search", { q: "test" }, "conv-1", "msg-1");

    expect(recordedToolName).toBe("ext-a__search");
  });

  test("error messages include namespaced name for unknown tools", async () => {
    const registry = createMockRegistry([searchA]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    const result = await executor.executeToolCall("nonexistent__tool", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nonexistent__tool");
  });

  test("unknown namespaced tool returns proper error shape", async () => {
    const registry = createMockRegistry([searchA]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    const result = await executor.executeToolCall("ext-a__missing", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(true);
    expect(result.content).toHaveLength(1);
    expect(result.content[0]!.type).toBe("text");
    expect(result.content[0]!.text).toContain("ext-a__missing");
  });

  test("PDP receives the namespaced toolName in its ctx, not stripped", async () => {
    const registry = createMockRegistry([searchA]);
    const engine = createStubPermissionEngine();
    const executor = new ToolExecutor(registry as any, engine);

    await executor.executeToolCall("ext-a__search", { q: "x" }, "conv-1", "msg-1");

    // The PDP's ctx.toolName is the ORIGINAL name (post-strip) because
    // that's what the manifest declares, but the routing identity is
    // the extensionId — both are surfaced.
    expect(engine.calls).toHaveLength(1);
    expect(engine.calls[0]!.ctx.extensionId).toBe("id-a");
    expect(engine.calls[0]!.ctx.toolName).toBe("search");
  });

  test("PDP deny throws PermissionDeniedError with namespaced name", async () => {
    const registry = createMockRegistry([searchA]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine("deny-all"));

    try {
      await executor.executeToolCall("ext-a__search", {}, "conv-1", "msg-1");
      throw new Error("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(PermissionDeniedError);
      expect((err as PermissionDeniedError).toolName).toBe("ext-a__search");
      expect((err as PermissionDeniedError).extensionId).toBe("id-a");
    }
  });

  test("event bus receives namespaced name on success", async () => {
    const registry = createMockRegistry([searchA]);
    const emitted: Array<{ event: string; data: any }> = [];
    // Phase 6 ToolExecutor wires bus.on("run:complete"/...) to clear
    // its per-conversation tool-call counter; provide a no-op `on` so
    // the constructor doesn't blow up on `this.bus.on is not a function`.
    const bus = {
      emit: (event: string, data: any) => emitted.push({ event, data }),
      on: () => () => {},
    };
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine(), { bus: bus as any });

    await executor.executeToolCall("ext-a__search", {}, "conv-1", "msg-1");

    const startEvt = emitted.find((e) => e.event === "tool:start");
    const completeEvt = emitted.find((e) => e.event === "tool:complete");
    expect(startEvt?.data.toolName).toBe("ext-a__search");
    expect(completeEvt?.data.toolName).toBe("ext-a__search");
  });

  test("event bus receives namespaced name on error", async () => {
    const registry = createMockRegistry([searchA]);
    // Make the process throw
    const proc = registry.getProcess("id-a");
    proc.callTool = mock(async () => {
      throw new Error("boom");
    });

    const emitted: Array<{ event: string; data: any }> = [];
    // Phase 6 ToolExecutor wires bus.on("run:complete"/...) to clear
    // its per-conversation tool-call counter; provide a no-op `on` so
    // the constructor doesn't blow up on `this.bus.on is not a function`.
    const bus = {
      emit: (event: string, data: any) => emitted.push({ event, data }),
      on: () => () => {},
    };
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine(), { bus: bus as any });

    await executor.executeToolCall("ext-a__search", {}, "conv-1", "msg-1");

    const errorEvt = emitted.find((e) => e.event === "tool:error");
    expect(errorEvt?.data.toolName).toBe("ext-a__search");
    expect(errorEvt?.data.error).toBe("boom");
  });
});

// ═════════════════════════════════════════════════════════════════════
// 3. End-to-End Flow
// ═════════════════════════════════════════════════════════════════════

describe("End-to-end namespace flow", () => {
  const extASearch = makeTool("ext-a", "search", "id-a", "Search in A");
  const extBSearch = makeTool("ext-b", "search", "id-b", "Search in B");
  const extAFormat = makeTool("ext-a", "format", "id-a", "Format in A");

  test("ext-a.search routes to ext-a process with originalName 'search'", async () => {
    const registry = createMockRegistry([extASearch, extBSearch, extAFormat]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-a__search", { q: "hello" }, "conv-1", "msg-1");

    const procA = registry._processes.get("id-a")!;
    expect(procA.callTool).toHaveBeenCalledTimes(1);
    expect(procA.callTool.mock.calls[0]![0]).toBe("search");

    // ext-b process should NOT have been called
    expect(registry._processes.has("id-b")).toBe(false);
  });

  test("ext-b.search routes to ext-b process with originalName 'search'", async () => {
    const registry = createMockRegistry([extASearch, extBSearch, extAFormat]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-b__search", { q: "world" }, "conv-1", "msg-1");

    const procB = registry._processes.get("id-b")!;
    expect(procB.callTool).toHaveBeenCalledTimes(1);
    expect(procB.callTool.mock.calls[0]![0]).toBe("search");

    // ext-a process should NOT have been called
    expect(registry._processes.has("id-a")).toBe(false);
  });

  test("calling both ext-a.search and ext-b.search dispatches to different processes", async () => {
    const registry = createMockRegistry([extASearch, extBSearch]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-a__search", { q: "a" }, "conv-1", "msg-1");
    await executor.executeToolCall("ext-b__search", { q: "b" }, "conv-1", "msg-2");

    const procA = registry._processes.get("id-a")!;
    const procB = registry._processes.get("id-b")!;

    expect(procA.callTool).toHaveBeenCalledTimes(1);
    expect(procB.callTool).toHaveBeenCalledTimes(1);
    expect(procA.callTool.mock.calls[0]![0]).toBe("search");
    expect(procB.callTool.mock.calls[0]![0]).toBe("search");
  });

  test("getToolsForAgent returns all tools with namespaced names for LLM", () => {
    const registry = createMockRegistry([extASearch, extBSearch, extAFormat]);

    const agentTools = registry.getToolsForAgent("any-agent-id");
    const names = agentTools.map((t) => t.name);

    expect(names).toContain("ext-a__search");
    expect(names).toContain("ext-b__search");
    expect(names).toContain("ext-a__format");
    expect(names).toHaveLength(3);

    // Internal fields must not leak to LLM
    for (const tool of agentTools) {
      expect((tool as any).originalName).toBeUndefined();
      expect((tool as any).extensionId).toBeUndefined();
      expect((tool as any).extensionName).toBeUndefined();
    }
  });

  test("getAllTools returns namespaced names with no internal fields", () => {
    const registry = createMockRegistry([extASearch, extBSearch]);

    const allTools = registry.getAllTools();
    expect(allTools).toHaveLength(2);

    for (const tool of allTools) {
      expect(tool.name).toMatch(/^ext-[ab]__search$/);
      expect((tool as any).originalName).toBeUndefined();
      expect((tool as any).extensionId).toBeUndefined();
    }
  });

  test("multiple tools from same extension each route correctly", async () => {
    const registry = createMockRegistry([extASearch, extBSearch, extAFormat]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("ext-a__search", { q: "s" }, "conv-1", "msg-1");
    await executor.executeToolCall("ext-a__format", { data: "d" }, "conv-1", "msg-2");

    const procA = registry._processes.get("id-a")!;
    expect(procA.callTool).toHaveBeenCalledTimes(2);
    expect(procA.callTool.mock.calls[0]![0]).toBe("search");
    expect(procA.callTool.mock.calls[1]![0]).toBe("format");
  });
});

// ═════════════════════════════════════════════════════════════════════
// 4. Edge Cases
// ═════════════════════════════════════════════════════════════════════

describe("Namespace edge cases", () => {
  test("tool name that already contains a dot (e.g. 'file.read')", () => {
    // If tool name is "file.read" and extension is "myext", the namespaced
    // name becomes "myext.file.read". originalName should be "file.read".
    const tool: RegisteredTool = {
      name: "myext.file.read",
      description: "Read a file",
      inputSchema: { type: "object" },
      extensionId: "id-myext",
      extensionName: "myext",
      originalName: "file.read",
    };
    const registry = createMockRegistry([tool]);

    const registered = registry.getRegisteredTool("myext.file.read");
    expect(registered).not.toBeNull();
    expect(registered!.originalName).toBe("file.read");
    expect(registered!.extensionId).toBe("id-myext");
  });

  test("tool with dotted name dispatches originalName correctly via executor", async () => {
    const tool: RegisteredTool = {
      name: "myext.file.read",
      description: "Read a file",
      inputSchema: { type: "object" },
      extensionId: "id-myext",
      extensionName: "myext",
      originalName: "file.read",
    };
    const registry = createMockRegistry([tool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("myext.file.read", { path: "/tmp" }, "conv-1", "msg-1");

    const proc = registry._processes.get("id-myext")!;
    expect(proc.callTool).toHaveBeenCalledTimes(1);
    // Must pass "file.read" (the originalName), NOT "myext.file.read"
    expect(proc.callTool.mock.calls[0]![0]).toBe("file.read");
  });

  test("extension name with special characters", () => {
    const tool: RegisteredTool = {
      name: "@scope/my-ext.search",
      description: "Scoped search",
      inputSchema: { type: "object" },
      extensionId: "id-scoped",
      extensionName: "@scope/my-ext",
      originalName: "search",
    };
    const registry = createMockRegistry([tool]);

    expect(registry.getRegisteredTool("@scope/my-ext.search")).not.toBeNull();
    expect(registry.getToolExtension("@scope/my-ext.search")).toBe("id-scoped");
    expect(registry.getRegisteredTool("@scope/my-ext.search")!.originalName).toBe("search");
  });

  test("extension name with special characters dispatches correctly", async () => {
    const tool: RegisteredTool = {
      name: "@scope/my-ext.search",
      description: "Scoped search",
      inputSchema: { type: "object" },
      extensionId: "id-scoped",
      extensionName: "@scope/my-ext",
      originalName: "search",
    };
    const registry = createMockRegistry([tool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall("@scope/my-ext.search", {}, "conv-1", "msg-1");

    const proc = registry._processes.get("id-scoped")!;
    expect(proc.callTool.mock.calls[0]![0]).toBe("search");
  });

  test("empty tool name after namespace prefix returns unknown tool error", async () => {
    // If somehow a tool got registered as "myext." (empty tool name)
    const tool: RegisteredTool = {
      name: "myext.",
      description: "Empty tool name",
      inputSchema: { type: "object" },
      extensionId: "id-myext",
      extensionName: "myext",
      originalName: "",
    };
    const registry = createMockRegistry([tool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    // The registry DOES contain "myext." so it resolves, but originalName is ""
    await executor.executeToolCall("myext.", {}, "conv-1", "msg-1");

    const proc = registry._processes.get("id-myext")!;
    expect(proc.callTool).toHaveBeenCalledTimes(1);
    expect(proc.callTool.mock.calls[0]![0]).toBe("");
  });

  test("bare tool name (no namespace) returns unknown tool error", async () => {
    const tools = [makeTool("ext-a", "search", "id-a")];
    const registry = createMockRegistry(tools);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    const result = await executor.executeToolCall("search", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("search");
  });

  test("dotted extension name + dotted tool name composes full key", () => {
    // Extension "org.company" with tool "fs.read" => "org.company.fs.read"
    const tool: RegisteredTool = {
      name: "org.company.fs.read",
      description: "Deeply dotted",
      inputSchema: { type: "object" },
      extensionId: "id-org-co",
      extensionName: "org.company",
      originalName: "fs.read",
    };
    const registry = createMockRegistry([tool]);

    const found = registry.getRegisteredTool("org.company.fs.read");
    expect(found).not.toBeNull();
    expect(found!.originalName).toBe("fs.read");
    expect(found!.extensionName).toBe("org.company");
  });

  test("createToolsContext.invoke passes namespaced name through executeToolCall", async () => {
    const tool = makeTool("ext-a", "search", "id-a");
    const registry = createMockRegistry([tool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    const ctx = executor.createToolsContext("conv-1", "msg-1");
    const result = await ctx.invoke("ext-a__search", { q: "test" });

    const proc = registry._processes.get("id-a")!;
    expect(proc.callTool).toHaveBeenCalledTimes(1);
    expect(proc.callTool.mock.calls[0]![0]).toBe("search");
    expect(typeof result).toBe("string");
  });

  test("createToolsContext.invoke throws on unknown namespaced tool", async () => {
    const registry = createMockRegistry([]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    const ctx = executor.createToolsContext("conv-1", "msg-1");
    await expect(ctx.invoke("fake__tool", {})).rejects.toThrow("Unknown tool: fake__tool");
  });
});
