/**
 * Resumption registry for tools whose ANSWER COMES BACK OVER HTTP.
 *
 * Two families share this engine and nothing else:
 *   • `origin: "ez"` — the Ez concierge's client-side tools (`fill_form`,
 *     `navigate_to`, `read_page`). The runtime emits `ez:client-tool`, the
 *     in-app panel performs the DOM operation and POSTs the outcome.
 *   • `origin: "caller"` — caller-executed tools declared on a conversation
 *     by an external application holding a member-role API key. The runtime
 *     emits `caller:tool-call`, the app runs it on ITS machine and POSTs the
 *     outcome.
 *
 * Both POST into `/api/conversations/[id]/tool-results`, and that handler
 * needs an O(1) way to wake the suspended tool's Promise. A `tool_calls`
 * SELECT cannot serve: the row is only persisted after `execute()` returns,
 * and `execute()` is exactly what is suspended. So we keep an in-memory map
 * keyed by `toolCallId`.
 *
 * ## Lifecycle
 *
 *   1. The tool calls {@link registerPendingRemoteTool} at the start of
 *      `execute`, then `await`s the returned Promise.
 *   2. The runtime emits the family's event on the bus → SSE → client.
 *   3. The client dispatches locally → POSTs `{ toolCallId, result }`.
 *   4. The POST handler authorizes, then calls {@link resolveRemoteTool}.
 *   5. The suspended `execute` resumes and normalizes the payload.
 *
 * ## Edge cases
 *
 *   - **Abort:** `rejectRemoteTool(toolCallId, …)` from the tool's abort
 *     listener when the run's signal fires.
 *   - **Timeout:** every registration carries its own `timeoutMs`; on expiry
 *     the gate rejects with the caller-supplied message so the LLM sees a
 *     concrete failure rather than a hang. The executor watchdog defers its
 *     idle kill for the whole of that wait — each family's tool def declares
 *     a `callTimeoutMs` derived from the same number plus
 *     `REMOTE_TOOL_WATCHDOG_MARGIN_MS`.
 *   - **Duplicate registration:** overwrites a prior entry for the same
 *     `toolCallId`, rejecting the prior Promise with a "superseded" error
 *     first. toolCallIds are UUIDs minted per LLM call, so this is defensive.
 *   - **Late POST:** once the entry is cleared the resolve/reject helpers are
 *     no-ops returning `false` (mirrors the ask-user late-POST contract).
 *
 * ## Concurrency
 *
 * Keyed by `toolCallId` ONLY. Parallel tool calls are the default in the
 * agent loop and two runs per conversation are real, so N gates coexist and
 * supersede fires solely on an identical id. Every entry records the `runId`
 * that opened it so a client can drop its pending list per-run on that run's
 * terminal event, and so a conversation-wide sweep can report which run each
 * orphan belonged to.
 *
 * Deliberately dependency-free: the `tool-results` API route imports it, and
 * a route should not pull the tools layer (and through it pi-agent-core) into
 * its module graph.
 */

/** Which family a pending entry belongs to. */
export type RemoteToolOrigin = "ez" | "caller";

/** Public view of a pending entry — everything except its settle handles. */
export interface PendingRemoteToolInfo {
  conversationId: string;
  /** Owner of the conversation, captured at wire time so the POST endpoint's
   *  auth check is O(1). May be null in test contexts. */
  userId: string | null;
  /** Name the CLIENT dispatches on — the bare declared name, matching the
   *  `toolName` field of the emitted event (never the `_caller__` wire form). */
  toolName: string;
  /**
   * The call's arguments, exactly as emitted.
   *
   * Held because the reconnect drain below has to be able to RE-DISPATCH the
   * call, not merely report that one is outstanding: a client that missed the
   * event has the toolCallId but nothing to run. This is the same value the
   * event carried, so it leaks nothing the client was not already sent.
   */
  input: unknown;
  /** Run that opened this call, when the opener knows it. */
  runId: string | null;
  origin: RemoteToolOrigin;
  /** Created-at ms, for diagnostics and the reconnect drain's ordering. */
  createdAt: number;
}

interface PendingRemoteToolEntry extends PendingRemoteToolInfo {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timeoutHandle: ReturnType<typeof setTimeout>;
}

const pendingByToolCallId = new Map<string, PendingRemoteToolEntry>();

export interface RegisterPendingRemoteToolOptions {
  toolCallId: string;
  conversationId: string;
  userId: string | null;
  toolName: string;
  input: unknown;
  runId: string | null;
  origin: RemoteToolOrigin;
  /** How long the client may take to POST before the gate rejects. */
  timeoutMs: number;
  /** Message the timeout rejection carries. Supplied per family so the LLM
   *  reads a sentence naming the thing that did not answer. */
  timeoutMessage: string;
}

/**
 * Register a pending remote tool call and return a Promise that resolves
 * when the client POSTs its result, or rejects on timeout / abort.
 *
 * Callers MUST also clear the registration in their `finally` (via
 * {@link clearPendingRemoteTool}) so the timeout handle and the map entry
 * don't outlive the underlying tool call.
 */
export function registerPendingRemoteTool(
  options: RegisterPendingRemoteToolOptions,
): Promise<unknown> {
  const { toolCallId, timeoutMs, timeoutMessage, ...info } = options;
  // Defensive: if a duplicate id arrives, supersede the prior Promise.
  const prior = pendingByToolCallId.get(toolCallId);
  if (prior) {
    clearTimeout(prior.timeoutHandle);
    pendingByToolCallId.delete(toolCallId);
    prior.reject(
      new Error(`${prior.origin} tool call superseded by a new registration`),
    );
  }

  return new Promise<unknown>((resolve, reject) => {
    const timeoutHandle = setTimeout(() => {
      const entry = pendingByToolCallId.get(toolCallId);
      if (entry) {
        pendingByToolCallId.delete(toolCallId);
        entry.reject(new Error(timeoutMessage));
      }
    }, timeoutMs);
    pendingByToolCallId.set(toolCallId, {
      ...info,
      resolve,
      reject,
      createdAt: Date.now(),
      timeoutHandle,
    });
  });
}

/**
 * Resolve a pending remote tool call with the client's result.
 * No-op when the entry is missing (gate already cleared — late POST).
 *
 * Returns true if a pending call was found + resolved, false otherwise.
 */
export function resolveRemoteTool(toolCallId: string, result: unknown): boolean {
  const entry = take(toolCallId);
  if (!entry) return false;
  entry.resolve(result);
  return true;
}

/**
 * Reject a pending remote tool call. Used by abort listeners on the tool
 * side and by the POST handler if the supplied result is malformed.
 *
 * Returns true if a pending call was found + rejected, false otherwise.
 */
export function rejectRemoteTool(toolCallId: string, err: Error | string): boolean {
  const entry = take(toolCallId);
  if (!entry) return false;
  entry.reject(err instanceof Error ? err : new Error(err));
  return true;
}

/**
 * Read a pending call's registered metadata. The POST endpoint uses this to
 * confirm the acting user owns the conversation before resolving. Returns
 * undefined when no entry exists.
 */
export function getPendingRemoteTool(
  toolCallId: string,
): PendingRemoteToolInfo | undefined {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return undefined;
  return publicInfo(entry);
}

/**
 * Every call currently suspended on `conversationId`, oldest first.
 *
 * This is the AUTHORITATIVE recovery channel for a client that reconnects
 * mid-call: the SSE resume ring holds 500 GLOBAL entries including every
 * token, so seconds of chat turn over a missed `caller:tool-call` event.
 * A reconnecting client drains this instead of trusting the ring.
 *
 * `origin` narrows the sweep to one family — a caller-tools client must not
 * be handed the Ez panel's pending DOM operations.
 */
export function getPendingRemoteToolsForConversation(
  conversationId: string,
  origin?: RemoteToolOrigin,
): Array<PendingRemoteToolInfo & { toolCallId: string }> {
  const out: Array<PendingRemoteToolInfo & { toolCallId: string }> = [];
  for (const [toolCallId, entry] of pendingByToolCallId) {
    if (entry.conversationId !== conversationId) continue;
    if (origin !== undefined && entry.origin !== origin) continue;
    out.push({ toolCallId, ...publicInfo(entry) });
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/**
 * Reject every call suspended on `conversationId`, returning how many were
 * torn down. Called when the conversation's declarations are revoked or the
 * conversation itself goes away: the client that would have answered is
 * gone, so parking until the per-call timeout only delays a certain failure.
 */
export function abortPendingRemoteToolsForConversation(
  conversationId: string,
  reason: string,
  origin?: RemoteToolOrigin,
): number {
  let aborted = 0;
  for (const [toolCallId, entry] of [...pendingByToolCallId]) {
    if (entry.conversationId !== conversationId) continue;
    if (origin !== undefined && entry.origin !== origin) continue;
    if (rejectRemoteTool(toolCallId, reason)) aborted++;
  }
  return aborted;
}

/**
 * Defensive clear without resolving / rejecting. Used by the tool-side
 * `finally` if the Promise already settled (timeout race). Subsequent
 * resolve/reject calls become no-ops.
 */
export function clearPendingRemoteTool(toolCallId: string): void {
  take(toolCallId);
}

/** Test-only: wipe the map between tests. */
export function _resetPendingRemoteToolsForTests(): void {
  for (const entry of pendingByToolCallId.values()) {
    clearTimeout(entry.timeoutHandle);
  }
  pendingByToolCallId.clear();
}

/** Remove an entry and stop its timer, returning it if it was there. The
 *  ONE place an entry leaves the map through a settle path, so "delete then
 *  settle" can never be written in the other order (which would let the
 *  timeout fire onto an already-settled promise). */
function take(toolCallId: string): PendingRemoteToolEntry | undefined {
  const entry = pendingByToolCallId.get(toolCallId);
  if (!entry) return undefined;
  clearTimeout(entry.timeoutHandle);
  pendingByToolCallId.delete(toolCallId);
  return entry;
}

/** Strip the settle handles so callers cannot resolve a gate by hand. */
function publicInfo(entry: PendingRemoteToolEntry): PendingRemoteToolInfo {
  return {
    conversationId: entry.conversationId,
    userId: entry.userId,
    toolName: entry.toolName,
    input: entry.input,
    runId: entry.runId,
    origin: entry.origin,
    createdAt: entry.createdAt,
  };
}
