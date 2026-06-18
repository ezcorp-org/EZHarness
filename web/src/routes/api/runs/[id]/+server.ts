import { json } from "@sveltejs/kit";
import { getExecutor, getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { awaitRunCompletion } from "$server/runtime/await-run-completion";
import type { RequestHandler } from "./$types";

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

export const GET: RequestHandler = async ({ params, url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const executor = getExecutor();
  const run = await executor.getRun(params.id);
  if (!run) return errorJson(404, "Not found");

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
      });
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
  requireAuth(locals);
  const executor = getExecutor();
  const cancelled = executor.cancelRun(params.id);
  if (!cancelled) return errorJson(404, "Run not found or not running");
  return json({ ok: true });
};
