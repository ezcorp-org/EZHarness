/**
 * The synthetic conversation coordinate a workflow tool step runs under.
 *
 * ## Why a workflow borrows the conversation slot at all
 *
 * Every host-mediated surface a tool step touches — the PDP, the fs
 * handler, the reverse-RPC provenance registry — is keyed by
 * `conversationId`, because until workflows existed a tool call was
 * always something a chat turn asked for. A workflow step has no chat
 * turn, so `WorkflowExecutor` mints `workflow-run:<runId>` and passes
 * that instead (`workflow-executor.ts` → `workflowScopeKey`).
 *
 * That key is deliberately shaped so every conversation-keyed lookup
 * FAILS CLOSED: `getConversation()` returns null, so the SSE filter
 * denies delivery; `resolveExtensionScopeGrant` derives `projectId =
 * null`, the strictest RBAC coordinate; and it can never collide with a
 * real conversation id, which is a bare UUID.
 *
 * ## Why the predicate lives HERE and not next to the minter
 *
 * Because both ends need it and they must not disagree. The literal was
 * already written out twice — once in `workflow-executor.ts` to MINT the
 * key and once in `runtime/tools/permissions.ts`
 * (`NON_INTERACTIVE_KEY_PREFIX`) to RECOGNISE it — and the persistence
 * boundaries need a third and fourth reading. Two of those consumers sit
 * under `src/db/queries/`, which must not import the runtime, so the
 * shared answer has to be a LEAF: this module imports nothing, which is
 * what makes it safe for the query layer, the executor and the
 * observability collector to share.
 *
 * ## The bug this exists to close
 *
 * `tool_calls.conversation_id` and `observability_events.conversation_id`
 * are both FKs to `conversations`. A synthetic key matches no row, so
 * every tool call a workflow made was REJECTED by the database:
 * `persistToolCall` swallowed the violation into an `error_logs` row and
 * the observability collector logged `Failed to persist tool:complete`
 * once per call, forever. The tool call itself was not recorded anywhere.
 *
 * The fix is not to stop writing — it is to stop pretending the run had a
 * conversation. {@link persistableConversationId} maps a synthetic key to
 * `null` (both columns are, or are now, nullable) and
 * {@link workflowRunIdFromScopeKey} recovers the run id so the row can
 * still say WHICH run it belongs to. The correlation moves from a column
 * that could never hold it to one that can.
 */

/**
 * Prefix of the synthetic non-interactive scope key.
 *
 * `runtime/tools/permissions.ts` re-exports this as
 * `NON_INTERACTIVE_KEY_PREFIX`, which is the name the permission code has
 * always used; the value now has exactly one definition.
 */
export const WORKFLOW_SCOPE_KEY_PREFIX = "workflow-run:";

/** The scope key for a workflow run. The ONE minter. */
export function workflowScopeKey(workflowRunId: string): string {
  return `${WORKFLOW_SCOPE_KEY_PREFIX}${workflowRunId}`;
}

/**
 * True when `id` is a synthetic workflow scope key rather than a real
 * conversation id.
 *
 * Tolerates `null` / `undefined` so callers holding a nullable column can
 * ask directly instead of guarding first.
 */
export function isWorkflowScopeKey(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(WORKFLOW_SCOPE_KEY_PREFIX);
}

/**
 * The run id inside a synthetic scope key, or `null` for anything else —
 * including a bare prefix with no id after it, which names no run and must
 * not be reported as one.
 */
export function workflowRunIdFromScopeKey(
  id: string | null | undefined,
): string | null {
  if (!isWorkflowScopeKey(id)) return null;
  const runId = (id as string).slice(WORKFLOW_SCOPE_KEY_PREFIX.length);
  return runId.length > 0 ? runId : null;
}

/**
 * The value to store in a `conversation_id` column for this scope.
 *
 * `null` for a synthetic workflow key — the honest answer, and the only
 * one the FK accepts — and the id itself for everything else. Every writer
 * to a conversation-FK column that can be reached from inside a workflow
 * MUST go through this; a raw pass-through is the defect it replaces.
 */
export function persistableConversationId(
  id: string | null | undefined,
): string | null {
  if (id === null || id === undefined || id === "") return null;
  return isWorkflowScopeKey(id) ? null : id;
}
