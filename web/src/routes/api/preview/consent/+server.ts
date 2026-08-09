import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import {
  exposeDetectedPort,
  setAlwaysExpose,
  clearAlwaysExpose,
} from "$server/runtime/preview/preview-consent";

// ── POST /api/preview/consent — requester consent action ───────────────
//
// The expose-consent card ([Expose] [Ignore] [Always expose in this
// conversation]) posts here. This route is behind the normal
// ezcorp_session auth (hooks.server.ts), so the acting user IS the
// requester — attribution is by construction (we NEVER trust a userId
// from the body; the detected port is exposed for the SESSION user only).
//
// Auto-detect ≠ auto-serve: a row is created only on an explicit Expose
// (or the per-conversation always-expose preference). Nothing serves until
// the browser redeems the returned code at `/__open?c=<code>` — the
// access-token gate still applies at serve time.
//
// Actions:
//   - "expose"        → create a dynamic preview + mint a handoff code
//   - "always-expose" → set the per-conversation pref AND expose now (D3)
//   - "ignore"        → non-action; nothing is exposed
//   - "disable-always"→ turn the always-expose preference back off
//
// Body: { conversationId: string, port?: number, action: string }

type ConsentAction = "expose" | "always-expose" | "ignore" | "disable-always";

function bad(status: number, error: string): Response {
  return new Response(JSON.stringify({ error }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
  });
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const user = requireAuth(locals);

  let body: { conversationId?: unknown; port?: unknown; action?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return bad(400, "Invalid JSON body");
  }

  const conversationId = typeof body.conversationId === "string" ? body.conversationId : "";
  const action = body.action as ConsentAction;
  if (!conversationId) return bad(400, "conversationId is required");

  if (action === "ignore") {
    // Explicit non-action — acknowledge without exposing anything.
    return new Response(JSON.stringify({ ok: true, action: "ignore" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }

  if (action === "disable-always") {
    await clearAlwaysExpose(conversationId);
    return new Response(JSON.stringify({ ok: true, action: "disable-always" }), {
      status: 200,
      headers: { "Content-Type": "application/json", "Cache-Control": "private, no-store" },
    });
  }

  if (action !== "expose" && action !== "always-expose") {
    return bad(400, "Unknown action");
  }

  const port = typeof body.port === "number" ? body.port : NaN;
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return bad(400, "A valid port is required");
  }

  // "Always expose" persists the per-conversation preference (scoped to
  // this requesting user) BEFORE exposing the current port.
  if (action === "always-expose") {
    await setAlwaysExpose(conversationId, user.id);
  }

  // Single expose path — requester-scoped: the event's userId is the
  // authenticated session user, never a body value.
  const { previewId, code, subdomainLabel } = await exposeDetectedPort({
    userId: user.id,
    conversationId,
    port,
  });

  return new Response(JSON.stringify({ ok: true, action, previewId, code, subdomainLabel }), {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
    },
  });
};
