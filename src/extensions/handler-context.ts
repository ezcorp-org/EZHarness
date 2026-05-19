/**
 * Provenance utility for Phase 51 capability handlers.
 *
 * Single source of truth for `{actorExtensionId, onBehalfOf,
 * conversationId, runId, parentCallId}`. Every Phase 51 handler
 * (`ctx.llm`, `ctx.memory`, `ctx.lessons`, `ctx.schedule`, `ctx.events`)
 * MUST derive these fields via this function — never directly off the
 * RPC `_meta` channel — so the trust boundary is enforced in one place.
 *
 * The structural defense against provenance spoofing:
 *   - `actorExtensionId` is sourced from `registeredTool.extensionId`
 *     (the in-memory map at the host's tool registry, owned by
 *     `tool-executor.ts:262-301`). NOT from RPC meta. The subprocess
 *     CAN'T lie about its own identity because it's not the source of
 *     truth.
 *   - `onBehalfOf` is sourced from `rpcMeta.ezOnBehalfOf` which is
 *     stamped server-side by `tool-executor.ts:262-301` BEFORE the
 *     RPC reaches the subprocess. The subprocess passes it through;
 *     it cannot manufacture one.
 *   - Throws if `onBehalfOf` is missing — better than silent
 *     anonymization. The `sdk_capability_calls.on_behalf_of` column
 *     is NOT NULL, so a row that escaped this check would be rejected
 *     at the DB anyway; the throw is defense-in-depth + clearer error
 *     than a Postgres NOT NULL violation.
 */

export interface HandlerContext {
  /** Which extension is making the call. Sourced from
   *  `registeredTool.extensionId` (host-owned), NOT from RPC meta. */
  actorExtensionId: string;
  /** User the call is made on behalf of. NOT NULL contract — the
   *  function throws if this can't be derived. */
  onBehalfOf: string;
  /** Active chat conversation, if any. NULL for scheduled-fire and
   *  event-subscribe handlers that fire without a chat context. */
  conversationId: string | null;
  /** Active sub-run id, if the call is happening within a spawned
   *  agent run. NULL for direct user-initiated calls. */
  runId: string | null;
  /** When this call is the child of an outer capability call (e.g.
   *  scheduled-fire → its LLM call), the parent's
   *  `sdk_capability_calls.id`. NULL for top-level calls. */
  parentCallId: string | null;
}

export interface RegisteredToolStub {
  extensionId: string;
}

interface InvocationMetadata {
  runId?: string;
  parentCallId?: string;
  [k: string]: unknown;
}

/**
 * Derive a HandlerContext from the RPC `_meta` channel + the
 * registered-tool record.
 *
 * @param rpcMeta — `_meta` channel stamped by `tool-executor.ts:262-301`
 *   (`ezOnBehalfOf`, `ezConversationId`, `invocationMetadata`, etc.).
 *   May be `undefined` if the call came in over a path that didn't go
 *   through tool-executor (the throw below catches that).
 * @param registeredTool — the in-memory tool record. Source of
 *   `actorExtensionId`. Pass `{extensionId}` only — typed loosely so
 *   callers don't need to import the full `RegisteredTool` shape.
 * @throws Error("handler-context: missing onBehalfOf") if
 *   `rpcMeta.ezOnBehalfOf` is not a string.
 */
export function deriveHandlerContext(
  rpcMeta: Record<string, unknown> | undefined,
  registeredTool: RegisteredToolStub,
): HandlerContext {
  if (!registeredTool || typeof registeredTool.extensionId !== "string" || !registeredTool.extensionId) {
    throw new Error("handler-context: missing registeredTool.extensionId");
  }

  const onBehalfOf = rpcMeta?.ezOnBehalfOf;
  if (typeof onBehalfOf !== "string" || !onBehalfOf) {
    throw new Error("handler-context: missing onBehalfOf");
  }

  const conversationId = rpcMeta && typeof rpcMeta.ezConversationId === "string"
    ? rpcMeta.ezConversationId
    : null;

  const invocationMetadata = (rpcMeta?.invocationMetadata as InvocationMetadata | undefined) ?? undefined;
  const runId = invocationMetadata && typeof invocationMetadata.runId === "string"
    ? invocationMetadata.runId
    : null;
  const parentCallId = invocationMetadata && typeof invocationMetadata.parentCallId === "string"
    ? invocationMetadata.parentCallId
    : null;

  return {
    // Sourced from the host's registered-tool record — not RPC meta.
    // This is the spoofing defense.
    actorExtensionId: registeredTool.extensionId,
    onBehalfOf,
    conversationId,
    runId,
    parentCallId,
  };
}
