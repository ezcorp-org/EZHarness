import { json } from "@sveltejs/kit";
import { z } from "zod";
import * as convQueries from "$server/db/queries/conversations";
import { getActiveRun } from "$server/db/queries/active-runs";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { validationError } from "$lib/server/security/validation";
import { errorJson } from "$lib/server/http-errors";
import type { RequestHandler } from "./$types";

// Single object + XOR refine (NOT z.union) — a union of two object arms would
// silently strip the second arm's field on payloads that contain both, e.g.
// `{content,excluded}` parses as `{content}` under the first arm and the
// dispatch below would misroute to the content branch. The refine rejects
// ambiguous payloads and empty payloads explicitly while keeping wire-compat
// for the two single-field shapes existing clients already send.
const patchMessageSchema = z.object({
  content: z.string().min(1, "Content is required").max(100_000).optional(),
  excluded: z.boolean().optional(),
}).refine(
  (d) => (d.content !== undefined) !== (d.excluded !== undefined),
  { message: "exactly one of `content` or `excluded` is required" },
);

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;
  const messageId = params.mid;

  // Ownership resolves against the ROOT of the parentConversationId
  // chain (sub-convs carry userId=null). Top-level convs are unchanged
  // (root === self == the legacy direct check). The active-run 409 gate
  // below STILL fires after this passes — pinned by both the Phase-0
  // baseline (top-level) and the Phase-2 sub-conv test.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");

  // Reject mutations while a run is actively streaming into this conversation
  // — the executor may be appending to a message row that's about to change
  // under its feet (content edits → mangled transcripts; excluded toggles →
  // mid-flight context swap that pi-ai already snapshotted). Tool callbacks
  // also re-read history mid-run, so a toggle accepted between the initial
  // pi-ai call and a tool-callback continuation would silently change the
  // context window the model sees on the very next step.
  const active = await getActiveRun(conversationId);
  if (active) {
    return errorJson(409, "Conversation has an active run; finish or cancel it first");
  }

  const parsed = patchMessageSchema.safeParse(await request.json());
  if (!parsed.success) return validationError(parsed.error);

  // Both fields are optional on the schema, so use `!== undefined` rather
  // than `in` — the refine above guarantees exactly one of them is set.
  const updated = parsed.data.excluded !== undefined
    ? await convQueries.setMessageExcluded(conversationId, messageId, parsed.data.excluded)
    : await convQueries.updateMessageContent(conversationId, messageId, parsed.data.content!);
  if (!updated) return errorJson(404, "Message not found in this conversation");

  return json(updated);
};
