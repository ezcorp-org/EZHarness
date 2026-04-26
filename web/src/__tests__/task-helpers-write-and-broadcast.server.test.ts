/**
 * Helper-level unit tests for `writeAndBroadcastSnapshot` extracted into
 * `web/src/lib/server/task-helpers.ts`.
 *
 * The handler tests assert the bus emit happens, but they don't pin the
 * conditional `activeTaskId` spread shape — that's what tripped the
 * original duplication (one caller spread it, the other passed
 * undefined and crashed downstream consumers that did `in payload`
 * checks). These tests pin both the persisted shape AND the bus payload
 * shape across:
 *   - activeTaskId set
 *   - activeTaskId undefined (must NOT appear in either payload)
 *   - empty tasks array
 *   - persistence ordering vs bus emit (persist happens FIRST)
 */

import { beforeEach, describe, expect, test, vi } from "vitest";
import type { TaskSnapshot } from "$server/runtime/task-tracking-host";

const writeTaskSnapshotForConversation = vi.fn<(...args: unknown[]) => Promise<unknown>>();
const emit = vi.fn<(...args: unknown[]) => void>();
const callOrder: string[] = [];

vi.mock("$server/runtime/task-tracking-host", () => ({
  writeTaskSnapshotForConversation: (...args: unknown[]) => {
    callOrder.push("write");
    return writeTaskSnapshotForConversation(...args);
  },
}));

vi.mock("$lib/server/context", () => ({
  getBus: () => ({
    emit: (...args: unknown[]) => {
      callOrder.push("emit");
      return emit(...args);
    },
  }),
}));

const { writeAndBroadcastSnapshot } = await import(
  "$lib/server/task-helpers"
);

beforeEach(() => {
  writeTaskSnapshotForConversation.mockReset();
  writeTaskSnapshotForConversation.mockResolvedValue(undefined);
  emit.mockReset();
  callOrder.length = 0;
});

describe("writeAndBroadcastSnapshot — happy path", () => {
  test("persists tasks + activeTaskId, then emits identical payload on bus", async () => {
    const snapshot: TaskSnapshot = {
      conversationId: "c1",
      tasks: [],
      activeTaskId: "t1",
    };
    await writeAndBroadcastSnapshot("c1", snapshot);

    expect(writeTaskSnapshotForConversation).toHaveBeenCalledTimes(1);
    expect(writeTaskSnapshotForConversation).toHaveBeenCalledWith("c1", {
      tasks: [],
      activeTaskId: "t1",
    });

    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith("task:snapshot", {
      conversationId: "c1",
      tasks: [],
      activeTaskId: "t1",
    });
  });

  test("persist runs BEFORE bus emit (order matters for SSE consumers)", async () => {
    await writeAndBroadcastSnapshot("c1", {
      conversationId: "c1",
      tasks: [],
      activeTaskId: "t1",
    });
    expect(callOrder).toEqual(["write", "emit"]);
  });
});

describe("writeAndBroadcastSnapshot — activeTaskId conditional spread", () => {
  test("undefined activeTaskId is OMITTED from both persisted + bus payloads", async () => {
    const snapshot: TaskSnapshot = {
      conversationId: "c1",
      tasks: [],
      // intentionally undefined
    };
    await writeAndBroadcastSnapshot("c1", snapshot);

    const persisted = writeTaskSnapshotForConversation.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(persisted).toBeDefined();
    expect("activeTaskId" in (persisted ?? {})).toBe(false);
    expect(persisted).toEqual({ tasks: [] });

    const emitted = emit.mock.calls[0]?.[1] as
      | Record<string, unknown>
      | undefined;
    expect(emitted).toBeDefined();
    expect("activeTaskId" in (emitted ?? {})).toBe(false);
    expect(emitted).toEqual({ conversationId: "c1", tasks: [] });
  });

  test("empty-string activeTaskId is preserved (only `=== undefined` filters)", async () => {
    // Pin behaviour: empty string is kept. If a caller wants to clear,
    // it must explicitly pass undefined.
    await writeAndBroadcastSnapshot("c1", {
      conversationId: "c1",
      tasks: [],
      activeTaskId: "",
    });
    expect(writeTaskSnapshotForConversation).toHaveBeenCalledWith("c1", {
      tasks: [],
      activeTaskId: "",
    });
    expect(emit).toHaveBeenCalledWith("task:snapshot", {
      conversationId: "c1",
      tasks: [],
      activeTaskId: "",
    });
  });
});

describe("writeAndBroadcastSnapshot — error propagation", () => {
  test("rejects + does NOT emit on bus when persistence throws", async () => {
    writeTaskSnapshotForConversation.mockRejectedValueOnce(new Error("db down"));
    await expect(
      writeAndBroadcastSnapshot("c1", {
        conversationId: "c1",
        tasks: [],
        activeTaskId: "t1",
      }),
    ).rejects.toThrow("db down");
    // Critical: a failed persist must not emit a phantom snapshot to clients.
    expect(emit).not.toHaveBeenCalled();
  });
});
