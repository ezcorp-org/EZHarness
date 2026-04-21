import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import type { InlineToolCall } from "$lib/inline-tool-store.svelte";

// ---------------------------------------------------------------------------
// Plain-JS recreation of InlineToolStore (no Svelte 5 runes)
// Mirrors the logic in inline-tool-store.svelte.ts exactly.
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

  getByConversation(conversationId: string): InlineToolCall[] {
    return this.calls.filter((c) => c.conversationId === conversationId);
  }

  getById(id: string): InlineToolCall | undefined {
    return this.calls.find((c) => c.id === id);
  }

  remove(id: string): void {
    this.calls = this.calls.filter((c) => c.id !== id);
  }
}

// ---------------------------------------------------------------------------
// Extracted validate / collectValues logic from InlineToolForm.svelte
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  enum?: string[];
  [k: string]: unknown;
}

function getFieldType(prop: SchemaProperty): string {
  if (prop.enum) return "enum";
  const t = prop.type as string;
  if (t === "boolean") return "boolean";
  if (t === "number" || t === "integer") return "number";
  if (t === "object" || t === "array") return "json";
  return "string";
}

function validate(
  properties: Record<string, SchemaProperty>,
  requiredFields: string[],
  values: Record<string, unknown>,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key]!;
    const val = values[key];
    const isRequired = requiredFields.includes(key);
    const fieldType = getFieldType(prop);

    if (isRequired && (val === "" || val === undefined || val === null)) {
      errors[key] = "Required";
      continue;
    }

    if (val === "" || val === undefined) continue;

    if (fieldType === "number") {
      const n = Number(val);
      if (isNaN(n)) {
        errors[key] = "Must be a valid number";
      }
    }
    if (fieldType === "json" && typeof val === "string" && val.trim() !== "") {
      try {
        JSON.parse(val);
      } catch {
        errors[key] = "Must be valid JSON";
      }
    }
  }
  return errors;
}

function collectValues(
  properties: Record<string, SchemaProperty>,
  values: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const key of Object.keys(properties)) {
    const prop = properties[key]!;
    const val = values[key];
    const fieldType = getFieldType(prop);

    if (val === "" || val === undefined) continue;

    if (fieldType === "number") result[key] = Number(val);
    else if (fieldType === "boolean") result[key] = val;
    else if (fieldType === "json" && typeof val === "string") {
      try {
        result[key] = JSON.parse(val);
      } catch {
        result[key] = val;
      }
    } else result[key] = val;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCall(overrides: Partial<Omit<InlineToolCall, "status" | "retryCount">> = {}): Omit<InlineToolCall, "status" | "retryCount"> {
  return {
    id: overrides.id ?? crypto.randomUUID(),
    extensionName: overrides.extensionName ?? "test-ext",
    toolName: overrides.toolName ?? "test-tool",
    input: overrides.input ?? { query: "hello" },
    conversationId: overrides.conversationId ?? "conv-1",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let store: PlainInlineToolStore;

beforeEach(() => {
  store = new PlainInlineToolStore();
});

// ── Happy path flow ──────────────────────────────────────────────────────

describe("happy path flow", () => {
  test("add → tool:start → tool:complete transitions correctly", () => {
    const call = makeCall({ id: "inv-1" });
    store.add(call);

    // pending
    expect(store.getById("inv-1")!.status).toBe("pending");
    expect(store.getById("inv-1")!.retryCount).toBe(0);

    // tool:start → running
    store.updateFromEvent("inv-1", "tool:start", { timestamp: 1000 });
    const running = store.getById("inv-1")!;
    expect(running.status).toBe("running");
    expect(running.startedAt).toBe(1000);

    // tool:complete → complete
    store.updateFromEvent("inv-1", "tool:complete", {
      output: "result data",
      duration: 250,
    });
    const completed = store.getById("inv-1")!;
    expect(completed.status).toBe("complete");
    expect(completed.output).toBe("result data");
    expect(completed.duration).toBe(250);
  });

  test("tool:complete with non-string output is JSON-stringified", () => {
    store.add(makeCall({ id: "inv-2" }));
    store.updateFromEvent("inv-2", "tool:start", { timestamp: 1 });
    store.updateFromEvent("inv-2", "tool:complete", {
      output: { key: "value" },
      duration: 50,
    });
    expect(store.getById("inv-2")!.output).toBe('{"key":"value"}');
  });

  test("getByConversation returns the completed call", () => {
    store.add(makeCall({ id: "inv-3", conversationId: "conv-A" }));
    store.updateFromEvent("inv-3", "tool:start", { timestamp: 1 });
    store.updateFromEvent("inv-3", "tool:complete", { output: "ok", duration: 10 });

    const results = store.getByConversation("conv-A");
    expect(results).toHaveLength(1);
    expect(results[0]!.status).toBe("complete");
  });
});

// ── Error + retry flow ───────────────────────────────────────────────────

describe("error + retry flow", () => {
  test("tool:error increments retryCount and sets error state", () => {
    store.add(makeCall({ id: "inv-err" }));
    store.updateFromEvent("inv-err", "tool:start", { timestamp: 1 });
    store.updateFromEvent("inv-err", "tool:error", {
      error: "timeout",
      duration: 500,
    });

    const errored = store.getById("inv-err")!;
    expect(errored.status).toBe("error");
    expect(errored.error).toBe("timeout");
    expect(errored.retryCount).toBe(1);
    expect(errored.duration).toBe(500);
  });

  test("retry creates new call while old remains in error", () => {
    const params = { extensionName: "ext", toolName: "tool", input: { x: 1 }, conversationId: "conv-1" };

    // First attempt fails
    store.add(makeCall({ id: "attempt-1", ...params }));
    store.updateFromEvent("attempt-1", "tool:start", { timestamp: 1 });
    store.updateFromEvent("attempt-1", "tool:error", { error: "fail", duration: 100 });

    // Retry with new id
    store.add(makeCall({ id: "attempt-2", ...params }));
    store.updateFromEvent("attempt-2", "tool:start", { timestamp: 2 });
    store.updateFromEvent("attempt-2", "tool:complete", { output: "success", duration: 50 });

    expect(store.getById("attempt-1")!.status).toBe("error");
    expect(store.getById("attempt-2")!.status).toBe("complete");
  });
});

// ── Multiple concurrent calls ────────────────────────────────────────────

describe("multiple concurrent calls", () => {
  test("3 calls in same conversation tracked independently", () => {
    store.add(makeCall({ id: "c1", toolName: "tool-a", conversationId: "conv-X" }));
    store.add(makeCall({ id: "c2", toolName: "tool-b", conversationId: "conv-X" }));
    store.add(makeCall({ id: "c3", toolName: "tool-c", conversationId: "conv-X" }));

    // Progress to different states
    store.updateFromEvent("c1", "tool:start", { timestamp: 1 });
    store.updateFromEvent("c1", "tool:complete", { output: "done", duration: 10 });

    store.updateFromEvent("c2", "tool:start", { timestamp: 2 });
    // c2 stays running

    // c3 stays pending

    const all = store.getByConversation("conv-X");
    expect(all).toHaveLength(3);
    expect(all.find((c) => c.id === "c1")!.status).toBe("complete");
    expect(all.find((c) => c.id === "c2")!.status).toBe("running");
    expect(all.find((c) => c.id === "c3")!.status).toBe("pending");
  });

  test("remove one leaves the rest", () => {
    store.add(makeCall({ id: "r1", conversationId: "conv-Y" }));
    store.add(makeCall({ id: "r2", conversationId: "conv-Y" }));
    store.add(makeCall({ id: "r3", conversationId: "conv-Y" }));

    store.remove("r2");

    const remaining = store.getByConversation("conv-Y");
    expect(remaining).toHaveLength(2);
    expect(remaining.map((c) => c.id).sort()).toEqual(["r1", "r3"]);
  });

  test("updateFromEvent on unknown id is a no-op", () => {
    store.add(makeCall({ id: "known" }));
    store.updateFromEvent("unknown-id", "tool:start", { timestamp: 1 });
    expect(store.calls).toHaveLength(1);
    expect(store.getById("known")!.status).toBe("pending");
  });
});

// ── InlineToolForm validation logic ──────────────────────────────────────

describe("InlineToolForm validation logic", () => {
  test("required field that is empty returns error", () => {
    const props = { name: { type: "string" } };
    const errors = validate(props, ["name"], { name: "" });
    expect(errors.name).toBe("Required");
  });

  test("required field that is undefined returns error", () => {
    const props = { name: { type: "string" } };
    const errors = validate(props, ["name"], {});
    expect(errors.name).toBe("Required");
  });

  test("non-numeric string in number field returns error", () => {
    const props = { count: { type: "number" } };
    const errors = validate(props, [], { count: "abc" });
    expect(errors.count).toBe("Must be a valid number");
  });

  test("invalid JSON in object field returns error", () => {
    const props = { data: { type: "object" } };
    const errors = validate(props, [], { data: "{broken" });
    expect(errors.data).toBe("Must be valid JSON");
  });

  test("valid inputs produce no errors", () => {
    const props = {
      name: { type: "string" },
      count: { type: "number" },
      config: { type: "object" },
    };
    const errors = validate(props, ["name"], {
      name: "hello",
      count: "42",
      config: '{"a":1}',
    });
    expect(errors).toEqual({});
  });

  test("empty optional fields produce no errors", () => {
    const props = { opt: { type: "string" } };
    const errors = validate(props, [], { opt: "" });
    expect(errors).toEqual({});
  });
});

describe("InlineToolForm collectValues logic", () => {
  test("converts number strings to numbers", () => {
    const props = { count: { type: "number" } };
    expect(collectValues(props, { count: "42" })).toEqual({ count: 42 });
  });

  test("parses JSON strings to objects", () => {
    const props = { data: { type: "object" } };
    expect(collectValues(props, { data: '{"a":1}' })).toEqual({ data: { a: 1 } });
  });

  test("boolean fields pass through", () => {
    const props = { flag: { type: "boolean" } };
    expect(collectValues(props, { flag: true })).toEqual({ flag: true });
    expect(collectValues(props, { flag: false })).toEqual({ flag: false });
  });

  test("empty optional fields are omitted", () => {
    const props = { opt: { type: "string" }, req: { type: "string" } };
    expect(collectValues(props, { opt: "", req: "val" })).toEqual({ req: "val" });
  });

  test("invalid JSON in object field falls back to raw string", () => {
    const props = { data: { type: "object" } };
    expect(collectValues(props, { data: "{bad" })).toEqual({ data: "{bad" });
  });

  test("integer type treated as number", () => {
    const props = { id: { type: "integer" } };
    expect(collectValues(props, { id: "7" })).toEqual({ id: 7 });
  });

  test("array type treated as json", () => {
    const props = { items: { type: "array" } };
    expect(collectValues(props, { items: "[1,2,3]" })).toEqual({ items: [1, 2, 3] });
  });
});

// ── API contract tests (mock fetch) ─────────────────────────────────────

describe("API contract tests", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function mockFetch(status: number, body: Record<string, unknown>) {
    globalThis.fetch = mock(() =>
      Promise.resolve(new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      })),
    ) as typeof fetch;
  }

  const validBody = {
    extensionName: "test-ext",
    toolName: "test-tool",
    input: { query: "hello" },
    conversationId: "conv-1",
    invocationId: "inv-1",
  };

  test("successful invocation returns output, retryCount, durationMs", async () => {
    mockFetch(200, {
      success: true,
      output: "result data",
      retryCount: 0,
      durationMs: 123,
      toolCallId: "inv-1",
    });

    const res = await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(validBody),
    });

    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.output).toBe("result data");
    expect(json.retryCount).toBe(0);
    expect(typeof json.durationMs).toBe("number");
    expect(json.toolCallId).toBe("inv-1");
  });

  test("missing fields returns 400", async () => {
    mockFetch(400, {
      success: false,
      error: "Missing required fields: extensionName, toolName, conversationId, invocationId",
    });

    const res = await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ extensionName: "x" }),
    });

    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain("Missing required fields");
  });

  test("unknown tool returns 404", async () => {
    mockFetch(404, {
      success: false,
      error: "Tool not found: ghost-ext.ghost-tool",
    });

    const res = await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...validBody, extensionName: "ghost-ext", toolName: "ghost-tool" }),
    });

    expect(res.status).toBe(404);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toContain("Tool not found");
  });

  test("full roundtrip: store add → API call → event updates → final state", async () => {
    mockFetch(200, {
      success: true,
      output: "computed result",
      retryCount: 0,
      durationMs: 200,
      toolCallId: "inv-rt",
    });

    // 1. Add to store
    store.add(makeCall({ id: "inv-rt", conversationId: "conv-rt" }));
    expect(store.getById("inv-rt")!.status).toBe("pending");

    // 2. Fire API call
    const res = await fetch("/api/tool-invoke", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        extensionName: "test-ext",
        toolName: "test-tool",
        input: { query: "hello" },
        conversationId: "conv-rt",
        invocationId: "inv-rt",
      }),
    });
    const json = await res.json();

    // 3. Simulate WS events that server would emit
    store.updateFromEvent("inv-rt", "tool:start", { timestamp: Date.now() });
    expect(store.getById("inv-rt")!.status).toBe("running");

    store.updateFromEvent("inv-rt", "tool:complete", {
      output: json.output,
      duration: json.durationMs,
    });

    // 4. Verify final state
    const final = store.getById("inv-rt")!;
    expect(final.status).toBe("complete");
    expect(final.output).toBe("computed result");
    expect(final.duration).toBe(200);

    // 5. Verify getByConversation
    const convCalls = store.getByConversation("conv-rt");
    expect(convCalls).toHaveLength(1);
    expect(convCalls[0]!.id).toBe("inv-rt");
  });
});
