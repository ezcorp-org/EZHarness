/**
 * Server-handler unit tests for /api/workflows/[name]/run/+server.ts.
 *
 * Covers the scope gate, the auth gate, the 404 "Workflow not found" branch,
 * the authorization gate, the strict-body 400, the run success path, and the
 * executor-throws 400 (the registry + executor + authz are mocked; the rules
 * themselves are tested in src/__tests__/workflow-authz.test.ts).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => {
  const runWorkflow = vi.fn(async () => ({ id: "run-1", status: "success" }));
  return {
    getCachedWorkflows: vi.fn(() => [] as unknown[]),
    getWorkflowExecutor: vi.fn(() => ({ runWorkflow })),
    runWorkflow,
  };
});
const authz = vi.hoisted(() => ({
  canRunWorkflow: vi.fn(async () => ({ allowed: true }) as { allowed: boolean; reason?: string }),
}));
// `callerFor` resolves the caller's project memberships once per request,
// so the read/run ladder can answer a project-SCOPED row. Every entry here
// is `system`, so the set is never consulted — but the resolve still
// happens and would otherwise reach a real `getDb()`.
const members = vi.hoisted(() => ({
  listProjectIdsForUser: vi.fn(async () => [] as string[]),
}));
vi.mock("$lib/server/context", () => ({
  getCachedWorkflows: ctx.getCachedWorkflows,
  getWorkflowExecutor: ctx.getWorkflowExecutor,
}));
vi.mock("$server/runtime/workflow-authz", () => authz);
vi.mock("$server/db/queries/project-members", () => members);

import { POST } from "../routes/api/workflows/[name]/run/+server";
import { expectThrownResponse, makeRequestEvent } from "./helpers/server-route-test-utils";

/** The definition the executor should receive, unwrapped from its entry. */
const W1 = { name: "w1", description: "", steps: [] };

/** A `system` entry — what every pre-C6 row migrates to, and the reason
 *  adding the ladder changed no existing caller's access. */
function systemEntry(definition = W1) {
  return {
    definition,
    source: "db",
    id: "wf-1",
    projectId: null,
    userId: null,
    visibility: "system",
    forkedFrom: null,
  };
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([]);
  ctx.runWorkflow.mockReset().mockResolvedValue({ id: "run-1", status: "success" });
  ctx.getWorkflowExecutor.mockReset().mockReturnValue({ runWorkflow: ctx.runWorkflow });
  authz.canRunWorkflow.mockReset().mockResolvedValue({ allowed: true });
});

function makeEvent(opts: {
	name?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	headers?: Record<string, string>;
}) {
	const name = opts.name ?? "does-not-exist";
	return makeRequestEvent(`http://localhost/api/workflows/${name}/run`, {
	  locals: opts.locals ?? {},
	  params: { name },
	  request: {
			method: "POST",
			headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
		},
	});
}

const authedUser = {
	user: { id: "u1", email: "u@x", name: "u", role: "member" },
};

describe("POST /api/workflows/[name]/run", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await POST(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				body: {},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(() => POST(makeEvent({ body: {} })), 401);
		expect(res.status).toBe(401);
	});

	test("returns 404 when the workflow is not in the registry", async () => {
		ctx.getCachedWorkflows.mockReturnValue([]);
		const res = await POST(makeEvent({ name: "missing", locals: authedUser, body: {} }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Workflow not found");
	});

	test("returns 403 with the deny reason when authorization refuses the run", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		authz.canRunWorkflow.mockResolvedValue({
			allowed: false,
			reason: 'Workflow "w1" is owned by another user',
		});
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('Workflow "w1" is owned by another user');
		expect(ctx.runWorkflow).not.toHaveBeenCalled();
	});

	test("authorizes the resolved ENTRY, not a re-lookup by name", async () => {
		// The object handed to the gate must be the one the executor will
		// run — on a YAML/DB name collision a re-lookup would authorize a
		// different graph than the one that executes. It is the cache ENTRY,
		// not the bare definition: the ladder reads the owner and visibility
		// that only the entry carries.
		const resolved = { name: "w1", description: "", steps: [], source: "yaml" };
		const cacheEntry = systemEntry(resolved);
		ctx.getCachedWorkflows.mockReturnValue([cacheEntry]);
		await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(authz.canRunWorkflow).toHaveBeenCalledWith(cacheEntry, authedUser.user, undefined);
	});

	test("a refused run never reaches the executor", async () => {
		// Replaces upstream's "the authorization gate runs BEFORE the body is
		// parsed". That ordering is not reachable here: this gate takes the
		// definition `resolveWorkflowOr` returns, and the ladder needs the
		// `projectId` that only exists once the body is parsed. The property
		// upstream bought with the early check — a denied caller cannot tell
		// a malformed body from a well-formed one — was already spent by the
		// ladder's own post-parse 404. What must still hold, and does, is
		// that a refusal stops the side effect.
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		authz.canRunWorkflow.mockResolvedValue({ allowed: false, reason: "nope" });
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(res.status).toBe(403);
		expect(ctx.runWorkflow).not.toHaveBeenCalled();
	});

	test("returns 400 when the body fails the schema (non-string projectId)", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: { projectId: 123 } }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Invalid request body");
	});

	test("runs the workflow (with projectId + input) and returns the run", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		const res = await POST(
			makeEvent({ name: "w1", locals: authedUser, body: { projectId: "proj-1", topic: "x" } }),
		);
		expect(res.status).toBe(200);
		expect(ctx.runWorkflow).toHaveBeenCalledWith(W1, { topic: "x" }, "proj-1", "u1");
		expect((await res.json()) as { id?: string }).toMatchObject({ id: "run-1" });
	});

	test("runs with no projectId (undefined passed through)", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: { topic: "y" } }));
		expect(res.status).toBe(200);
		expect(ctx.runWorkflow).toHaveBeenCalledWith(W1, { topic: "y" }, undefined, "u1");
	});

	test("a system workflow runs for any chat caller — byte-identical to pre-C6", async () => {
		// Acceptance criterion 2: every row that exists at migration time is
		// `system`, and `system` authorizes exactly who could run it before
		// the ladder existed. Asserted for a plain member with no project.
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(res.status).toBe(200);
		expect(ctx.runWorkflow).toHaveBeenCalledTimes(1);
	});

	test("a private workflow the caller does not own is 404, and never dispatches", async () => {
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...systemEntry(), visibility: "private", userId: "someone-else" },
		]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(res.status).toBe(404);
		expect((await res.json()) as { error?: string }).toEqual({ error: "Workflow not found" });
		expect(ctx.runWorkflow).not.toHaveBeenCalled();
	});

	test("returns 400 with the error message when the executor throws", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		ctx.runWorkflow.mockRejectedValue(new Error("boom"));
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: {} }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("boom");
	});
});

/**
 * `X-EZ-Workflow-Async: 1` — the opt-in non-blocking run.
 *
 * The compatibility ledger's claim is that the ABSENT header leaves every
 * existing caller byte-identical, so the cases above are the other half of
 * this block: they all run without the header and must keep passing
 * unchanged.
 */
describe("POST /api/workflows/[name]/run — X-EZ-Workflow-Async", () => {
	test("with the header: 202, a run id, and the response does NOT wait for the run", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		// A run that never settles. If the handler awaited it, this test
		// would time out rather than fail — which is the point: the property
		// is "does not block", and only a never-resolving run can prove it.
		ctx.runWorkflow.mockReturnValue(new Promise(() => {}));

		const res = await POST(
			makeEvent({
				name: "w1",
				locals: authedUser,
				body: { topic: "x" },
				headers: { "X-EZ-Workflow-Async": "1" },
			}),
		);

		expect(res.status).toBe(202);
		const body = (await res.json()) as { id?: string; status?: string };
		expect(body.status).toBe("running");
		expect(typeof body.id).toBe("string");
		// The id in the 202 is the id the executor was told to use — a
		// response naming a different run than the one that started would be
		// worse than no id at all.
		const call = ctx.runWorkflow.mock.calls[0] as unknown as unknown[];
		expect(call[5]).toEqual({ runId: body.id });
	});

	test("the header only counts as opt-in when it is exactly \"1\"", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		for (const value of ["0", "false", "true", "yes", ""]) {
			ctx.runWorkflow.mockClear();
			const res = await POST(
				makeEvent({
					name: "w1",
					locals: authedUser,
					body: {},
					headers: { "X-EZ-Workflow-Async": value },
				}),
			);
			// A header that accepted "0" as async is the sort of thing nobody
			// notices until a workflow they expected to have finished has not.
			expect(res.status).toBe(200);
			expect((ctx.runWorkflow.mock.calls[0] as unknown as unknown[]).length).toBe(4);
		}
	});

	test("without the header the executor is called with the UNCHANGED positional signature", async () => {
		// The ledger's core claim, asserted rather than asserted-in-prose:
		// no sixth argument, so the CLI / trigger / demo callers see exactly
		// what they saw before.
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		await POST(makeEvent({ name: "w1", locals: authedUser, body: { topic: "z" } }));
		expect(ctx.runWorkflow).toHaveBeenCalledWith(W1, { topic: "z" }, undefined, "u1");
	});

	test("an async run that rejects does not become an unhandled rejection", async () => {
		ctx.getCachedWorkflows.mockReturnValue([systemEntry()]);
		ctx.runWorkflow.mockRejectedValue(new Error("executor exploded"));

		const res = await POST(
			makeEvent({
				name: "w1",
				locals: authedUser,
				body: {},
				headers: { "X-EZ-Workflow-Async": "1" },
			}),
		);

		// Still 202 — the run was accepted; its failure is recorded on the
		// row, not in this response. An unhandled rejection here would take
		// the process down along with every other run in flight.
		expect(res.status).toBe(202);
		await new Promise((r) => setTimeout(r, 10));
	});
});
