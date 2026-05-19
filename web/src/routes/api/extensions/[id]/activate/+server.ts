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
// The enable+grant+governance+audit core lives in the shared
// `activateExtension` service so the Library install route can reuse the
// exact same sequence for the auto-enable allowlist. This handler keeps
// only HTTP concerns: role check, body parsing, and the inline
// null/array guard whose exact 400 message is part of the test contract.
//
// NOTE: the sibling `[id]/confirm/+server.ts` handles a completely
// different concern (runtime shell/filesystem permission prompts) and
// is actively used by the UI, so it can't be repurposed for this.

import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireRole } from "$server/auth/middleware";
import { errorJson } from "$lib/server/http-errors";
import { activateExtension } from "$lib/server/extensions/activate-extension";
import type { ExtensionPermissions } from "$server/extensions/types";
import type { RequestHandler } from "./$types";

// Boundary validation. The handler reads exactly one optional field —
// `grantedPermissions`, an object that's then passed to clampExtensionPermissions.
// We accept any object/undefined here; the inline guard below (rejecting
// null/array with 400 "grantedPermissions must be an object") stays so
// the test contract on that exact message holds. .passthrough() because
// clampExtensionPermissions expects the full Partial<ExtensionPermissions>
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

	const parsed = activatePostSchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "Invalid request body");
	}
	const submittedPerms = parsed.data.grantedPermissions;

	if (submittedPerms !== undefined) {
		if (!submittedPerms || typeof submittedPerms !== "object" || Array.isArray(submittedPerms)) {
			return errorJson(400, "grantedPermissions must be an object");
		}
	}

	const result = await activateExtension(
		params.id,
		{ submittedPermissions: submittedPerms as Partial<ExtensionPermissions> | undefined },
		admin.id,
	);
	if (!result.ok) {
		return errorJson(result.status, result.message);
	}
	return json(result.extension);
};
