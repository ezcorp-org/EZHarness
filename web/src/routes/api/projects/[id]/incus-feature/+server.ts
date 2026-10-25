import { json } from "@sveltejs/kit";
import { and, eq, sql } from "drizzle-orm";
import { checkProjectRole, requireAdminSession } from "$server/auth/middleware";
import { getDb } from "$server/db/connection";
import { providerConnections, sandboxBindings } from "$server/db/schema";
import { requireScope } from "$lib/server/security/api-keys";
import type { RequestHandler } from "./$types";

/** Project-scoped binding identity for Settings. A path is never binding proof. */
export const GET: RequestHandler = async ({ params, locals }) => {
	const scopeError = requireScope(locals, "read");
	if (scopeError) return scopeError;
	const member = await checkProjectRole(locals, params.id, "member");
	if (member instanceof Response) return member;
	const [binding] = await getDb().select({ presetId: sandboxBindings.presetId,
		observedState: sandboxBindings.observedState,
		installationId: sandboxBindings.providerInstallationId,
		releaseId: sandboxBindings.providerReleaseId,
		connectionId: sandboxBindings.connectionId })
		.from(sandboxBindings).where(eq(sandboxBindings.projectId, params.id)).limit(1);
	if (!binding) return json({ kind: "none" }, { headers: { "cache-control": "no-store" } });
	const [connection] = await getDb().select({ kind: sql<string | null>`${providerConnections.configuration}->>'kind'` })
		.from(providerConnections).where(and(eq(providerConnections.id, binding.connectionId),
			eq(providerConnections.providerInstallationId, binding.installationId),
			eq(providerConnections.providerReleaseId, binding.releaseId))).limit(1);
	if (connection?.kind !== "incus") return json({ kind: "unavailable" }, { headers: { "cache-control": "no-store" } });
	return json({ kind: "incus", presetId: binding.presetId, observedState: binding.observedState,
		canManage: !(requireAdminSession(locals) instanceof Response) }, { headers: { "cache-control": "no-store" } });
};
