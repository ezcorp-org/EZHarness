import { json } from "@sveltejs/kit";
import { z } from "zod";
import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { isRegisteredExtensionEvent } from "$server/runtime/sse-conversation-filter";
import { getConversation } from "$server/db/queries/conversations";
import { getToolCallConversationById } from "$server/db/queries/tool-calls";

// ── /api/extensions/[name]/events/[event] — Phase A2 generic event route ──
//
// Replaces every per-extension bespoke POST route (e.g.
// `/api/ask-user/answer`) for canvas-style cards that need to
// round-trip user input back into the extension subprocess. Same
// security model as the ask-user route, generalized:
//
//   1. `requireScope(locals, "chat")` — same scope used by every
//      conversation-affecting endpoint.
//   2. `requireAuth(locals)` — pulls the session user.
//   3. URL params validated against the manifest-name regex.
//   4. The event must be declared by the extension in its manifest's
//      `permissions.eventSubscriptions`, captured at registration time
//      via `registerExtensionEvent`. Unknown events → 404.
//   5. Authorization: the active user must own the request body's
//      `conversationId`. 404 (not 403) so an attacker can't enumerate
//      which conversations exist.
//
// Wire format (matches every existing direct-carrier event — see
// `docs/extensions/examples/ask-user/index.ts:204-211` for the
// canonical reference): the bus emits a flat object with `toolCallId`
// and `conversationId` as siblings of the user-defined event data.

// Boundary validation. `conversationId` and `toolCallId` are the host-
// authoritative identity fields the extension relies on; `loose()`
// preserves any additional user-defined keys without coercion.
const eventBodySchema = z.looseObject({
  conversationId: z.string().min(1).max(64),
  toolCallId: z.string().min(1).max(64),
});

// Mirrors `manifest.name` regex. We re-validate URL params in case the
// router accepted something the regex would reject (defense-in-depth).
const PARAM_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

export const POST: RequestHandler = async ({ request, locals, params }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  // URL param shape — reject anything outside the manifest-name regex
  // before we touch the body. SvelteKit decodes `params.name` /
  // `params.event` for us; we validate post-decoding.
  const name = params.name;
  const event = params.event;
  if (!name || !PARAM_REGEX.test(name)) return errorJson(404, "Not found");
  if (!event || !PARAM_REGEX.test(event)) return errorJson(404, "Not found");

  // Manifest-clamp: the event MUST have been declared at extension
  // registration time. Cross-namespace forgery (POST to ext-A's route
  // claiming ext-B's event) is rejected here because the registry is
  // populated per-extension by the dispatcher.
  const fullEventName = `${name}:${event}`;
  if (!isRegisteredExtensionEvent(fullEventName)) {
    return errorJson(404, "Not found");
  }

  // Body. Strict at the two known fields, passthrough on the rest so
  // extensions can ship arbitrary user-defined payloads without the
  // host having to know their shape.
  const raw = await request.json().catch(() => null);
  const parsed = eventBodySchema.safeParse(raw);
  if (!parsed.success) return errorJson(400, "Invalid body");
  const { conversationId, toolCallId, ...userData } = parsed.data;

  // Authorization: the acting user must own the conversation. 404 (not
  // 403) — never leak the existence of conversations the user can't
  // see. Mirror `ask-user/answer/+server.ts:73-75`.
  const conv = await getConversation(conversationId);
  if (!conv || conv.userId !== user.id) {
    return errorJson(404, "Not found");
  }

  // Defense-in-depth: bind toolCallId to conversationId. Without this,
  // a user who owns BOTH conv-A and conv-B could POST to conv-A's
  // route with conv-B's toolCallId and trick an extension into
  // resolving the wrong card. We accept missing rows (canvas tools
  // may persist after the subprocess returns) but reject mismatches.
  // [F2 from the Phase A security review]
  const toolCall = await getToolCallConversationById(toolCallId);
  if (toolCall && toolCall.conversationId !== conversationId) {
    return errorJson(404, "Not found");
  }

  // Emit on the bus. The dispatcher fans out to subscribed extensions
  // (gated on `conversation_extensions` wiring + per-extension rate
  // limit). The SSE filter treats this event as a direct carrier
  // because `isRegisteredExtensionEvent` returned true.
  getBus().emit(fullEventName as never, {
    toolCallId,
    conversationId,
    ...userData,
  } as never);

  return json({ ok: true });
};
