import { json } from "@sveltejs/kit";
import { getExtension, updateExtension } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { requireAuth, requireRole } from "$server/auth/middleware";
import { requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import { isBundledExtensionName } from "$server/extensions/bundled";
import { getCeiling } from "$server/extensions/bundled-ceiling";
import { upsertSetting } from "$server/db/queries/settings";
import {
  alwaysAllowSettingKey,
  buildAlwaysAllowValue,
  type AlwaysAllowScope,
} from "$server/extensions/permissions";
import { parseTtlOverrideMs } from "$server/extensions/ttl-validate";
import { mapAlwaysAllowCapabilityToExpiryKind } from "$server/extensions/perm-expiry-sweep";
import type { ExtensionPermissions } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

/**
 * Phase 56: scopes accepted on the reapprove endpoint. The picker widens
 * the vocabulary beyond the pre-Phase-56 `"forever" | undefined` shape;
 * defense-in-depth on `"forever"` (admin-only) is enforced separately
 * below. `undefined` remains a valid scope (legacy callers, banner-row
 * click with no explicit scope picker).
 */
const VALID_REAPPROVE_SCOPES = new Set<AlwaysAllowScope>([
  "session",
  "conversation",
  "project",
  "forever",
]);

/**
 * POST /api/extensions/[id]/reapprove
 *
 * Phase 4 (capability-expiry) — settings-page banner re-approve action.
 *
 * Body: { capability: string, scope?: "forever" }
 *
 * Effect: re-grants the manifest's declared permission for the supplied
 * capability family AND resets `grantedPermissions.grantedAt[<key>]` to
 * now. This silences the corresponding banner row and lets the
 * extension's tool calls go through again until the next TTL window.
 *
 * Auth model:
 *   • `scope: "forever"` is admin-only. The settings-page banner
 *     surfaces the same admin gate as the in-chat modal — the modal's
 *     "Approve forever (admin only)" button posts here with the scope
 *     field set, and the server cross-checks the role.
 *   • Default re-approve (no scope) accepts any authenticated user.
 *     This cannot grant MORE than the manifest declares — the new
 *     value is read directly from the install-time manifest, so a
 *     non-admin re-approve is bounded by what the extension's author
 *     declared and the install-time admin already approved.
 *
 * 404 on unknown extension; 400 on unmappable capability (defensive —
 * the banner only surfaces capabilities written by the sweep, which
 * uses the same map both directions).
 */

/**
 * Reverse `mapGrantKeyToExpiryKind` from
 * `src/extensions/perm-expiry-sweep.ts`. The forward map collapses
 * `"filesystem"` → `"filesystem-write"` (conservative tier choice for
 * the sweep). When re-granting, we map back to the grant-record key
 * the manifest declares — both filesystem-read and filesystem-write
 * collapse to the same `filesystem` slot on `ExtensionPermissions`.
 */
function expiryKindToGrantKey(capability: string): string | null {
  switch (capability) {
    case "filesystem-read":
    case "filesystem-write":
      return "filesystem";
    case "network":
      return "network";
    case "shell":
      return "shell";
    case "env":
      return "env";
    case "storage":
      return "storage";
    case "taskEvents":
      return "taskEvents";
    case "appendMessages":
      return "appendMessages";
    case "llm":
      return "llm";
    case "memory":
      return "memory";
    case "lessons":
      return "lessons";
    case "schedule":
      return "schedule";
    default:
      return null;
  }
}

export const POST: RequestHandler = async ({ request, params, locals }) => {
  const scopeErr = requireScope(locals, "extensions");
  if (scopeErr) return scopeErr;
  // Auth model: requireAuth (not requireRole(admin)). Reapprove is user
  // self-service recovery from the system-driven expiry sweep — the user
  // reasserts consent for a capability they already approved at install
  // time. The manifest ceiling (line 116-132) bounds the re-grant to what
  // the extension's author declared; a non-admin cannot escalate beyond
  // install-time scope. The peer PUT /api/extensions/[id]/permissions uses
  // requireRole(admin) because that endpoint is admin policy override
  // (arbitrary grant/revoke), a distinct operation. scope="forever" is
  // separately admin-gated below as defense in depth.
  const user = requireAuth(locals);

  let body: { capability?: unknown; scope?: unknown; ttlOverrideMs?: unknown };
  try {
    body = await request.json();
  } catch {
    return errorJson(400, "Invalid JSON body");
  }
  const capability = typeof body.capability === "string" ? body.capability : "";
  const scope = body.scope;

  if (!capability) return errorJson(400, "capability (string) is required");

  // Phase 56 — scope vocabulary widened beyond pre-Phase-56's
  // `"forever" | undefined`. The picker can land on any of session /
  // conversation / project / forever (or omit scope entirely for the
  // legacy banner-click path). `"forever"` is still admin-gated below;
  // the picker's `Never` selection (ttlOverrideMs: null) on a non-
  // forever scope is allowed for any authenticated user — see
  // CONTEXT.md §"Never availability".
  if (
    scope !== undefined &&
    !VALID_REAPPROVE_SCOPES.has(scope as AlwaysAllowScope)
  ) {
    return errorJson(
      400,
      `scope must be one of: ${[...VALID_REAPPROVE_SCOPES].join(", ")} (or unset)`,
    );
  }

  // Phase 56 — validate ttlOverrideMs via the shared parser. Pitfall 2:
  // null is the SOLE Never sentinel; 0 / negative / NaN / Infinity all
  // return 400 (a `0`-ms TTL would expire the grant the moment it
  // lands on disk — that's a footgun, not a feature).
  const parsed = parseTtlOverrideMs(body.ttlOverrideMs);
  if (!parsed.ok) {
    return errorJson(400, parsed.error);
  }
  const ttlOverrideMs = parsed.value;

  // Defense in depth: the modal's "Approve forever (admin only)" button
  // is gated client-side via the `isAdmin` prop. A tampered DOM could
  // still post this scope from a non-admin session, so reject server-
  // side. The chat-side gate at `/api/tool-calls/:id/permission`
  // applies the same check. Picker `Never` (ttlOverrideMs: null) does
  // NOT escalate scope — only `scope: "forever"` is admin-gated.
  if (scope === "forever") {
    requireRole(locals, "admin");
  }

  const ext = await getExtension(params.id);
  if (!ext) return errorJson(404, "Not found");

  const grantKey = expiryKindToGrantKey(capability);
  if (!grantKey) return errorJson(400, `Unknown capability: ${capability}`);

  // v1.3 security review HIGH 2 — reapprove must clamp.
  //
  // Pre-fix: this handler wrote `manifest.permissions[grantKey]` verbatim,
  // which (a) bypassed `BUNDLED_CEILING` for bundled extensions whose
  // manifest declares wider perms than the hardcoded ceiling, and (b)
  // silently restored a user's install-time NARROWED choice to the full
  // manifest declaration.
  //
  // Post-fix:
  //   1. The clamp source is `installedPermissions` if present (the
  //      user's install-time NARROWED choice, captured by the activate
  //      handler + bundled install path).
  //   2. Legacy rows installed before the new column existed have
  //      `installedPermissions = NULL`; fall back to clamping against
  //      `manifest.permissions` (the pre-fix behavior — a non-admin
  //      cannot elevate beyond the manifest ceiling).
  //   3. For bundled extensions, ALSO clamp against `getCeiling(name)`
  //      so even legacy rows pick up the bundled-ceiling guarantee.
  //      `clampExtensionPermissions` is the single permissions clamper;
  //      we run it twice (once against the install ceiling, once against
  //      the bundled ceiling) so the result is the intersection of both.
  const installedPerms = (ext.installedPermissions ?? null) as ExtensionPermissions | null;
  const ceilingTarget = (installedPerms ?? ext.manifest?.permissions ?? {}) as ExtensionPermissions;

  // First-stage clamp: against `installedPermissions` (or manifest fallback).
  // The second arg is the manifest, which `clampExtensionPermissions`
  // requires as its absolute ceiling. We pass `ceilingTarget` as the
  // "submitted" set so anything wider than the install-time choice
  // is dropped.
  let clamped = clampExtensionPermissions(
    ceilingTarget,
    (ext.manifest?.permissions ?? {}) as ExtensionPermissions,
    {
      acceptsCallerCaps: ext.manifest?.acceptsCallerCaps,
      escalateChildCaps: ext.manifest?.escalateChildCaps,
    },
  );

  // Second-stage clamp: bundled extensions are additionally clamped
  // against the hardcoded ceiling. This applies even when
  // `installedPermissions` is NULL (legacy bundled rows), so the
  // `BUNDLED_CEILING` invariant survives a sweep + reapprove cycle.
  if (isBundledExtensionName(ext.name)) {
    const bundledCeiling = getCeiling(ext.name);
    if (bundledCeiling) {
      clamped = clampExtensionPermissions(
        clamped,
        bundledCeiling,
        {
          acceptsCallerCaps: ext.manifest?.acceptsCallerCaps,
          escalateChildCaps: ext.manifest?.escalateChildCaps,
        },
      );
    }
  }

  const clampedValue = (clamped as unknown as Record<string, unknown>)[grantKey];

  // Build the next granted permissions snapshot. We start from the
  // current value, restore the matching slot from the CLAMPED ceiling
  // (post-fix), and bump `grantedAt[grantKey]` to now.
  const prior = (ext.grantedPermissions ?? null) as ExtensionPermissions | null;
  const priorGrantedAt = prior?.grantedAt ?? {};
  const nextGrantedAt: Record<string, number> = { ...priorGrantedAt, [grantKey]: Date.now() };

  // The mutator merges the prior snapshot, applies the clamped value
  // to the affected slot, and overwrites grantedAt. We allow `any`
  // here because `ExtensionPermissions` has heterogeneous field types
  // and TS can't narrow on a runtime `grantKey` string.
  const next: any = { ...(prior ?? {}), grantedAt: nextGrantedAt };
  if (clampedValue !== undefined) {
    next[grantKey] = clampedValue;
  } else {
    // The capability isn't present in the clamped ceiling — drop the
    // slot from the snapshot rather than leave a stale wider value.
    delete next[grantKey];
  }

  const updated = await updateExtension(params.id, {
    grantedPermissions: next as ExtensionPermissions,
  });
  await ExtensionRegistry.getInstance().reload();

  // Phase 56 — persist the picker's `ttlOverrideMs` (and the derived
  // `expiresAt`) onto an always-allow row so the sweep evaluator can
  // honor the per-row override on the next pass. `expiresAt` is
  // materialized here (rather than recomputed from grantedAt at sweep
  // time) so admin UI / audit consumers see the absolute timestamp
  // directly. Three branches:
  //   • ttlOverrideMs === null    → expiresAt = null (Never sentinel;
  //                                   sweep skips the row entirely).
  //   • ttlOverrideMs === number  → expiresAt = now + ttl (positive
  //                                   override; wins over TTL_CONFIG).
  //   • ttlOverrideMs === undefined → expiresAt = undefined (legacy
  //                                   path; sweep falls back to
  //                                   TTL_CONFIG[kind] / foreverTtlMs).
  const now = Date.now();
  const expiresAt =
    ttlOverrideMs === null
      ? null
      : ttlOverrideMs !== undefined
        ? now + ttlOverrideMs
        : undefined;
  // Pass the options object regardless of branch — buildAlwaysAllowValue
  // treats `undefined` fields as ABSENT (byte-identical to the legacy
  // 2-arg call) and writes positive/null values when present (Plan 56-01
  // contract: empty options ≠ explicit null).
  const recordValue = buildAlwaysAllowValue(true, now, {
    ttlOverrideMs,
    expiresAt,
  });
  // Settings-side reapprove always lands as a per-user, per-scope row.
  // When the body omits scope (legacy banner-click), use "forever" as
  // the default scope key — this matches the existing reapprove
  // semantics ("the user reasserts the install-time grant" — not
  // tied to a specific conversation/session/project). When the picker
  // lands on Never (ttlOverrideMs: null), the same row gets written
  // with the null sentinel and the sweep skips it forever.
  const effectiveScope: AlwaysAllowScope =
    (scope as AlwaysAllowScope | undefined) ?? "forever";
  const scopeId = "*"; // settings-side reapprove is scope-broad
  const alwaysAllowKey = alwaysAllowSettingKey({
    extensionId: params.id,
    userId: user.id,
    scope: effectiveScope,
    scopeId,
    capability,
  });
  try {
    await upsertSetting(alwaysAllowKey, recordValue);
  } catch {
    /* swallow — failure to persist the override is recoverable; the
       reapprove still updates `grantedPermissions.grantedAt` above. */
  }

  // Phase 56: sticky last-pick (Never-suppression — Pitfall 3) ─────
  //
  // After the always-allow row write, persist the user's per-kind
  // picker selection so the next mount of the modal for the same
  // capability defaults to this TTL. The key shape
  // (`user:<id>:reapprove:lastTtl:<kind>`) is shared with the chat-
  // side handler at `src/routes/tool-permission.ts` — one KV
  // namespace, two surfaces.
  //
  // Never-suppression: when the picker is `Never` (ttlOverrideMs ===
  // null) OR omitted (undefined, legacy caller), SKIP the write. This
  // preserves the user's previous sticky value — picking Never is an
  // explicit escape hatch, not a habit signal. CONTEXT.md locked
  // decision; Pitfall 3.
  if (ttlOverrideMs !== null && ttlOverrideMs !== undefined) {
    // Settings-side `capability` is already a CapabilityExpiryKind
    // (validated by `expiryKindToGrantKey` above — unknown strings
    // already rejected with 400). The helper handles the always-allow
    // token namespace ("shell" / "fs.write") which overlaps with
    // CapabilityExpiryKind on the lowest-common-denominator values
    // (e.g. "shell"). When the helper returns null (token doesn't
    // belong to that namespace), fall through to the literal
    // capability string — both surfaces of the sticky KV namespace
    // converge on the same key shape for shared kinds.
    const expiryKind = mapAlwaysAllowCapabilityToExpiryKind(capability) ?? capability;
    try {
      await upsertSetting(
        `user:${user.id}:reapprove:lastTtl:${expiryKind}`,
        ttlOverrideMs,
      );
    } catch {
      /* swallow — failure to record sticky is recoverable; the
         re-grant still landed above. */
    }
  }

  // Audit row — re-approval is a deliberate consent event so it goes
  // into the audit trail. Phase 54 SEC-04: use the dedicated
  // `PERMISSION_REAPPROVED` action so SOC 2 / SIEM dashboards can
  // filter the operationally-distinct consent event without parsing
  // the free-form `metadata.reason` field. The legacy reason string
  // is retained transitionally for any downstream filter that hasn't
  // migrated; drop in a follow-up PR after the migration window closes.
  //
  // Phase 56: also records `requestedTtl` + `appliedTtl` (the picker's
  // selection AND what the server persisted). Both default to `null`
  // for legacy callers that omit `ttlOverrideMs` — null in the audit
  // row is queryable; investigators distinguish "user picked Never"
  // from "user provided no override" via the surrounding context (the
  // legacy callers don't hit this code path post-Phase-56).
  try {
    await insertAuditEntry(user.id, EXT_AUDIT_ACTIONS.PERMISSION_REAPPROVED, params.id, {
      permission: grantKey,
      oldValue: prior?.[grantKey as keyof ExtensionPermissions],
      newValue: clampedValue,
      actor: user.id,
      reason: scope === "forever" ? "user-reapprove (admin: forever)" : "user-reapprove",
      capability,
      requestedTtl: ttlOverrideMs ?? null,
      appliedTtl: ttlOverrideMs ?? null,
    });
  } catch {
    /* swallow — audit-write failure already routed through persistError */
  }

  return json({ reapproved: true, capability, grantKey, extension: updated });
};
