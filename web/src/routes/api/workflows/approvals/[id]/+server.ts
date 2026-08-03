import { json } from "@sveltejs/kit";
import { z } from "zod";
import { answerApproval } from "$server/runtime/workflow-answer-approval";
import { workflowRefusalStatus } from "$server/runtime/workflow-refusal-status";
import { requireSessionAuth } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { hasExtensionScope } from "$server/auth/extension-rbac";
import type { RequestHandler } from "./$types";

// Boundary validation only. Every consent rule lives behind
// `answerApproval` — this route deliberately re-derives NONE of them, so
// it cannot drift from the Hub action or the chat card. See ported
// invariant 7 in `workflow-answer-approval.ts`.
const answerBodySchema = z.object({
  choice: z.string().min(1),
  form: z.record(z.string(), z.unknown()).optional(),
  itemIds: z.array(z.string()).optional(),
  consentAll: z.boolean().optional(),
});

/**
 * SESSION-ONLY, not `chat`-scoped.
 *
 * Answering an approval is the consent boundary: a run parks here precisely
 * so that a PERSON decides. `requireScope(locals, "chat")` — what this route
 * used to gate on — passes for any `chat`-scoped API key, which made a leaked
 * key a consent-minting key and left the approval mechanism decorative
 * against exactly the threat it exists for. The SDK already documents the
 * rule this now enforces: "Answering is a separate, deliberate act… An
 * extension cannot answer on their behalf"
 * (`packages/@ezcorp/sdk/src/runtime/workflows.ts:196`).
 *
 * `requireSessionAuth` subsumes both old gates — no principal is 401, a
 * non-session principal is 403 — so there is nothing left for `requireScope`
 * to decide: every caller that reaches the chokepoint is a cookie session,
 * for which scope gating is a no-op by definition.
 *
 * Deliberately NOT applied to `POST /api/workflows/:name/run`: STARTING a run
 * is a capability (the `run_workflow` chat tool, the extension trigger path
 * and the CLI all legitimately do it programmatically), and it clears no
 * gate — every approval inside that run still parks and still lands here.
 */
export const POST: RequestHandler = async ({ request, params, locals }) => {
  const user = requireSessionAuth(locals);
  if (user instanceof Response) return user;

  const parsed = answerBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "choice is required");
  }

  const result = await answerApproval(
    params.id,
    parsed.data,
    // The only surface that mints a `user` actor with a real role behind
    // it, and the only one that supplies `checkScope` — which the actor
    // kind is now what makes reachable.
    { kind: "user", userId: user.id, isAdmin: user.role === "admin" },
    {
      // Fail-closed by construction: a throw inside this check is caught
      // by the chokepoint and treated as a DENY, never as an allow. The
      // approval's scope is checked at the strictest coordinates (NULL
      // project, NULL extension), matching how a workflow run's own
      // synthetic scope key resolves.
      checkScope: (scope) =>
        hasExtensionScope(
          { id: user.id, role: user.role === "admin" ? "admin" : "member" },
          { projectId: null, extensionId: null, scope },
        ),
    },
  );

  if (!result.ok) {
    return errorJson(workflowRefusalStatus(result.code), result.message);
  }
  return json({ run: result.run, consentAllUsed: result.consentAllUsed });
};
