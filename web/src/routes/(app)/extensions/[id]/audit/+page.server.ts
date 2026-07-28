import { error } from "@sveltejs/kit";
import { mergeAuditForExtension, statsForExtension } from "$server/db/queries/audit-merge";
import { getExtensionByRef } from "$server/db/queries/extensions";
import { requireAuth, requireRole } from "$server/auth/middleware";
import type { PageServerLoad } from "./$types";

/**
 * Phase 52.2 — per-extension audit drill-down loader.
 *
 * Server-side gates:
 *   - admin only (per spec — these rows include actor identifiers
 *     and reveal grant history).
 *   - 404 on unknown extension (so an admin can't probe a list of
 *     extension ids by URL).
 *
 * Prefetches the first page + the 24h stats strip so the first paint
 * is meaningful. Filter changes use the API endpoint at
 * `/api/extensions/[id]/audit?…` to advance the cursor without a full
 * page reload.
 */
export const load: PageServerLoad = async ({ params, locals }) => {
  // requireAuth/requireRole throw a Response on failure; SvelteKit
  // surfaces it as the corresponding HTTP status.
  requireAuth(locals);
  requireRole(locals, "admin");

  // `[id]` is a REFERENCE (id OR manifest name), matching the parent detail
  // route — a user who arrives on `/extensions/<name>` and edits the URL, or
  // any future link built from the post-install deep-link, must not 404 here.
  // Resolve ONCE, then key the audit reads on the resolved `ext.id`: the
  // audit tables store the extension id, so passing the raw reference through
  // would have silently returned an empty trail for a name-addressed URL.
  const ext = await getExtensionByRef(params.id);
  if (!ext) throw error(404, "Extension not found");

  const [{ entries, nextCursor }, stats] = await Promise.all([
    mergeAuditForExtension(ext.id, { limit: 100 }),
    statsForExtension(ext.id, 24 * 60 * 60 * 1000),
  ]);

  return {
    extension: {
      id: ext.id,
      name: ext.name,
      version: ext.version,
      isBundled: ext.isBundled,
      // Surface the current grants snapshot for the right-rail
      // "cross-reference denials" sidebar.
      grantedPermissions: ext.grantedPermissions,
    },
    entries,
    nextCursor,
    stats,
  };
};
