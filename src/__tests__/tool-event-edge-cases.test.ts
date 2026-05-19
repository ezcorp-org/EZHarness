import { test, expect, describe } from "bun:test";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  createPermissionGate,
  resolvePermission,
  getPendingApproval,
} from "../runtime/tools/permissions";

// ── Helpers ───────────────────────────────────────────────────────────

/** Collect events emitted on a bus into an array for later assertions. */
function collect<K extends keyof AgentEvents & string>(
  bus: EventBus<AgentEvents>,
  event: K,
): AgentEvents[K][] {
  const collected: AgentEvents[K][] = [];
  bus.on(event, (data) => collected.push(data));
  return collected;
}

/** Index into an array, throwing if the slot is absent — avoids `!` under noUncheckedIndexedAccess. */
function at<T>(arr: readonly T[], i: number, what: string): T {
  const v = arr[i];
  if (v === undefined) throw new Error(`expected ${what} at index ${i}`);
  return v;
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("tool:start and tool:permission_request emit different data shapes", () => {
  test("tool:start includes timestamp, tool:permission_request includes toolCallId", () => {
    const bus = new EventBus<AgentEvents>();
    const starts = collect(bus, "tool:start");
    const perms = collect(bus, "tool:permission_request");

    bus.emit("tool:start", {
      conversationId: "conv-1",
      extensionId: "",
      toolName: "shell",
      input: { command: "ls" },
      timestamp: Date.now(),
      cardType: "terminal",
      category: "execute",
    });

    bus.emit("tool:permission_request", {
      conversationId: "conv-1",
      toolCallId: "tc-42",
      toolName: "shell",
      input: { command: "ls" },
      cardType: "terminal",
      category: "execute",
    });

    expect(starts).toHaveLength(1);
    expect(perms).toHaveLength(1);

    // tool:start has timestamp but NOT toolCallId
    const start = starts[0]!;
    expect(start.timestamp).toBeNumber();
    expect("toolCallId" in start).toBe(false);

    // tool:permission_request has toolCallId but NOT timestamp
    const perm = perms[0]!;
    expect(perm.toolCallId).toBe("tc-42");
    expect("timestamp" in perm).toBe(false);
  });
});

describe("tool:permission_request includes all required fields", () => {
  test("event data shape matches what PermissionGate.svelte expects", () => {
    const bus = new EventBus<AgentEvents>();
    const perms = collect(bus, "tool:permission_request");

    bus.emit("tool:permission_request", {
      conversationId: "conv-1",
      toolCallId: "tc-99",
      toolName: "edit_file",
      input: { file_path: "/tmp/x.ts", content: "hello" },
      cardType: "diff",
      category: "write",
    });

    expect(perms).toHaveLength(1);
    const p = perms[0]!;

    // All six fields the frontend depends on
    expect(p.conversationId).toBe("conv-1");
    expect(p.toolCallId).toBe("tc-99");
    expect(p.toolName).toBe("edit_file");
    expect(p.input).toEqual({ file_path: "/tmp/x.ts", content: "hello" });
    expect(p.cardType).toBe("diff");
    expect(p.category).toBe("write");
  });
});

describe("tool:complete preserves cardType from tool:start", () => {
  test("both events carry the same cardType when emitted in sequence", () => {
    const bus = new EventBus<AgentEvents>();
    const starts = collect(bus, "tool:start");
    const completes = collect(bus, "tool:complete");

    const cardType = "terminal";

    bus.emit("tool:start", {
      conversationId: "conv-1",
      extensionId: "",
      toolName: "shell",
      input: { command: "echo hi" },
      timestamp: Date.now(),
      cardType,
      category: "execute",
    });

    bus.emit("tool:complete", {
      conversationId: "conv-1",
      extensionId: "",
      toolName: "shell",
      output: { stdout: "hi\n" },
      duration: 42,
      success: true,
      cardType,
    });

    const start0 = at(starts, 0, "starts");
    const complete0 = at(completes, 0, "completes");
    expect(start0.cardType).toBe("terminal");
    expect(complete0.cardType).toBe("terminal");
    expect(start0.cardType).toBe(complete0.cardType);
  });

  test("cardType consistency holds for diff-type tools too", () => {
    const bus = new EventBus<AgentEvents>();
    const starts = collect(bus, "tool:start");
    const completes = collect(bus, "tool:complete");

    bus.emit("tool:start", {
      conversationId: "conv-2",
      extensionId: "",
      toolName: "edit_file",
      input: { file_path: "/tmp/a.ts" },
      timestamp: Date.now(),
      cardType: "diff",
      category: "write",
    });

    bus.emit("tool:complete", {
      conversationId: "conv-2",
      extensionId: "",
      toolName: "edit_file",
      output: "ok",
      duration: 10,
      success: true,
      cardType: "diff",
    });

    expect(at(starts, 0, "starts").cardType).toBe(
      at(completes, 0, "completes").cardType,
    );
  });
});

describe("extension tool without cardType emits undefined", () => {
  test("tool:start with no cardType in ToolDefinition has cardType undefined", () => {
    const bus = new EventBus<AgentEvents>();
    const starts = collect(bus, "tool:start");

    // Simulates the builtin path: toolDef?.cardType when toolDef has no cardType
    const toolDef: { cardType?: string; category?: string } = {};

    bus.emit("tool:start", {
      conversationId: "conv-3",
      extensionId: "ext-custom",
      toolName: "custom_tool",
      input: {},
      timestamp: Date.now(),
      cardType: toolDef?.cardType,   // undefined, not null
      category: toolDef?.category,
    });

    expect(starts).toHaveLength(1);
    const start0 = at(starts, 0, "starts");
    expect(start0.cardType).toBeUndefined();
    // Verify it's `undefined` specifically, not `null` or missing entirely
    expect(start0.cardType).not.toBeNull();
    expect("cardType" in start0).toBe(true);
    expect(start0.cardType).toBe(undefined);
  });

  test("extension spread pattern omits cardType key when falsy", () => {
    const bus = new EventBus<AgentEvents>();
    const starts = collect(bus, "tool:start");

    // Simulates the extension ToolExecutor pattern:
    //   ...(registered.cardType && { cardType: registered.cardType })
    const registered = { cardType: undefined as string | undefined };

    bus.emit("tool:start", {
      conversationId: "conv-4",
      extensionId: "ext-no-card",
      toolName: "ext_tool",
      input: {},
      timestamp: Date.now(),
      ...(registered.cardType && { cardType: registered.cardType }),
    });

    expect(starts).toHaveLength(1);
    // When cardType is undefined on the registered tool, the spread doesn't add it
    expect(at(starts, 0, "starts").cardType).toBeUndefined();
  });
});

describe("permission gate creates and resolves without leftover state", () => {
  test("create gate, resolve it, verify cleared, then create another with same ID", async () => {
    const toolCallId = "reuse-gate-1";

    // First gate lifecycle
    const gate1 = createPermissionGate(toolCallId);
    expect(getPendingApproval(toolCallId)).toBe(true);

    resolvePermission(toolCallId, true);
    await gate1;

    expect(getPendingApproval(toolCallId)).toBe(false);

    // Second gate with the same ID should work without conflicts
    const gate2 = createPermissionGate(toolCallId);
    expect(getPendingApproval(toolCallId)).toBe(true);

    resolvePermission(toolCallId, true);
    await gate2;

    expect(getPendingApproval(toolCallId)).toBe(false);
  });

  test("rejected gate cleans up and allows reuse of same ID", async () => {
    const toolCallId = "reuse-gate-2";

    // First gate — denied
    const gate1 = createPermissionGate(toolCallId);
    expect(getPendingApproval(toolCallId)).toBe(true);

    resolvePermission(toolCallId, false);
    await expect(gate1).rejects.toThrow("Permission denied");
    expect(getPendingApproval(toolCallId)).toBe(false);

    // Reuse same ID — should not conflict
    const gate2 = createPermissionGate(toolCallId);
    expect(getPendingApproval(toolCallId)).toBe(true);

    resolvePermission(toolCallId, true);
    await gate2;

    expect(getPendingApproval(toolCallId)).toBe(false);
  });

  test("resolving an already-resolved gate is a no-op", async () => {
    const toolCallId = "double-resolve";

    const gate = createPermissionGate(toolCallId);
    resolvePermission(toolCallId, true);
    await gate;

    // Should not throw or leave dangling state
    expect(() => resolvePermission(toolCallId, true)).not.toThrow();
    expect(() => resolvePermission(toolCallId, false)).not.toThrow();
    expect(getPendingApproval(toolCallId)).toBe(false);
  });
});
