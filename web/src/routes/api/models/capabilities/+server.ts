import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getCapabilitiesWithExtensions } from "$server/providers/model-capabilities";
import {
  getConversationExtensionMimes,
  getExtensionMimesByNames,
} from "$server/db/queries/conversation-extensions";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { getSetting } from "$server/db/queries/settings";
import {
  DEFAULT_TIER_LADDER,
  TIER_LADDER_SETTING_KEY,
  ladderCandidates,
  parseTierLadder,
} from "$server/runtime/routing/tier-ladder";
import { intersectCapabilities } from "$server/runtime/routing/auto-capabilities";
import { VALID_TIERS } from "$server/runtime/tier-classifier";
import { AUTO_MODEL, AUTO_PROVIDER } from "$lib/model-selector-logic";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const provider = url.searchParams.get("provider");
  const model = url.searchParams.get("model");
  const conversationId = url.searchParams.get("conversationId");
  // Comma-separated list of extension names the user has *drafted* via
  // `!ext:NAME` mentions but not yet sent. Lets the picker accept files
  // for not-yet-wired extensions so dragging an .xlsx into a fresh chat
  // mentioning `!ext:excel` works on the first message instead of after
  // a round-trip. Static names only — registry-resolved server-side.
  const pendingExtensionsRaw = url.searchParams.get("extensions");
  if (!provider || !model) {
    return errorJson(400, "provider and model query params are required");
  }
  const pendingNames = pendingExtensionsRaw
    ? pendingExtensionsRaw.split(",").map((s) => s.trim()).filter(Boolean)
    : [];
  // When a conversationId is supplied, union in MIMEs from extensions
  // wired to that conversation. Without one, the picker sees the static
  // per-model allowlist (correct for new chats / preview paths).
  const mimeSet = new Set<string>();
  if (conversationId) {
    try {
      for (const m of await getConversationExtensionMimes(conversationId)) mimeSet.add(m);
    } catch { /* non-fatal — fall back to static caps */ }
  }
  if (pendingNames.length > 0) {
    try {
      for (const m of getExtensionMimesByNames(pendingNames)) mimeSet.add(m);
    } catch { /* non-fatal */ }
  }
  // "Auto (smart routing)" has no concrete model yet, so answer with what
  // EVERY rung of the configured ladder accepts (see auto-capabilities.ts for
  // why an intersection and not a guess). An unconfigured/empty ladder yields
  // no candidates — we 404 rather than invent limits, and the composer keeps
  // its text-only fallback.
  if (provider === AUTO_PROVIDER && model === AUTO_MODEL) {
    const ladder = parseTierLadder(await getSetting(TIER_LADDER_SETTING_KEY)) ?? DEFAULT_TIER_LADDER;
    const seen = new Set<string>();
    const candidates: ReturnType<typeof getCapabilitiesWithExtensions>[] = [];
    for (const tier of VALID_TIERS) {
      for (const rung of ladderCandidates(ladder, tier)) {
        const key = `${rung.provider}::${rung.model}`;
        if (seen.has(key)) continue;
        seen.add(key);
        candidates.push(getCapabilitiesWithExtensions(rung.provider, rung.model, [...mimeSet]));
      }
    }
    const merged = intersectCapabilities(candidates);
    if (!merged) return errorJson(404, "no routable models configured for auto selection");
    return json({ provider, model, ...merged });
  }

  const caps = getCapabilitiesWithExtensions(provider, model, [...mimeSet]);
  // Avoid leaking the internal delivery-strategy enum to clients; the UI only
  // needs to know what's accepted and the limits.
  return json({
    provider,
    model,
    kinds: caps.kinds,
    acceptedMimeTypes: caps.acceptedMimeTypes,
    maxBytesPerFile: caps.maxBytesPerFile,
    maxFilesPerMessage: caps.maxFilesPerMessage,
  });
};
