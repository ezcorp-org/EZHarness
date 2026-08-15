import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireScope } from "$lib/server/security/api-keys";
import { checkProjectRole } from "$server/auth/middleware";

/**
 * The per-project built-in-tool permission mode — the dial that decides
 * whether the model's `write` / `execute` tool calls auto-run or pause for a
 * human. Both verbs gate on PROJECT MEMBERSHIP, the same ladder that guards
 * rename and delete (`web/src/routes/api/projects/[id]/+server.ts`), because
 * this is project-wide state and not a per-user preference: one PUT decides
 * what EVERY run in the project may do without asking.
 *
 * Both used to carry `requireAuth` + `requireScope` and nothing else, which
 * is not a gate. `requireScope` is a NO-OP for every cookie session, so the
 * `chat` scope on PUT stopped only a narrowly-scoped API key — see "a no-op
 * scope check is not a gate" in
 * docs/features/platform/rbac-and-permission-modes.md. Any principal that
 * could reach the route could PUT `yolo` onto ANY project id, and the next
 * run in that project executed shell commands unprompted.
 *
 * The READ is gated too, which `GET /api/projects/:id` deliberately is not.
 * That read stays instance-global because the LIST route is unfiltered, so
 * hiding one project there would be theatre. The mode is in no list: it says
 * whether a project's shell calls auto-run, which is reconnaissance for
 * exactly the attack above. `GET /api/projects/:id/members` is the
 * precedent — a project SUBRESOURCE gates even where the project row does
 * not. A denied read costs the caller nothing real: the picker falls back to
 * the same default it shows before the fetch resolves.
 *
 * `checkProjectRole` RETURNS its denial (401 unauthenticated, 403
 * non-member) rather than throwing it — a thrown Response from a handler is
 * a 500 — and instance admins bypass membership. It also replaces the
 * `requireAuth` call, which threw on exactly that 401 path.
 *
 * The CONVERSATION half of the PUT — that `conversationId` names a chat this
 * caller owns, inside this project — is enforced in `handleSetPermissionMode`
 * (`src/routes/tool-permission.ts`), where the body is parsed.
 */

export const GET: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "read");
	if (scopeErr) return scopeErr;
	const gate = await checkProjectRole(locals, params.id, "member");
	if (gate instanceof Response) return gate;
	const { handleGetPermissionMode } = await import("$server/routes/tool-permission");
	return handleGetPermissionMode(request, params.id);
};

export const PUT: RequestHandler = async ({ params, request, locals }) => {
	const scopeErr = requireScope(locals, "chat");
	if (scopeErr) return scopeErr;
	const gate = await checkProjectRole(locals, params.id, "member");
	if (gate instanceof Response) return gate;
	const { handleSetPermissionMode } = await import("$server/routes/tool-permission");
	const bus = getBus();
	return handleSetPermissionMode(request, params.id, gate, {
		onModeChange: (mode, conversationId) => {
			bus.emit("tool:permission_mode_change", { conversationId, mode });
		},
	});
};
