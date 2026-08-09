/**
 * GET /api/workflows/delegated-runs — "jobs running as me".
 *
 * The runs an extension started unattended under a delegation THIS human
 * consented to. It is the accountability half of C3: consent mints standing
 * authority, and standing authority that nobody can look at afterwards is
 * not reviewable authority.
 *
 * ## Why this is a ROUTE and not the SDK's `runs()`
 *
 * It reads server-side because the extension-facing read genuinely cannot
 * answer it. `readRuns` scopes to the names a grant covers AND to the acting
 * user; a delegated-only grant lists no names, and a cron fire has no acting
 * user, so a delegated run is invisible through that surface by construction.
 * That is correct for the extension — the extension should not be able to
 * enumerate what it did on someone's behalf as if it were the someone — and
 * it is exactly why the human's view has to be its own read.
 *
 * ## Scoped by CONSENTER, not by principal
 *
 * {@link listDelegatedRunsForConsenter} joins through `delegation_id` to
 * `consented_by_user_id`. Scoping on `run_as` instead would show a user
 * their own user-kind jobs and hide every service-account job they
 * authorized — and a service account has no session anywhere, so those runs
 * would become unreadable by anyone. Ruling 1: the account owns the run, the
 * human who consented answers for it. Same key `mayManageDelegation` uses,
 * so what a person can SEE here is exactly what they can REVOKE.
 *
 * ## SESSION-ONLY, like every other delegation surface
 *
 * `requireSessionAuth` allowlists a positively stamped
 * `locals.authMethod === "session"` rather than inferring from the absence
 * of `apiKeyScopes`. The gate RETURNS its denial; a thrown `Response` from a
 * `+server.ts` handler becomes a 500.
 *
 * No route-level ownership filter is applied on top, and none is needed: the
 * query takes the caller's own id as its only scope argument, so there is no
 * "unscoped" shape of this read to reach by omitting a parameter.
 */
import { json } from "@sveltejs/kit";
import { requireSessionAuth } from "$server/auth/middleware";
import { listDelegatedRunsForConsenter } from "$server/db/queries/workflow-runs";
import type { RequestHandler } from "./$types";

/** One page. Bounded rather than paginated for now: the page shows a
 *  person their recent unattended jobs, and a cursor UI for something
 *  nobody has more than a screenful of is complexity without a reader.
 *  The query is keyset-ready, so adding one later changes only this file. */
const PAGE_LIMIT = 100;

export const GET: RequestHandler = async ({ locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const page = await listDelegatedRunsForConsenter(user.id, { limit: PAGE_LIMIT });

  return json({
    runs: page.runs.map((run) => ({
      id: run.id,
      workflowName: run.workflowName,
      status: run.status,
      // The plain-text audit snapshot, not a join: it survives revocation
      // of the delegation and deletion of the owner, which is the whole
      // reason those two columns carry no FK.
      runAsKind: run.runAsKind,
      runAs: run.runAs,
      delegationId: run.delegationId,
      startedAt: run.startedAt.toISOString(),
      finishedAt: run.finishedAt?.toISOString() ?? null,
      // `result.error` is either a free-form string or the cancel path's
      // `{code, message}` discriminator, so it is normalized to one string
      // here rather than leaving the browser to know both shapes. The
      // OUTPUT is deliberately not carried: a delegated run's output can be
      // anything the workflow produced, and this list is an accountability
      // view, not a data export.
      error: describeRunError(run.result?.error),
      // Why it stopped, when it stopped without failing — a delegated run
      // parked on an approval is the row its consenter most needs to see.
      suspendedReason: run.suspendedReason,
    })),
  });
};

function describeRunError(
  error: string | { code: string; message: string } | undefined,
): string | null {
  if (error === undefined) return null;
  return typeof error === "string" ? error : error.message;
}
