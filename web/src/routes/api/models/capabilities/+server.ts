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
