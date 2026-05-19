import { describe, test, expect, beforeEach } from "bun:test";

// ── Shared types ──

interface InlineToolCall {
  id: string;
  extensionName: string;
  toolName: string;
  input: Record<string, unknown>;
  status: "pending" | "running" | "complete" | "error";
  output?: string;
  error?: string;
  retryCount: number;
  startedAt?: number;
  duration?: number;
  conversationId: string;
  messageId?: string;
}

// ── Store (reused from inline-tool-store.test.ts) ──

class PlainInlineToolStore {
  calls: InlineToolCall[] = [];

  add(call: Omit<InlineToolCall, "status" | "retryCount">): void {
    this.calls = [...this.calls, { ...call, status: "pending", retryCount: 0 }];
  }

  updateFromEvent(invocationId: string, eventType: string, data: Record<string, unknown>): void {
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
          output: typeof data.output === "string" ? data.output : JSON.stringify(data.output),
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

// ── Extracted pure functions ──

const statusColors: Record<string, string> = {
  pending: "bg-gray-400",
  running: "bg-yellow-400 animate-pulse",
  complete: "bg-green-500",
  error: "bg-red-500",
};

function getStatusDotClass(status: string | undefined): string | undefined {
  if (!status) return undefined;
  return statusColors[status];
}

function getExtensionStatus(
  extName: string,
  calls: InlineToolCall[],
  conversationId: string,
): string | undefined {
  const filtered = calls.filter(
    (c) => c.extensionName === extName && c.conversationId === conversationId,
  );
  if (filtered.length === 0) return undefined;
  return filtered[filtered.length - 1]!.status;
}

function deriveSummaryLine(call: InlineToolCall): string {
  if (call.status !== "complete" || !call.output) return "";
  const firstLine = call.output.split("\n")[0] ?? "";
  const truncated = firstLine.length > 80 ? firstLine.slice(0, 80) + "..." : firstLine;
  const dur = call.duration != null ? ` (${(call.duration / 1000).toFixed(1)}s)` : "";
  return `${call.extensionName} > ${call.toolName} -- ${truncated}${dur}`;
}

interface ChipProps {
  status?: string;
  onclick?: () => void;
}

function chipAttributes(props: ChipProps) {
  const hasClick = typeof props.onclick === "function";
  return {
    role: hasClick ? "button" : undefined,
    tabindex: hasClick ? 0 : undefined,
    statusDotClass: getStatusDotClass(props.status),
  };
}

function makeCall(overrides: Partial<Omit<InlineToolCall, "status" | "retryCount">> = {}): Omit<InlineToolCall, "status" | "retryCount"> {
  return {
    id: overrides.id ?? "inv-1",
    extensionName: overrides.extensionName ?? "ext-a",
    toolName: overrides.toolName ?? "doThing",
    input: overrides.input ?? { foo: "bar" },
    conversationId: overrides.conversationId ?? "conv-1",
    ...overrides,
  };
}

function makeFullCall(overrides: Partial<InlineToolCall> = {}): InlineToolCall {
  return {
    id: "inv-1",
    extensionName: "test-ext",
    toolName: "do-thing",
    input: {},
    status: "complete",
    retryCount: 0,
    conversationId: "conv-1",
    ...overrides,
  };
}

// ── 1. MentionChip Status Logic ──

describe("MentionChip status dot mapping", () => {
  test("each status maps to correct CSS class", () => {
    expect(getStatusDotClass("pending")).toBe("bg-gray-400");
    expect(getStatusDotClass("running")).toBe("bg-yellow-400 animate-pulse");
    expect(getStatusDotClass("complete")).toBe("bg-green-500");
    expect(getStatusDotClass("error")).toBe("bg-red-500");
  });

  test("undefined status means no dot rendered", () => {
    expect(getStatusDotClass(undefined)).toBeUndefined();
  });

  test("unknown status returns undefined", () => {
    expect(getStatusDotClass("cancelled")).toBeUndefined();
  });
});

describe("MentionChip interactivity", () => {
  test("with onclick: chip is interactive (role=button, tabindex=0)", () => {
    const attrs = chipAttributes({ onclick: () => {} });
    expect(attrs.role).toBe("button");
    expect(attrs.tabindex).toBe(0);
  });

  test("without onclick: chip is not interactive", () => {
    const attrs = chipAttributes({});
    expect(attrs.role).toBeUndefined();
    expect(attrs.tabindex).toBeUndefined();
  });

  test("onclick undefined explicitly: chip is not interactive", () => {
    const attrs = chipAttributes({ onclick: undefined });
    expect(attrs.role).toBeUndefined();
    expect(attrs.tabindex).toBeUndefined();
  });

  test("keyboard accessibility: Enter and Space trigger onclick", () => {
    let count = 0;
    const onclick = () => { count++; };

    // Simulate keyboard handler logic from MentionChip
    function handleKeydown(key: string, handler?: () => void) {
      if (handler && (key === "Enter" || key === " ")) {
        handler();
      }
    }

    handleKeydown("Enter", onclick);
    expect(count).toBe(1);

    handleKeydown(" ", onclick);
    expect(count).toBe(2);

    handleKeydown("Tab", onclick);
    expect(count).toBe(2); // Tab should not trigger

    handleKeydown("Enter", undefined);
    expect(count).toBe(2); // no handler, no crash
  });
});

// ── 2. getExtensionStatus Logic ──

describe("getExtensionStatus", () => {
  test("no calls returns undefined", () => {
    expect(getExtensionStatus("ext-a", [], "conv-1")).toBeUndefined();
  });

  test("single call returns its status", () => {
    const calls: InlineToolCall[] = [makeFullCall({ extensionName: "ext-a", conversationId: "conv-1", status: "running" })];
    expect(getExtensionStatus("ext-a", calls, "conv-1")).toBe("running");
  });

  test("multiple calls for same extension returns LAST call's status", () => {
    const calls: InlineToolCall[] = [
      makeFullCall({ id: "1", extensionName: "ext-a", conversationId: "conv-1", status: "complete" }),
      makeFullCall({ id: "2", extensionName: "ext-a", conversationId: "conv-1", status: "error" }),
      makeFullCall({ id: "3", extensionName: "ext-a", conversationId: "conv-1", status: "running" }),
    ];
    expect(getExtensionStatus("ext-a", calls, "conv-1")).toBe("running");
  });

  test("different extensions are correctly filtered", () => {
    const calls: InlineToolCall[] = [
      makeFullCall({ id: "1", extensionName: "ext-a", conversationId: "conv-1", status: "complete" }),
      makeFullCall({ id: "2", extensionName: "ext-b", conversationId: "conv-1", status: "error" }),
    ];
    expect(getExtensionStatus("ext-a", calls, "conv-1")).toBe("complete");
    expect(getExtensionStatus("ext-b", calls, "conv-1")).toBe("error");
  });

  test("different conversations are correctly filtered", () => {
    const calls: InlineToolCall[] = [
      makeFullCall({ id: "1", extensionName: "ext-a", conversationId: "conv-1", status: "complete" }),
      makeFullCall({ id: "2", extensionName: "ext-a", conversationId: "conv-2", status: "error" }),
    ];
    expect(getExtensionStatus("ext-a", calls, "conv-1")).toBe("complete");
    expect(getExtensionStatus("ext-a", calls, "conv-2")).toBe("error");
    expect(getExtensionStatus("ext-a", calls, "conv-3")).toBeUndefined();
  });
});

// ── 3. Concurrent Invocations Edge Cases ──

describe("concurrent invocations", () => {
  let store: PlainInlineToolStore;

  beforeEach(() => {
    store = new PlainInlineToolStore();
  });

  test("5 concurrent invocations reach different states independently", () => {
    for (let i = 1; i <= 5; i++) {
      store.add(makeCall({ id: `inv-${i}`, toolName: `tool-${i}` }));
    }
    expect(store.calls).toHaveLength(5);

    store.updateFromEvent("inv-1", "tool:start", { timestamp: 100 });
    store.updateFromEvent("inv-2", "tool:start", { timestamp: 101 });
    store.updateFromEvent("inv-2", "tool:complete", { output: "done", duration: 50 });
    store.updateFromEvent("inv-3", "tool:start", { timestamp: 102 });
    store.updateFromEvent("inv-3", "tool:error", { error: "fail", duration: 10 });

    expect(store.getById("inv-1")!.status).toBe("running");
    expect(store.getById("inv-2")!.status).toBe("complete");
    expect(store.getById("inv-3")!.status).toBe("error");
    expect(store.getById("inv-4")!.status).toBe("pending");
    expect(store.getById("inv-5")!.status).toBe("pending");
  });

  test("removing one call while others are running leaves running calls unaffected", () => {
    store.add(makeCall({ id: "inv-1" }));
    store.add(makeCall({ id: "inv-2" }));
    store.updateFromEvent("inv-1", "tool:start", { timestamp: 100 });
    store.updateFromEvent("inv-2", "tool:start", { timestamp: 101 });

    store.remove("inv-1");

    expect(store.calls).toHaveLength(1);
    expect(store.getById("inv-2")!.status).toBe("running");
    expect(store.getById("inv-1")).toBeUndefined();
  });

  test("rapid add->start->complete in same timestamp", () => {
    store.add(makeCall({ id: "inv-rapid" }));
    store.updateFromEvent("inv-rapid", "tool:start", { timestamp: 0 });
    store.updateFromEvent("inv-rapid", "tool:complete", { output: "instant", duration: 0 });

    const call = store.getById("inv-rapid")!;
    expect(call.status).toBe("complete");
    expect(call.duration).toBe(0);
    expect(call.output).toBe("instant");
  });

  test("re-invoke same tool after error: old and new coexist", () => {
    store.add(makeCall({ id: "inv-old", toolName: "search" }));
    store.updateFromEvent("inv-old", "tool:start", { timestamp: 100 });
    store.updateFromEvent("inv-old", "tool:error", { error: "timeout", duration: 5000 });

    // Re-invoke with new id
    store.add(makeCall({ id: "inv-new", toolName: "search" }));
    store.updateFromEvent("inv-new", "tool:start", { timestamp: 200 });
    store.updateFromEvent("inv-new", "tool:complete", { output: "success", duration: 100 });

    expect(store.calls).toHaveLength(2);
    expect(store.getById("inv-old")!.status).toBe("error");
    expect(store.getById("inv-new")!.status).toBe("complete");
  });

  test("cancel (remove) one running call while others continue", () => {
    store.add(makeCall({ id: "inv-a" }));
    store.add(makeCall({ id: "inv-b" }));
    store.add(makeCall({ id: "inv-c" }));
    store.updateFromEvent("inv-a", "tool:start", { timestamp: 100 });
    store.updateFromEvent("inv-b", "tool:start", { timestamp: 101 });
    store.updateFromEvent("inv-c", "tool:start", { timestamp: 102 });

    // Cancel inv-b
    store.remove("inv-b");

    // Others still running
    expect(store.getById("inv-a")!.status).toBe("running");
    expect(store.getById("inv-c")!.status).toBe("running");
    expect(store.calls).toHaveLength(2);

    // Completing inv-a still works
    store.updateFromEvent("inv-a", "tool:complete", { output: "ok", duration: 50 });
    expect(store.getById("inv-a")!.status).toBe("complete");
  });
});

// ── 4. InlineToolCard Edge Cases ──

describe("InlineToolCard summaryLine edge cases", () => {
  test("empty string output yields empty summary content", () => {
    const result = deriveSummaryLine(makeFullCall({ output: "" }));
    // output is empty string, which is falsy, so returns ""
    expect(result).toBe("");
  });

  test("output with only newlines yields empty first line", () => {
    const result = deriveSummaryLine(makeFullCall({ output: "\n\n\n" }));
    expect(result).toBe("test-ext > do-thing -- ");
  });

  test("unicode/emoji in output", () => {
    const result = deriveSummaryLine(makeFullCall({ output: "Results found: 42 items" }));
    expect(result).toContain("Results found: 42 items");
  });

  test("zero duration (0ms)", () => {
    const result = deriveSummaryLine(makeFullCall({ output: "fast", duration: 0 }));
    expect(result).toContain("(0.0s)");
  });

  test("very large duration formatting", () => {
    const result = deriveSummaryLine(makeFullCall({ output: "slow", duration: 3_600_000 }));
    expect(result).toContain("(3600.0s)");
  });
});

// ── 5. Form Validation Edge Cases ──

describe("form validation edge cases", () => {
  interface SchemaProperty {
    type: string;
    enum?: string[];
  }

  interface InputSchema {
    type: "object";
    properties: Record<string, SchemaProperty>;
    required?: string[];
  }

  /**
   * Mirrors the form value coercion logic from the tool invocation form.
   * Converts raw string inputs to typed values based on schema.
   */
  function coerceFormValues(
    rawValues: Record<string, string>,
    schema: InputSchema,
  ): Record<string, unknown> {
    const result: Record<string, unknown> = {};

    for (const [key, rawValue] of Object.entries(rawValues)) {
      const prop = schema.properties[key];
      if (!prop) continue;

      if (rawValue === "" || rawValue === undefined || rawValue === null) {
        // Skip empty optional fields
        if (!schema.required?.includes(key)) continue;
        result[key] = null;
        continue;
      }

      switch (prop.type) {
        case "number":
        case "integer": {
          const n = Number(rawValue);
          result[key] = Number.isNaN(n) ? rawValue : n;
          break;
        }
        case "boolean":
          result[key] = rawValue === "true";
          break;
        case "object":
        case "array":
          try {
            result[key] = JSON.parse(rawValue);
          } catch {
            result[key] = rawValue;
          }
          break;
        default:
          result[key] = rawValue;
      }
    }

    return result;
  }

  test("null values in required fields produce null", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
    };
    const result = coerceFormValues({ name: "" }, schema);
    expect(result.name).toBeNull();
  });

  test("NaN from non-numeric string in number field preserves raw string", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { count: { type: "number" } },
    };
    const result = coerceFormValues({ count: "abc" }, schema);
    expect(result.count).toBe("abc");
  });

  test("deeply nested JSON in object field", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { config: { type: "object" } },
    };
    const nested = JSON.stringify({ a: { b: { c: [1, 2, { d: true }] } } });
    const result = coerceFormValues({ config: nested }, schema);
    expect(result.config).toEqual({ a: { b: { c: [1, 2, { d: true }] } } });
  });

  test("empty array JSON [] is valid", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { items: { type: "array" } },
    };
    const result = coerceFormValues({ items: "[]" }, schema);
    expect(result.items).toEqual([]);
  });

  test("enum field with value not in enum list passes through", () => {
    const schema: InputSchema = {
      type: "object",
      properties: { color: { type: "string", enum: ["red", "blue"] } },
    };
    const result = coerceFormValues({ color: "green" }, schema);
    expect(result.color).toBe("green");
  });

  test("all fields optional and empty yields empty result object", () => {
    const schema: InputSchema = {
      type: "object",
      properties: {
        a: { type: "string" },
        b: { type: "number" },
        c: { type: "boolean" },
      },
    };
    const result = coerceFormValues({ a: "", b: "", c: "" }, schema);
    expect(result).toEqual({});
  });
});

// ── 6. API Response Destructuring (32-04 fix verification) ──

describe("API response destructuring (32-04 fix)", () => {
  test("{ tools } destructuring yields array with .length", () => {
    const response = { tools: [{ name: "a", description: "b", inputSchema: {} }] };
    const { tools } = response;
    expect(Array.isArray(tools)).toBe(true);
    expect(tools.length).toBe(1);
    expect(tools[0].name).toBe("a");
  });

  test("raw response object does NOT have .length (the bug scenario)", () => {
    const response = { tools: [{ name: "a", description: "b", inputSchema: {} }] };
    // Bug: treating response as the array directly
    const tools = response as any;
    expect(tools.length).toBeUndefined();
  });

  test(".find() works on destructured array but not on wrapper object", () => {
    const response = { tools: [
      { name: "a", description: "first", inputSchema: {} },
      { name: "b", description: "second", inputSchema: {} },
    ]};

    // Correct: destructured
    const { tools } = response;
    const found = tools.find((t) => t.name === "b");
    expect(found).toBeDefined();
    expect(found!.description).toBe("second");

    // Bug scenario: .find is not a function on the wrapper
    const buggy = response as any;
    expect(typeof buggy.find).toBe("undefined");
  });

  test("destructured empty tools array has length 0", () => {
    const response = { tools: [] as any[] };
    const { tools } = response;
    expect(tools.length).toBe(0);
    expect(tools.find((t: any) => t.name === "x")).toBeUndefined();
  });
});
