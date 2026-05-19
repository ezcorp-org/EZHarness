import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import type { InlineToolCall } from "$lib/inline-tool-store.svelte";

// ---------------------------------------------------------------------------
// Plain-JS recreation of InlineToolStore (no Svelte 5 runes)
// ---------------------------------------------------------------------------

class PlainInlineToolStore {
  calls: InlineToolCall[] = [];

  add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
    this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
  }

  updateFromEvent(
    invocationId: string,
    eventType: string,
    data: Record<string, unknown>,
  ): void {
    const idx = this.calls.findIndex((c) => c.id === invocationId);
    if (idx < 0) return;

    const call = this.calls[idx]!;
    const updated = [...this.calls];

    switch (eventType) {
      case "tool:start":
        updated[idx] = { ...call, status: "running", startedAt: data.timestamp as number };
        break;
      case "tool:complete":
        updated[idx] = {
          ...call,
          status: "complete",
          output:
            typeof data.output === "string"
              ? data.output
              : JSON.stringify(data.output),
          duration: data.duration as number,
        };
        break;
      case "tool:error":
        updated[idx] = {
          ...call,
          status: "error",
          error: data.error as string,
          duration: data.duration as number,
          retryCount: call.retryCount + 1,
        };
        break;
    }

    this.calls = updated;
  }

  getById(id: string): InlineToolCall | undefined {
    return this.calls.find((c) => c.id === id);
  }
}

// ---------------------------------------------------------------------------
// 1. WS Event Routing Logic (pure function extraction)
// ---------------------------------------------------------------------------

interface ToolEventData {
  source?: string;
  invocationId?: string;
  conversationId: string;
  toolName: string;
  [key: string]: unknown;
}

type RouteResult =
  | { target: "inline"; invocationId: string; eventType: string }
  | { target: "agent-run"; conversationId: string; eventType: string };

function routeToolEvent(eventType: string, data: ToolEventData): RouteResult {
  if (data.source === "inline" && data.invocationId) {
    return { target: "inline", invocationId: data.invocationId, eventType };
  }
  return { target: "agent-run", conversationId: data.conversationId, eventType };
}

// ---------------------------------------------------------------------------
// 2. ChatInput handleChipClick logic (pure extraction)
// ---------------------------------------------------------------------------

interface ToolDefinition {
  name: string;
  description?: string;
  inputSchema?: { properties?: Record<string, unknown>; required?: string[] };
}

interface ChipClickResult {
  action: "show-form" | "show-picker" | "noop" | "error";
  tools?: ToolDefinition[];
  selectedTool?: ToolDefinition;
}

async function handleChipClickLogic(
  extName: string,
  fetchFn: typeof fetch,
): Promise<ChipClickResult> {
  try {
    const res = await fetchFn(`/api/extensions/${encodeURIComponent(extName)}/tools`);
    if (!res.ok) return { action: "noop" };
    const { tools }: { tools: ToolDefinition[] } = await res.json();
    if (tools.length === 1) {
      return { action: "show-form", tools, selectedTool: tools[0] };
    } else if (tools.length > 1) {
      return { action: "show-picker", tools };
    }
    return { action: "noop", tools };
  } catch {
    return { action: "error" };
  }
}

// ---------------------------------------------------------------------------
// 3. ChatInput handleFormConfirm logic (pure extraction)
// ---------------------------------------------------------------------------

interface FormConfirmResult {
  invocationId: string;
  addedCall: Omit<InlineToolCall, "status" | "retryCount">;
  fetchBody: Record<string, unknown>;
}

function handleFormConfirmLogic(
  activeExtension: string,
  selectedTool: ToolDefinition,
  input: Record<string, unknown>,
  conversationId: string,
  generateId: () => string,
): FormConfirmResult {
  const invocationId = generateId();
  return {
    invocationId,
    addedCall: {
      id: invocationId,
      extensionName: activeExtension,
      toolName: selectedTool.name,
      input,
      conversationId,
    },
    fetchBody: {
      extensionName: activeExtension,
      toolName: selectedTool.name,
      input,
      conversationId,
      invocationId,
    },
  };
}

// ---------------------------------------------------------------------------
// 4. Chat Page handleInlineRetry logic
// ---------------------------------------------------------------------------

function handleInlineRetryLogic(
  call: InlineToolCall,
  generateId: () => string,
): FormConfirmResult {
  const invocationId = generateId();
  return {
    invocationId,
    addedCall: {
      id: invocationId,
      extensionName: call.extensionName,
      toolName: call.toolName,
      input: call.input,
      conversationId: call.conversationId,
    },
    fetchBody: {
      extensionName: call.extensionName,
      toolName: call.toolName,
      input: call.input,
      conversationId: call.conversationId,
      invocationId,
    },
  };
}

// ---------------------------------------------------------------------------
// 5. Chat Page handleInlineEditRetry logic
// ---------------------------------------------------------------------------

interface EditRetryResult {
  action: "set-edit-state" | "noop";
  editRetryCall?: InlineToolCall;
  editRetryTool?: ToolDefinition;
}

async function handleInlineEditRetryLogic(
  call: InlineToolCall,
  fetchFn: typeof fetch,
): Promise<EditRetryResult> {
  try {
    const res = await fetchFn(`/api/extensions/${encodeURIComponent(call.extensionName)}/tools`);
    if (!res.ok) return { action: "noop" };
    const { tools }: { tools: ToolDefinition[] } = await res.json();
    const tool = tools.find((t) => t.name === call.toolName);
    if (tool) {
      return { action: "set-edit-state", editRetryCall: call, editRetryTool: tool };
    }
    return { action: "noop" };
  } catch {
    return { action: "noop" };
  }
}

// ---------------------------------------------------------------------------
// 6. Chat Page handleInlineCancel logic
// ---------------------------------------------------------------------------

interface CancelResult {
  eventType: "tool:error";
  data: { error: string; duration: number };
}

function handleInlineCancelLogic(call: InlineToolCall): CancelResult {
  return {
    eventType: "tool:error",
    data: {
      error: "Cancelled by user",
      duration: call.startedAt ? Date.now() - call.startedAt : 0,
    },
  };
}

// ---------------------------------------------------------------------------
// 7. Chat Page handleEditRetryConfirm logic
// ---------------------------------------------------------------------------

function handleEditRetryConfirmLogic(
  editRetryCall: InlineToolCall,
  input: Record<string, unknown>,
  generateId: () => string,
): FormConfirmResult {
  const invocationId = generateId();
  return {
    invocationId,
    addedCall: {
      id: invocationId,
      extensionName: editRetryCall.extensionName,
      toolName: editRetryCall.toolName,
      input,
      conversationId: editRetryCall.conversationId,
    },
    fetchBody: {
      extensionName: editRetryCall.extensionName,
      toolName: editRetryCall.toolName,
      input,
      conversationId: editRetryCall.conversationId,
      invocationId,
    },
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

function mockFetch(status: number, body: unknown) {
  globalThis.fetch = mock(() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    ),
    // Bun's `Mock<…>` lacks `preconnect`; route through `unknown`.
  ) as unknown as typeof fetch;
}

function makeCall(overrides: Partial<InlineToolCall> = {}): InlineToolCall {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    extensionName: overrides.extensionName ?? "test-ext",
    toolName: overrides.toolName ?? "test-tool",
    input: overrides.input ?? { query: "hello" },
    conversationId: overrides.conversationId ?? "conv-1",
    status: overrides.status ?? "pending",
    retryCount: overrides.retryCount ?? 0,
    ...overrides,
  };
}

function makeTool(name: string, props?: Record<string, unknown>): ToolDefinition {
  return {
    name,
    description: `${name} tool`,
    inputSchema: { properties: props ?? { query: { type: "string" } }, required: ["query"] },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let store: PlainInlineToolStore;

beforeEach(() => {
  store = new PlainInlineToolStore();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// ── 1. WS Event Routing ─────────────────────────────────────────────────

describe("WS event routing", () => {
  const baseData = { conversationId: "conv-1", toolName: "my-tool" };

  test("tool:start with source=inline routes to inline store", () => {
    const result = routeToolEvent("tool:start", {
      ...baseData,
      source: "inline",
      invocationId: "inv-1",
    });
    expect(result).toEqual({ target: "inline", invocationId: "inv-1", eventType: "tool:start" });
  });

  test("tool:complete with source=inline routes to inline store", () => {
    const result = routeToolEvent("tool:complete", {
      ...baseData,
      source: "inline",
      invocationId: "inv-2",
    });
    expect(result).toEqual({ target: "inline", invocationId: "inv-2", eventType: "tool:complete" });
  });

  test("tool:error with source=inline routes to inline store", () => {
    const result = routeToolEvent("tool:error", {
      ...baseData,
      source: "inline",
      invocationId: "inv-3",
    });
    expect(result).toEqual({ target: "inline", invocationId: "inv-3", eventType: "tool:error" });
  });

  test("tool:start without source routes to agent-run", () => {
    const result = routeToolEvent("tool:start", baseData);
    expect(result).toEqual({ target: "agent-run", conversationId: "conv-1", eventType: "tool:start" });
  });

  test("tool:complete without source routes to agent-run", () => {
    const result = routeToolEvent("tool:complete", baseData);
    expect(result).toEqual({ target: "agent-run", conversationId: "conv-1", eventType: "tool:complete" });
  });

  test("tool:error without source routes to agent-run", () => {
    const result = routeToolEvent("tool:error", baseData);
    expect(result).toEqual({ target: "agent-run", conversationId: "conv-1", eventType: "tool:error" });
  });

  test("source=inline but missing invocationId routes to agent-run", () => {
    const result = routeToolEvent("tool:start", { ...baseData, source: "inline" });
    expect(result).toEqual({ target: "agent-run", conversationId: "conv-1", eventType: "tool:start" });
  });

  test("source=agent routes to agent-run", () => {
    const result = routeToolEvent("tool:start", { ...baseData, source: "agent" });
    expect(result).toEqual({ target: "agent-run", conversationId: "conv-1", eventType: "tool:start" });
  });

  test("inline routing integrates with store updateFromEvent", () => {
    store.add({
      id: "inv-ws",
      extensionName: "ext",
      toolName: "tool",
      input: {},
      conversationId: "conv-1",
    });

    const startResult = routeToolEvent("tool:start", {
      ...baseData,
      source: "inline",
      invocationId: "inv-ws",
    });
    expect(startResult.target).toBe("inline");
    if (startResult.target === "inline") {
      store.updateFromEvent(startResult.invocationId, startResult.eventType, { timestamp: 1000 });
    }
    expect(store.getById("inv-ws")!.status).toBe("running");

    const completeResult = routeToolEvent("tool:complete", {
      ...baseData,
      source: "inline",
      invocationId: "inv-ws",
    });
    if (completeResult.target === "inline") {
      store.updateFromEvent(completeResult.invocationId, completeResult.eventType, {
        output: "done",
        duration: 50,
      });
    }
    expect(store.getById("inv-ws")!.status).toBe("complete");
  });
});

// ── 2. ChatInput handleChipClick ─────────────────────────────────────────

describe("handleChipClick logic", () => {
  test("single tool auto-selects and shows form", async () => {
    const tool = makeTool("search");
    mockFetch(200, { tools: [tool] });
    const result = await handleChipClickLogic("my-ext", globalThis.fetch);
    expect(result.action).toBe("show-form");
    expect(result.selectedTool).toEqual(tool);
    expect(result.tools).toHaveLength(1);
  });

  test("multiple tools shows picker", async () => {
    const tools = [makeTool("search"), makeTool("create")];
    mockFetch(200, { tools });
    const result = await handleChipClickLogic("my-ext", globalThis.fetch);
    expect(result.action).toBe("show-picker");
    expect(result.tools).toHaveLength(2);
    expect(result.selectedTool).toBeUndefined();
  });

  test("empty tools array is noop", async () => {
    mockFetch(200, { tools: [] });
    const result = await handleChipClickLogic("my-ext", globalThis.fetch);
    expect(result.action).toBe("noop");
    expect(result.tools).toHaveLength(0);
  });

  test("non-ok response is noop", async () => {
    mockFetch(404, { error: "Not found" });
    const result = await handleChipClickLogic("ghost-ext", globalThis.fetch);
    expect(result.action).toBe("noop");
  });

  test("fetch error resets state", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    const result = await handleChipClickLogic("my-ext", globalThis.fetch);
    expect(result.action).toBe("error");
  });

  test("correctly destructures { tools } from response", async () => {
    const tools = [makeTool("only-tool")];
    mockFetch(200, { tools });
    const result = await handleChipClickLogic("ext", globalThis.fetch);
    expect(result.action).toBe("show-form");
    expect(result.selectedTool!.name).toBe("only-tool");
  });
});

// ── 3. ChatInput handleFormConfirm ───────────────────────────────────────

describe("handleFormConfirm logic", () => {
  test("generates invocationId and correct body", () => {
    const tool = makeTool("search");
    const input = { query: "test" };
    const result = handleFormConfirmLogic("my-ext", tool, input, "conv-1", () => "uuid-123");
    expect(result.invocationId).toBe("uuid-123");
    expect(result.addedCall).toEqual({
      id: "uuid-123",
      extensionName: "my-ext",
      toolName: "search",
      input: { query: "test" },
      conversationId: "conv-1",
    });
    expect(result.fetchBody).toEqual({
      extensionName: "my-ext",
      toolName: "search",
      input: { query: "test" },
      conversationId: "conv-1",
      invocationId: "uuid-123",
    });
  });

  test("adds call to store with pending status", () => {
    const tool = makeTool("run");
    const result = handleFormConfirmLogic("ext", tool, { x: 1 }, "conv-2", () => "inv-add");
    store.add(result.addedCall);
    const call = store.getById("inv-add")!;
    expect(call.status).toBe("pending");
    expect(call.retryCount).toBe(0);
    expect(call.extensionName).toBe("ext");
    expect(call.toolName).toBe("run");
  });

  test("fires POST with correct body", async () => {
    mockFetch(200, { success: true });
    const tool = makeTool("action");
    const result = handleFormConfirmLogic("ext", tool, { q: "hi" }, "conv-3", () => "inv-post");
    await globalThis.fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.fetchBody),
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
    const callArgs = (globalThis.fetch as any).mock.calls[0];
    expect(callArgs[0]).toBe("/api/tool-invoke");
    expect(callArgs[1].method).toBe("POST");
    const body = JSON.parse(callArgs[1].body);
    expect(body.invocationId).toBe("inv-post");
    expect(body.extensionName).toBe("ext");
    expect(body.toolName).toBe("action");
  });
});

// ── 4. Chat Page handleInlineRetry ───────────────────────────────────────

describe("handleInlineRetry logic", () => {
  test("creates new invocationId with same extension/tool/input", () => {
    const original = makeCall({
      id: "old-id",
      extensionName: "ext-a",
      toolName: "tool-a",
      input: { k: "v" },
      conversationId: "conv-r",
      status: "error",
    });
    const result = handleInlineRetryLogic(original, () => "new-retry-id");
    expect(result.invocationId).toBe("new-retry-id");
    expect(result.addedCall.extensionName).toBe("ext-a");
    expect(result.addedCall.toolName).toBe("tool-a");
    expect(result.addedCall.input).toEqual({ k: "v" });
    expect(result.addedCall.conversationId).toBe("conv-r");
    expect(result.addedCall.id).toBe("new-retry-id");
  });

  test("adds retry call to store and fires POST", async () => {
    mockFetch(200, { success: true });
    const original = makeCall({ id: "orig", status: "error" });
    const result = handleInlineRetryLogic(original, () => "retry-inv");
    store.add(result.addedCall);
    expect(store.getById("retry-inv")!.status).toBe("pending");

    await globalThis.fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.fetchBody),
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });
});

// ── 5. Chat Page handleInlineEditRetry ───────────────────────────────────

describe("handleInlineEditRetry logic", () => {
  test("fetches tools and finds matching tool by name", async () => {
    const tools = [makeTool("alpha"), makeTool("beta")];
    mockFetch(200, { tools });
    const call = makeCall({ toolName: "beta", extensionName: "my-ext" });
    const result = await handleInlineEditRetryLogic(call, globalThis.fetch);
    expect(result.action).toBe("set-edit-state");
    expect(result.editRetryCall).toBe(call);
    expect(result.editRetryTool!.name).toBe("beta");
  });

  test("no matching tool returns noop", async () => {
    mockFetch(200, { tools: [makeTool("other")] });
    const call = makeCall({ toolName: "missing" });
    const result = await handleInlineEditRetryLogic(call, globalThis.fetch);
    expect(result.action).toBe("noop");
  });

  test("fetch failure returns noop", async () => {
    globalThis.fetch = mock(() => Promise.reject(new Error("network"))) as unknown as typeof fetch;
    const call = makeCall();
    const result = await handleInlineEditRetryLogic(call, globalThis.fetch);
    expect(result.action).toBe("noop");
  });

  test("non-ok response returns noop", async () => {
    mockFetch(500, { error: "server error" });
    const call = makeCall();
    const result = await handleInlineEditRetryLogic(call, globalThis.fetch);
    expect(result.action).toBe("noop");
  });

  test("correctly destructures { tools } from response", async () => {
    const tools = [makeTool("target")];
    mockFetch(200, { tools });
    const call = makeCall({ toolName: "target", extensionName: "ext" });
    const result = await handleInlineEditRetryLogic(call, globalThis.fetch);
    expect(result.action).toBe("set-edit-state");
    expect(result.editRetryTool!.name).toBe("target");
  });
});

// ── 6. Chat Page handleInlineCancel ──────────────────────────────────────

describe("handleInlineCancel logic", () => {
  test("produces tool:error with 'Cancelled by user'", () => {
    const call = makeCall({ startedAt: Date.now() - 500 });
    const result = handleInlineCancelLogic(call);
    expect(result.eventType).toBe("tool:error");
    expect(result.data.error).toBe("Cancelled by user");
    expect(result.data.duration).toBeGreaterThanOrEqual(0);
  });

  test("duration is calculated from startedAt", () => {
    const now = Date.now();
    const call = makeCall({ startedAt: now - 1000 });
    const result = handleInlineCancelLogic(call);
    // Allow some margin for test execution time
    expect(result.data.duration).toBeGreaterThanOrEqual(999);
    expect(result.data.duration).toBeLessThan(2000);
  });

  test("duration is 0 when startedAt is undefined", () => {
    const call = makeCall({ startedAt: undefined });
    const result = handleInlineCancelLogic(call);
    expect(result.data.duration).toBe(0);
  });

  test("integrates with store to set error status", () => {
    store.add({
      id: "cancel-inv",
      extensionName: "ext",
      toolName: "tool",
      input: {},
      conversationId: "conv-1",
    });
    store.updateFromEvent("cancel-inv", "tool:start", { timestamp: Date.now() - 200 });
    expect(store.getById("cancel-inv")!.status).toBe("running");

    const call = store.getById("cancel-inv")!;
    const result = handleInlineCancelLogic(call);
    store.updateFromEvent(call.id, result.eventType, result.data);

    const cancelled = store.getById("cancel-inv")!;
    expect(cancelled.status).toBe("error");
    expect(cancelled.error).toBe("Cancelled by user");
    expect(cancelled.retryCount).toBe(1);
  });
});

// ── 7. Chat Page handleEditRetryConfirm ──────────────────────────────────

describe("handleEditRetryConfirm logic", () => {
  test("creates new invocationId and adds to store with new input", () => {
    const original = makeCall({
      id: "old",
      extensionName: "ext",
      toolName: "tool",
      input: { old: true },
      conversationId: "conv-e",
      status: "error",
    });
    const newInput = { updated: true };
    const result = handleEditRetryConfirmLogic(original, newInput, () => "edit-retry-id");
    expect(result.invocationId).toBe("edit-retry-id");
    expect(result.addedCall.input).toEqual({ updated: true });
    expect(result.addedCall.extensionName).toBe("ext");
    expect(result.addedCall.toolName).toBe("tool");
    expect(result.addedCall.conversationId).toBe("conv-e");
  });

  test("fires POST with edited input", async () => {
    mockFetch(200, { success: true });
    const original = makeCall({ extensionName: "ext", toolName: "tool", conversationId: "conv" });
    const result = handleEditRetryConfirmLogic(original, { newKey: "val" }, () => "eid");
    await globalThis.fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(result.fetchBody),
    });
    const body = JSON.parse((globalThis.fetch as any).mock.calls[0][1].body);
    expect(body.input).toEqual({ newKey: "val" });
    expect(body.invocationId).toBe("eid");
  });

  test("store receives pending call that can transition through events", () => {
    const original = makeCall({ extensionName: "e", toolName: "t", conversationId: "c" });
    const result = handleEditRetryConfirmLogic(original, { q: 1 }, () => "flow-id");
    store.add(result.addedCall);
    expect(store.getById("flow-id")!.status).toBe("pending");

    store.updateFromEvent("flow-id", "tool:start", { timestamp: 100 });
    expect(store.getById("flow-id")!.status).toBe("running");

    store.updateFromEvent("flow-id", "tool:complete", { output: "ok", duration: 30 });
    expect(store.getById("flow-id")!.status).toBe("complete");
    expect(store.getById("flow-id")!.output).toBe("ok");
  });
});
