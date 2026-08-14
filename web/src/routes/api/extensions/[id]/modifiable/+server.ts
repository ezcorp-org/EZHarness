// Admin-only toggle for the per-extension `modifiable` gate.
//
// `modifiable` authorizes an extension's CREATOR to re-open and edit
// it (web Modify action + the in-chat `modify_extension` tool). Only
// an admin may flip it — a user cannot self-enable editing their own
// extension, and the in-chat LLM can never reach this route. Mirrors
// the admin-guard + audit pattern of `[id]/activate/+server.ts`.

import { json } from "@sveltejs/kit";
import { z } from "zod";
import { requireAdmin, requireScope } from "$lib/server/security/api-keys";
import { errorJson } from "$lib/server/http-errors";
import {
	getExtension,
	setExtensionModifiable,
} from "$server/db/queries/extensions";
import { redactExtensionSecrets } from "$server/extensions/mcp-secret-redaction";
import { insertAuditEntry } from "$server/db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "$server/extensions/audit-actions";
import type { RequestHandler } from "./$types";

const postSchema = z.object({ modifiable: z.boolean() });

export const POST: RequestHandler = async ({ request, params, locals }) => {
	// F2: replaces the local try/catch around `requireRole` (which THREW, and
	// SvelteKit renders a thrown Response as a 500). `requireAdmin` returns the
	// denial; `requireScope("admin")` adds the second authorization axis, so an
	// API-key principal needs the `admin` SCOPE and not just the admin role.
	// Cookie sessions carry no `apiKeyScopes` and pass on role alone.
	const adminErr = requireAdmin(locals);
	if (adminErr) return adminErr;
	const scopeErr = requireScope(locals, "admin");
	if (scopeErr) return scopeErr;
	const admin = locals.user!;

	const parsed = postSchema.safeParse(await request.json().catch(() => ({})));
	if (!parsed.success) {
		return errorJson(400, "Body must be { modifiable: boolean }");
	}
	const { modifiable } = parsed.data;

	const ext = await getExtension(params.id);
	if (!ext) return errorJson(404, "Not found");

	// Bundled extensions are never user-modifiable — refuse to flip the
	// flag on one so the admin UI can't create a false affordance.
	if (ext.isBundled) {
		return errorJson(400, "Bundled extensions cannot be made modifiable");
	}

	// Idempotent no-op: no write, no audit row, when already at target.
	// #205: scrubbed on the way out like every other row-serving route.
	if (ext.modifiable === modifiable) {
		return json(redactExtensionSecrets(ext));
	}

	const updated = await setExtensionModifiable(params.id, modifiable);
	if (!updated) return errorJson(404, "Not found");

	await insertAuditEntry(admin.id, EXT_AUDIT_ACTIONS.MODIFIABLE_TOGGLED, params.id, {
		permission: "modifiable",
		oldValue: ext.modifiable,
		newValue: modifiable,
		actor: admin.id,
		reason: modifiable
			? "admin enabled creator modification for this extension"
			: "admin disabled creator modification for this extension",
	});

	return json(redactExtensionSecrets(updated));
};
