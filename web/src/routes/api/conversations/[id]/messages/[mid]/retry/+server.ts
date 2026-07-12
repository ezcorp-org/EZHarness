import { json } from "@sveltejs/kit";
import { errorJson } from "$lib/server/http-errors";
import { logger } from "$server/logger";
import * as convQueries from "$server/db/queries/conversations";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getExecutor } from "$lib/server/context";
import { getActiveRun } from "$server/db/queries/active-runs";
import { isSessionHistoryProducerEnabled } from "$server/db/session-sync";
import { checkTokenBudget } from "$lib/server/security/resource-quotas";
import { buildCommandResolver } from "$lib/server/command-resolver";
import { validationError } from "$lib/server/security/validation";
import { retryMessageSchema } from "./schema";
import type { RequestHandler } from "./$types";

const log = logger.child("api.retry");

/**
 * POST /api/conversations/:id/messages/:mid/retry — the clean A/B retry
 * (Sessions P5). Re-runs the turn from the target assistant message's parent
 * USER message WITHOUT duplicating that user row, so the new response is a
 * same-role SIBLING of the original assistant (both children of the one user
 * turn). This is the honest A/B: `handleRegenerate`'s `editOf` path forks a new
 * user row too, producing mixed-role siblings — that path stays for the toolbar
 * regenerate; this route is what the labeled A/B "Retry" affordance drives.
 *
 * The seam is the SAME contract a normal turn uses: `streamChat` takes the
 * user turn's `content` + `parentMessageId` and never creates the user row
 * itself (the messages POST does). Anchoring `parentMessageId` at the EXISTING
 * user message makes the assistant save (parented on `ctx.lastSavedMessageId`,
 * seeded from `parentMessageId`) land as the sibling. The session live-append
 * only appends the assistant turn; the user row is already in `messages`, so
 * the backfill/branch read reproduces it — no duplicate.
 *
 * Guards mirror the rewind route (all-or-nothing with the flag):
 *  - unowned/missing conversation → 404 (fail-closed, before anything else).
 *  - flag OFF → 409 `session_producer_disabled` (siblings need the tree).
 *  - a LIVE run in flight → 409 `active_run` (no concurrent turn on one conv).
 *  - target not an assistant row of THIS conversation, or it has no user
 *    parent → 400 (target validation).
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;
  const messageId = params.mid;

  // Ownership FIRST — same root-walk gate as the sibling message routes.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");
  const conv = ownership.conv;

  if (!(await isSessionHistoryProducerEnabled())) {
    return errorJson(409, "Session history producer is disabled", { code: "session_producer_disabled" });
  }

  // Never start a second turn on a conversation with a live run — check the
  // in-memory controller first, then the DB row (survives a restart).
  const memRun = getExecutor().getActiveRunForConversation(conversationId);
  const dbRun = memRun ? null : await getActiveRun(conversationId);
  if (memRun || dbRun) {
    return errorJson(409, "Cannot retry while a run is active", { code: "active_run" });
  }

  const parsed = retryMessageSchema.safeParse(
    await request.json().catch(() => ({})),
  );
  if (!parsed.success) return validationError(parsed.error);

  const budget = await checkTokenBudget(user.id);
  if (!budget.allowed) {
    return errorJson(429, "Daily token budget exceeded", { resetsAt: budget.resetsAt });
  }

  // Resolve the target assistant message + its parent user turn from THIS
  // conversation's messages. `getMessages` scopes by conversation, so a
  // cross-conversation `mid` simply isn't found (fail-closed target check).
  const allMessages = await convQueries.getMessages(conversationId);
  const target = allMessages.find((m) => m.id === messageId);
  if (!target || target.role !== "assistant") {
    return errorJson(400, "Target is not an assistant message of this conversation", { code: "target_not_found" });
  }
  const parentUser = target.parentMessageId
    ? allMessages.find((m) => m.id === target.parentMessageId)
    : undefined;
  if (!parentUser || parentUser.role !== "user") {
    return errorJson(400, "Target assistant message has no user parent to retry from", { code: "no_user_parent" });
  }

  // A retry uses the conversation's pinned identity unless the caller
  // overrides it (compose-and-retry-with-a-different-model). Absent both →
  // undefined, and streamChat's tier routing picks a model, exactly like a
  // normal turn with no explicit model.
  const provider = parsed.data.provider ?? conv.provider ?? undefined;
  const model = parsed.data.model ?? conv.model ?? undefined;

  const executor = getExecutor();
  const runId = crypto.randomUUID();

  log.debug("retry starting", { conversationId, messageId, parentUser: parentUser.id, runId });

  // Anchor the turn at the EXISTING user row: no new user message is created,
  // so the assistant response becomes a sibling of `target`.
  const streamPromise = executor.streamChat(conversationId, parentUser.content, {
    projectId: conv.projectId,
    provider,
    model,
    runId,
    parentMessageId: parentUser.id,
    agentConfigId: conv.agentConfigId ?? undefined,
    modeId: conv.modeId ?? undefined,
    thinkingLevel: parsed.data.thinkingLevel,
    commandResolver: buildCommandResolver(user.id, conv.projectId),
  });
  streamPromise.catch((err) => {
    log.error("retry streamChat error", { error: err instanceof Error ? err.message : String(err) });
  });

  return json({
    // The existing user turn the retry re-runs from — no new row was created,
    // so callers (and the harness SendMessageResult shape) get the anchor id.
    userMessage: parentUser,
    retriedMessageId: target.id,
    runId,
  });
};
