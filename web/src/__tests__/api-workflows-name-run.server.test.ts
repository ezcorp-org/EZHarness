/**
 * Server-handler unit tests for /api/workflows/[name]/run/+server.ts.
 *
 * Covers the scope gate, the auth gate, the 404 "Workflow not found" branch,
 * the strict-body 400, the run success path, and the executor-throws 400
 * (the registry + executor are mocked).
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
vi.mock("$lib/server/context", () => ({
  getCachedWorkflows: ctx.getCachedWorkflows,
  getWorkflowExecutor: ctx.getWorkflowExecutor,
}));

import { POST } from "../routes/api/workflows/[name]/run/+server";

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
});

function makeEvent(opts: {
	name?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
}) {
	const name = opts.name ?? "does-not-exist";
	return {
		url: new URL(`http://localhost/api/workflows/${name}/run`),
		locals: opts.locals ?? {},
		params: { name },
		request: new Request(`http://localhost/api/workflows/${name}/run`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : "{}",
		}),
	} as any;
}

async function expectThrownResponse(
	fn: () => Promise<Response> | Response,
	status: number,
): Promise<Response> {
	let res: Response | undefined;
	try {
		res = await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		res = thrown as Response;
	}
	expect(res!.status).toBe(status);
	return res!;
}

const authedUser = {
	user: { id: "u1", email: "u@x", name: "u", role: "user" },
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
