import { json } from "@sveltejs/kit";
import { z } from "zod";
import { answerApproval } from "$server/runtime/workflow-answer-approval";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
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

/** Refusal code → HTTP status. The chokepoint returns typed codes rather
 *  than throwing precisely so each surface can map them to its own
 *  conventions without re-deciding what they mean. */
const STATUS: Record<string, number> = {
  "not-found": 404,
  forbidden: 403,
  "not-pending": 409,
  "lost-race": 409,
  "run-unavailable": 409,
  // The answer landed; the run did not continue. 409, not 200.
  "resume-failed": 409,
  "invalid-answer": 400,
};

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const parsed = answerBodySchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "choice is required");
  }

  const result = await answerApproval(
    params.id,
    parsed.data,
    { userId: user.id },
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
    return errorJson(STATUS[result.code] ?? 400, result.message);
  }
  return json({ run: result.run, consentAllUsed: result.consentAllUsed });
};
