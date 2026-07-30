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
    getWorkflows: vi.fn(() => [] as Array<{ name: string }>),
    getWorkflowExecutor: vi.fn(() => ({ runWorkflow })),
    runWorkflow,
  };
});
vi.mock("$lib/server/context", () => ({
  getWorkflows: ctx.getWorkflows,
  getWorkflowExecutor: ctx.getWorkflowExecutor,
}));

import { POST } from "../routes/api/workflows/[name]/run/+server";

beforeEach(() => {
  ctx.getWorkflows.mockReset().mockReturnValue([]);
  ctx.runWorkflow.mockReset().mockResolvedValue({ id: "run-1", status: "success" });
  ctx.getWorkflowExecutor.mockReset().mockReturnValue({ runWorkflow: ctx.runWorkflow });
});

function makeEvent(opts: {
	name?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	headers?: Record<string, string>;
}) {
	const name = opts.name ?? "does-not-exist";
	return {
		url: new URL(`http://localhost/api/workflows/${name}/run`),
		locals: opts.locals ?? {},
		params: { name },
		request: new Request(`http://localhost/api/workflows/${name}/run`, {
			method: "POST",
			headers: { "content-type": "application/json", ...(opts.headers ?? {}) },
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
		ctx.getWorkflows.mockReturnValue([]);
		const res = await POST(makeEvent({ name: "missing", locals: authedUser, body: {} }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Workflow not found");
	});

	test("returns 400 when the body fails the schema (non-string projectId)", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: { projectId: 123 } }));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Invalid request body");
	});

	test("runs the workflow (with projectId + input) and returns the run", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
		const res = await POST(
			makeEvent({ name: "w1", locals: authedUser, body: { projectId: "proj-1", topic: "x" } }),
		);
		expect(res.status).toBe(200);
		expect(ctx.runWorkflow).toHaveBeenCalledWith({ name: "w1" }, { topic: "x" }, "proj-1", "u1");
		expect((await res.json()) as { id?: string }).toMatchObject({ id: "run-1" });
	});

	test("runs with no projectId (undefined passed through)", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
		const res = await POST(makeEvent({ name: "w1", locals: authedUser, body: { topic: "y" } }));
		expect(res.status).toBe(200);
		expect(ctx.runWorkflow).toHaveBeenCalledWith({ name: "w1" }, { topic: "y" }, undefined, "u1");
	});

	test("returns 400 with the error message when the executor throws", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
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
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
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
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
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
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
		await POST(makeEvent({ name: "w1", locals: authedUser, body: { topic: "z" } }));
		expect(ctx.runWorkflow).toHaveBeenCalledWith({ name: "w1" }, { topic: "z" }, undefined, "u1");
	});

	test("an async run that rejects does not become an unhandled rejection", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
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
