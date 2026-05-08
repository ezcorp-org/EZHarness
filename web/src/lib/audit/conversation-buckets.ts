/**
 * Phase 52.3 — pure bucketing logic for the conversation audit
 * timeline. Extracted from the +page.svelte so the
 * "audit aligned to message stream" invariant is unit-testable
 * without mounting the page.
 *
 * Contract: each audit entry is assigned to the most recent message
 * whose createdAt is <= the entry's createdAt. Entries that fire
 * before the first message land in `beforeFirst` (e.g. an extension
 * that ran a scheduled fire and inserted context before the first
 * user turn). Entries that fire after the last message hang off the
 * last message bucket.
 */

export interface BucketableMessage {
  id: string;
  role: string;
  createdAt: string | Date;
  contentPreview?: string;
}

export interface BucketableEntry {
  id: string;
  createdAt: string | Date;
}

export interface BucketResult<E extends BucketableEntry> {
  /** All input messages, sorted ASC by createdAt. */
  sortedMessages: BucketableMessage[];
  /** Map from messageId → entries that fired between this message and the next. */
  byMessage: Map<string, E[]>;
  /** Entries that fired before the first message. */
  beforeFirst: E[];
}

function ts(d: string | Date): number {
  return d instanceof Date ? d.getTime() : new Date(d).getTime();
}

export function bucketEntriesByMessage<E extends BucketableEntry>(
  messages: BucketableMessage[],
  entries: E[],
): BucketResult<E> {
  const sortedMessages = [...messages].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const sortedEntries = [...entries].sort((a, b) => ts(a.createdAt) - ts(b.createdAt));
  const byMessage = new Map<string, E[]>();
  const beforeFirst: E[] = [];

  if (sortedMessages.length === 0) {
    // No messages → everything is "beforeFirst" (the page renders
    // it as a single bucket). Preserves chronological order.
    beforeFirst.push(...sortedEntries);
    return { sortedMessages, byMessage, beforeFirst };
  }

  let mIdx = 0;
  for (const e of sortedEntries) {
    const ets = ts(e.createdAt);
    if (ets < ts(sortedMessages[0]!.createdAt)) {
      beforeFirst.push(e);
      continue;
    }
    while (
      mIdx + 1 < sortedMessages.length &&
      ts(sortedMessages[mIdx + 1]!.createdAt) <= ets
    ) {
      mIdx++;
    }
    const ownerId = sortedMessages[mIdx]!.id;
    const list = byMessage.get(ownerId) ?? [];
    list.push(e);
    byMessage.set(ownerId, list);
  }
  return { sortedMessages, byMessage, beforeFirst };
}
