import { json } from "@sveltejs/kit";
import { listWorkflowRunsForCaller, RUN_PAGE_MAX } from "$server/runtime/workflow-run-trace";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import type { WorkflowRunStatus } from "$server/types";
import type { RequestHandler } from "./$types";

/**
 * Workflow run history, newest first.
 *
 * Boundary only — the ownership scoping lives in
 * `listWorkflowRunsForCaller`, because it has to be part of the WHERE
 * clause rather than a filter over the result. Post-filtering a page
 * returns short pages and eventually an empty one with a cursor still
 * pointing forward, which a client reads as "no more runs" while runs
 * remain.
 *
 * `read` scope: this lists history, it starts nothing.
 */
const STATUSES = new Set<string>([
  "running", "success", "error", "cancelled", "awaiting_approval", "suspended",
]);

/** Parse an ISO date, refusing garbage rather than silently ignoring it —
 *  a dropped `since` would quietly widen the window the caller asked for. */
function parseDate(raw: string | null, field: string): { date?: Date; error?: string } {
  if (raw === null) return {};
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) return { error: `Invalid ${field}: expected an ISO date` };
  return { date };
}

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const status = url.searchParams.get("status");
  if (status !== null && !STATUSES.has(status)) {
    return errorJson(400, `Invalid status: ${status}`);
  }

  const since = parseDate(url.searchParams.get("since"), "since");
  if (since.error) return errorJson(400, since.error);
  const until = parseDate(url.searchParams.get("until"), "until");
  if (until.error) return errorJson(400, until.error);

  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw === null ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > RUN_PAGE_MAX)) {
    return errorJson(400, `Invalid limit: expected 1..${RUN_PAGE_MAX}`);
  }

  // Both halves or neither. A cursor missing its `id` cannot disambiguate
  // two runs that started in the same millisecond, so it would silently
  // drop or repeat one — better refused than half-honoured.
  const cursorAt = parseDate(url.searchParams.get("cursorStartedAt"), "cursorStartedAt");
  if (cursorAt.error) return errorJson(400, cursorAt.error);
  const cursorId = url.searchParams.get("cursorId");
  if ((cursorAt.date === undefined) !== (cursorId === null)) {
    return errorJson(400, "A cursor needs both cursorStartedAt and cursorId");
  }

  const workflowName = url.searchParams.get("workflowName");
  const projectId = url.searchParams.get("projectId");

  const page = await listWorkflowRunsForCaller(
    {
      ...(workflowName !== null ? { workflowName } : {}),
      ...(status !== null ? { status: status as WorkflowRunStatus } : {}),
      ...(projectId !== null ? { projectId } : {}),
      ...(since.date !== undefined ? { since: since.date } : {}),
      ...(until.date !== undefined ? { until: until.date } : {}),
      ...(cursorAt.date !== undefined && cursorId !== null
        ? { cursor: { startedAt: cursorAt.date, id: cursorId } }
        : {}),
      ...(limit !== undefined ? { limit } : {}),
    },
    { userId: user.id, isAdmin: user.role === "admin" },
  );

  return json(page);
};
