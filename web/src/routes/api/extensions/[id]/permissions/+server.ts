import { json } from "@sveltejs/kit";
import { getExtension, updateExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS, type ExtensionAuditMetadata } from "$server/extensions/audit-actions";
import { capabilityToolsDisabled, CAPABILITY_PERMISSION_FIELDS } from "$server/extensions/capability-flags";
import { DIRECT_CARRIER_EVENT_TYPES } from "$server/runtime/sse-conversation-filter";
import type { ExtensionPermissions, ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

// sec-C4: clamp a caller-submitted permission set to the intersection of what
// the extension's manifest actually requested. Anything beyond the manifest
// is dropped silently — an admin cannot elevate an extension past what its
// author declared. Anything less is allowed (admin can grant a subset).
function clampToManifest(
  submitted: Partial<ExtensionPermissions>,
  manifest: ExtensionManifestV2["permissions"],
): ExtensionPermissions {
  const clamped: ExtensionPermissions = { grantedAt: {} };

  if (submitted.network && manifest.network) {
    const allowed = submitted.network.filter((d) => manifest.network!.includes(d));
    if (allowed.length > 0) clamped.network = allowed;
  }

  if (submitted.filesystem && manifest.filesystem) {
    const allowed = submitted.filesystem.filter((p) => manifest.filesystem!.includes(p));
    if (allowed.length > 0) clamped.filesystem = allowed;
  }

  if (submitted.shell === true && manifest.shell === true) {
    clamped.shell = true;
  }

  if (submitted.env && manifest.env) {
    const allowed = submitted.env.filter((v) => manifest.env!.includes(v));
    if (allowed.length > 0) clamped.env = allowed;
  }

  if (submitted.storage === true && manifest.storage === true) {
    clamped.storage = true;
  }

  // ── Capability tier (Phase 2+): taskEvents / spawnAgents / agentConfig ──
  // Each field is clamped against the manifest declaration AND against the
  // kill-switch env var. If EZCORP_DISABLE_CAPABILITY_TOOLS=1 is set, the
  // fields behave as if the manifest never declared them — operators can
  // disable the entire tier without touching schema or code.
  if (!capabilityToolsDisabled()) {
    if (submitted.taskEvents === true && manifest.taskEvents === true) {
      clamped.taskEvents = true;
    }
    if (submitted.spawnAgents && manifest.spawnAgents) {
      // spawnAgents is a structured permission — both maxPerHour and
      // maxConcurrent must be present at grant time. The grant cannot
      // exceed the manifest's declared caps; clamp numerically.
      const submittedMax = submitted.spawnAgents;
      const manifestMax = manifest.spawnAgents;
      const hourly = Math.min(submittedMax.maxPerHour, manifestMax.maxPerHour);
      const concurrent = Math.min(
        submittedMax.maxConcurrent ?? manifestMax.maxConcurrent ?? 3,
        manifestMax.maxConcurrent ?? 3,
      );
      if (hourly > 0 && concurrent > 0) {
        clamped.spawnAgents = { maxPerHour: hourly, maxConcurrent: concurrent };
      }
    }
    if (submitted.agentConfig === "read" && manifest.agentConfig === "read") {
      clamped.agentConfig = "read";
    }
    // eventSubscriptions (Phase 2c): clamp to the triple-intersection
    // of submitted ∩ manifest-declared ∩ direct-carrier allowlist. An
    // event name that survives is guaranteed routable by the dispatcher
    // at runtime; unknown names fail closed (no grant) rather than
    // landing in a grant that can never be honored.
    if (Array.isArray(submitted.eventSubscriptions) && Array.isArray(manifest.eventSubscriptions)) {
      const manifestSet = new Set(manifest.eventSubscriptions);
      const allowed = submitted.eventSubscriptions.filter(
        (e) => typeof e === "string"
          && manifestSet.has(e)
          && DIRECT_CARRIER_EVENT_TYPES.has(e as never),
      );
      if (allowed.length > 0) clamped.eventSubscriptions = allowed;
    }
  }

  // Preserve any prior grantedAt timestamps the caller passed for permissions
  // that survived clamping; stamp new ones below in the handler.
  if (submitted.grantedAt && typeof submitted.grantedAt === "object") {
    for (const [k, v] of Object.entries(submitted.grantedAt)) {
      if (typeof v === "number") clamped.grantedAt[k] = v;
    }
  }

  return clamped;
}

/** Returns true for the capability-tier permission fields so the audit
 *  loop can route them through CAPABILITY_GRANTED/CAPABILITY_REVOKED
 *  actions instead of the regular PERMISSION_* ones. */
function isCapabilityField(name: string): boolean {
  return (CAPABILITY_PERMISSION_FIELDS as readonly string[]).includes(name);
}

export const GET: RequestHandler = async ({ params, locals }) => {
  requireAuth(locals);
  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });
  return json(ext.grantedPermissions);
};

export const PUT: RequestHandler = async ({ request, params, locals }) => {
  // sec-C4: admin role required. Pre-fix this route was only gated by
  // requireScope(locals, "extensions") which is a no-op for cookie auth, so
  // any authenticated member could PUT {shell: true, filesystem: ["/"]} and
  // then invoke the extension's tools — an RCE primitive via /api/tool-invoke.
  const admin = requireRole(locals, "admin");

  const ext = await getExtension(params.id);
  if (!ext) return json({ error: "Not found" }, { status: 404 });

  const { permissions } = await request.json();
  if (!permissions || typeof permissions !== "object") {
    return json({ error: "permissions required" }, { status: 400 });
  }

  // sec-C4: clamp to manifest — admin cannot grant more than the extension
  // author declared. Anything beyond manifest.permissions is dropped silently.
  const manifestPerms = ext.manifest?.permissions ?? {};
  const clamped = clampToManifest(permissions as Partial<ExtensionPermissions>, manifestPerms);

  const updated = await updateExtension(params.id, { grantedPermissions: clamped });
  await ExtensionRegistry.getInstance().reload();

  // Best-effort audit log. Dual-write: the legacy blob-level row is
  // preserved for backward compatibility, and we also write typed
  // per-permission rows so `listAuditForExtension()` surfaces both the
  // changes that landed and the ones that were rejected by `clampToManifest`.
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
        // The admin tried to grant something that `clampToManifest`
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
