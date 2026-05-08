import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { errorJson } from "$lib/server/http-errors";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import * as convQueries from "$server/db/queries/conversations";
import { listExtensions } from "$server/db/queries/extensions";
import type { AuthUser } from "$server/auth/types";
import type { ExtensionManifestV2, MessageToolbarItem } from "$server/extensions/types";

// ── /api/conversations/[id]/extension-toolbar — message-toolbar contributions ──
//
// Returns the union of `messageToolbar[]` items declared by every
// ENABLED installed extension. The frontend uses the response to
// render extra icons in `MessageToolbar.svelte`; clicking one POSTs
// to `/api/extensions/<extName>/events/<event>` (the same canvas-card
// event route).
//
// Why not gate on conversation_extensions wiring (like canvas-card
// flows do)? `messageToolbar` is a USER-facing UI affordance — the
// user clicks the icon directly; the LLM never sees it. Wiring
// requirements exist so the LLM gets exposed to tools and so
// composer-attachment caps line up — neither applies here. Treating
// the speaker icon like "copy"/"regenerate" (always visible when the
// extension is installed) gives the right UX. The conversation
// param is still required so callers can't fish toolbar contributions
// without an authenticated chat-scope session, and the body of the
// fetch is per-conversation cacheable.
//
// Defense-in-depth: even though the manifest validator already
// enforces "every messageToolbar.event is also in
// permissions.eventSubscriptions", we re-clamp here so a malformed
// runtime grant never lets an unsubscribed event through to the host.

interface ToolbarItemResponse {
  extName: string;
  id: string;
  icon: string;
  tooltip: string;
  appliesTo: "user" | "assistant" | "both";
  /**
   * Whether the contribution participates in the multi-select bulk
   * action bar. Forwarded from the manifest; default `"single"` (only
   * per-message hover toolbar). `"bulk"` = bulk only. `"both"` = both.
   */
  appliesToSelection: "single" | "bulk" | "both";
  event: string;
}

async function verifyConversationOwnership(id: string, user: AuthUser) {
  const conv = await convQueries.getConversation(id);
  if (!conv) return null;
  if (conv.userId !== user.id && user.role !== "admin") return null;
  return conv;
}

/**
 * Materialize each manifest's `messageToolbar[]` into the wire shape,
 * dropping any item whose event isn't in the manifest's
 * `permissions.eventSubscriptions` allowlist. The validator should
 * already guarantee this — the re-check here is the same
 * "permission grant could narrow at runtime" defense the
 * `getConversationExtensionMimes` path relies on for accepted MIMEs.
 */
function clampToolbarForManifest(manifest: ExtensionManifestV2): ToolbarItemResponse[] {
  const items = manifest.messageToolbar;
  if (!Array.isArray(items) || items.length === 0) return [];
  // Phase 51.4: `eventSubscriptions` may be the legacy string[] OR the
  // new object form `{events, includeFullPayload}`. Normalize.
  const rawEvSubs = manifest.permissions?.eventSubscriptions;
  const evList = Array.isArray(rawEvSubs)
    ? rawEvSubs
    : (rawEvSubs?.events ?? []);
  const allowed = new Set(evList);
  const out: ToolbarItemResponse[] = [];
  for (const it of items as MessageToolbarItem[]) {
    if (!allowed.has(it.event)) continue;
    out.push({
      extName: manifest.name,
      id: it.id,
      icon: it.icon,
      tooltip: it.tooltip,
      appliesTo: it.appliesTo ?? "both",
      appliesToSelection: it.appliesToSelection ?? "single",
      event: it.event,
    });
  }
  return out;
}

export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "chat");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);

  const conversationId = params.id;
  if (!conversationId) return errorJson(404, "Not found");

  const conv = await verifyConversationOwnership(conversationId, user);
  if (!conv) return errorJson(404, "Not found");

  // Pull every enabled extension's manifest and union their
  // `messageToolbar[]` contributions. The DB row's `manifest` JSONB
  // field IS the source of truth for what's installed — no need to
  // round-trip through the live ExtensionRegistry, which is also
  // populated from the same column at startup.
  const installed = await listExtensions(true);
  const items: ToolbarItemResponse[] = [];
  for (const row of installed) {
    const manifest = row.manifest as ExtensionManifestV2;
    items.push(...clampToolbarForManifest(manifest));
  }

  // Short cache window — toolbar contributions only change when an
  // extension is installed/uninstalled or its manifest is re-loaded.
  // 10 s is enough to absorb a tight-loop fetch from the frontend
  // store without masking a fresh-install in dev.
  return json({ items }, {
    headers: { "Cache-Control": "private, max-age=10" },
  });
};
