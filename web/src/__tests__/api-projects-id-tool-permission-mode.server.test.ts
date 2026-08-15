/**
 * Server-handler unit tests for
 * /api/projects/[id]/tool-permission-mode/+server.ts.
 *
 * The handler is thin: it gates on API-key scope + PROJECT MEMBERSHIP, then
 * defers to the shared tool-permission helper via dynamic import, wiring a bus
 * emit into the helper's `onModeChange` callback. All three halves are covered
 * here — the scope gate and the membership gate that run BEFORE the dynamic
 * import, and the delegation + emit that run after it (the helper itself and
 * its DB write are integration-tested against real PGlite elsewhere; `vi.mock`
 * stands in for it here).
 *
 * The membership gate is the fix for a real hole: both verbs used to carry
 * `requireAuth` + `requireScope` and nothing else, and `requireScope` is a
 * NO-OP for cookie sessions. So any principal that could reach the route could
 * PUT `yolo` onto ANY project id. `checkProjectRole` is stubbed here — the
 * gate's OWN semantics (admin bypass, missing-row 403, the member<owner
 * ladder) are exercised against the shipped implementation by
 * `src/__tests__/security/project-permission-mode-authz.test.ts`, which drives
 * these same handlers with only the membership QUERY stubbed. What these tests
 * pin is that the route CALLS the gate, with this project id, at this rung, and
 * RETURNS its denial instead of proceeding.
 *
 * This is the coverage-authoritative leg for the route: bun `mock.module`
 * tests of web routes are excluded from the merged lcov, so route coverage
 * counts ONLY via vitest `vi.mock` (precedent:
 * `api-projects-id-features-scan.server.test.ts`). Until it was wired into
 * BOTH of scripts/test-coverage.sh's hand-maintained allowlists, the route had
 * no lcov data at all — which is why its `any` sat on `biome.json`'s
 * noExplicitAny opt-out list (issue #142).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

// ── The project-membership gate ─────────────────────────────────────
// Stubbed at the GATE (not at the membership query) because this file's job is
// the route's wiring; the gate's own rules have their own suite. Records every
// call, so a route that asked about the wrong project or the wrong rung cannot
// pass, and answers 403 for anyone outside `memberOf`.
type RoleCall = { projectId: string; minRole: string; userId: string | undefined };
let roleCalls: RoleCall[] = [];
/** Project ids the caller is a member of, per test. */
let memberOf: Set<string>;

vi.mock("$server/auth/middleware", () => ({
	checkProjectRole: async (
		locals: { user?: { id: string } },
		projectId: string,
		minRole: string,
	) => {
		roleCalls.push({ projectId, minRole, userId: locals.user?.id });
		if (!locals.user) return Response.json({ error: "Authentication required" }, { status: 401 });
		if (!memberOf.has(projectId)) return Response.json({ error: "Forbidden" }, { status: 403 });
		return locals.user;
	},
}));

// ── The shared helper the route dynamically imports ─────────────────
// Records the call and drives the `onModeChange` callback so the route's bus
// emit is actually exercised.
type SetCall = {
	projectId: string;
	body: unknown;
	user: unknown;
	options?: { onModeChange?: (mode: string, conversationId: string) => void };
};
let setCalls: SetCall[] = [];
let getCalls: Array<{ projectId: string }> = [];
/** What the mocked helper feeds back through `onModeChange`, per test. */
let modeChange: { mode: string; conversationId: string } | null = null;

vi.mock("$server/routes/tool-permission", () => ({
	handleGetPermissionMode: vi.fn(async (_req: Request, projectId: string) => {
		getCalls.push({ projectId });
		return new Response(JSON.stringify({ mode: "ask" }), { status: 200 });
	}),
	handleSetPermissionMode: vi.fn(
		async (req: Request, projectId: string, user: unknown, options?: SetCall["options"]) => {
			setCalls.push({ projectId, body: await req.json(), user, options });
			if (modeChange) options?.onModeChange?.(modeChange.mode, modeChange.conversationId);
			return new Response(JSON.stringify({ ok: true }), { status: 200 });
		},
	),
}));

// ── The runtime event bus ───────────────────────────────────────────
const emitted: Array<{ type: string; data: unknown }> = [];
vi.mock("$lib/server/context", () => ({
	getBus: () => ({ emit: (type: string, data: unknown) => emitted.push({ type, data }) }),
}));

import { GET, PUT } from "../routes/api/projects/[id]/tool-permission-mode/+server";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

function makeEvent(opts: {
	id?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const id = opts.id ?? "p1";
	return makeRequestEvent(`http://localhost/api/projects/${id}/tool-permission-mode`, {
	  locals: opts.locals ?? {},
	  params: { id },
	  request: {
				method: opts.method ?? "GET",
				headers: { "content-type": "application/json" },
				body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
			},
	});
}

const AUTHED = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
	apiKeyScopes: ["read", "chat"],
};

beforeEach(() => {
	setCalls = [];
	getCalls = [];
	roleCalls = [];
	emitted.length = 0;
	modeChange = null;
	// The default principal is a member of the project ids used below.
	memberOf = new Set(["p1", "proj-7"]);
});

describe("GET /api/projects/[id]/tool-permission-mode", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
					apiKeyScopes: ["chat"],
				},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
		// The scope gate runs FIRST: a key that may not read costs no membership
		// lookup and learns nothing about membership.
		expect(roleCalls).toEqual([]);
	});

	test("a NON-MEMBER cannot read another project's mode", async () => {
		// The mode says whether this project's `write` / `execute` tool calls
		// auto-run. It appears in no list route, so — unlike `GET
		// /api/projects/:id` — withholding it here is not theatre.
		memberOf = new Set(["some-other-project"]);
		const res = await GET(makeEvent({ id: "victim-proj", locals: AUTHED }));
		expect(res.status).toBe(403);
		expect(getCalls).toEqual([]);
	});

	test("delegates to handleGetPermissionMode with the route's project id", async () => {
		const res = await GET(makeEvent({ id: "proj-7", locals: AUTHED }));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ mode: "ask" });
		expect(getCalls).toEqual([{ projectId: "proj-7" }]);
		// Asked about the project in the PATH, at the `member` rung.
		expect(roleCalls).toEqual([{ projectId: "proj-7", minRole: "member", userId: "u1" }]);
	});
});

describe("PUT /api/projects/[id]/tool-permission-mode", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await PUT(
			makeEvent({
				locals: {
					user: { id: "u1", email: "u@x", name: "u", role: "user" },
					apiKeyScopes: ["read"],
				},
				method: "PUT",
				body: { mode: "ask" },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
		expect(roleCalls).toEqual([]);
	});

	test("a NON-MEMBER cannot raise another project's mode", async () => {
		// The hole this route shipped with: the `chat` scope was the only check,
		// and a scope check is a no-op for cookie sessions. One PUT re-armed
		// every run in someone else's project.
		memberOf = new Set(["some-other-project"]);
		const res = await PUT(
			makeEvent({
				id: "victim-proj",
				locals: AUTHED,
				method: "PUT",
				body: { mode: "yolo" },
			}),
		);
		expect(res.status).toBe(403);
		// The load-bearing half: the helper — which owns the DB write and the
		// bus emit — is never reached.
		expect(setCalls).toEqual([]);
		expect(emitted).toEqual([]);
		expect(roleCalls).toEqual([{ projectId: "victim-proj", minRole: "member", userId: "u1" }]);
	});

	test("an UNAUTHENTICATED caller gets 401, not a 500", async () => {
		// `checkProjectRole` RETURNS its denial; the `requireAuth` it replaced
		// THREW one, which SvelteKit surfaces from a handler as a 500.
		const res = await PUT(makeEvent({ locals: {}, method: "PUT", body: { mode: "ask" } }));
		expect(res.status).toBe(401);
		expect(setCalls).toEqual([]);
	});

	test("forwards the body and emits tool:permission_mode_change for a conversation", async () => {
		modeChange = { mode: "acceptEdits", conversationId: "conv-9" };
		const res = await PUT(
			makeEvent({
				id: "proj-7",
				locals: AUTHED,
				method: "PUT",
				body: { mode: "acceptEdits", conversationId: "conv-9" },
			}),
		);
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual({ ok: true });
		expect(setCalls).toHaveLength(1);
		expect(setCalls[0]!.projectId).toBe("proj-7");
		expect(setCalls[0]!.body).toEqual({ mode: "acceptEdits", conversationId: "conv-9" });
		expect(emitted).toEqual([
			{
				type: "tool:permission_mode_change",
				data: { conversationId: "conv-9", mode: "acceptEdits" },
			},
		]);
	});

	test("the gated principal is handed to the helper, not re-read from locals", async () => {
		// The helper needs the AUTHENTICATED user to decide whether the named
		// conversation is the caller's. Passing the gate's return value means
		// the principal the membership check approved is the principal the
		// ownership check reads.
		await PUT(makeEvent({ locals: AUTHED, method: "PUT", body: { mode: "ask" } }));
		expect(setCalls[0]!.user).toEqual(AUTHED.user);
	});

	test("a project-wide change (no conversationId) emits nothing", async () => {
		// The event is per-conversation: without a conversation to scope it to,
		// broadcasting would push another chat's mode change into every client.
		// The helper decides — it is the half that parses the body and the half
		// that authorizes the conversation, so it is the half that may fire.
		modeChange = null;
		const res = await PUT(
			makeEvent({ locals: AUTHED, method: "PUT", body: { mode: "plan" } }),
		);
		expect(res.status).toBe(200);
		expect(setCalls).toHaveLength(1);
		expect(emitted).toEqual([]);
	});
});
