import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExecutor, getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { getActiveRun, markInterrupted } from "$server/db/queries/active-runs";
import { getPendingAskUserForConversation } from "$server/runtime/ask-user-registry";
import { getPendingCallerToolCallsForUser } from "$server/runtime/remote-tool-registry";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";

// Boundary validation: the only field the handler reads off the body is
// `action`, which must be one of two literal strings. Keep the schema
// strict so unknown fields fail loud rather than silently — this route
// is small enough that any drift would be intentional.
const activeRunActionSchema = z.object({
  action: z.enum(["cancel", "force-cancel"]),
}).strict();

/** Compute "how long since this run last emitted a heartbeat" in ms. Treats the row's
 *  startedAt as a fallback when last_heartbeat is missing. Used by the client to drive
 *  the stuck-run banner. */
function stalenessFor(dbRun: { startedAt: Date; lastHeartbeat: Date | null } | null): number | null {
  if (!dbRun) return null;
  const ref = dbRun.lastHeartbeat ?? dbRun.startedAt;
  return Date.now() - ref.getTime();
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // IDOR guard (parity with the sibling messages/tree/topics routes): the
  // response leaks the in-flight assistant text (partialResponse) plus
  // pending permission / ask-user payloads, so it must be owner-gated.
  // Fail-closed 404 on an unowned conversation walks to the root owner.
  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  // Caller-executed tool calls this conversation is suspended on. THE
  // authoritative recovery channel: a client that drops its stream mid-call
  // cannot rely on `Last-Event-ID` replay, because the SSE resume ring holds
  // 500 GLOBAL entries including every `run:token` — seconds of a busy chat
  // turn it over, and a missed `caller:tool-call` is then simply gone.
  //
  // On EVERY branch below, deliberately. The registry is keyed by toolCallId,
  // not by run, and a client draining on reconnect asks this one question
  // without first knowing whether a run is live; a field present on three of
  // four shapes would make recovery depend on which branch answered. The
  // helper's two narrowings (caller origin, exact user) are what keeps the
  // payload — the LLM's raw arguments for a call about to run on the owner's
  // machine — from reaching an admin or the Ez panel's family.
  const pendingCallerTools = getPendingCallerToolCallsForUser(params.id, user.id);

  // Check in-memory first, but cross-check with DB to catch orphaned runs
  // (e.g. in-memory run stuck in auto-spin-up while DB was marked interrupted by orphan cleanup)
  const executor = getExecutor();
  const memRun = executor.getActiveRunForConversation(params.id);
  if (memRun) {
    // Cross-check: if DB says this run is no longer running, don't report it as active
    const dbRun = await getActiveRun(params.id);
    if (dbRun && dbRun.status !== "running") {
      // DB was marked interrupted/error — cancel the orphaned in-memory run
      executor.cancelRun(memRun.id);
      return json({
        runId: dbRun.id,
        status: dbRun.status,
        partialResponse: dbRun.partialResponse,
        startedAt: dbRun.startedAt,
        stalenessMs: stalenessFor(dbRun),
        pendingCallerTools,
      });
    }
    const pendingPermissions = executor.getPendingPermissions(params.id);
    // Open ask_user_question gates for this conversation. Sourced from
    // the in-memory registry, not the DB — the `tool_calls` row isn't
    // written until the gate resolves, so a refreshed client has no
    // other way to learn about a question that's still pending.
    const pendingAskUser = getPendingAskUserForConversation(params.id);
    return json({
      runId: memRun.id,
      status: "running",
      partialResponse: null,
      pendingPermissions,
      pendingAskUser,
      pendingCallerTools,
      startedAt: new Date(memRun.startedAt).toISOString(),
      stalenessMs: stalenessFor(dbRun),
    });
  }

  // Check DB for runs that survived a restart
  const dbRun = await getActiveRun(params.id);
  if (dbRun) {
    return json({
      runId: dbRun.id,
      status: dbRun.status,
      startedAt: dbRun.startedAt,
      partialResponse: dbRun.partialResponse,
      stalenessMs: stalenessFor(dbRun),
      pendingCallerTools,
    });
  }

  return json({ runId: null, pendingCallerTools });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // IDOR guard: without this a chat-scoped member could POST {action:"cancel"}
  // against another tenant's conversation and kill their run. Fail-closed 404.
  const ownership = await resolveRootConversationForOwnership(params.id, user);
  if (!ownership) return errorJson(404, "Not found");

  const raw = await request.json().catch(() => null);
  const parsed = activeRunActionSchema.safeParse(raw);
  if (!parsed.success) {
    return errorJson(400, "Unknown action");
  }

  const executor = getExecutor();
  const memRun = executor.getActiveRunForConversation(params.id);
  if (memRun) {
    // Happy path: run is in memory, cancelling aborts the controller and fires run:cancel.
    const cancelled = executor.cancelRun(memRun.id);
    return json({ cancelled, path: "memory" });
  }

  // Fallback path: no in-memory controller but the DB still thinks a run is alive — either
  // because the process died mid-run, or because a leaked sub-agent promise kept the
  // heartbeat ticking while nothing was actually happening. Flip the DB row and synthesize
  // a run:error on the bus so every connected client cleans up its streaming state.
  const dbRun = await getActiveRun(params.id);
  if (dbRun) {
    try {
      await markInterrupted(dbRun.id);
    } catch (err) {
      return errorJson(500, `Failed to mark run interrupted: ${String(err)}`);
    }
    try {
      const bus = getBus();
      bus.emit("run:error", {
        run: {
          id: dbRun.id,
          agentName: "chat",
          status: "error",
          startedAt: dbRun.startedAt.getTime(),
          finishedAt: Date.now(),
          logs: [],
          result: { success: false, output: null, error: "Force-cancelled (no in-memory run)" },
        },
        runId: dbRun.id,
        error: "Force-cancelled (no in-memory run)",
        conversationId: params.id,
      });
    } catch {
      /* bus unavailable is non-fatal — the DB flip already unsticks the client on next poll */
    }
    return json({ cancelled: true, path: "db-fallback", runId: dbRun.id });
  }

  return errorJson(404, "No active run");
};
