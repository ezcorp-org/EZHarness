import { test, expect, describe, mock, beforeEach } from "bun:test";

// Mock getSetting before importing the module
const mockGetSetting = mock<(key: string) => Promise<unknown>>(() => Promise.resolve(undefined));
mock.module("../../db/queries/settings", () => ({
  getSetting: mockGetSetting,
  upsertSetting: mock(() => Promise.resolve()),
}));

import {
  needsApproval,
  getPermissionMode,
  createPermissionGate,
  resolvePermission,
  getPendingApproval,
} from "./permissions";

beforeEach(() => {
  mockGetSetting.mockReset();
  mockGetSetting.mockResolvedValue(undefined);
});

describe("needsApproval", () => {
  test('"ask" mode auto-approves read tools, blocks write and execute', () => {
    expect(needsApproval("read", "ask")).toBe(false);
    expect(needsApproval("write", "ask")).toBe(true);
    expect(needsApproval("execute", "ask")).toBe(true);
  });

  test('"auto-edit" mode auto-approves read and write, blocks execute', () => {
    expect(needsApproval("read", "auto-edit")).toBe(false);
    expect(needsApproval("write", "auto-edit")).toBe(false);
    expect(needsApproval("execute", "auto-edit")).toBe(true);
  });

  test('"yolo" mode auto-approves all categories', () => {
    expect(needsApproval("read", "yolo")).toBe(false);
    expect(needsApproval("write", "yolo")).toBe(false);
    expect(needsApproval("execute", "yolo")).toBe(false);
  });

  test("returns correct boolean for each category+mode combo", () => {
    // Exhaustive matrix check
    const expected: Record<string, Record<string, boolean>> = {
      ask: { read: false, write: true, execute: true },
      "auto-edit": { read: false, write: false, execute: true },
      yolo: { read: false, write: false, execute: false },
    };
    for (const [mode, categories] of Object.entries(expected)) {
      for (const [category, needs] of Object.entries(categories)) {
        expect(needsApproval(category as any, mode as any)).toBe(needs);
      }
    }
  });
});

describe("getPermissionMode", () => {
  test("returns session override when provided", async () => {
    const result = await getPermissionMode("proj-1", "yolo");
    expect(result).toBe("yolo");
    expect(mockGetSetting).not.toHaveBeenCalled();
  });

  test("falls back to stored setting when no override", async () => {
    mockGetSetting.mockResolvedValue("auto-edit");
    const result = await getPermissionMode("proj-1");
    expect(result).toBe("auto-edit");
    expect(mockGetSetting).toHaveBeenCalledWith("project:proj-1:tool_permission_mode");
  });

  test('defaults to "ask" when no setting exists', async () => {
    mockGetSetting.mockResolvedValue(undefined);
    const result = await getPermissionMode("proj-1");
    expect(result).toBe("ask");
  });

  test("defaults to ask for invalid stored value", async () => {
    mockGetSetting.mockResolvedValue("invalid-mode");
    const result = await getPermissionMode("proj-1");
    expect(result).toBe("ask");
  });
});

describe("permission gate", () => {
  test("createPermissionGate returns a promise that resolves when resolvePermission is called with approved=true", async () => {
    const gate = createPermissionGate("tool-1");
    expect(getPendingApproval("tool-1")).toBe(true);
    resolvePermission("tool-1", true);
    await expect(gate).resolves.toBeUndefined();
    expect(getPendingApproval("tool-1")).toBe(false);
  });

  test("createPermissionGate rejects when resolvePermission is called with approved=false", async () => {
    const gate = createPermissionGate("tool-2");
    resolvePermission("tool-2", false);
    await expect(gate).rejects.toThrow("Permission denied");
    expect(getPendingApproval("tool-2")).toBe(false);
  });

  test("resolvePermission for unknown toolCallId is a no-op", () => {
    // Should not throw
    expect(() => resolvePermission("nonexistent", true)).not.toThrow();
  });
});

describe("dynamic permission mode re-read", () => {
  test("re-reads from DB each call when no session override", async () => {
    mockGetSetting.mockResolvedValueOnce("yolo");
    const first = await getPermissionMode("proj-1");
    expect(first).toBe("yolo");

    mockGetSetting.mockResolvedValueOnce("ask");
    const second = await getPermissionMode("proj-1");
    expect(second).toBe("ask");

    expect(mockGetSetting).toHaveBeenCalledTimes(2);
  });
});

describe("multiple concurrent permission gates", () => {
  test("3 gates resolved in different order resolve/reject independently", async () => {
    const gate1 = createPermissionGate("concurrent-1");
    const gate2 = createPermissionGate("concurrent-2");
    const gate3 = createPermissionGate("concurrent-3");

    expect(getPendingApproval("concurrent-1")).toBe(true);
    expect(getPendingApproval("concurrent-2")).toBe(true);
    expect(getPendingApproval("concurrent-3")).toBe(true);

    // Resolve out of order: 3 (deny), 1 (approve), 2 (approve)
    resolvePermission("concurrent-3", false);
    resolvePermission("concurrent-1", true);
    resolvePermission("concurrent-2", true);

    await expect(gate1).resolves.toBeUndefined();
    await expect(gate2).resolves.toBeUndefined();
    await expect(gate3).rejects.toThrow("Permission denied");
  });
});

describe("gate cleanup after resolve", () => {
  test("getPendingApproval returns false after resolve and re-resolve is a no-op", async () => {
    const gate = createPermissionGate("cleanup-1");
    expect(getPendingApproval("cleanup-1")).toBe(true);

    resolvePermission("cleanup-1", true);
    await gate;

    expect(getPendingApproval("cleanup-1")).toBe(false);

    // Re-resolving should be a no-op (no throw, no side effects)
    expect(() => resolvePermission("cleanup-1", true)).not.toThrow();
    expect(() => resolvePermission("cleanup-1", false)).not.toThrow();
    expect(getPendingApproval("cleanup-1")).toBe(false);
  });

  test("getPendingApproval returns false after rejection and re-resolve is a no-op", async () => {
    const gate = createPermissionGate("cleanup-2");
    resolvePermission("cleanup-2", false);
    await expect(gate).rejects.toThrow("Permission denied");

    expect(getPendingApproval("cleanup-2")).toBe(false);
    expect(() => resolvePermission("cleanup-2", true)).not.toThrow();
    expect(getPendingApproval("cleanup-2")).toBe(false);
  });
});

describe("permission gate lifecycle", () => {
  test("resolving one gate leaves other gates still pending", async () => {
    const gateA = createPermissionGate("lifecycle-a");
    const gateB = createPermissionGate("lifecycle-b");
    const gateC = createPermissionGate("lifecycle-c");

    expect(getPendingApproval("lifecycle-a")).toBe(true);
    expect(getPendingApproval("lifecycle-b")).toBe(true);
    expect(getPendingApproval("lifecycle-c")).toBe(true);

    // Resolve only "b"
    resolvePermission("lifecycle-b", true);
    await gateB;

    expect(getPendingApproval("lifecycle-b")).toBe(false);
    expect(getPendingApproval("lifecycle-a")).toBe(true);
    expect(getPendingApproval("lifecycle-c")).toBe(true);

    // Clean up remaining gates
    resolvePermission("lifecycle-a", true);
    resolvePermission("lifecycle-c", true);
    await gateA;
    await gateC;
  });
});

describe("live permission mode via bus", () => {
  test("getPermissionMode returns DB value when no override", async () => {
    mockGetSetting.mockResolvedValue("yolo");
    const result = await getPermissionMode("proj-1");
    expect(result).toBe("yolo");
  });

  test("getPermissionMode with override ignores DB", async () => {
    mockGetSetting.mockResolvedValue("yolo");
    const result = await getPermissionMode("proj-1", "ask");
    expect(result).toBe("ask");
    expect(mockGetSetting).not.toHaveBeenCalled();
  });
});

describe("permission matrix edge cases", () => {
  test("read tools NEVER need approval in any mode", () => {
    expect(needsApproval("read", "ask")).toBe(false);
    expect(needsApproval("read", "auto-edit")).toBe(false);
    expect(needsApproval("read", "yolo")).toBe(false);
  });

  test("write tools need approval in ask mode", () => {
    expect(needsApproval("write", "ask")).toBe(true);
  });

  test("write tools do NOT need approval in auto-edit mode", () => {
    expect(needsApproval("write", "auto-edit")).toBe(false);
  });

  test("execute tools need approval in ask mode", () => {
    expect(needsApproval("execute", "ask")).toBe(true);
  });

  test("execute tools need approval in auto-edit mode", () => {
    expect(needsApproval("execute", "auto-edit")).toBe(true);
  });

  test("execute tools do NOT need approval in yolo mode", () => {
    expect(needsApproval("execute", "yolo")).toBe(false);
  });
});
