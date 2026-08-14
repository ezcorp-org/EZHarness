import { json } from "@sveltejs/kit";
import { z } from "zod";
import { errorJson } from "$lib/server/http-errors";
import {
  getExtension,
  getExtensionByRef,
  updateExtension,
} from "$server/db/queries/extensions";
import { uninstallExtension } from "$server/extensions/installer";
import { ExtensionRegistry } from "$server/extensions/registry";
import { getPageCache } from "$server/extensions/page-cache";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import type { RequestHandler } from "./$types";

// `requireRole` throws a raw Response that SvelteKit surfaces as a 500;
// catch it so non-admins get the intended 403 (matches the /activate
// and /modifiable sibling routes). Returns the Response to short-circuit
// with, or null when the caller is an admin.
function requireAdminOr403(locals: App.Locals): Response | null {
  try {
    requireRole(locals, "admin");
    return null;
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
}

// Boundary validation. PATCH only accepts `{ enabled: false }` — the
// handler explicitly rejects `enabled: true` (that path goes through
// /activate, which does the manifest-clamped permission review). Any
// other value of `enabled` (or any other field) is a no-op that returns
// 400 "No valid update fields provided" today; passthrough preserves
// that behaviour exactly while pinning the type of `enabled` itself.
const extensionPatchSchema = z.object({
  enabled: z.boolean().optional(),
}).passthrough();

// GET resolves `[id]` as a REFERENCE (id OR manifest name) — it is the read
// the `/extensions/<ref>` detail page issues, and the one deep-link the server
// hands a user after an install is `/extensions/<manifest-name>`
// (`installAuthoredDraft`'s redirectUrl/openUrl). The page canonicalises on
// the returned `ext.id` for every subsequent call, so ONLY this read is
// reference-addressed; PATCH/DELETE below stay id-only on purpose (see
// getExtensionByRef's contract — destructive ops key on the primary key).
export const GET: RequestHandler = async ({ params, locals }) => {
  const scopeErr = requireScope(locals, "read");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  const ext = await getExtensionByRef(params.id);
  if (!ext) return errorJson(404, "Not found");
  return json(ext);
};

export const PATCH: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  // Disabling an extension is instance-wide; admin-only, like /activate.
  const adminErr = requireAdminOr403(locals);
  if (adminErr) return adminErr;
  const parsed = extensionPatchSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "No valid update fields provided");
  }
  const { enabled } = parsed.data;

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  if (typeof enabled === "boolean") {
    // Enabling via PATCH is a back-door around POST /:id/activate — it skips
    // the admin-role check and the manifest-clamped permission review. Only
    // disabling is permitted here; enabling must go through /activate.
    if (enabled === true) {
      return errorJson(400, "Use POST /:id/activate to enable an extension");
    }
    // `disabledByUser` records that this OFF is a deliberate choice, so the
    // boot reconcilers leave it alone (`ensureBundledExtensions` otherwise
    // re-enables every disabled built-in). Only `activateExtension` clears
    // it, so the flag and `enabled` can never disagree about intent.
    const updated = await updateExtension(params.id, { enabled, disabledByUser: true });
    await ExtensionRegistry.getInstance().reload();
    // Drop the extension's cached Hub page trees (60s TTL) so a
    // re-enable can't serve content rendered before the disable.
    getPageCache().invalidateExtension(params.id);
    return json(updated);
  }

  return errorJson(400, "No valid update fields provided");
};

/**
 * Uninstall — remove the row AND the files the host created for it.
 *
 * `?purgeData=1` additionally deletes the extension's own data store
 * (`.ezcorp/extension-data/<name>/`). It has no default worth guessing, so
 * the UI asks outright before it calls here: keeping the data lets a
 * reinstall resume, deleting it cannot be undone.
 *
 * Built-ins are refused with 409. The Extensions page has never shown the
 * button for them, but the API did allow it, and the delete was worse than
 * useless: `ensureBundledExtensions` reinstalls the row on the next boot
 * with default grants, so the only lasting effect was silently discarding
 * the admin's permission narrowing. Disabling is the supported off switch
 * and now survives restarts.
 */
export const DELETE: RequestHandler = async ({ params, locals, url }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  requireAuth(locals);
  // Uninstall is destructive and instance-wide; admin-only.
  const adminErr = requireAdminOr403(locals);
  if (adminErr) return adminErr;
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  if (ext.isBundled) {
    return errorJson(409, "Built-in extensions can't be uninstalled — disable it instead");
  }

  // `uninstallExtension` deletes the row, removes the install directory
  // when it is inside a host-owned install root, optionally purges the data
  // store, and reloads the registry. The reload is what retires THIS
  // extension's subprocess, MCP proxy and client — the previous
  // `registry.killAll()` here killed EVERY extension's subprocess, which
  // the comment beside it claimed it did not.
  await uninstallExtension(ext, {
    purgeData: url.searchParams.get("purgeData") === "1",
  });

  // An uninstalled extension's cached Hub page trees must not linger.
  getPageCache().invalidateExtension(params.id);

  // Audit the uninstall. Install, permission grant/revoke and (now) the three
  // MCP mutations all leave a row; the destructive end left none, which is
  // the one an investigator needs most — an uninstall cascade-deletes
  // `extension_secrets`, i.e. an MCP extension's stored transport
  // credential. Written AFTER the delete so the row never claims a
  // removal that failed. The extension id is gone from `extensions` by now,
  // but `audit_log.target` is a plain text column with no FK, so the trail
  // survives the row it describes.
  try {
    await insertAuditEntry(
      locals.user?.id ?? null,
      EXT_AUDIT_ACTIONS.EXTENSION_UNINSTALLED,
      ext.id,
      {
        extensionName: ext.name,
        oldValue: { version: ext.version, source: ext.source, isBundled: ext.isBundled },
        newValue: null,
        actor: locals.user?.id ?? "unknown",
        purgeData: url.searchParams.get("purgeData") === "1",
        reason: "uninstall",
      },
    );
  } catch { /* non-fatal — audit is observability, not a gate */ }
  // 204, unchanged: `@ezcorp/harness-client`'s `uninstallExtension` is
  // published as "resolves with no body on 204". The caller learns nothing
  // new from a result body — it chose `purgeData` itself.
  return new Response(null, { status: 204 });
};
