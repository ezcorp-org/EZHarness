/**
 * Server-handler unit tests for /api/workflows/[name]/+server.ts.
 *
 * Covers the scope/auth gates, the owner-or-admin gate on PUT/DELETE, the
 * strict-body + definition-time validation rejections, and the
 * GET/PUT/DELETE success + 404 branches (the workflow registry + DB query
 * layer are mocked; the ownership rule itself is tested in
 * src/__tests__/workflow-authz.test.ts).
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

const ctx = vi.hoisted(() => ({
  // The cache now carries provenance — a bare `WorkflowDefinition` has
  // nothing to authorize against, so the routes read this instead.
  getCachedWorkflows: vi.fn(() => [] as unknown[]),
  reloadWorkflows: vi.fn(async () => {}),
}));
const queries = vi.hoisted(() => ({
  getWorkflowByName: vi.fn(
    async (_name: string) => undefined as { id: string; createdBy?: string | null } | undefined,
  ),
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
	user: { id: "u1", email: "u@x", name: "u", role: "member" },
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
		// Additively wrapped: the definition plus the provenance the editor
		// needs to decide whether to offer Edit. The detail route serves the
		// SAME shape as the list — a workflow must not gain or lose a field
		// depending on which route returned it.
		expect((await res.json()) as { name?: string }).toMatchObject({
			name: "w1",
			source: "db",
			visibility: "project",
			canEdit: true,
		});
	});

	test("reports canEdit false for a workflow this caller may see but not write", async () => {
		// `system` is readable by anyone and admin-only to EDIT, so this is
		// the case where the two answers diverge — exactly what the flag is for.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry("w1"), visibility: "system", userId: null },
		]);
		const res = await GET(makeEvent({ name: "w1", locals: authedUser }));
		expect((await res.json()) as { canEdit?: boolean }).toMatchObject({
			name: "w1",
			canEdit: false,
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

	// ── Re-classification (Ruling 1, update path) ──────────────────────
	//
	// Changing an existing workflow's visibility is a re-classification, so
	// the question "who may do it" is asked in two halves. The `edit` gate
	// asks it about the row AS IT STANDS — and for `project` and `private`
	// that already means owner-or-admin, which is what makes tightening
	// safe to allow with no extra rule. The second half is the one value
	// `edit` does not imply: promotion into `system`.

	test("the owner may TIGHTEN their own workflow to private", async () => {
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1" });
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { visibility: "private" } }),
		);
		expect(res.status).toBe(200);
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", { visibility: "private" });
	});

	test("a member may NOT broaden a workflow they do not own", async () => {
		// The denial that matters most: the `edit` ladder refuses before the
		// visibility rule is ever consulted, so someone else's `private` row
		// cannot be broadened to `project` no matter what the body says.
		//
		// 403, not 404 — `denialStatus` returns 403 for every EDIT denial
		// (pre-existing, and pinned by the DELETE case below). Worth being
		// explicit about because the reasoning it rests on — "the caller can
		// already see the workflow by then" — does not hold for `private`,
		// which Ruling 1 has just made reachable for the first time. The
		// authorization is correct; the STATUS is an existence oracle for
		// private workflow names. Out of scope here, flagged deliberately.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry("secret"), visibility: "private", userId: "someone-else" },
		]);
		const res = await PUT(
			makeEvent({
				name: "secret",
				locals: authedUser,
				method: "PUT",
				body: { visibility: "project" },
			}),
		);
		expect(res.status).toBe(403);
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("the owner may NOT promote their own workflow to system", async () => {
		// Tightening is free; promoting into the everyone-can-run,
		// admin-only-to-edit tier is not. Discriminates against a rule that
		// merely allowed whatever cleared `edit`: this caller IS the owner
		// and DID clear `edit`, and is still refused.
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { visibility: "system" } }),
		);
		expect(res.status).toBe(403);
		expect((await res.json()) as { error?: string }).toMatchObject({
			error: "Only an admin can make a workflow system-owned",
		});
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("an admin MAY promote a workflow to system", async () => {
		// Discrimination for the test above — the 403 is keyed on role.
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1" });
		const res = await PUT(
			makeEvent({
				locals: { user: { ...authedUser.user, id: "admin1", role: "admin" } },
				method: "PUT",
				body: { visibility: "system" },
			}),
		);
		expect(res.status).toBe(200);
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", { visibility: "system" });
	});

	test("an update that omits visibility does not re-classify the row", async () => {
		// `updateWorkflow` writes `visibility` only when the key is present,
		// so an ordinary description edit must not carry one. Without this,
		// a route that defaulted the field would silently re-tier every row
		// it touched.
		ctx.getCachedWorkflows.mockReturnValue([ownedEntry()]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1" });
		await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", { description: "d" });
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

	// PUT authorizes through ONE gate: the ladder, via `resolveWorkflowOr`.
	// A second owner-or-admin rule over a `created_by` column used to run
	// after it; it is gone, and these cover the ladder's own refusals.

	test("the CREATOR of a default-visibility (`system`) workflow may update it", async () => {
		// The bug, at the route that has to answer for it. `POST
		// /api/workflows` defaults `visibility` to `system` and stamps the
		// creator, and this PUT used to 403 on that exact row — the ladder
		// refused the tier before it consulted the owner, so a non-admin
		// could not edit the workflow they had just created.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "system", userId: "u1" },
		]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		queries.updateWorkflow.mockResolvedValue({ id: "wf-1", name: "w1", description: "d" });
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(200);
		expect(queries.updateWorkflow).toHaveBeenCalledWith("wf-1", { description: "d" });
	});

	test("the creator of a `system` row still may not re-stamp `system` on it", async () => {
		// The bound on the grant above. Clearing `edit` is not clearing
		// assignment: the same owner, on the same row they just proved they
		// may update, is refused a body that names `system`. Otherwise
		// "the owner may edit their system row" would quietly become "the
		// owner may mint system rows".
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "system", userId: "u1" },
		]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		const res = await PUT(
			makeEvent({ locals: authedUser, method: "PUT", body: { visibility: "system" } }),
		);
		expect(res.status).toBe(403);
		expect((await res.json()) as { error?: string }).toMatchObject({
			error: "Only an admin can make a workflow system-owned",
		});
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("returns 403 when a NON-owner tries to update a system workflow", async () => {
		// The tier still bites for everyone but the owner. `userId: null`
		// is the legacy shape — every row that predates the ownership
		// columns has it, and there is no owner for the ladder to match, so
		// it stays admin-only. A 403 (not 404) because the caller can
		// already see it — there is nothing left to conceal.
		ctx.getCachedWorkflows.mockReturnValue([{ ...ownedEntry(), visibility: "system", userId: null }]);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(403);
		expect((await res.json()) as { error?: string }).toMatchObject({
			error: expect.stringContaining("admin"),
		});
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("returns 403 when someone ELSE owns the system workflow", async () => {
		// Discrimination for the grant: a `system` row with a real owner
		// who is not this caller is refused for the tier's reason, not the
		// owner's. Without this the ownership rung could be "any row with
		// a non-null user_id" and every test above would still pass.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "system", userId: "someone-else" },
		]);
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

	test("returns 403 when the caller does not own the row", async () => {
		// The ladder's own refusal: a `private` row owned by someone else.
		// A 403 rather than a 404 because an EDIT denial has nothing left
		// to conceal — the caller could already see it.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "private", userId: "someone-else" },
		]);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(403);
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
	});

	test("an ORPHANED private row is admin-only, not writable by anyone", async () => {
		// `user_id` is ON DELETE SET NULL, so deleting the owner leaves a
		// private row with a NULL owner. The rule this replaced read that
		// NULL as "unowned — anyone may act", which made a departed
		// employee's private workflow world-writable.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "private", userId: null },
		]);
		const res = await PUT(makeEvent({ locals: authedUser, method: "PUT", body: { description: "d" } }));
		expect(res.status).toBe(403);
		expect(queries.updateWorkflow).not.toHaveBeenCalled();
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

	test("returns 403 when the caller does not own the row", async () => {
		// The ladder's own refusal: a `private` row owned by someone else.
		// A 403 rather than a 404 because an EDIT denial has nothing left
		// to conceal — the caller could already see it.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "private", userId: "someone-else" },
		]);
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(403);
		expect(queries.deleteWorkflow).not.toHaveBeenCalled();
	});

	test("an ORPHANED private row is admin-only, not writable by anyone", async () => {
		// `user_id` is ON DELETE SET NULL, so deleting the owner leaves a
		// private row with a NULL owner. The rule this replaced read that
		// NULL as "unowned — anyone may act", which made a departed
		// employee's private workflow world-writable.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "private", userId: null },
		]);
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(403);
		expect(queries.deleteWorkflow).not.toHaveBeenCalled();
	});

	test("the CREATOR of a default-visibility (`system`) workflow may delete it", async () => {
		// DELETE resolves through the same `edit` rung as PUT, so the fix
		// has to reach both. Asserted separately rather than trusted to
		// the shared helper: "the ladder is the one gate" is a claim about
		// this route, and a route that grew its own second check would
		// still pass the PUT case.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "system", userId: "u1" },
		]);
		queries.getWorkflowByName.mockResolvedValue({ id: "wf-1" });
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(200);
		expect(queries.deleteWorkflow).toHaveBeenCalledWith("wf-1");
	});

	test("a legacy OWNERLESS system row is not deletable by a non-admin", async () => {
		// Same tier, no owner: the row every pre-ownership workflow
		// migrated to stays admin-only, on the destructive path too.
		ctx.getCachedWorkflows.mockReturnValue([
			{ ...ownedEntry(), visibility: "system", userId: null },
		]);
		const res = await DELETE(makeEvent({ locals: authedUser, method: "DELETE" }));
		expect(res.status).toBe(403);
		expect(queries.deleteWorkflow).not.toHaveBeenCalled();
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
