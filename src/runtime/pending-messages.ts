/**
 * In-memory pending message queue for async user→agent chat.
 *
 * When a user sends a message to a running agent's sub-conversation,
 * the message is persisted to DB immediately (so it appears in the feed)
 * and enqueued here. The assignment's run:complete handler checks this
 * queue — if a message is pending, it auto-starts a new run instead of
 * marking the assignment as completed.
 */

export interface PendingMessage {
  messageId: string;
  content: string;
  createdAt: string;
}

const queues = new Map<string, PendingMessage[]>();

/** Enqueue a pending user message for a sub-conversation. */
export function enqueue(subConversationId: string, msg: PendingMessage): void {
  const q = queues.get(subConversationId);
  if (q) {
    q.push(msg);
  } else {
    queues.set(subConversationId, [msg]);
  }
}

/** Dequeue the oldest pending message (FIFO). Returns undefined if empty. */
export function dequeue(subConversationId: string): PendingMessage | undefined {
  const q = queues.get(subConversationId);
  if (!q || q.length === 0) {
    queues.delete(subConversationId);
    return undefined;
  }
  const msg = q.shift()!;
  if (q.length === 0) queues.delete(subConversationId);
  return msg;
}

/** Check whether there are pending messages for a sub-conversation. */
export function hasPending(subConversationId: string): boolean {
  const q = queues.get(subConversationId);
  return !!q && q.length > 0;
}
