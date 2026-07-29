/**
 * Per-conversation write serialization for the task-tracking snapshot.
 *
 * A conversation's task state is ONE `extension_storage` row, and every
 * task-lifecycle HTTP handler mutates it read-modify-write:
 * `getTaskSnapshotForConversation()` → mutate → `writeTaskSnapshotForConversation()`.
 * Two overlapping requests (Stop and Retry clicked in quick succession; a
 * retry fanning out across N failed assignments) both read the same base and
 * the second write silently discards the first one's mutation — which left
 * an assignment pinned to "running" in the task panel long after the agent
 * had finished.
 *
 * Lives in its own module rather than inside `task-tracking-host.ts` because
 * it is a pure sequencing primitive with no DB dependency: route tests that
 * mock the storage helpers still get the real locking behaviour, and it
 * carries none of the storage module's import weight.
 *
 * The extension subprocess serializes the same row on its side with the
 * SDK's `withLock` (see `docs/extensions/examples/task-tracking/index.ts`);
 * this covers the host's writers.
 */

/**
 * In-flight critical sections keyed by conversation id. The value is the
 * promise for "everything queued on this conversation so far"; new callers
 * chain after it.
 */
const snapshotLocks = new Map<string, Promise<unknown>>();

/**
 * Serialize `fn` against every other call for the same conversation.
 * Different conversations never contend.
 *
 * A rejection does not poison the queue: the next waiter still runs, and the
 * original error propagates to the caller that scheduled it.
 */
export function withTaskSnapshotLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = snapshotLocks.get(conversationId) ?? Promise.resolve();
  const run = prev.then(() => fn());
  // The published tail never rejects, so a failed critical section can't
  // wedge the conversation.
  const tail = run.catch(() => undefined);
  snapshotLocks.set(conversationId, tail);
  void tail.then(() => {
    // Drop the entry once we're the last one out, so the map doesn't grow
    // one permanent key per conversation the process ever served.
    if (snapshotLocks.get(conversationId) === tail) snapshotLocks.delete(conversationId);
  });
  return run;
}
