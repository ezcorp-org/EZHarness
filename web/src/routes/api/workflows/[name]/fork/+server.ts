import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as workflowQueries from "$server/db/queries/workflows";
import { listWorkflows } from "$server/db/queries/workflows";
import { ensureWorkflowVersion } from "$server/db/queries/workflow-versions";
import { reloadWorkflows } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { denyVisibilityOr, resolveWorkflowOr } from "$lib/server/workflow-access";
import { isForkNameRequestable, pickForkName } from "$server/runtime/workflow-fork";
import type { RequestHandler } from "./$types";

// `projectId` is taken from the BODY, not from any server-side "active
// project" — there isn't one. The active project lives in the client
// store (`stores.svelte.ts`) and every route that needs it is told
// explicitly, exactly like `POST …/run`.
//
// `name` and `visibility` are what turned this route into the platform's
// ONE copy verb: the UI now collects both BEFORE the row exists, so the
// author names the copy and picks its audience rather than discovering
// afterwards what the server chose for them. Both stay optional — a
// bodyless POST is still a valid fork, and every pre-existing caller
// keeps working.
const forkBodySchema = z
  .object({
    projectId: z.string().optional(),
    name: z.string().optional(),
    visibility: z.enum(["system", "project", "private"]).optional(),
  })
  .strict();

/**
 * The tier a copy lands on when the author names none.
 *
 * It was `project`, unconditionally and invisibly, and that was the
 * problem: `project` resolves to `"any-authenticated-principal"` on the
 * read/run ladder — **every user on the instance**, because the platform
 * has no project-membership model (`readRunAudience` in
 * `src/runtime/workflow-scope.ts` says so in as many words). So copying a
 * workflow to tinker with published it to everyone with a login, before
 * the author had decided anything at all.
 *
 * `private` is the only tier narrower than that, and the only defensible
 * default for a copy: a copy is yours until you say otherwise, and the UI
 * offers the widening in the same breath as the copy. INHERITING the
 * source's tier was the other candidate and is worse — the commonest
 * source is a `system` YAML/extension demo, so inheritance would stamp
 * `system` on a member's private tinkering, which `denyVisibilityAssignment`
 * refuses outright for a non-admin and which means "ships with the
 * install" for everyone who reads it.
 *
 * **What this deliberately does NOT fix:** a service account carries
 * `userId: null`, so it satisfies only `system` — see the REACH WARNING
 * on `serviceAccounts` in `src/db/schema.ts`. A copy was unrunnable by a
 * delegated principal at `project` and is still unrunnable at `private`.
 * That is a property of the read/run ladder, not of this default, and no
 * value here repairs it: the only tier that would is `system`, which is
 * admin-only to assign for exactly the right reason.
 */
const DEFAULT_COPY_VISIBILITY = "private" as const;

/**
 * Clone a workflow the caller can READ into an editable row they own.
 *
 * Authorized for `read`, not `edit`: copying a workflow you may look at
 * is the whole point — it gives you your own copy and leaves the original
 * untouched. The caller is always stamped as `user_id`, and the tier is
 * either the one they asked for (gated by the shared assignment rule) or
 * {@link DEFAULT_COPY_VISIBILITY}. A copy never widens the source's
 * audience: the widest tier reachable here is `system`, which only an
 * admin may assign.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = forkBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) return errorJson(400, "Invalid request body");
  const projectId = parsed.data.projectId ?? null;

  const resolved = resolveWorkflowOr(user, params.name, "read", projectId);
  if (resolved instanceof Response) return resolved;
  const source = resolved.entry.definition;

  // WHO may stamp WHICH tier is one rule, owned by the ladder and reached
  // only through this adapter — the same call `POST /api/workflows` makes.
  // Asked about the tier the caller NAMED, never about the default, so
  // this route cannot quietly become a second answer to "who may assign
  // `system`". Asked AFTER the read resolve so a 403 here is only ever
  // reachable by someone who can already see the source.
  const visibilityDenial = denyVisibilityOr(user, parsed.data.visibility);
  if (visibilityDenial) return visibilityDenial;
  const visibility = parsed.data.visibility ?? DEFAULT_COPY_VISIBILITY;

  // A name the grammar can never accept is the author's typo, not a
  // collision — answered 400 here rather than as the 409 `pickForkName`
  // would reach after rejecting all 1000 candidates for the same reason.
  const requestedName = parsed.data.name?.trim();
  if (requestedName && !isForkNameRequestable(requestedName)) {
    return errorJson(400, `"${requestedName}" is not a valid workflow name`);
  }

  const taken = new Set((await listWorkflows()).map((w) => w.name));
  let name: string;
  try {
    name = pickForkName(requestedName || source.name, (candidate) => taken.has(candidate));
  } catch (err) {
    return errorJson(409, err instanceof Error ? err.message : String(err));
  }

  let created: workflowQueries.DbWorkflow;
  try {
    created = await workflowQueries.createWorkflow(
      {
        name,
        description: source.description,
        ...(source.inputSchema !== undefined ? { inputSchema: source.inputSchema } : {}),
        ...(source.defaultModel !== undefined ? { defaultModel: source.defaultModel } : {}),
        steps: source.steps,
      },
      {
        visibility,
        projectId,
        userId: user.id,
        // The source's FULLY QUALIFIED name as a string snapshot, never an
        // FK: the source is often an extension asset with no row, and the
        // extension may be uninstalled later. A fork of a fork records its
        // immediate parent, with no chain walking.
        forkedFrom: source.name,
      },
    );
  } catch (err) {
    // The `taken` set was read before the insert, so a concurrent create
    // can still win the name. Reported as a 409 rather than a 500.
    if (err instanceof workflowQueries.WorkflowNameConflictError) {
      return errorJson(409, err.message, { name: err.workflowName });
    }
    throw err;
  }

  await ensureWorkflowVersion(created, user.id);
  await reloadWorkflows();
  // The tier rides back with the name for the same reason the name does:
  // both may differ from what was asked for (a suffix, or the default),
  // and the UI should report what actually landed rather than what it
  // hoped for.
  return json(
    { name: created.name, id: created.id, forkedFrom: source.name, visibility },
    { status: 201 },
  );
};
