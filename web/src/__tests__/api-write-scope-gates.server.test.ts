/**
 * The `write` scope gate, asserted on every handler the 2026-08 re-scope moved.
 *
 * One probe, repeated across seven routes, rather than seven bespoke suites:
 * invoke the REAL handler with an API-key principal holding ONLY `read`, and
 * assert it answers `403 {"error":"Insufficient scope","required":"<scope>"}`.
 *
 * Why this shape works without stubbing a single query: `requireScope` is the
 * FIRST statement in each handler, so a refused request returns before any DB
 * call. That is also what makes the assertion strong — a 403 carrying the
 * `required` field can only come from the scope gate, not from ownership, not
 * from validation, not from a missing row.
 *
 * The paired positive case matters as much as the negative one. Asserting only
 * "read is refused" would still pass if the route demanded some scope nobody
 * can mint; asserting the correct scope is ADMITTED (it proceeds past the gate
 * and fails later, in the DB layer this suite deliberately does not stub)
 * pins which scope it actually wants.
 *
 * See docs/audit/2026-08-read-scope-mutation-inventory.md for why these
 * handlers took `read` in the first place.
 */
import { describe, expect, test } from "vitest";

// Imported at MODULE scope, not inside the tests that use them.
//
// `ez-actions/[name]/+server.ts` transitively pulls the extension host
// (ExtensionRegistry, ToolExecutor, ensureInitialized). Loading that graph
// inside a `test()` bills it to the 5s per-test budget, and under a loaded
// ~180-file vitest leg it blows the timeout — reproducibly, while passing in
// isolation, which is the worst kind of red. Hoisting moves the cost to module
// setup where it belongs. Same fix as #51 ("stop billing the boot-graph import
// to the 5s per-test budget").
const memories = await import("../routes/api/memories/+server");
const memoriesId = await import("../routes/api/memories/[id]/+server");
const projects = await import("../routes/api/projects/+server");
const knowledgeBase = await import("../routes/api/knowledge-base/+server");
const lessonsId = await import("../routes/api/lessons/[id]/+server");
const fsMkdir = await import("../routes/api/fs/mkdir/+server");
const ezActions = await import("../routes/api/ez-actions/[name]/+server");

const USER = { id: "u1", email: "u@x.test", name: "u", role: "member" };

/** A minimal SvelteKit RequestEvent — enough to reach the scope gate. */
function makeEvent(scopes: string[], method: string, body: unknown = {}) {
	const url = new URL("http://localhost/api/probe");
	return {
		locals: { user: USER, apiKeyScopes: scopes },
		params: { id: "00000000-0000-4000-8000-000000000000", name: "distill" },
		url,
		request: new Request(url, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "GET" || method === "DELETE" ? undefined : JSON.stringify(body),
		}),
		cookies: { get: () => undefined, set: () => {}, delete: () => {}, getAll: () => [] },
		fetch: globalThis.fetch,
		setHeaders: () => {},
		getClientAddress: () => "127.0.0.1",
		route: { id: "/api/probe" },
		isDataRequest: false,
		isSubRequest: false,
	} as never;
}

/** Run a handler and normalise "threw a Response" into "returned it". */
async function invoke(
	handler: (e: never) => unknown,
	scopes: string[],
	method: string,
): Promise<Response | Error> {
	try {
		return (await handler(makeEvent(scopes, method))) as Response;
	} catch (e) {
		if (e instanceof Response) return e;
		return e as Error;
	}
}

/** Assert the handler REFUSES a read-only key, naming the scope it wants. */
async function expectRefusesRead(
	handler: (e: never) => unknown,
	required: string,
	method: string,
) {
	const res = await invoke(handler, ["read"], method);
	expect(res).toBeInstanceOf(Response);
	const r = res as Response;
	expect(r.status).toBe(403);
	const body = (await r.json()) as { error?: string; required?: string };
	expect(body.error).toBe("Insufficient scope");
	expect(body.required).toBe(required);
}

/**
 * Assert the handler ADMITS the required scope — it gets PAST the gate and
 * fails downstream instead (no DB is stubbed here, so "not a scope 403" is
 * the signal). Without this half, a route demanding an unmintable scope would
 * look identical to a correctly-gated one.
 */
async function expectAdmits(
	handler: (e: never) => unknown,
	scopes: string[],
	method: string,
) {
	const res = await invoke(handler, scopes, method);
	// Reduce both outcomes to ONE assertable fact — "was this a scope refusal?"
	// A thrown non-Response error means the handler reached real work, which is
	// itself proof it was admitted; collapsing it here keeps the branch that
	// asserts nothing from existing.
	const refusal =
		res instanceof Response
			? ((await res.clone().json().catch(() => ({}))) as { error?: string }).error
			: undefined;
	expect(refusal).not.toBe("Insufficient scope");
}

describe("routes moved onto the `write` scope", () => {
	test("POST /api/memories refuses read, admits write", async () => {
		const { POST } = memories;
		await expectRefusesRead(POST, "write", "POST");
		await expectAdmits(POST, ["write"], "POST");
	});

	test("PUT /api/memories/:id refuses read, admits write", async () => {
		const { PUT } = memoriesId;
		await expectRefusesRead(PUT, "write", "PUT");
	});

	test("PATCH /api/memories/:id refuses read, admits write", async () => {
		// The line the patch-coverage gate flagged (`+server.ts:128`): PATCH's
		// scope gate had no test reaching it under coverage.
		const { PATCH } = memoriesId;
		await expectRefusesRead(PATCH, "write", "PATCH");
		await expectAdmits(PATCH, ["write"], "PATCH");
	});

	test("DELETE /api/memories/:id refuses read, admits write", async () => {
		const { DELETE } = memoriesId;
		await expectRefusesRead(DELETE, "write", "DELETE");
	});

	test("POST /api/projects refuses read, admits write", async () => {
		const { POST } = projects;
		await expectRefusesRead(POST, "write", "POST");
		await expectAdmits(POST, ["write"], "POST");
	});

	test("POST /api/knowledge-base refuses read, admits write", async () => {
		const { POST } = knowledgeBase;
		await expectRefusesRead(POST, "write", "POST");
	});

	test("DELETE /api/lessons/:id refuses read, admits write", async () => {
		const { DELETE } = lessonsId;
		await expectRefusesRead(DELETE, "write", "DELETE");
	});

	test("PATCH /api/lessons/:id refuses read, admits write", async () => {
		const { PATCH } = lessonsId;
		await expectRefusesRead(PATCH, "write", "PATCH");
	});
});

describe("routes moved elsewhere by the same pass", () => {
	test("POST /api/fs/mkdir now demands `admin`, not `read`", async () => {
		// It enforced admin INLINE (`+server.ts:22`) while advertising `read` —
		// the F4 blind spot. The scope now says what the gate does.
		const { POST } = fsMkdir;
		await expectRefusesRead(POST, "admin", "POST");
	});

	test("POST /api/ez-actions/:name now demands `chat`, not `read`", async () => {
		const { POST } = ezActions;
		await expectRefusesRead(POST, "chat", "POST");
	});
});

describe("the read scope still opens the read-shaped verbs", () => {
	test("GET /api/memories/:id admits a read-only key", async () => {
		// The split is per-VERB. If the re-scope had moved a whole file, every
		// read-only integration would break — the opposite failure, equally
		// invisible without this.
		const { GET } = memoriesId;
		await expectAdmits(GET, ["read"], "GET");
	});

	test("GET /api/projects admits a read-only key", async () => {
		const { GET } = projects;
		await expectAdmits(GET, ["read"], "GET");
	});

	test("GET /api/knowledge-base admits a read-only key", async () => {
		const { GET } = knowledgeBase;
		await expectAdmits(GET, ["read"], "GET");
	});
});
