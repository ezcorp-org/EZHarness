/**
 * Per-conversation extension wiring — first-class, scope-gated control for
 * external harnesses (and any bearer client) to attach installed extensions
 * to a conversation and read back the wired set.
 *
 * Before this route the only user-facing wiring paths were the `![ext:name]`
 * chat mention and bundled auto-wire; a harness had no typed way to wire an
 * extension before invoking its tools via `POST /api/tool-invoke`.
 *
 * Gate order mirrors the sibling messages route: scope → auth → ownership.
 * Ownership resolves against the ROOT of the parentConversationId chain, and a
 * non-owner or missing conversation both collapse to 404 (no existence leak).
 */
import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { resolveRootConversationForOwnership } from "$lib/server/conversation-ownership";
import { getExtension, getExtensionsByNames } from "$server/db/queries/extensions";
import {
  addConversationExtensions,
  getConversationExtensionIds,
} from "$server/db/queries/conversation-extensions";
import { errorJson } from "$lib/server/http-errors";
import { validationError } from "$lib/server/security/validation";
import type { RequestHandler } from "./$types";

// Boundary validation. `names` is the set of extension manifest names to wire.
// Strict mode rejects unknown top-level keys; 1..20 non-empty strings bounds
// the batch so a single request can't wire an unbounded set.
const wireBodySchema = z
  .object({
    names: z.array(z.string().min(1)).min(1).max(20),
  })
  .strict();

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  // Root-walk ownership: non-owner and nonexistent both → 404 (fail-closed,
  // no existence leak). Identical posture to the messages route.
  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");

  let raw: unknown;
  try {
    raw = await request.json();
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  const parsed = wireBodySchema.safeParse(raw);
  if (!parsed.success) return validationError(parsed.error);

  // Resolve every name against the extensions table up front. Unknown names
  // are all-or-nothing: if ANY name is unresolved we wire NOTHING and 404 with
  // the offending set, so a partial batch can never leave a half-wired state.
  const names = [...new Set(parsed.data.names)];
  const found = await getExtensionsByNames(names);
  const unknown = names.filter((n) => !found.has(n));
  if (unknown.length > 0) {
    return json({ error: "Unknown extension(s)", unknown }, { status: 404 });
  }

  const extensionIds = names.map((n) => found.get(n)!.id);
  // Idempotent: addConversationExtensions inserts ON CONFLICT DO NOTHING, so
  // re-wiring an already-wired extension is a no-op success.
  await addConversationExtensions(
    conversationId,
    extensionIds.map((extensionId) => ({ extensionId })),
  );
  return json({ wired: names, extensionIds });
};

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  const conversationId = params.id;

  const ownership = await resolveRootConversationForOwnership(conversationId, user);
  if (!ownership) return errorJson(404, "Not found");

  const ids = await getConversationExtensionIds(conversationId);
  const extensions: Array<{ id: string; name: string }> = [];
  for (const id of ids) {
    // A wired id whose extension row was deleted out from under it is skipped
    // rather than surfaced as a dangling entry.
    const ext = await getExtension(id);
    if (ext) extensions.push({ id: ext.id, name: ext.name });
  }
  return json({ extensions });
};
