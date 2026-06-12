import { json } from "@sveltejs/kit";
import { getExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { isBundledExtensionName } from "$server/extensions/bundled";
import { reapproveBundledDrift } from "$server/extensions/bundled-drift-reapprove";
import type { RequestHandler } from "./$types";

/**
 * POST /api/extensions/[id]/reapprove-drift
 *
 * Admin-only heal for the S6/S9 boot gate's fail-closed disable: a
 * NON-critical bundled extension whose manifest permissions
 * legitimately changed in a release is disabled "pending re-approval"
 * at boot, and the two pre-existing mutation surfaces both dead-end on
 * the STALE stored manifest:
 *
 *   - `POST .../reapprove` re-grants from the stored manifest (its
 *     TTL-expiry contract — unchanged), and
 *   - `PUT .../permissions` clamps to that same stored manifest.
 *
 * This endpoint re-grants from the CURRENT ON-DISK bundled manifest,
 * clamped to the bundled ceiling (the hard security bound), refreshes
 * the stored manifest + version, re-enables the row, and reloads the
 * registry so the tools go live immediately. Idempotent — calling it
 * with no drift simply refreshes/re-enables; it can never widen beyond
 * the ceiling. The `manifest.lock.json` gate still applies: a disk
 * manifest failing the lockfile check is refused with 409 (this
 * endpoint heals grant drift, not tampering).
 *
 * Auth model: `requireRole(admin)` — re-approving a permission
 * WIDENING is admin policy, exactly like the peer
 * `PUT .../permissions`. (The stored-manifest `reapprove` route stays
 * requireAuth because it can only restore what was already approved.)
 *
 * Response: `{ extension: <updated row>, diffs: [{field, oldValue,
 * newValue}] }` — the diff mirrors the boot gate's UPDATE_BLOCKED
 * audit shape so the admin UI can render both identically.
 *
 * 404 unknown id; 400 non-bundled extension; 409 lockfile mismatch;
 * 500 unreadable on-disk manifest.
 */
export const POST: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  const admin = requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");
  if (!isBundledExtensionName(ext.name)) {
    return errorJson(
      400,
      "Not a bundled extension — drift re-approval only applies to bundled extensions",
    );
  }

  const result = await reapproveBundledDrift(ext, admin.id);
  if (!result.ok) {
    switch (result.code) {
      case "not-found":
        return errorJson(404, result.message);
      case "lockfile-mismatch":
        return errorJson(409, result.message);
      case "manifest-unreadable":
        return errorJson(500, result.message);
      default:
        // "not-bundled" — defensive; the isBundledExtensionName gate
        // above already rejected this, but the core re-checks against
        // the BUNDLED_EXTENSIONS table.
        return errorJson(400, result.message);
    }
  }

  // Registry reload so the refreshed manifest/tools go live without a
  // restart — same post-mutation step as the sibling permission routes.
  await ExtensionRegistry.getInstance().reload();

  return json({ extension: result.updated, diffs: result.diffs });
};
