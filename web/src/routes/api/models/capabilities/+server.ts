import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { getCapabilities } from "$server/providers/model-capabilities";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";

export const GET: RequestHandler = async ({ url, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const provider = url.searchParams.get("provider");
  const model = url.searchParams.get("model");
  if (!provider || !model) {
    return json({ error: "provider and model query params are required" }, { status: 400 });
  }
  const caps = getCapabilities(provider, model);
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
