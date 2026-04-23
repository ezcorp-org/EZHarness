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
import { getExtension, updateExtension, resetFailures } from "$server/db/queries/extensions";
import { ExtensionRegistry } from "$server/extensions/registry";
import { hasSecurityViolation } from "$server/extensions/security";
import { requireRole } from "$server/auth/middleware";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { capabilityToolsDisabled } from "$server/extensions/capability-flags";
import { DIRECT_CARRIER_EVENT_TYPES } from "$server/runtime/sse-conversation-filter";
import { errorJson } from "$lib/server/http-errors";
import type { ExtensionPermissions, ExtensionManifestV2 } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

// Keep the clamp logic inline (do not factor into a shared helper — the
// sec-C4 code review asked for this exact behaviour co-located with the
// writer). Mirrors the implementation in
// web/src/routes/api/extensions/[id]/permissions/+server.ts.
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

	// ── Capability tier (Phase 2+): mirror the clamp logic in the sibling
	// PUT /api/extensions/[id]/permissions handler. Kept inline per
	// sec-C4 review convention — each writer owns its own clamp.
	if (!capabilityToolsDisabled()) {
		if (submitted.taskEvents === true && manifest.taskEvents === true) {
			clamped.taskEvents = true;
		}
		if (submitted.spawnAgents && manifest.spawnAgents) {
			const sm = submitted.spawnAgents;
			const mm = manifest.spawnAgents;
			const hourly = Math.min(sm.maxPerHour, mm.maxPerHour);
			const concurrent = Math.min(
				sm.maxConcurrent ?? mm.maxConcurrent ?? 3,
				mm.maxConcurrent ?? 3,
			);
			if (hourly > 0 && concurrent > 0) {
				clamped.spawnAgents = { maxPerHour: hourly, maxConcurrent: concurrent };
			}
		}
		if (submitted.agentConfig === "read" && manifest.agentConfig === "read") {
			clamped.agentConfig = "read";
		}
		// eventSubscriptions (Phase 2c): intersect submitted ∩ manifest ∩
		// direct-carrier allowlist. Fail-closed on unknown event names.
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

	if (submitted.grantedAt && typeof submitted.grantedAt === "object") {
		for (const [k, v] of Object.entries(submitted.grantedAt)) {
			if (typeof v === "number") clamped.grantedAt[k] = v;
		}
	}

	return clamped;
}

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

	const body = await request.json().catch(() => ({}));
	const submittedPerms = (body as { grantedPermissions?: unknown }).grantedPermissions;

	const update: { enabled: boolean; grantedPermissions?: ExtensionPermissions } = {
		enabled: true,
	};

	if (submittedPerms !== undefined) {
		if (!submittedPerms || typeof submittedPerms !== "object" || Array.isArray(submittedPerms)) {
			return errorJson(400, "grantedPermissions must be an object");
		}
		const manifestPerms = ext.manifest?.permissions ?? {};
		update.grantedPermissions = clampToManifest(
			submittedPerms as Partial<ExtensionPermissions>,
			manifestPerms,
		);
	}

	const updated = await updateExtension(params.id, update);
	await resetFailures(params.id);
	await ExtensionRegistry.getInstance().reload();

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
