/**
 * GET /api/hub/pages — list the authenticated user's Hub tabs.
 *
 * Core providers (registered via `src/runtime/hub-pages.ts` at boot)
 * surface as `core:<id>`; enabled extensions declaring `manifest.pages`
 * surface as `ext:<name>:<pageId>`. v1 RBAC: any authenticated user
 * sees every tab — per-user isolation happens inside each page's
 * `render(userId)`, never at list time.
 */
import { json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { requireAuth } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { listHubPageProviders } from "$server/runtime/hub-pages";
import { listEnabledExtensionPages } from "$lib/server/hub-extension-pages";
import type { HubPageListing } from "$lib/hub";

export const GET: RequestHandler = async ({ locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);

  const core: HubPageListing[] = listHubPageProviders().map((p) => ({
    id: `core:${p.id}`,
    title: p.title,
    ...(p.icon ? { icon: p.icon } : {}),
    ...(p.description ? { description: p.description } : {}),
    kind: "core" as const,
  }));

  const ext = await listEnabledExtensionPages();

  return json({ pages: [...core, ...ext] });
};
