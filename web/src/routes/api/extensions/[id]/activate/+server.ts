// sec-C3 follow-up: admin-only endpoint to activate an extension and
// (optionally) grant its permissions after install.
//
// Background: the sec-C3 fix (f6ee69e) hard-codes enabled=false on first
// install and ignores any caller-supplied permissions to close an RCE
// path where an attacker-controlled install body elevated permissions
// before the extension was even registered. That left a gap: once
// installed, there was no way to enable the extension or grant any of
// its declared permissions without direct DB access.
//
// This endpoint closes that gap:
//   - requireRole(locals, "admin")
//   - POST body: { grantedPermissions?: Partial<ExtensionPermissions> }
//       - If omitted: just flip enabled=true, leave perms untouched.
//       - If present: clamp to manifest (same semantics as sec-C4's
//         PUT /api/extensions/[id]/permissions handler), then store.
//   - 404 on unknown id.
//   - Audit-logged on success.
//
// NOTE: the sibling `[id]/confirm/+server.ts` handles a completely
// different concern (runtime shell/filesystem permission prompts) and
// is actively used by the UI, so it can't be repurposed for this.

import { json } from "@sveltejs/kit";
import { z } from "zod";
import { getExtension, updateExtension, resetFailures } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { hasSecurityViolation } from "$server/extensions/security";
import { requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { errorJson } from "$lib/server/http-errors";
import { clampExtensionPermissions } from "$lib/server/extension-helpers";
import { emitEnvKeyLeakWarnings } from "$server/extensions/clamp-permissions";
import { reconcileSchedules } from "$server/extensions/schedule-reconcile";
import type { ExtensionPermissions } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

// Boundary validation. The handler reads exactly one optional field —
// `grantedPermissions`, an object that's then passed to clampExtensionPermissions.
// We accept any object/undefined here; the existing inline guards
// (rejecting null/array with 400 "grantedPermissions must be an object")
// stay so the test contract on that exact message holds. .passthrough()
// because clampExtensionPermissions expects the full Partial<ExtensionPermissions>
// shape, which has too many nested fields to enumerate locally.
const activatePostSchema = z.object({
  grantedPermissions: z.unknown().optional(),
}).passthrough();

export const POST: RequestHandler = async ({ request, params, locals }) => {
	// requireRole throws a raw Response; SvelteKit does not recognise that and
	// surfaces it as a 500. Catch here so non-admin callers see the intended 403.
	let admin;
	try {
		admin = requireRole(locals, "admin");
	} catch (e) {
		if (e instanceof Response) return e;
		throw e;
	}

	const ext = await getExtension(params.id);
	if (!ext) return errorJson(404, "Not found");

	// Preserve the sec-C4 invariant that previously lived on PATCH: an
	// extension with an unresolved security violation cannot be re-enabled.
	const hasViolation = await hasSecurityViolation(params.id);
	if (hasViolation) {
		return errorJson(
			403,
			"Cannot re-enable extension with security violations. Clear violations first.",
		);
	}

	const parsed = activatePostSchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "Invalid request body");
	}
	const submittedPerms = parsed.data.grantedPermissions;

	const update: { enabled: boolean; grantedPermissions?: ExtensionPermissions } = {
		enabled: true,
	};

	if (submittedPerms !== undefined) {
		if (!submittedPerms || typeof submittedPerms !== "object" || Array.isArray(submittedPerms)) {
			return errorJson(400, "grantedPermissions must be an object");
		}
		const manifestPerms = ext.manifest?.permissions ?? {};
		update.grantedPermissions = clampExtensionPermissions(
			submittedPerms as Partial<ExtensionPermissions>,
			manifestPerms,
			{
				acceptsCallerCaps: ext.manifest?.acceptsCallerCaps,
				escalateChildCaps: ext.manifest?.escalateChildCaps,
			},
		);
	}

	const updated = await updateExtension(params.id, update);
	await resetFailures(params.id);
	await ExtensionRegistry.getInstance().reload();

	// Phase 51: install-time governance. Emit env-key-leak warnings for
	// any credential-shaped env names AND reconcile cron schedules on
	// activate. Both are fire-and-forget — failures are non-fatal and
	// must not block enable.
	try {
		await emitEnvKeyLeakWarnings(params.id, ext.manifest?.permissions?.env);
	} catch { /* swallow — audit governance is non-fatal */ }
	try {
		const cronList = ext.manifest?.permissions?.schedule?.crons;
		if (Array.isArray(cronList)) {
			await reconcileSchedules(params.id, cronList);
		}
	} catch { /* swallow — schedule reconcile is non-fatal */ }

	// Best-effort audit log — do not fail the request on logging errors.
	try {
		await insertAuditEntry(admin.id, "extension:confirmed", params.id, {
			enabled: true,
			submittedPermissions: submittedPerms ?? null,
			grantedPermissions: update.grantedPermissions ?? null,
		});
	} catch { /* swallow */ }

	return json(updated);
};
