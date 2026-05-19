// Shared "enable + grant" core for an installed extension.
//
// This is the post-validation body that used to live inline in
// `web/src/routes/api/extensions/[id]/activate/+server.ts`. It was
// extracted so the Library/marketplace install route can reuse the
// exact same enable+grant+audit sequence for the
// `AUTO_ENABLE_ON_INSTALL` allowlist instead of duplicating it.
//
// HTTP concerns (role check, request-body parsing, the exact 400
// "grantedPermissions must be an object" message) stay in the route;
// this function takes an already-validated `submittedPermissions`
// (object or undefined) and reports failures as a discriminated result
// rather than throwing a Response.

import {
	getExtension,
	updateExtension,
	resetFailures,
} from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { hasSecurityViolation } from "$server/extensions/security";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import { emitEnvKeyLeakWarnings } from "$server/extensions/clamp-permissions";
import { reconcileSchedules } from "$server/extensions/schedule-reconcile";
import type { ExtensionManifestV2, ExtensionPermissions } from "$server/extensions/types";
import type { Extension } from "$server/db/schema";

/**
 * Consent shape accepted by `activateExtension`. The activate endpoint
 * passes the user's request-body perms (`Partial<ExtensionPermissions>`);
 * the Library auto-enable path passes the extension's full declared
 * manifest perms (`ExtensionManifestV2["permissions"]`, whose
 * `eventSubscriptions` may be the object form). `clampExtensionPermissions`
 * normalizes both forms internally, so the union is safe at runtime —
 * the cast at the clamp call is the documented boundary.
 */
type SubmittedPermissions =
	| Partial<ExtensionPermissions>
	| ExtensionManifestV2["permissions"];

export type ActivateExtensionResult =
	| { ok: true; extension: Extension }
	| { ok: false; status: 403 | 404; message: string };

/**
 * Flip an installed extension to `enabled=true` and (optionally) grant
 * permissions clamped to its manifest.
 *
 * @param id    extension row id
 * @param opts.submittedPermissions  caller-consented permissions. When
 *        present they're clamped to the manifest (same semantics as the
 *        `PUT /api/extensions/[id]/permissions` handler) and stored as
 *        BOTH `grantedPermissions` and `installedPermissions`. When
 *        omitted, only `enabled` is flipped and perms are left untouched.
 * @param actorId  user id recorded on the `extension:confirmed` audit row.
 */
export async function activateExtension(
	id: string,
	opts: { submittedPermissions?: SubmittedPermissions },
	actorId: string | null,
): Promise<ActivateExtensionResult> {
	const ext = await getExtension(id);
	if (!ext) return { ok: false, status: 404, message: "Not found" };

	// Preserve the sec-C4 invariant: an extension with an unresolved
	// security violation cannot be re-enabled.
	if (await hasSecurityViolation(id)) {
		return {
			ok: false,
			status: 403,
			message:
				"Cannot re-enable extension with security violations. Clear violations first.",
		};
	}

	const submittedPerms = opts.submittedPermissions;
	const update: {
		enabled: boolean;
		grantedPermissions?: ExtensionPermissions;
		installedPermissions?: ExtensionPermissions;
	} = { enabled: true };

	if (submittedPerms !== undefined) {
		const manifestPerms = ext.manifest?.permissions ?? {};
		const clamped = clampExtensionPermissions(submittedPerms as Partial<ExtensionPermissions>, manifestPerms, {
			acceptsCallerCaps: ext.manifest?.acceptsCallerCaps,
			escalateChildCaps: ext.manifest?.escalateChildCaps,
		});
		update.grantedPermissions = clamped;
		// v1.3 security review HIGH 2 — persist the install-time NARROWED
		// choice so the reapprove handler clamps against the user's actual
		// consent rather than the full manifest. At activate time these
		// two are equal; a later sweep that narrows `grantedPermissions`
		// must NOT widen `installedPermissions`.
		update.installedPermissions = clamped;
	}

	const updated = await updateExtension(id, update);
	await resetFailures(id);
	await ExtensionRegistry.getInstance().reload();

	// Phase 51 install-time governance — both fire-and-forget; failures
	// are non-fatal and must not block enable.
	try {
		await emitEnvKeyLeakWarnings(id, ext.manifest?.permissions?.env);
	} catch {
		/* swallow — audit governance is non-fatal */
	}
	try {
		const cronList = ext.manifest?.permissions?.schedule?.crons;
		if (Array.isArray(cronList)) await reconcileSchedules(id, cronList);
	} catch {
		/* swallow — schedule reconcile is non-fatal */
	}

	// Best-effort audit log — do not fail on logging errors.
	try {
		await insertAuditEntry(actorId, "extension:confirmed", id, {
			enabled: true,
			submittedPermissions: submittedPerms ?? null,
			grantedPermissions: update.grantedPermissions ?? null,
		});
	} catch {
		/* swallow */
	}

	return { ok: true, extension: updated as Extension };
}
