import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import {
  ToolExecutor,
  MAX_TOOL_CALLS_PER_TURN,
  PermissionDeniedError,
} from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { AssistantMessageEvent, AgentEvents } from "../types";
import { EventBus } from "../runtime/events";

// ── Helpers ────────────────────────────────────────────────────────

function stubAssistantMessage(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant" as const,
    content: [],
    api: "anthropic-messages",
    provider: "anthropic",
    model: "test",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

/** Stub getDb so recordToolCall never hits a real DB. */
mock.module("../db/connection", () => ({
  getDb: () => ({
    insert: () => ({
      values: async () => {},
    }),
  }),
}));

afterAll(() => restoreModuleMocks());

// ── ToolExecutor ───────────────────────────────────────────────────

function createMockRegistry(knownTools: Record<string, string> = { read_file: "ext-123" }) {
  return {
    getToolExtension: (name: string) => knownTools[name] ?? null,
    getRegisteredTool: (name: string) => knownTools[name] ? { name, originalName: name, extensionId: knownTools[name], description: "mock", inputSchema: {} } : null,
    // Non-mcp manifest so executeToolCall takes the subprocess path.
    getManifest: () => ({ kind: "local" as const }),
    getMcpClient: () => { throw new Error("not an mcp ext"); },
    getProcess: () => ({
      callTool: async (_name: string, _args: Record<string, unknown>, _meta?: Record<string, unknown>) => ({
        content: [{ type: "text" as const, text: "result" }],
        isError: false,
      }),
      setRequestHandler: () => {},
    }),
    listTools: () => [],
    getInstalledExtension: () => null,
    listExtensions: () => [],
  } as any;
}

function createFailingRegistry() {
  return {
    getToolExtension: (name: string) => (name === "fail_tool" ? "ext-fail" : null),
    getRegisteredTool: (name: string) => name === "fail_tool" ? { name, originalName: name, extensionId: "ext-fail", description: "mock", inputSchema: {} } : null,
    getManifest: () => ({ kind: "local" as const }),
    getMcpClient: () => { throw new Error("not an mcp ext"); },
    getProcess: () => ({
      callTool: async () => {
        throw new Error("subprocess crashed");
      },
      setRequestHandler: () => {},
    }),
    listTools: () => [],
  } as any;
}

describe("ToolExecutor", () => {
  test("executeToolCall returns result for known tool", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const result = await executor.executeToolCall("read_file", { path: "/tmp" }, "conv-1", "msg-1");

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe("result");
  });

  test("executeToolCall returns isError for unknown tool", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const result = await executor.executeToolCall("unknown_tool", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
  });

  test("PDP deny throws PermissionDeniedError", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine("deny-all"));

    await expect(
      executor.executeToolCall("read_file", {}, "conv-1", "msg-1"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("PDP allow lets the call through", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine("allow-all"));
    const result = await executor.executeToolCall("read_file", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(false);
  });

  test("default stub engine = allow-all", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const result = await executor.executeToolCall("read_file", { any: "thing" }, "conv-1", "msg-1");

    expect(result.isError).toBe(false);
  });

  test("PDP mode toggle updates decisions at runtime (replaces deprecated setPermissionChecker)", async () => {
    const engine = createStubPermissionEngine("allow-all");
    const executor = new ToolExecutor(createMockRegistry(), engine);

    // Initially allow-all → succeeds
    const r1 = await executor.executeToolCall("read_file", {}, "c", "m");
    expect(r1.isError).toBe(false);

    // Flip to deny-all → next call rejects
    engine.setMode("deny-all");
    await expect(
      executor.executeToolCall("read_file", {}, "c", "m"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("PDP runtime fail-closed: engine.authorize throwing converts to PermissionDeniedError", async () => {
    // A transient DB outage in `getSetting` (or any other unexpected
    // authorize() throw) must NOT silently allow the dispatch on the
    // existing try/catch's success path. The wrapper in
    // tool-executor.ts:executeToolCall converts the throw into a
    // PermissionDeniedError, which routes through the same reject
    // path as a normal deny.
    const explodingEngine = createStubPermissionEngine();
    explodingEngine.authorize = async () => {
      throw new Error("simulated DB outage in getSetting");
    };
    const executor = new ToolExecutor(createMockRegistry(), explodingEngine);

    let caught: unknown = null;
    try {
      await executor.executeToolCall("read_file", {}, "c", "m");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(PermissionDeniedError);
    expect((caught as PermissionDeniedError).reason).toContain("engine error");
    expect((caught as PermissionDeniedError).reason).toContain(
      "simulated DB outage",
    );
  });

  test("PermissionDeniedError has correct extensionId and toolName", () => {
    const err = new PermissionDeniedError("ext-abc", "dangerous_tool");
    expect(err.extensionId).toBe("ext-abc");
    expect(err.toolName).toBe("dangerous_tool");
    expect(err.name).toBe("PermissionDeniedError");
    expect(err.message).toContain("dangerous_tool");
    expect(err.message).toContain("ext-abc");
    expect(err instanceof Error).toBe(true);
  });

  test("createToolsContext.invoke returns text content", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const ctx = executor.createToolsContext("conv-1", "msg-1");
    const result = await ctx.invoke("read_file", { path: "/tmp" });

    expect(result).toBe("result");
  });

  test("createToolsContext.invoke throws on error results", async () => {
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const ctx = executor.createToolsContext("conv-1", "msg-1");

    // "unknown_tool" returns isError: true
    await expect(ctx.invoke("unknown_tool", {})).rejects.toThrow("Unknown tool");
  });

  test("multiple sequential tool calls work correctly", async () => {
    let callCount = 0;
    const registry = {
      getToolExtension: (name: string) => (name.startsWith("tool_") ? "ext-seq" : null),
      getRegisteredTool: (name: string) => name.startsWith("tool_") ? { name, originalName: name, extensionId: "ext-seq", description: "mock", inputSchema: {} } : null,
      getManifest: () => ({ kind: "local" as const }),
      getMcpClient: () => { throw new Error("not an mcp ext"); },
      getProcess: () => ({
        callTool: async (_name: string) => {
          callCount++;
          return { content: [{ type: "text" as const, text: `result-${callCount}` }], isError: false };
        },
        setRequestHandler: () => {},
      }),
    } as any;

    const executor = new ToolExecutor(registry, createStubPermissionEngine());
    const r1 = await executor.executeToolCall("tool_a", {}, "c", "m");
    const r2 = await executor.executeToolCall("tool_b", {}, "c", "m");
    const r3 = await executor.executeToolCall("tool_c", {}, "c", "m");

    expect(r1.content[0]!.text).toBe("result-1");
    expect(r2.content[0]!.text).toBe("result-2");
    expect(r3.content[0]!.text).toBe("result-3");
    expect(callCount).toBe(3);
  });

  test("tool execution error is caught and returned as error result", async () => {
    const executor = new ToolExecutor(createFailingRegistry(), createStubPermissionEngine());
    const result = await executor.executeToolCall("fail_tool", {}, "c", "m");

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("subprocess crashed");
  });

  test("MAX_TOOL_CALLS_PER_TURN is 10", () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(10);
  });
});

// ── ToolExecutor with EventBus ─────────────────────────────────────

describe("ToolExecutor with EventBus", () => {
  test("emits tool:complete event after successful call", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: AgentEvents["tool:complete"][] = [];
    bus.on("tool:complete", (data) => events.push(data));

    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine(), { bus });
    await executor.executeToolCall("read_file", { path: "/tmp" }, "conv-1", "msg-1");

    expect(events.length).toBe(1);
    expect(events[0]!.toolName).toBe("read_file");
    expect(events[0]!.extensionId).toBe("ext-123");
    expect(events[0]!.success).toBe(true);
    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  test("emits tool:error event after failed call", async () => {
    const bus = new EventBus<AgentEvents>();
    const events: AgentEvents["tool:error"][] = [];
    bus.on("tool:error", (data) => events.push(data));

    const executor = new ToolExecutor(createFailingRegistry(), createStubPermissionEngine(), { bus });
    await executor.executeToolCall("fail_tool", {}, "conv-1", "msg-1");

    expect(events.length).toBe(1);
    expect(events[0]!.toolName).toBe("fail_tool");
    expect(events[0]!.error).toContain("subprocess crashed");
    expect(events[0]!.duration).toBeGreaterThanOrEqual(0);
  });

  test("no emission when bus is not provided", async () => {
    // Should not throw - bus is optional
    const executor = new ToolExecutor(createMockRegistry(), createStubPermissionEngine());
    const result = await executor.executeToolCall("read_file", {}, "conv-1", "msg-1");
    expect(result.isError).toBe(false);
  });
});

// ── AssistantMessageEvent type correctness ───────────────────────

describe("AssistantMessageEvent type correctness", () => {
  test("toolcall_end event has toolCall field with id, name, arguments", () => {
    const event: AssistantMessageEvent = {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: { type: "toolCall", id: "t1", name: "read", arguments: { key: "val" } },
      partial: stubAssistantMessage() as any,
    };
    expect(event.type).toBe("toolcall_end");
    expect(event.toolCall).toBeDefined();
    expect(event.toolCall.id).toBe("t1");
    expect(event.toolCall.name).toBe("read");
    expect(event.toolCall.arguments).toEqual({ key: "val" });
  });

  test("text_delta event has delta field", () => {
    const event: AssistantMessageEvent = {
      type: "text_delta",
      contentIndex: 0,
      delta: "hello",
      partial: stubAssistantMessage() as any,
    };
    expect(event.type).toBe("text_delta");
    expect(event.delta).toBe("hello");
  });

  test("done event has reason and message fields", () => {
    const msg = stubAssistantMessage({
      usage: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0, totalTokens: 30, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    });
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: msg as any,
    };

    expect(event.type).toBe("done");
    expect(event.reason).toBe("stop");
    expect(event.message).toBeDefined();
  });

  test("error event has reason and error fields", () => {
    const event: AssistantMessageEvent = {
      type: "error",
      reason: "error",
      error: stubAssistantMessage({ errorMessage: "something broke" }) as any,
    };
    expect(event.type).toBe("error");
    expect(event.reason).toBe("error");
  });
});
