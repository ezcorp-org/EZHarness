import type { RequestHandler } from "./$types";
import { getBus } from "$lib/server/context";
import { requireScope } from "$lib/server/security/api-keys";
import { checkProjectRole, requireSessionAuth } from "$server/auth/middleware";

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
 * 403, NOT 404, for a project the caller cannot see. That looks like an
 * existence oracle and is not one: `GET /api/projects` is deliberately
 * instance-global and unfiltered, so every authenticated caller can already
 * enumerate every project id one request later. A 404 here would be theatre
 * AND a lie about a row the same caller may read. The reasoning is
 * `checkProjectRole`'s own (`src/auth/middleware.ts`) and is pinned by the
 * "reads stay instance-global" block in
 * `src/__tests__/security/cross-tenant-deletion-projects-kb-modes.test.ts`.
 * The sec-H3 404 shape is for ids that ARE secret; a project id is not.
 *
 * ── The WRITE is SESSION-ONLY; the read is not ──
 *
 * `requireSessionAuth` on PUT, so no API key of any scope can move this dial.
 * Raising the stored mode to `yolo` is not a capability, it is STANDING
 * CONSENT: it pre-answers every future permission prompt in the project, for
 * every member, until someone lowers it again. `POST /api/workflows/
 * approvals/:id` is session-only for the weaker case of spending ONE
 * approval — "a leaked key must not be able to spend one" — so the row that
 * abolishes all of them cannot be looser.
 *
 * It also closes a self-escalation loop. A `chat`-scoped key runs the agent
 * whose `shell` / `write` / `edit_file` calls this dial gates. Without this,
 * that key could raise its OWN ceiling and then auto-approve its own tool
 * calls — the gate would be asking the caller's permission to gate the
 * caller. The `internal` principal (`bearer-auth.ts`, the loopback
 * extension-host identity) is refused for the same reason and it is the
 * sharper case: an extension calling back into the API must not be able to
 * stop the host asking about its own `shell` calls.
 *
 * Nothing shipped regresses: the only writer is
 * `PermissionModeIndicator.svelte`, a cookie session, and the route is not
 * `harness: { controllable: true }`.
 *
 * The scope check stays, and stays FIRST, so `scope: "chat"` in
 * `src/api-registry.ts` keeps naming a gate this handler actually enforces
 * (#97's rule) instead of becoming dead code behind the session check — a
 * key lacking `chat` is still refused on the scope axis, and it is refused
 * before any membership row is read, so no denial leaks who belongs here.
 *
 * GET is deliberately NOT session-gated. Reading the mode is a capability an
 * agent legitimately needs, and disclosing it escalates nothing.
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
	const session = requireSessionAuth(locals);
	if (session instanceof Response) return session;
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
