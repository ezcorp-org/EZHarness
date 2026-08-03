/**
 * The `write` scope gate, asserted on every handler the 2026-08 re-scope moved.
 *
 * One shared PROBE, but every assertion inline. `probe()` is a pure verdict
 * function — it drives a handler and RETURNS `{status, error, required}`,
 * asserting nothing. Each `test()` then states its own claim about that value.
 *
 * That split is deliberate. A helper that both drives AND asserts reads as an
 * assertion-free test to `scripts/gate-integrity.ts` — and the check is right
 * to complain, because a reader scanning the file could not see what any
 * individual case claimed either. One place knows how to drive a handler;
 * thirteen places say what they expect.
 *
 * Why the probe needs no query stubs: `requireScope` is the FIRST statement in
 * each handler, so a refused request returns before any DB call. That also
 * makes the assertion strong — a 403 carrying a `required` field can only have
 * come from the scope gate, never from ownership, validation, or a missing row.
 *
 * Every case asserts BOTH halves:
 *   - the wrong scope is REFUSED, naming the scope the route wants;
 *   - the intended scope is ADMITTED.
 * The second half is not decoration. "read is refused" alone would still pass
 * if a route demanded a scope nobody can mint, which is indistinguishable from
 * correct gating without it.
 *
 * See docs/audit/2026-08-read-scope-mutation-inventory.md.
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
function makeEvent(scopes: string[], method: string) {
	const url = new URL("http://localhost/api/probe");
	return {
		locals: { user: USER, apiKeyScopes: scopes },
		params: { id: "00000000-0000-4000-8000-000000000000", name: "distill" },
		url,
		request: new Request(url, {
			method,
			headers: { "content-type": "application/json" },
			body: method === "GET" || method === "DELETE" ? undefined : "{}",
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

/** What a handler did, reduced to the three facts a scope test cares about. */
interface Verdict {
	/** HTTP status, or `null` when the handler threw a non-Response error —
	 *  which only happens AFTER the gate, down in the DB layer this suite
	 *  deliberately leaves unstubbed, and is therefore itself evidence of
	 *  admission. */
	status: number | null;
	error?: string;
	required?: string;
}

/**
 * Drive a handler and report what happened. ASSERTS NOTHING — every claim
 * belongs to the test that calls this. A thrown `Response` is normalised into
 * a returned one so no test has to care which style a route uses.
 */
async function probe(
	handler: (e: never) => unknown,
	scopes: string[],
	method: string,
): Promise<Verdict> {
	let res: unknown;
	try {
		res = await handler(makeEvent(scopes, method));
	} catch (e) {
		if (!(e instanceof Response)) return { status: null };
		res = e;
	}
	if (!(res instanceof Response)) return { status: null };
	const body = (await res.clone().json().catch(() => ({}))) as {
		error?: string;
		required?: string;
	};
	return { status: res.status, error: body.error, required: body.required };
}

/** The exact shape a scope refusal takes. Spelled once; asserted inline. */
function refusal(required: string): Verdict {
	return { status: 403, error: "Insufficient scope", required };
}

describe("routes moved onto the `write` scope", () => {
	test("POST /api/memories refuses read, admits write", async () => {
		expect(await probe(memories.POST, ["read"], "POST")).toEqual(refusal("write"));
		expect((await probe(memories.POST, ["write"], "POST")).error).not.toBe("Insufficient scope");
	});

	test("PUT /api/memories/:id refuses read, admits write", async () => {
		expect(await probe(memoriesId.PUT, ["read"], "PUT")).toEqual(refusal("write"));
		expect((await probe(memoriesId.PUT, ["write"], "PUT")).error).not.toBe("Insufficient scope");
	});

	test("PATCH /api/memories/:id refuses read, admits write", async () => {
		// The line the patch-coverage gate flagged (`+server.ts:128`): PATCH's
		// scope gate had no test reaching it under coverage.
		expect(await probe(memoriesId.PATCH, ["read"], "PATCH")).toEqual(refusal("write"));
		expect((await probe(memoriesId.PATCH, ["write"], "PATCH")).error).not.toBe("Insufficient scope");
	});

	test("DELETE /api/memories/:id refuses read, admits write", async () => {
		expect(await probe(memoriesId.DELETE, ["read"], "DELETE")).toEqual(refusal("write"));
		expect((await probe(memoriesId.DELETE, ["write"], "DELETE")).error).not.toBe("Insufficient scope");
	});

	test("POST /api/projects refuses read, admits write", async () => {
		expect(await probe(projects.POST, ["read"], "POST")).toEqual(refusal("write"));
		expect((await probe(projects.POST, ["write"], "POST")).error).not.toBe("Insufficient scope");
	});

	test("POST /api/knowledge-base refuses read, admits write", async () => {
		expect(await probe(knowledgeBase.POST, ["read"], "POST")).toEqual(refusal("write"));
		expect((await probe(knowledgeBase.POST, ["write"], "POST")).error).not.toBe("Insufficient scope");
	});

	test("DELETE /api/lessons/:id refuses read, admits write", async () => {
		expect(await probe(lessonsId.DELETE, ["read"], "DELETE")).toEqual(refusal("write"));
		expect((await probe(lessonsId.DELETE, ["write"], "DELETE")).error).not.toBe("Insufficient scope");
	});

	test("PATCH /api/lessons/:id refuses read, admits write", async () => {
		expect(await probe(lessonsId.PATCH, ["read"], "PATCH")).toEqual(refusal("write"));
		expect((await probe(lessonsId.PATCH, ["write"], "PATCH")).error).not.toBe("Insufficient scope");
	});
});

describe("routes moved elsewhere by the same pass", () => {
	test("POST /api/fs/mkdir now demands `admin`, not `read`", async () => {
		// It enforced admin INLINE (`+server.ts:22`) while advertising `read` —
		// the F4 blind spot. The scope now says what the gate does. Admitting the
		// admin SCOPE then hits the ROLE wall (this principal is a member), which
		// is the two-axis model working: a different 403, carrying no `required`.
		expect(await probe(fsMkdir.POST, ["read"], "POST")).toEqual(refusal("admin"));
		expect(await probe(fsMkdir.POST, ["admin"], "POST")).toEqual({
			status: 403,
			error: "Access denied: admin role required",
			required: undefined,
		});
	});

	test("POST /api/ez-actions/:name now demands `chat`, not `read`", async () => {
		expect(await probe(ezActions.POST, ["read"], "POST")).toEqual(refusal("chat"));
		expect((await probe(ezActions.POST, ["chat"], "POST")).error).not.toBe("Insufficient scope");
	});
});

describe("the read scope still opens the read-shaped verbs", () => {
	// The split is per-VERB. If the re-scope had moved a whole file, every
	// read-only integration would break — the opposite failure, equally
	// invisible without these.
	test("GET /api/memories/:id admits read, refuses chat", async () => {
		expect((await probe(memoriesId.GET, ["read"], "GET")).error).not.toBe("Insufficient scope");
		expect(await probe(memoriesId.GET, ["chat"], "GET")).toEqual(refusal("read"));
	});

	test("GET /api/projects admits read, refuses chat", async () => {
		expect((await probe(projects.GET, ["read"], "GET")).error).not.toBe("Insufficient scope");
		expect(await probe(projects.GET, ["chat"], "GET")).toEqual(refusal("read"));
	});

	test("GET /api/knowledge-base admits read, refuses chat", async () => {
		expect((await probe(knowledgeBase.GET, ["read"], "GET")).error).not.toBe("Insufficient scope");
		expect(await probe(knowledgeBase.GET, ["chat"], "GET")).toEqual(refusal("read"));
	});
});
