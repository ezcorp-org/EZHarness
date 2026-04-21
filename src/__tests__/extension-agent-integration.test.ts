import { test, expect, describe, mock } from "bun:test";
import type { AssistantMessageEvent, Tool, ToolCall, AgentContext } from "../types";
import { ToolExecutor, MAX_TOOL_CALLS_PER_TURN, PermissionDeniedError } from "../extensions/tool-executor";
import type { ExtensionRegistry } from "../extensions/registry";
import type { ToolCallResult } from "../extensions/types";

// ── Helpers ──────────────────────────────────────────────────────────

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

// ── Type-level tests ─────────────────────────────────────────────────

describe("pi-ai tool-use types", () => {
  test("AssistantMessageEvent with type 'toolcall_end' contains toolCall field", () => {
    const event: AssistantMessageEvent = {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: {
        type: "toolCall",
        id: "call_123",
        name: "read_file",
        arguments: { path: "/tmp/test.txt" },
      },
      partial: stubAssistantMessage() as any,
    };
    expect(event.type).toBe("toolcall_end");
    expect(event.toolCall).toBeDefined();
    expect(event.toolCall.id).toBe("call_123");
    expect(event.toolCall.name).toBe("read_file");
    expect(event.toolCall.arguments).toEqual({ path: "/tmp/test.txt" });
  });

  test("Tool type has name, description, and parameters", () => {
    const tool: Tool = {
      name: "read_file",
      description: "Read a file from disk",
      parameters: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      } as any,
    };
    expect(tool.name).toBe("read_file");
    expect(tool.description).toBe("Read a file from disk");
    expect(tool.parameters).toBeDefined();
  });

  test("AgentContext has optional tools property", () => {
    // Type-level: verify tools is optional on AgentContext
    const ctxWithoutTools: Pick<AgentContext, "input"> = { input: {} };
    expect(ctxWithoutTools).toBeDefined();

    // Verify shape: tools has invoke method
    const mockTools: NonNullable<AgentContext["tools"]> = {
      invoke: async (_toolName: string, _input: Record<string, unknown>) => {
        return { result: "ok" };
      },
    };
    expect(mockTools).toBeDefined();
    expect(typeof mockTools.invoke).toBe("function");
  });

  test("text_delta event has delta and partial fields", () => {
    const event: AssistantMessageEvent = {
      type: "text_delta",
      contentIndex: 0,
      delta: "Hello world",
      partial: stubAssistantMessage() as any,
    };
    expect(event.type).toBe("text_delta");
    expect(event.delta).toBe("Hello world");
  });

  test("done event has reason and message fields", () => {
    const event: AssistantMessageEvent = {
      type: "done",
      reason: "stop",
      message: stubAssistantMessage() as any,
    };
    expect(event.type).toBe("done");
    expect(event.reason).toBe("stop");
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

// ── ToolExecutor ─────────────────────────────────────────────────────

function createMockRegistry(): ExtensionRegistry {
  const mockCallTool = mock(async (_toolName: string, _args: Record<string, unknown>): Promise<ToolCallResult> => ({
    content: [{ type: "text", text: "file contents here" }],
    isError: false,
  }));

  const mockProcess = {
    callTool: mockCallTool,
    setRequestHandler: mock(() => {}),
    isRunning: true,
  };

  return {
    getToolExtension: (name: string) => name === "read_file" ? "ext-123" : null,
    getRegisteredTool: (name: string) => name === "read_file" ? { name: "read_file", originalName: "read_file", extensionId: "ext-123", description: "Read file", inputSchema: {} } : null,
    getToolsForAgent: async () => [{ name: "read_file", description: "Read file", inputSchema: {} }],
    // Non-mcp manifest so executeToolCall takes the subprocess path.
    getManifest: () => ({ kind: "local" as const }),
    getProcess: () => mockProcess as any,
    getMcpClient: () => { throw new Error("not an mcp ext"); },
    getAllTools: () => [],
    loadFromDb: async () => {},
    reload: async () => {},
    killAll: () => {},
  } as any;
}

describe("ToolExecutor", () => {
  test("executes tool call through extension process", async () => {
    const registry = createMockRegistry();
    const executor = new ToolExecutor(registry);

    const result = await executor.executeToolCall("read_file", { path: "/test" }, "conv-1", "msg-1");

    expect(result.isError).toBe(false);
    expect(result.content[0]!.text).toBe("file contents here");
  });

  test("returns error for unknown tool", async () => {
    const registry = createMockRegistry();
    const executor = new ToolExecutor(registry);

    const result = await executor.executeToolCall("unknown_tool", {}, "conv-1", "msg-1");

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Unknown tool");
  });

  test("permission checker blocks denied tools", async () => {
    const registry = createMockRegistry();
    const executor = new ToolExecutor(registry, {
      permissionChecker: async () => false,
    });

    expect(
      executor.executeToolCall("read_file", { path: "/secret" }, "conv-1", "msg-1"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("setPermissionChecker updates checker after construction", async () => {
    const registry = createMockRegistry();
    const executor = new ToolExecutor(registry);

    // First call should work (no checker)
    const result1 = await executor.executeToolCall("read_file", {}, "conv-1", "msg-1");
    expect(result1.isError).toBe(false);

    // Set checker that blocks
    executor.setPermissionChecker(async () => false);
    expect(
      executor.executeToolCall("read_file", {}, "conv-1", "msg-1"),
    ).rejects.toThrow(PermissionDeniedError);
  });

  test("createToolsContext returns invoke function", async () => {
    const registry = createMockRegistry();
    const executor = new ToolExecutor(registry);

    const tools = executor.createToolsContext("conv-1", "msg-1");
    expect(typeof tools.invoke).toBe("function");

    const result = await tools.invoke("read_file", { path: "/test" });
    expect(result).toBe("file contents here");
  });

  test("createToolsContext throws on error results", async () => {
    const errorRegistry = {
      ...createMockRegistry(),
      getProcess: () => ({
        callTool: async () => ({
          content: [{ type: "text" as const, text: "tool failed" }],
          isError: true,
        }),
        setRequestHandler: () => {},
      }),
    } as any;

    const executor = new ToolExecutor(errorRegistry);
    const tools = executor.createToolsContext("conv-1", "msg-1");

    expect(tools.invoke("read_file", {})).rejects.toThrow("tool failed");
  });

  test("MAX_TOOL_CALLS_PER_TURN is 10", () => {
    expect(MAX_TOOL_CALLS_PER_TURN).toBe(10);
  });
});
