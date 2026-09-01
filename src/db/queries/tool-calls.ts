import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { getDb } from "../connection";
import { toolCalls } from "../schema";
import { redactForAudit, redactToolCallOutputContent } from "../../extensions/audit-redaction";
import { persistableConversationId } from "../../runtime/workflow-scope-key";
import { persistError } from "./error-logs";
import type { ToolCallResult } from "../../extensions/types";

/**
 * Shape shared by both tool_calls writers — the built-in path in
 * `executor.ts:tool_execution_end` and the extension path in
 * `tool-executor.ts:recordToolCall`. Kept narrow on purpose: callers hand
 * us the values they have in closure and we own the insert shape so the
 * four analytics dimensions (userId / agentConfigId / model / provider)
 * can't be silently dropped by a future refactor on one of the two sides.
 */
export interface ToolCallRow {
  /**
   * Optional row id — an explicit, HOST-MINTED (`crypto.randomUUID()`)
   * override for the DB-generated default. `append-message-handler.ts`
   * uses this so it can return the id to the caller before the insert
   * (the subprocess calls back via `ezcorp/finalize-tool-call` using it).
   *
   * NEVER hand this a provider-controlled value — that was the bug: the
   * built-in path used to pin it to `event.toolCallId`, the LLM's OWN wire
   * id, so two conversations whose provider reused an id (the mock LLM's
   * positional `call_0` default, and plenty of real OpenAI-compatible local
   * servers) collided on the PK and the second insert was silently
   * dropped. A provider wire id belongs in `providerToolCallId` below,
   * never here.
   */
  id?: string;
  /**
   * The LLM provider's own wire id for this call (built-in path:
   * `event.toolCallId`) — correlation-only, stored in the non-unique
   * `provider_tool_call_id` column, deliberately NOT used as `id` (see
   * above). The client-hydration path (`toolCallRowToSummary`) reads this
   * field back — falling back to `id` — so a reload still matches an
   * in-flight card by the same id the live stream used. Omitted by the
   * extension path (no provider wire id at that layer) and by
   * `append-message-handler.ts` (its `id` above already fills that role).
   */
  providerToolCallId?: string | null;
  conversationId: string;
  messageId: string | null;
  extensionId: string;
  toolName: string;
  input: Record<string, unknown>;
  output: ToolCallResult | { content: unknown[] };
  success: boolean;
  durationMs: number;
  cardType?: string | null;
  /** "inline" | "dock" — drives the chat UI's DockHost auto-open. NULL/unset
   *  is treated as "inline" by the host (see canvas-dock-sdk plan §4). */
  cardLayout?: string | null;
  userId?: string | null;
  agentConfigId?: string | null;
  model?: string | null;
  provider?: string | null;
}

/**
 * Persist a tool_calls row. Single write site for the denormalized
 * analytics dimensions — both the built-in and extension-tool paths call
 * through here so the schema contract lives in one place.
 *
 * Never throws: the caller has already started returning data to the
 * LLM / user, and a DB glitch must not block that path.
 */
/**
 * Bulk-load `(messageId, output)` pairs for a set of message IDs.
 *
 * Used by the assistant-message image rehydrator: tool results often carry
 * `![](…)` markdown pointing at generated images, and models following the
 * extension's guidance don't echo that URL into their text reply. Scanning
 * the raw tool output closes that gap.
 *
 * Rows whose `messageId` is null (orphan tool calls) are excluded — this
 * helper is for tool calls anchored to a specific assistant turn.
 */
export async function listToolCallOutputsForMessages(
  messageIds: string[],
): Promise<Array<{ messageId: string; output: unknown }>> {
  if (messageIds.length === 0) return [];
  const db = getDb();
  const rows: Array<{ messageId: string | null; output: unknown }> = await db
    .select({ messageId: toolCalls.messageId, output: toolCalls.output })
    .from(toolCalls)
    .where(inArray(toolCalls.messageId, messageIds));
  return rows.filter(
    (r: { messageId: string | null; output: unknown }): r is { messageId: string; output: unknown } =>
      r.messageId !== null,
  );
}

/**
 * Bulk-load minimal `(success)` rows for every tool call in a
 * conversation, ordered by `created_at` so the slice is sequence-faithful.
 *
 * Used by the lessons distiller's trigger gate
 * (`runtime/lessons/triggers.ts`) to compute two of the four signals:
 *   - `toolCallCount` (length of the returned array)
 *   - `errorRecoveryObserved` (an `error` row followed by an `ok` row)
 *
 * Selects only the `success` column — the gate doesn't need outputs,
 * names, or timing, so we keep the row footprint tiny. Row order is
 * load-bearing for the recovery detector; do not reorder.
 *
 * `sinceMs` (optional, epoch ms) narrows the scan to rows created at or
 * after that instant. The trigger gate passes the finished run's
 * `startedAt` so both signals describe THE RUN THAT JUST ENDED rather
 * than the conversation's whole lifetime — without it, one conversation
 * that ever made 5 tool calls distills on every subsequent turn forever
 * (a paid LLM call + a lesson write per turn). Filtering lives in SQL,
 * not in the caller, so a long conversation doesn't drag every historic
 * row across the wire. OMITTED → unchanged lifetime behaviour for every
 * existing caller.
 */
export async function listToolCallsByConversation(
  conversationId: string,
  sinceMs?: number,
): Promise<Array<{ success: boolean }>> {
  if (!conversationId) return [];
  const db = getDb();
  const scope = eq(toolCalls.conversationId, conversationId);
  const rows: Array<{ success: boolean }> = await db
    .select({ success: toolCalls.success })
    .from(toolCalls)
    .where(
      sinceMs === undefined
        ? scope
        : and(scope, gte(toolCalls.createdAt, new Date(sinceMs))),
    )
    .orderBy(toolCalls.createdAt);
  return rows;
}

/**
 * Look up the (id, conversationId) pair for a tool call. Returns null
 * when the row doesn't exist (yet — extension tools persist after the
 * subprocess returns, so very fresh ids may be missing).
 *
 * Used by the generic events route to cross-check that a posted
 * `toolCallId` actually belongs to the body's `conversationId`,
 * closing the F2 forgery surface from the Phase A security review:
 * without this check, a user authenticated for conv-A could fire
 * events tagged with toolCallIds from conv-B as long as both are
 * theirs.
 *
 * `id` here may be the row's own surrogate PK OR a built-in tool's
 * provider wire id (a card only ever knows the client-visible id —
 * `toolCallRowToSummary` exposes `providerToolCallId ?? id`, so a
 * built-in row's client-visible id is the wire id, not its PK). Tries
 * the exact PK first (cheap, unambiguous); a miss falls back to the
 * wire-id column, most-recent-first, because that value is
 * deliberately NOT unique (see `toolCalls.providerToolCallId`'s doc) —
 * the caller-side conversationId cross-check that follows is what stays
 * fail-closed if that fallback ever picks the wrong tenant's row.
 */
// fallow-ignore-next-line unused-export
export async function getToolCallConversationById(
  id: string,
): Promise<{ id: string; conversationId: string | null } | null> {
  const db = getDb();
  const byId = await db
    .select({ id: toolCalls.id, conversationId: toolCalls.conversationId })
    .from(toolCalls)
    .where(eq(toolCalls.id, id))
    .limit(1);
  if (byId[0]) return byId[0];
  const byWireId = await db
    .select({ id: toolCalls.id, conversationId: toolCalls.conversationId })
    .from(toolCalls)
    .where(eq(toolCalls.providerToolCallId, id))
    .orderBy(desc(toolCalls.createdAt))
    .limit(1);
  return byWireId[0] ?? null;
}

/**
 * Distinct extension ids that authored tool-call rows anchored to a
 * message. This IS the recorded extension identity of an
 * extension-authored message: the `messages` table carries no extension
 * column, but every `ezcorp/append-message` turn that a card can upload
 * to persists its tool-call rows with the calling extension's id
 * (append-message-handler.ts step 9). The uploads route uses this to
 * bind a target message to the uploading extension — a message with no
 * tool-call rows has no recorded identity and binds to nothing.
 */
export async function listToolCallExtensionIdsForMessage(
  messageId: string,
): Promise<string[]> {
  if (!messageId) return [];
  const rows: Array<{ extensionId: string }> = await getDb()
    .select({ extensionId: toolCalls.extensionId })
    .from(toolCalls)
    .where(eq(toolCalls.messageId, messageId));
  return [...new Set(rows.map((r) => r.extensionId))];
}

/**
 * Insert one `tool_calls` row.
 *
 * ## The synthetic-scope normalisation is load-bearing
 *
 * A tool step inside a WORKFLOW is dispatched with the synthetic
 * `workflow-run:<id>` scope key in the `conversationId` slot, because
 * every host-mediated surface it touches is conversation-keyed. That key
 * matches no `conversations` row, so `conversation_id`'s FK REJECTED the
 * insert — and this function's never-throw contract turned the rejection
 * into an `error_logs` row nobody reads. The result: every tool call a
 * workflow ever made was missing from `tool_calls`, and therefore from
 * every analytics surface built on it.
 *
 * {@link persistableConversationId} maps the synthetic key to `null`
 * (this column, unlike `observability_events`', has always been nullable)
 * so the row LANDS, carrying the tool name, extension, input, output,
 * success and duration it always should have. It is normalised HERE, at
 * the single writer, rather than at the two call sites: a caller that
 * forgets is a silent regression of exactly this bug.
 *
 * The run correlation is not lost by the null — `workflow_step_runs`
 * records the step, and the observability event for the same call carries
 * `data.workflowRunId`.
 */
export async function persistToolCall(row: ToolCallRow): Promise<void> {
  try {
    await getDb().insert(toolCalls).values({
      // `row.id`, when set, is a HOST-MINTED uuid (see the doc above) — the
      // DB default kicks in otherwise. Never a provider wire id; that goes
      // in `providerToolCallId`.
      ...(row.id ? { id: row.id } : {}),
      conversationId: persistableConversationId(row.conversationId),
      messageId: row.messageId,
      extensionId: row.extensionId,
      toolName: row.toolName,
      input: row.input,
      output: {
        content: redactToolCallOutputContent("content" in row.output ? row.output.content : []),
      } as Record<string, unknown>,
      success: row.success,
      durationMs: row.durationMs,
      cardType: row.cardType ?? null,
      cardLayout: row.cardLayout ?? null,
      userId: row.userId ?? null,
      agentConfigId: row.agentConfigId ?? null,
      model: row.model ?? null,
      provider: row.provider ?? null,
      providerToolCallId: row.providerToolCallId ?? null,
    });
  } catch (err) {
    // Never-throw contract preserved: a DB persistence failure must not break
    // tool execution (the caller has already returned data to the LLM/user).
    // But it must not vanish silently either — a broken tool_calls insert
    // drops analytics dimensions, the message-detail tool-call UI, and the
    // extension-identity binding the uploads route relies on. Route the caught
    // error to persistError (fire-and-forget, itself never-throw) so the
    // failure stays observable — mirroring insertAuditEntry (audit-log.ts).
    //
    // `String(err)` alone is NOT observable enough to diagnose from: a
    // failure through drizzle is a `DrizzleQueryError` whose OWN `.message`
    // is just "Failed query: <sql> params: <bound values>" — the Postgres
    // constraint name / detail / SQLSTATE code live one level down, on
    // `.cause`, and never surface in `String(err)` at all. Diagnosing the
    // defect-1 FK violation (a `messageId` that didn't exist in `messages`)
    // took four separate ad-hoc queries against a log line that already
    // existed, purely because that line didn't carry `.cause`. Pull those
    // three fields out explicitly so the next failure reads off one line.
    const cause =
      err instanceof Error && err.cause && typeof err.cause === "object"
        ? (err.cause as { code?: unknown; constraint?: unknown; detail?: unknown; message?: unknown })
        : undefined;
    // `String(err)` also EMBEDS THE BOUND PARAMS verbatim (drizzle renders
    // "Failed query: <sql> params: <values>") — and those values are this
    // row's `input`/`output`, which can carry whatever the tool call itself
    // carried (credentials an extension echoed, file contents, etc.). Never
    // widen that leak into `error_logs`: run it through the same
    // credential-redaction boundary every other audit-adjacent write uses
    // (`redactForAudit` — the house helper for exactly this threat model),
    // rather than storing the raw string.
    await persistError({
      level: "warn",
      message: "tool-call-persist-failed: tool_calls",
      stack: err instanceof Error ? err.stack ?? null : null,
      metadata: {
        conversationId: row.conversationId,
        messageId: row.messageId,
        extensionId: row.extensionId,
        toolName: row.toolName,
        // Postgres SQLSTATE (e.g. "23503" = foreign_key_violation) — see
        // https://www.postgresql.org/docs/current/errcodes-appendix.html.
        code: typeof cause?.code === "string" ? cause.code : null,
        // The violated constraint's name (e.g. "tool_calls_message_id_fkey"),
        // when Postgres reported one.
        constraint: typeof cause?.constraint === "string" ? cause.constraint : null,
        // Postgres's own DETAIL line (e.g. "Key (message_id)=(…) is not
        // present in table \"messages\"."). Redacted defensively — it only
        // ever echoes id/column values for this table, never tool payload,
        // but costs nothing to run through the same boundary.
        detail:
          typeof cause?.detail === "string"
            ? redactForAudit(cause.detail, { truncate: false }).redacted
            : null,
        error: redactForAudit(String(err)).redacted,
      },
    });
  }
}
