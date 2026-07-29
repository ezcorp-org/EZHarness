/**
 * Server-handler unit tests for /api/workflows/[name]/+server.ts.
 *
 * Covers the scope/auth gates, the strict-body + definition-time validation
 * rejections, and the GET/PUT/DELETE success + 404 branches (the workflow
 * registry + DB query layer are mocked).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  // The cache now carries provenance — a bare `WorkflowDefinition` has
  // nothing to authorize against, so the routes read this instead.
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  getWorkflowByName: vi.fn(async (_name: string) => undefined as { id: string } | undefined),
  updateWorkflow: vi.fn(async (_id: string, _data: unknown) => undefined as unknown),
  deleteWorkflow: vi.fn(async (_id: string) => true),
  WorkflowNameConflictError: class extends Error {},
}));
const versions = vi.hoisted(() => ({
  ensureWorkflowVersion: vi.fn(async () => ({ version: { version: 1 }, minted: false })),
}));
vi.mock("$lib/server/context", () => ctx);
vi.mock("$server/db/queries/workflows", () => queries);
vi.mock("$server/db/queries/workflow-versions", () => versions);

import { GET, PUT, DELETE } from "../routes/api/workflows/[name]/+server";

/** A cache entry the authed member below OWNS, so it is editable. */
function ownedEntry(name = "w1") {
	return {
		definition: { name, description: "", steps: [] },
		source: "db",
		id: "wf-1",
		projectId: null,
		userId: "u1",
		visibility: "project",
		forkedFrom: null,
	};
}

beforeEach(() => {
  ctx.getCachedWorkflows.mockReset().mockReturnValue([]);
  ctx.reloadWorkflows.mockReset().mockResolvedValue(undefined);
  queries.getWorkflowByName.mockReset().mockResolvedValue(undefined);
  queries.updateWorkflow.mockReset().mockResolvedValue(undefined);
  queries.deleteWorkflow.mockReset().mockResolvedValue(true);
  versions.ensureWorkflowVersion.mockReset().mockResolvedValue({ version: { version: 1 }, minted: false });
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
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry("w1")]);
		const res = await GET(makeEvent({ name: "w1", locals: { ...authedUser, apiKeyScopes: ["read"] } }));
		expect(res.status).toBe(200);
		// Additively wrapped now: the definition plus the provenance the
		// editor needs to decide whether to offer Edit.
		expect((await res.json()) as { name?: string }).toMatchObject({
			name: "w1",
			source: "db",
			visibility: "project",
			canEdit: true,
		});
	});

	test("returns 404 when the workflow is not in the registry", async () => {
		ctx.getCachedWorkflows.mockReturnValue([]);
		const res = await GET(makeEvent({ name: "missing", locals: authedUser }));
		expect(res.status).toBe(404);
	});

	test("returns 404 — not 403 — for a workflow the caller may not see", async () => {
		// The endpoint must not be an existence oracle: an unauthorized read
		// is indistinguishable from a missing workflow.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry("secret"), visibility: "private", userId: "someone-else" },
		]);
		const res = await GET(makeEvent({ name: "secret", locals: authedUser }));
		expect(res.status).toBe(404);
		expect((await res.json()) as { error?: string }).toEqual({ error: "Not found" });
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

	test("returns 400 for a malformed defaultModel, even with no steps in the body", async () => {
		// This route is a PARTIAL update, so a defaultModel-only body has no
		// step list to hand the whole-definition validator — it is checked on
		// its own, or it would slip through unvalidated.
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { defaultModel: { effort: "turbo" } },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toContain('Workflow "defaultModel" "effort" must be one of');
		// Rejected before any DB work.
		expect(queries.getWorkflowByName).not.toHaveBeenCalled();
	});

	test("forwards a valid defaultModel to the update", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1" });
		const res = await PUT(
			makeEvent({
				locals: authedUser,
				method: "PUT",
				body: { defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" } },
			}),
		);
		expect(res.status).toBe(200);
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", {
			defaultModel: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
		});
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
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue(undefined);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found (only DB workflows can be updated)");
	});

	test("returns 403 when the caller may not edit a system workflow", async () => {
		// The deliberate tightening: every pre-existing row is `system`, and
		// `system` is admin-only to edit. A 403 (not 404) because the caller
		// can already see it — there is nothing left to conceal.
		ctx.getCachedWorkflows.mockReturnValue([{ ...ownedEntry(), visibility: "system", userId: null }]);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(403);
		expect((await res.json()) as { error?: string }).toMatchObject({
			error: expect.stringContaining("admin"),
		});
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("returns 409 when a rename collides with an existing name", async () => {
		// Unreachable before the editor made renaming ordinary; it used to
		// surface as an unhandled 500 from the unique index.
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockRejectedValue(new queries.WorkflowNameConflictError("taken"));
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { name: "taken" } }),
		);
		expect(res.status).toBe(409);
	});

	test("an unrelated update failure is re-thrown, never mislabelled a 409", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockRejectedValue(new Error("disk full"));
		await expect(
			PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } })),
		).rejects.toThrow("disk full");
	});

	test("returns 404 when the update itself resolves to nothing", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue(undefined);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(404);
	});

	test("updates a DB workflow, reloads, and returns the updated row", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
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
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue(undefined);
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Not found (only DB workflows can be deleted)");
	});

	test("deletes a DB workflow, reloads, and returns ok", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(200);
		expect(queries.deleteWorkflow).toHaveBeenCalledWith("wf-1");
		expect(ctx.reloadWorkflows).toHaveBeenCalledTimes(1);
		expect((await res.json()) as { ok?: boolean }).toEqual({ ok: true });
	});
});
