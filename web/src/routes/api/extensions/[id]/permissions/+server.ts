import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension, updateExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "$server/extensions/audit-actions";
import { CAPABILITY_PERMISSION_FIELDS } from "$server/extensions/capability-flags";
import type { ExtensionPermissions } from "$server/extensions/types";
import { errorJson } from "$lib/server/http-errors";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import type { RequestHandler } from "./$types";

// Boundary validation. PUT body has exactly one field — `permissions`,
// an object that's then handed to clampExtensionPermissions. The existing 400
// path ("permissions required") fires for missing OR non-object values,
// so the schema accepts `unknown` and the post-parse runtime check
// preserves both error message and behaviour exactly.
const permissionsPutSchema = z.object({
  permissions: z.unknown(),
}).passthrough();

/** Returns true for the capability-tier permission fields so the audit
 *  loop can route them through CAPABILITY_GRANTED/CAPABILITY_REVOKED
 *  actions instead of the regular PERMISSION_* ones. */
function isCapabilityField(name: string): boolean {
  return (CAPABILITY_PERMISSION_FIELDS as readonly string[]).includes(name);
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");
  return json(ext.grantedPermissions);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  // sec-C4: admin role required. Pre-fix this route was only gated by
  // requireScope(locals, "extensions") which is a no-op for cookie auth, so
  // any authenticated member could PUT {shell: true, filesystem: ["/"]} and
  // then invoke the extension's tools — an RCE primitive via /api/tool-invoke.
  const admin = requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const parsed = permissionsPutSchema.safeParse(await request.json().catch(() => ({})));
  if (!parsed.success) {
    return errorJson(400, "permissions required");
  }
  const { permissions } = parsed.data;
  if (!permissions || typeof permissions !== "object" || Array.isArray(permissions)) {
    return errorJson(400, "permissions required");
  }

  // sec-C4: clamp to manifest — admin cannot grant more than the extension
  // author declared. Anything beyond manifest.permissions is dropped silently.
  // Phase 4: also pass the manifest's top-level deputy/escalation flags so
  // the clamp can gate the matching ExtensionPermissions overlay fields.
  const manifestPerms = ext.manifest?.permissions ?? {};
  const clamped = clampExtensionPermissions(
    permissions as Partial<ExtensionPermissions>,
    manifestPerms,
    {
      acceptsCallerCaps: ext.manifest?.acceptsCallerCaps,
      escalateChildCaps: ext.manifest?.escalateChildCaps,
    },
  );

  const updated = await updateExtension(params.id, { grantedPermissions: clamped });
  await ExtensionRegistry.getInstance().reload();

  // Best-effort audit log. Dual-write: the legacy blob-level row is
  // preserved for backward compatibility, and we also write typed
  // per-permission rows so `listAuditForExtension()` surfaces both the
  // changes that landed and the ones that were rejected by `clampExtensionPermissions`.
  const priorGrant = ext.grantedPermissions as ExtensionPermissions | null;
  try {
    await insertAuditEntry(admin.id, "extension:permissions_granted", params.id, {
      submitted: permissions,
      granted: clamped,
    });
    const fields = [
      "network", "filesystem", "shell", "env", "storage",
      // Capability tier — audited under CAPABILITY_* actions so the detail
      // page can surface them with elevated (red) badges.
      "taskEvents", "spawnAgents", "agentConfig", "eventSubscriptions",
    ] as const;
    const submitted = permissions as Record<string, unknown>;
    for (const f of fields) {
      const oldValue = (priorGrant as unknown as Record<string, unknown> | null)?.[f];
      const newValue = (clamped as unknown as Record<string, unknown>)[f];
      const submittedValue = submitted[f];
      if (JSON.stringify(oldValue) !== JSON.stringify(newValue)) {
        // A permission flipped — grant or revoke. Capability-tier fields
        // flow through CAPABILITY_* actions; legacy fields through PERMISSION_*.
        const isGranting = !(
          newValue === undefined ||
          newValue === false ||
          (Array.isArray(newValue) && newValue.length === 0)
        );
        const action = isCapabilityField(f)
          ? (isGranting ? EXT_AUDIT_ACTIONS.CAPABILITY_GRANTED : EXT_AUDIT_ACTIONS.CAPABILITY_REVOKED)
          : (isGranting ? EXT_AUDIT_ACTIONS.PERMISSION_GRANTED : EXT_AUDIT_ACTIONS.PERMISSION_REVOKED);
        const meta: ExtensionAuditMetadata = {
          permission: f,
          oldValue,
          newValue,
          actor: admin.id,
          reason: `admin-${isGranting ? "grant" : "revoke"}${isCapabilityField(f) ? " (capability-tier)" : ""}`,
        };
        await insertAuditEntry(admin.id, action, params.id, meta);
      } else if (submittedValue !== undefined && JSON.stringify(submittedValue) !== JSON.stringify(newValue)) {
        // The admin tried to grant something that `clampExtensionPermissions`
        // dropped (field not declared in manifest, or beyond its scope).
        // Log the attempt so we have visibility into thwarted elevations.
        const meta: ExtensionAuditMetadata = {
          permission: f,
          oldValue: newValue,
          newValue: submittedValue,
          actor: admin.id,
          reason: "rejected-by-clamp: attempt exceeded manifest declaration",
        };
        await insertAuditEntry(admin.id, EXT_AUDIT_ACTIONS.PERMISSION_REJECTED, params.id, meta);
      }
    }
  } catch { /* swallow */ }

  return json(updated);
};
