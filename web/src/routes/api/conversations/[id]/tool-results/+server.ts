import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { isInteractiveSession, requireAuth } from "$server/auth/middleware";
import { isSessionPrincipalId, principalId } from "$server/auth/principal-id";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { createRateLimiter } from "$server/extensions/rate-limit";
import * as convQueries from "$server/db/queries/conversations";
import {
  getPendingRemoteTool,
  resolveRemoteTool,
  type PendingRemoteToolInfo,
} from "$server/runtime/remote-tool-registry";

/**
 * POST /api/conversations/[id]/tool-results
 *
 * Phase 48 — resumes a suspended Ez client-side tool call. The runtime
 * emits `ez:client-tool` over SSE when the LLM invokes `fill_form` or
 * `navigate_to`; the Ez panel dispatches the call locally and POSTs the
 * result here, which resolves the registry-pending Promise and the
 * agent loop continues.
 *
 * Mirrors the contract used by `/api/ask-user/answer/+server.ts`:
 *   1. `requireScope(locals, "chat")` — same scope as message-send.
 *   2. `requireAuth(locals)` — pulls the session user.
 *   3. Authorization: the pending entry's `userId` (captured at wire time)
 *      must match the acting user, AND the URL [id] must match the
 *      pending entry's `conversationId`. Mismatch → 404, not 403, so
 *      we don't leak existence of others' pending tool calls.
 *
 * Late-POST contract: when no entry exists, return
 * `{ ok: true, resolved: false, reason: "already-resolved" }` without
 * emitting. Mirrors the legacy human-input endpoint's optimistic
 * dismissal — the gate may have already collapsed (timeout, abort, server
 * restart) and the panel has already moved on.
 *
 * ── `{ ok, resolved, reason }`, NOT `{ ok, late }` ───────────────────────
 *
 * Caller-executed tools make the two-devices-on-one-key case ordinary
 * rather than pathological: both devices receive the same
 * `caller:tool-call` over SSE, both execute it, both POST. `ok` answers
 * "was your request accepted", which is true for the loser too — nothing
 * it did was wrong. `resolved` answers "did YOUR result reach the waiting
 * tool", which is the fact a client needs to decide whether to report
 * success to its user. `late` conflated the two and, being true only on
 * the no-entry branch, could not describe a loser that raced past the
 * registry lookup and lost at `resolveRemoteTool`.
 *
 * The body's `result` is forwarded verbatim to the registry. The
 * fill_form / navigate_to tool body normalizes any shape into a stable
 * `AgentToolResult` for the LLM (see fill-form.ts:panelResultToToolResult).
 */
const toolResultBodySchema = z
  .object({
    toolCallId: z.string().min(1),
    // `result` is the panel's `DispatchResult` (see
    // web/src/lib/ez/client-tool-dispatcher.ts) — but we accept any JSON
    // shape so a future panel refactor doesn't require a coupled server
    // change. The tool body normalizes whatever arrives.
    result: z.unknown(),
  })
  .strict();

/**
 * A tool result is an LLM-visible payload from an external machine, so it is
 * capped twice: 256 KiB on the wire here, and 64 KiB of rendered text at the
 * tool body (`truncateText`). This outer cap is the one that stops the bytes
 * being ALLOCATED — it is checked on the declared `Content-Length` and again
 * on the actual bytes, so a lying header buys nothing.
 */
const MAX_RESULT_BODY_BYTES = 256 * 1024;

/**
 * 20 results per second per USER. A device answering caller tools posts once
 * per tool call, and parallel tool calls are bounded by the model's own fan-
 * out, so 20/s is far above legitimate use and far below what it takes to
 * make 256 KiB bodies expensive.
 */
const resultLimiter = createRateLimiter(20);

/**
 * May THIS principal settle THAT suspended call?
 *
 * Ownership is not attribution, and every other check in this handler is
 * satisfied by ANY credential of the same user. Both families' call events ride
 * SSE to every connection that user holds, so before this a narrow key that may
 * only read the event stream could lift a `toolCallId` off it and POST a forged
 * result — winning, because `resolveRemoteTool` is first-write-wins — and put
 * attacker-chosen text into the owner's LLM context. `origin` was recorded from
 * the start (`remote-tool-registry.ts`) and simply never read.
 *
 * ── 1. FAMILY ────────────────────────────────────────────────────────────
 *
 * `origin` names the client the call was ADDRESSED to, and a principal names
 * one too. `ez` is this app's own in-page panel, which is only ever a cookie
 * session; `caller` is an external application on the user's own machine, which
 * is only ever an API key. Neither can EXECUTE the other's call, so neither has
 * any business answering it. This is the rule that refuses the leaked companion
 * key forging a `read_page` result, and equally the caller-tools client
 * answering an Ez call.
 *
 * ── 2. KEY ───────────────────────────────────────────────────────────────
 *
 * Within the caller family, a key may not settle a call raised by a run some
 * OTHER key started — the confinement `handleToolPermission` applies to a gate
 * ANSWER, via the same `principalId`.
 *
 * It is narrower there than here, deliberately. That route can demand the
 * initiator outright because a gate is a decision and an unattributed one is
 * always answerable by the owner's session instead. A tool RESULT is not: it is
 * the only way the run can proceed, and the documented caller-tools topology
 * has a person send the message and approve the gate while the APP — a
 * different principal — executes and returns the call. Demanding an initiator
 * match there would break the feature rather than close a hole. So a call
 * attributable to a SESSION (or to nothing) rests on rule 1, which is already
 * enough to exclude every principal that cannot execute the call at all.
 */
function maySettleRemoteTool(
  locals: App.Locals,
  pending: PendingRemoteToolInfo,
): boolean {
  const bySession = isInteractiveSession(locals);
  if (pending.origin !== (bySession ? "ez" : "caller")) return false;
  if (bySession) return true;

  const me = principalId(locals);
  // An unnameable principal can never be SHOWN to match — the deny side, and
  // the same reading of `undefined` `principalId` documents.
  if (me === undefined) return false;
  const raisedByAnotherKey =
    pending.initiator !== undefined &&
    !isSessionPrincipalId(pending.initiator) &&
    pending.initiator !== me;
  return !raisedByAnotherKey;
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  if (!resultLimiter(user.id, 1)) {
    return errorJson(429, "Too many requests", undefined, { "Retry-After": "1" });
  }

  const declaredLen = Number(request.headers.get("content-length"));
  if (Number.isFinite(declaredLen) && declaredLen > MAX_RESULT_BODY_BYTES) {
    return errorJson(413, "Payload too large");
  }
  const bodyBytes = new Uint8Array(await request.arrayBuffer());
  if (bodyBytes.byteLength > MAX_RESULT_BODY_BYTES) {
    return errorJson(413, "Payload too large");
  }

  let raw: unknown = null;
  try {
    raw = JSON.parse(new TextDecoder().decode(bodyBytes));
  } catch {
    raw = null;
  }
  const parsed = toolResultBodySchema.safeParse(raw);
  if (!parsed.success) return errorJson(400, "Invalid body");
  const { toolCallId, result } = parsed.data;

  // Late-POST: registry entry already cleared (timeout/abort/server
  // restart), or a second device beat this one to it. Return ok without
  // emitting — mirrors ask-user/answer.
  const pending = getPendingRemoteTool(toolCallId);
  if (!pending) return json({ ok: true, resolved: false, reason: "already-resolved" });

  // Authorization: the URL [id] must agree with the registered
  // conversation. A mismatch implies a malicious / buggy caller — return
  // 404 (not 403) so we don't leak pending-tool-call existence across
  // conversations.
  if (pending.conversationId !== conversationId) {
    return errorJson(404, "Not found");
  }

  // Owner check: the registry captured the conversation owner at wire
  // time (see ez-tools-host.ts → fill-form.ts ctx.userId). Mismatch ⇒
  // 404 (not 403) — same posture as ask-user/answer's auth chain.
  if (pending.userId !== null && pending.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  // Settlement confinement — see `maySettleRemoteTool`. 404 like its
  // neighbours: a refusal that said 403 would confirm the toolCallId names a
  // real suspended call, which is precisely what an attacker who lifted one off
  // the event stream wants confirmed.
  if (!maySettleRemoteTool(locals, pending)) {
    return errorJson(404, "Not found");
  }

  // Defense-in-depth: confirm the conversation actually exists and is
  // owned by the user. The registry's userId match above SHOULD be
  // sufficient (it was captured server-side), but a stale registration
  // after a server crash could theoretically outlive a deleted
  // conversation. The DB hop here is the same one /api/conversations/[id]
  // makes on every read.
  const conv = await convQueries.getConversation(conversationId);
  if (!conv || (conv.userId !== user.id && user.role !== "admin")) {
    return errorJson(404, "Not found");
  }

  // The lookup above and this call are not one atomic step, so a second
  // device can settle the entry in between. `resolveRemoteTool` reports
  // that as `false`, and it carries the same meaning as the no-entry branch:
  // your bytes did not reach the tool because somebody else's already had.
  const resolved = resolveRemoteTool(toolCallId, result);
  return json(resolved ? { ok: true, resolved } : { ok: true, resolved, reason: "already-resolved" });
};
