import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { RegisteredTool } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import type { ToolCallResult } from "../extensions/types";

// ── Mock Registry & Process ──────────────────────────────────────────

function createMockRegistry(tools: RegisteredTool[]) {
  const toolMap = new Map(tools.map((t) => [t.name, t]));
  const processes = new Map<string, { callTool: ReturnType<typeof mock>; setRequestHandler: ReturnType<typeof mock> }>();

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
    getProcess(extensionId: string) {
      if (!processes.has(extensionId)) {
        processes.set(extensionId, {
          callTool: mock(async (_name: string, _args: Record<string, unknown>, _meta?: Record<string, unknown>): Promise<ToolCallResult> => ({
            content: [{ type: "text", text: "ok" }],
            isError: false,
          })),
          setRequestHandler: mock(() => {}),
        });
      }
      return processes.get(extensionId)!;
    },
    getMcpClient(_extensionId: string): never {
      throw new Error("not an mcp ext");
    },
    // Expose for assertions
    _processes: processes,
  };
}

// Suppress DB recording errors (no DB in unit tests)
const noopDb = {
  insert: () => ({ values: () => Promise.resolve() }),
};

describe("ToolExecutor namespace stripping", () => {
  const weatherTool: RegisteredTool = {
    name: "weather.getForecast",
    description: "Get weather forecast",
    inputSchema: { type: "object" },
    extensionId: "ext-weather",
    extensionName: "weather",
    originalName: "getForecast",
  };

  test("proc.callTool receives originalName, not namespaced name", async () => {
    const registry = createMockRegistry([weatherTool]);
    const executor = new ToolExecutor(registry as any);

    await executor.executeToolCall(
      "weather.getForecast",
      { city: "NYC" },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-weather")!;
    expect(proc.callTool).toHaveBeenCalledTimes(1);
    // Must be called with originalName "getForecast", NOT "weather.getForecast"
    expect(proc.callTool.mock.calls[0]![0]).toBe("getForecast");
    expect(proc.callTool.mock.calls[0]![1]).toEqual({ city: "NYC" });
  });

  test("unknown namespaced tool returns error", async () => {
    const registry = createMockRegistry([weatherTool]);
    const executor = new ToolExecutor(registry as any);

    const result = await executor.executeToolCall(
      "nonexistent.tool",
      {},
      "conv-1",
      "msg-1",
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("nonexistent.tool");
  });

  test("event bus emissions use namespaced name", async () => {
    const registry = createMockRegistry([weatherTool]);
    const emitted: Array<{ event: string; data: any }> = [];
    const bus = {
      emit(event: string, data: any) {
        emitted.push({ event, data });
      },
    };
    const executor = new ToolExecutor(registry as any, { bus: bus as any });

    await executor.executeToolCall(
      "weather.getForecast",
      { city: "NYC" },
      "conv-1",
      "msg-1",
    );

    // tool:start and tool:complete should both have the namespaced name
    const startEvent = emitted.find((e) => e.event === "tool:start");
    expect(startEvent?.data.toolName).toBe("weather.getForecast");
    const completeEvent = emitted.find((e) => e.event === "tool:complete");
    expect(completeEvent?.data.toolName).toBe("weather.getForecast");
  });
});
