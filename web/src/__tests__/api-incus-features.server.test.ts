import { beforeEach, expect, test, vi } from "vitest";
import { projects, sandboxBindings, sandboxOperations } from "$server/db/schema";

const calls: string[] = [];
let qualified = false;
let failWith: unknown = null;
let projectExists = true;
let bindingExists = true;
let operationExists = true;
const binding = { id: "binding-a", projectId: "project-a" };
const operation = { id: "operation-a", state: "DISPATCHING" };
const database = {
	select() {
		let source: unknown;
		const query = {
			from(table: unknown) { source = table; return query; },
			where() { return query; },
			orderBy() { return query; },
			limit: async () => source === projects ? (projectExists ? [{ id: "project-a" }] : [])
				: source === sandboxBindings ? (bindingExists ? [binding] : [])
				: source === sandboxOperations ? (operationExists ? [operation] : []) : [],
		};
		return query;
	},
};

vi.mock("$server/auth/middleware", () => ({
	requireAdminSession: (locals: { user?: { id: string; role: string }; authMethod?: string }) =>
		locals.user?.role === "admin" && locals.authMethod === "session" ? locals.user
			: Response.json({}, { status: locals.user ? 403 : 401 }),
	checkProjectRole: async (locals: { deniedProject?: boolean }, _projectId: string, role: string) => {
		calls.push(`role:${role}`);
		return locals.deniedProject ? Response.json({}, { status: 403 }) : { id: "admin" };
	},
}));
vi.mock("$server/db/connection", () => ({ getDb: () => database }));
vi.mock("$server/infrastructure/incus-qualification", () => ({
	IncusQualificationStore: class { async load() { calls.push("qualification"); return qualified ? { ready: true } : null; } },
}));
vi.mock("$server/infrastructure/incus-feature-service", () => ({
	IncusFeatureService: class {
		constructor(private readonly deps: { loadQualification: () => Promise<unknown> }) {}
		async prepare(input: { projectId: string }) {
			calls.push(`prepare:${input.projectId}`);
			if (!await this.deps.loadQualification()) throw new Error("qualification unavailable");
			return binding;
		}
		async create(input: { idempotencyKey: string }) {
			calls.push(`create:${input.idempotencyKey}`);
			if (failWith) throw failWith;
			return input.idempotencyKey === "denied" ? { state: "REJECTED", reason: "capacity" } : { state: "DISPATCHED", operation };
		}
		async start(input: { bindingId: string }) { calls.push(`start:${input.bindingId}`); return { state: "QUEUED", operation }; }
		async stop(input: { bindingId: string }) { calls.push(`stop:${input.bindingId}`); return operation; }
		async destroy(input: { bindingId: string }) { calls.push(`destroy:${input.bindingId}`); return operation; }
		async destroyRetired(input: { bindingId: string }) { calls.push(`destroyRetired:${input.bindingId}`); return operation; }
		async reconcile(limit?: number) { calls.push(`reconcile:${limit}`); return { processed: 0 }; }
	},
}));

const { POST } = await import("../routes/api/infrastructure/incus/features/+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
function event(body: unknown, locals: Record<string, unknown> = admin, origin: string | null = "http://localhost", contentType = "application/json"): Parameters<typeof POST>[0] {
	return { locals, request: new Request("http://localhost/api/infrastructure/incus/features", {
		method: "POST", headers: { "content-type": contentType, ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
	}) } as unknown as Parameters<typeof POST>[0];
}
const mutation = { projectId: "project-a", bindingId: "binding-a", idempotencyScope: "scope-a", idempotencyKey: "key-a" };

beforeEach(() => { calls.length = 0; qualified = false; failWith = null; projectExists = true; bindingExists = true; operationExists = true; });

test("denies non-admin, cross-origin, and non-JSON requests before effects", async () => {
	expect((await POST(event({ action: "reconcile" }, {}))).status).toBe(401);
	expect((await POST(event({ action: "reconcile" }, { ...admin, authMethod: "api-key" }))).status).toBe(403);
	expect((await POST(event({ action: "reconcile" }, admin, "https://other.example"))).status).toBe(403);
	expect((await POST(event({ action: "reconcile" }, admin, null))).status).toBe(403);
	expect((await POST(event({ action: "reconcile" }, admin, "http://localhost", "text/plain"))).status).toBe(400);
	expect(calls).toEqual([]);
});

test("rejects malformed action shapes and identifiers", async () => {
	for (const body of [null, [], {}, { action: "unknown" }, { action: "prepare", projectId: "bad/id", installationId: "i", connectionId: "c", presetId: "p" },
		{ action: "create", ...mutation, qualification: "forged" }, { action: "create", ...mutation, idempotencyKey: "" },
		{ action: "reconcile", limit: 0 }, { action: "reconcile", limit: 101 }, { action: "reconcile", limit: 1.5 }]) {
		expect((await POST(event(body))).status).toBe(400);
	}
	expect(calls).toEqual([]);
});

test("requires project membership, a real project, and a matching binding", async () => {
	expect((await POST(event({ action: "create", ...mutation }, { ...admin, deniedProject: true }))).status).toBe(403);
	projectExists = false;
	expect((await POST(event({ action: "create", ...mutation }))).status).toBe(404);
	projectExists = true;
	bindingExists = false;
	expect((await POST(event({ action: "create", ...mutation }))).status).toBe(404);
	bindingExists = true;
	expect((await POST(event({ action: "create", ...mutation, projectId: "other" }))).status).toBe(404);
	expect(calls.filter(call => call.startsWith("create:"))).toEqual([]);
});

test("prepare needs host qualification and returns the prepared binding", async () => {
	const input = { action: "prepare", projectId: "project-a", installationId: "install-a", connectionId: "connection-a", presetId: "preset-a" };
	expect((await POST(event(input))).status).toBe(409);
	qualified = true;
	const response = await POST(event(input));
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ binding });
	expect(calls).toEqual(["role:member", "prepare:project-a", "qualification", "role:member", "prepare:project-a", "qualification"]);
});

test("reports status and dispatches each mutation with its result status", async () => {
	const status = await POST(event({ action: "status", projectId: "project-a", bindingId: "binding-a" }));
	expect(await status.json()).toEqual({ binding, operation });
	operationExists = false;
	expect(await (await POST(event({ action: "status", projectId: "project-a", bindingId: "binding-a" }))).json()).toEqual({ binding, operation: null });
	for (const [action, expected] of [["create", 202], ["start", 202], ["stop", 202], ["destroy", 202], ["destroyRetired", 202]] as const) {
		expect((await POST(event({ action, ...mutation }))).status).toBe(expected);
	}
	expect((await POST(event({ action: "create", ...mutation, idempotencyKey: "denied" }))).status).toBe(409);
	expect(calls).toContain("destroyRetired:binding-a");
	expect(calls).toContain("destroy:binding-a");
});

test("reconcile accepts an optional bounded limit and hides unexpected errors", async () => {
	expect(await (await POST(event({ action: "reconcile" }))).json()).toEqual({ result: { processed: 0 } });
	expect(await (await POST(event({ action: "reconcile", limit: 5 }))).json()).toEqual({ result: { processed: 0 } });
	failWith = new Error("database secret");
	expect(await (await POST(event({ action: "create", ...mutation }))).json()).toMatchObject({ code: "feature_failed" });
	failWith = "opaque";
	expect(await (await POST(event({ action: "create", ...mutation }))).json()).toMatchObject({ code: "feature_failed" });
	expect(calls).toContain("reconcile:5");
});
