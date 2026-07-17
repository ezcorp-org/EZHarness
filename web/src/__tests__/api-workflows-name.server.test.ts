/**
 * Server-handler unit tests for /api/workflows/[name]/+server.ts.
 *
 * Covers the scope/auth gates, the strict-body + definition-time validation
 * rejections, and the GET/PUT/DELETE success + 404 branches (the workflow
 * registry + DB query layer are mocked).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  getWorkflows: vi.fn(() => [] as Array<{ name: string }>),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  getWorkflowByName: vi.fn(async (_name: string) => undefined as { id: string } | undefined),
  updateWorkflow: vi.fn(async (_id: string, _data: unknown) => undefined as unknown),
  deleteWorkflow: vi.fn(async (_id: string) => true),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);

import { GET, PUT, DELETE } from "../routes/api/workflows/[name]/+server";

beforeEach(() => {
  ctx.getWorkflows.mockReset().mockReturnValue([]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.getWorkflowByName.mockReset().mockResolvedValue(undefined);
  queries.updateWorkflow.mockReset().mockResolvedValue(undefined);
  queries.deleteWorkflow.mockReset().mockResolvedValue(true);
});

function makeEvent(opts: {
	name?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
	method?: string;
}) {
	const name = opts.name ?? "w1";
	return {
		url: new URL(`http://localhost/api/workflows/${name}`),
		locals: opts.locals ?? {},
		params: { name },
		request: new Request(`http://localhost/api/workflows/${name}`, {
			method: opts.method ?? "GET",
			headers: { "content-type": "application/json" },
			body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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

describe("GET /api/workflows/[name]", () => {
	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["chat"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("read");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({ locals: {} })), 401);
		expect(res.status).toBe(401);
	});

	test("returns the workflow when it exists", async () => {
		ctx.getWorkflows.mockReturnValue([{ name: "w1" }]);
		const res = await GET(makeEvent({ name: "w1", locals: { ...authedUser, apiKeyScopes: ["read"] } }));
		expect(res.status).toBe(200);
		expect((await res.json()) as { name?: string }).toEqual({ name: "w1" });
	});

	test("returns 404 when the workflow is not in the registry", async () => {
		ctx.getWorkflows.mockReturnValue([]);
		const res = await GET(makeEvent({ name: "missing", locals: authedUser }));
		expect(res.status).toBe(404);
	});
});

describe("PUT /api/workflows/[name]", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await PUT(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				method: "PUT",
				body: { steps: [] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { required?: string };
		expect(body.required).toBe("chat");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => PUT(makeEvent({ locals: {}, method: "PUT", body: {} })),
			401,
		);
		expect(res.status).toBe(401);
	});

	test("returns 400 when replacement steps fail definition-time validation", async () => {
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { steps: [{ name: "g", kind: "gate" }] },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe('Step "g" (kind "gate") requires a "condition"');
	});

	test("returns 400 when the body fails the strict schema", async () => {
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { bogus: true } }),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Invalid request body");
	});

	test("returns 404 when the named workflow is not a DB workflow", async () => {
		queries.getWorkflowByName.mockResolvedValue(undefined);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found (only DB workflows can be updated)");
	});

	test("returns 404 when the update itself resolves to nothing", async () => {
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue(undefined);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(404);
	});

	test("updates a DB workflow, reloads, and returns the updated row", async () => {
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1", description: "new" });
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { description: "new" } }),
		);
		expect(res.status).toBe(200);
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", { description: "new" });
		expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
		expect((await res.json()) as { description?: string }).toMatchObject({ description: "new" });
	});
});

describe("DELETE /api/workflows/[name]", () => {
	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await DELETE(
			makeEvent({
				locals: { ...authedUser, apiKeyScopes: ["read"] },
				method: "DELETE",
			}),
		);
		expect(res.status).toBe(403);
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => DELETE(makeEvent({ locals: {}, method: "DELETE" })),
			401,
		);
		expect(res.status).toBe(401);
	});

	test("returns 404 when the named workflow is not a DB workflow", async () => {
		queries.getWorkflowByName.mockResolvedValue(undefined);
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found (only DB workflows can be deleted)");
	});

	test("deletes a DB workflow, reloads, and returns ok", async () => {
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(200);
		expect(queries.deleteWorkflow).toHaveBeenCalledWith("wf-1");
		expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
		expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
	});
});
