/**
 * The sub-conversations of `conversationId` once at least one exists: polls the observed rows, never a fixed wait.
 * Returns the last answer at the deadline (an empty list then fails the caller's assertion by name). Used by the
 * fan-out e2e suite; proved by test/unit/e2e-poll.test.ts against a stub client (W4H-33, D3).
 */
export async function spawnedSubConversations<Row>(
  client: { getSubConversations(conversationId: string): Promise<Row[]> },
  conversationId: string,
  { timeoutMs = 30_000, intervalMs = 100 }: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<Row[]> {
  const deadline = Date.now() + timeoutMs;
  let subs = await client.getSubConversations(conversationId);
  while (subs.length === 0 && Date.now() <= deadline) {
    await Bun.sleep(intervalMs);
    subs = await client.getSubConversations(conversationId);
  }
  return subs;
}
