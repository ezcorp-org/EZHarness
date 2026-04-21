import { test, expect, describe, beforeEach } from "bun:test";
import { enqueue, dequeue, hasPending } from "../runtime/pending-messages";

// The module uses a module-level Map, so we need to drain it between tests
function drainQueue(subConvId: string) {
  while (dequeue(subConvId) !== undefined) {}
}

describe("pending-messages", () => {
  const SUB_CONV_1 = "sub-conv-1";
  const SUB_CONV_2 = "sub-conv-2";

  beforeEach(() => {
    drainQueue(SUB_CONV_1);
    drainQueue(SUB_CONV_2);
  });

  describe("enqueue + dequeue", () => {
    test("enqueue adds a message that can be dequeued", () => {
      const msg = { messageId: "m1", content: "hello", createdAt: "2026-01-01T00:00:00Z" };
      enqueue(SUB_CONV_1, msg);

      const result = dequeue(SUB_CONV_1);
      expect(result).toEqual(msg);
    });

    test("dequeue returns undefined when queue is empty", () => {
      expect(dequeue(SUB_CONV_1)).toBeUndefined();
    });

    test("dequeue returns undefined for unknown subConversationId", () => {
      expect(dequeue("nonexistent")).toBeUndefined();
    });

    test("dequeue is FIFO — oldest message first", () => {
      enqueue(SUB_CONV_1, { messageId: "m1", content: "first", createdAt: "2026-01-01T00:00:00Z" });
      enqueue(SUB_CONV_1, { messageId: "m2", content: "second", createdAt: "2026-01-01T00:00:01Z" });
      enqueue(SUB_CONV_1, { messageId: "m3", content: "third", createdAt: "2026-01-01T00:00:02Z" });

      expect(dequeue(SUB_CONV_1)!.messageId).toBe("m1");
      expect(dequeue(SUB_CONV_1)!.messageId).toBe("m2");
      expect(dequeue(SUB_CONV_1)!.messageId).toBe("m3");
      expect(dequeue(SUB_CONV_1)).toBeUndefined();
    });

    test("queues are independent per subConversationId", () => {
      enqueue(SUB_CONV_1, { messageId: "m1", content: "for conv 1", createdAt: "2026-01-01T00:00:00Z" });
      enqueue(SUB_CONV_2, { messageId: "m2", content: "for conv 2", createdAt: "2026-01-01T00:00:00Z" });

      expect(dequeue(SUB_CONV_1)!.content).toBe("for conv 1");
      expect(dequeue(SUB_CONV_2)!.content).toBe("for conv 2");

      // Both should be empty now
      expect(dequeue(SUB_CONV_1)).toBeUndefined();
      expect(dequeue(SUB_CONV_2)).toBeUndefined();
    });
  });

  describe("hasPending", () => {
    test("returns false when queue is empty", () => {
      expect(hasPending(SUB_CONV_1)).toBe(false);
    });

    test("returns false for unknown subConversationId", () => {
      expect(hasPending("nonexistent")).toBe(false);
    });

    test("returns true after enqueue", () => {
      enqueue(SUB_CONV_1, { messageId: "m1", content: "hello", createdAt: "2026-01-01T00:00:00Z" });
      expect(hasPending(SUB_CONV_1)).toBe(true);
    });

    test("returns false after all messages are dequeued", () => {
      enqueue(SUB_CONV_1, { messageId: "m1", content: "hello", createdAt: "2026-01-01T00:00:00Z" });
      dequeue(SUB_CONV_1);
      expect(hasPending(SUB_CONV_1)).toBe(false);
    });

    test("returns true when some messages remain", () => {
      enqueue(SUB_CONV_1, { messageId: "m1", content: "first", createdAt: "2026-01-01T00:00:00Z" });
      enqueue(SUB_CONV_1, { messageId: "m2", content: "second", createdAt: "2026-01-01T00:00:01Z" });
      dequeue(SUB_CONV_1);
      expect(hasPending(SUB_CONV_1)).toBe(true);
    });
  });
});
