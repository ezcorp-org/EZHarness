import { expect, test } from "bun:test";
import { spawnedSubConversations } from "../e2e/_poll";

// The fan-out e2e suite (test/e2e/fanout.test.ts) waits for spawned sub-conversations by polling the observed rows,
// never by a fixed sleep. That helper runs only in the real-auth lane, so it is proved here against a stub client
// (W4H-33, D3): a row that appears after some polls is returned, the deadline returns what was seen, and it polls.

function stubClient(answers: unknown[][]) {
  const calls: string[] = [];
  return {
    calls,
    async getSubConversations(conversationId: string) {
      calls.push(conversationId);
      return answers[Math.min(calls.length - 1, answers.length - 1)]!;
    },
  };
}

test("returns the rows as soon as one exists, after polling the empty answers before it", async () => {
  const client = stubClient([[], [], [{ id: "sub-1" }]]);
  expect(await spawnedSubConversations(client, "conv-1", { timeoutMs: 5_000, intervalMs: 1 })).toEqual([{ id: "sub-1" }]);
  expect(client.calls).toEqual(["conv-1", "conv-1", "conv-1"]);
});

test("returns the last (empty) answer at the deadline instead of waiting for ever", async () => {
  const client = stubClient([[]]);
  expect(await spawnedSubConversations(client, "conv-2", { timeoutMs: 20, intervalMs: 5 })).toEqual([]);
  expect(client.calls.length).toBeGreaterThan(1);
});

test("asks once when the first answer already holds a row", async () => {
  const client = stubClient([[{ id: "sub-9" }]]);
  expect(await spawnedSubConversations(client, "conv-3")).toEqual([{ id: "sub-9" }]);
  expect(client.calls).toEqual(["conv-3"]);
});
