import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExecutor, getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";
import { getActiveRun, markInterrupted } from "$server/db/queries/active-runs";
import { getPendingAskUserForConversation } from "$server/runtime/ask-user-registry";

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
  requireAuth(locals);

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
    });
  }

  return json({ runId: null });
};

export const POST: RequestHandler = async ({ params, request, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

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
