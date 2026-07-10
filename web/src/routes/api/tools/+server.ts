import { json } from "@sveltejs/kit";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { ensureInitialized } from "$lib/server/context";
import { resolveScopedTools } from "$lib/server/scoped-tools";
import type { RequestHandler } from "./$types";

export const GET: RequestHandler = async ({ locals, url }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  const user = requireAuth(locals);
  await ensureInitialized();

  // `?modeId=` and/or `?conversationId=` scope the listing to the tools
  // the runtime would actually grant for that mode + conversation — the
  // header badge can never show tools the mode doesn't allow (or hide
  // ones it does). Scope semantics live in resolveScopedTools (shared
  // with /api/composer/suggest).
  const result = await resolveScopedTools(user, {
    conversationId: url.searchParams.get("conversationId"),
    modeId: url.searchParams.get("modeId"),
    hasModeParam: url.searchParams.has("modeId"),
  });
  if (!result) return json({ error: "Not found" }, { status: 404 });

  const { tools, orchestrationTools } = result;
  return json({ tools, count: tools.length, orchestrationTools });
};
