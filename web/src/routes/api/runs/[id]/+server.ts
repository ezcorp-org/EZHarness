import { json } from "@sveltejs/kit";
import { getExecutor, getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { awaitRunCompletion } from "$server/runtime/await-run-completion";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import type { AuthUser } from "$server/auth/types";
import type { RequestHandler } from "./$types";

// Enforce per-user run ownership for GET/await/DELETE. Closes a cross-tenant
// IDOR (read/await/cancel any run) for EVERY run type — chat, agent, CLI —
// including runs created before run-attribution existed.
//
// Decision order (fail closed):
//   1. admin            ⇒ allow (admins retain full access)
//   2. run.userId === caller.id  ⇒ allow (authoritative initiator match,
//        covers agent/CLI runs that have no conversation)
//   3. run has a conversation the caller owns (root-owner walk) ⇒ allow
//        (covers historical chat runs whose userId predates backfill on a
//         fresh insert, and any run attributed only by conversation)
//   4. otherwise (NULL/unattributable, or owned by someone else) ⇒ DENY
//
// A non-admin who matches none of the allow rules — INCLUDING a run that
// cannot be attributed to any user (userId NULL and no owned conversation) —
// is denied. The caller maps a denial to 404 so run existence isn't leaked.
async function callerOwnsRun(runId: string, user: AuthUser): Promise<boolean> {
  if (user.role === "admin") return true;
  const { userId, conversationId } = await getExecutor().getRunOwnership(runId);
  if (userId && userId === user.id) return true;
  if (conversationId) {
    return (await resolveRootConversationForOwnership(conversationId, user)) !== null;
  }
  // Unattributable to this non-admin caller ⇒ fail closed.
  return false;
}

// Bound the synchronous wait so a stuck/never-finishing run can't pin a
// connection forever. 1s floor, 10min ceiling, 2min default.
const WAIT_MIN_MS = 1_000;
const WAIT_MAX_MS = 600_000;
const WAIT_DEFAULT_MS = 120_000;

function parseTimeoutMs(raw: string | null): number {
  const n = raw ? parseInt(raw, 10) : NaN;
  if (!Number.isFinite(n)) return WAIT_DEFAULT_MS;
  return Math.min(WAIT_MAX_MS, Math.max(WAIT_MIN_MS, n));
}

// Admission cap on concurrent `?wait=1` long-polls. Each waiter pins a
// connection + bus listeners for up to WAIT_MAX_MS, and `/api/runs/:id` is
// not otherwise rate-limited — so without a cap a single `read` key could
// open thousands of 10-minute waits (DoS). Process-local counter; the cap is
// read per-request from `EZCORP_MAX_RUN_WAITS` (default 200). Non-wait GETs
// are unaffected.
let activeWaits = 0;
function maxConcurrentWaits(): number {
  const n = Number(process.env.EZCORP_MAX_RUN_WAITS ?? 200);
  return Number.isFinite(n) && n >= 0 ? n : 200;
}

export const GET: RequestHandler = async ({ params, url, locals, request }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const executor = getExecutor();
  const run = await executor.getRun(params.id);
  if (!run) return errorJson(404, "Not found");
  // Ownership: a non-owner gets 404 (don't reveal the run exists).
  if (!(await callerOwnsRun(params.id, user))) return errorJson(404, "Not found");

  // ?wait=1 — block until the run reaches a terminal state (or timeout).
  // Lets external harnesses drive a turn and read the result in one call
  // instead of correlating SSE frames by runId.
  if (url.searchParams.get("wait") === "1") {
    if (activeWaits >= maxConcurrentWaits()) {
      return errorJson(429, "Too many concurrent run waits", { retryAfter: 5 });
    }
    activeWaits++;
    try {
      const result = await awaitRunCompletion({
        bus: getBus(),
        getRun: (id) => executor.getRun(id),
        runId: params.id,
        timeoutMs: parseTimeoutMs(url.searchParams.get("timeoutMs")),
        // Abort-on-disconnect: a client that drops the connection releases its
        // bus listeners + activeWaits slot immediately instead of pinning them
        // until the run finishes or the ≤10-min timeout — closes the soft-DoS
        // that could fill the concurrency cap with dead waiters.
        signal: request.signal,
      });
      // Client disconnected mid-wait: awaitRunCompletion already ran its
      // cleanup (listeners + timer) on abort. There is no socket left to
      // write to, but we still return so the `finally` decrements the slot.
      if (result.kind === "aborted") {
        return errorJson(499, "Client closed request");
      }
      if (result.kind === "timeout") {
        const latest = await executor.getRun(params.id);
        return errorJson(408, "Run did not reach a terminal state in time", {
          runId: params.id,
          status: latest?.status ?? run.status,
        });
      }
      if (result.kind === "notfound") return errorJson(404, "Not found");
      return json({ outcome: result.outcome, run: result.run, error: result.error });
    } finally {
      activeWaits--;
    }
  }

  return json(run);
};

export const DELETE: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const executor = getExecutor();
  // Ownership before cancel — prevents cross-tenant run cancellation.
  if (!(await callerOwnsRun(params.id, user))) return errorJson(404, "Run not found or not running");
  const cancelled = executor.cancelRun(params.id);
  if (!cancelled) return errorJson(404, "Run not found or not running");
  return json({ ok: true });
};
