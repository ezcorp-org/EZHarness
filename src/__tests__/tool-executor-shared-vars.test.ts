import { test, expect, describe, mock, beforeEach } from "bun:test";
import type { RegisteredTool } from "../extensions/registry";
import { ToolExecutor, _resetToolCallsCounterForTests } from "../extensions/tool-executor";
import { createStubPermissionEngine } from "./helpers/permission-engine-stub";
import type { ToolCallResult } from "../extensions/types";

// Reset Phase 6's process-global per-conversation tool-call counter so
// each test starts fresh — otherwise the 11th case on conv-1 trips
// MaxToolCallsExceededError.
beforeEach(() => {
  _resetToolCallsCounterForTests();
});

// ── Mock Registry ───────────────────────────────────────────────────────

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
    // Non-mcp manifest so executeToolCall routes through the subprocess path.
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
    _processes: processes,
  };
}

// ── Tool definitions ────────────────────────────────────────────────────

const fileRefactorTool: RegisteredTool = {
  name: "file-refactor.rename-files",
  description: "Preview file renames",
  inputSchema: {
    type: "object",
    properties: {
      sourcePath: { type: "string", format: "file-path", "x-shared": "project.cwd" },
      convention: { type: "string" },
    },
    required: ["sourcePath", "convention"],
  },
  extensionId: "ext-file-refactor",
  extensionName: "file-refactor",
  originalName: "rename-files",
};

const noSharedTool: RegisteredTool = {
  name: "markdown.format",
  description: "Format markdown",
  inputSchema: {
    type: "object",
    properties: {
      text: { type: "string" },
    },
    required: ["text"],
  },
  extensionId: "ext-markdown",
  extensionName: "markdown",
  originalName: "format",
};

const multiSharedTool: RegisteredTool = {
  name: "analyzer.analyze",
  description: "Analyze project",
  inputSchema: {
    type: "object",
    properties: {
      path: { type: "string", "x-shared": "project.cwd" },
      projectName: { type: "string", "x-shared": "project.name" },
      depth: { type: "number" },
    },
  },
  extensionId: "ext-analyzer",
  extensionName: "analyzer",
  originalName: "analyze",
};

// ── Integration: ToolExecutor resolves shared variables ─────────────────

describe("ToolExecutor shared variable injection", () => {
  test("injects project.cwd when sourcePath is missing", async () => {
    const registry = createMockRegistry([fileRefactorTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "file-refactor.rename-files",
      { convention: "kebab-case" },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-file-refactor")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.sourcePath).toBe(process.cwd());
    expect(callArgs.convention).toBe("kebab-case");
  });

  test("injects project.cwd when sourcePath is empty string", async () => {
    const registry = createMockRegistry([fileRefactorTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "file-refactor.rename-files",
      { sourcePath: "", convention: "camelCase" },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-file-refactor")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.sourcePath).toBe(process.cwd());
  });

  test("does NOT overwrite user-provided sourcePath", async () => {
    const registry = createMockRegistry([fileRefactorTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "file-refactor.rename-files",
      { sourcePath: "/my/custom/path", convention: "snake_case" },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-file-refactor")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.sourcePath).toBe("/my/custom/path");
  });

  test("tools without x-shared are unaffected", async () => {
    const registry = createMockRegistry([noSharedTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "markdown.format",
      { text: "# Hello" },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-markdown")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs).toEqual({ text: "# Hello" });
  });

  test("resolves multiple x-shared fields in one call", async () => {
    const registry = createMockRegistry([multiSharedTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "analyzer.analyze",
      { depth: 3 },
      "conv-1",
      "msg-1",
    );

    const proc = registry._processes.get("ext-analyzer")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.path).toBe(process.cwd());
    expect(typeof callArgs.projectName).toBe("string");
    expect((callArgs.projectName as string).length).toBeGreaterThan(0);
    expect(callArgs.depth).toBe(3);
  });

  test("shared vars still injected with cross-extension depth", async () => {
    const registry = createMockRegistry([fileRefactorTool]);
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine());

    await executor.executeToolCall(
      "file-refactor.rename-files",
      { convention: "PascalCase" },
      "conv-1",
      "msg-1",
      { _callDepth: 1 },
    );

    const proc = registry._processes.get("ext-file-refactor")!;
    const callArgs = proc.callTool.mock.calls[0]![1] as Record<string, unknown>;
    expect(callArgs.sourcePath).toBe(process.cwd());
    expect(callArgs._depth).toBe(1);
  });

  test("event bus receives original input (not resolved)", async () => {
    const registry = createMockRegistry([fileRefactorTool]);
    const emitted: Array<{ event: string; data: any }> = [];
    // Phase 6 ToolExecutor wires bus.on("run:complete"/...) for counter
    // cleanup; provide a no-op `on` so the constructor doesn't throw.
    const bus = {
      emit(event: string, data: any) { emitted.push({ event, data }); },
      on: () => () => {},
    };
    const executor = new ToolExecutor(registry as any, createStubPermissionEngine(), { bus: bus as any });

    await executor.executeToolCall(
      "file-refactor.rename-files",
      { convention: "camelCase" },
      "conv-1",
      "msg-1",
    );

    const startEvent = emitted.find((e) => e.event === "tool:start");
    // The start event should have the original input (without sourcePath injected)
    expect(startEvent?.data.input).toEqual({ convention: "camelCase" });
  });
});
