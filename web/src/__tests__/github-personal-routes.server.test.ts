import { beforeEach, describe, expect, test, vi } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

const mocks = vi.hoisted(() => ({
	status: vi.fn(), disconnect: vi.fn(), authorize: vi.fn(), complete: vi.fn(),
	list: vi.fn(), check: vi.fn(), create: vi.fn(),
	getRun: vi.fn(), prepare: vi.fn(), getReview: vi.fn(), confirm: vi.fn(), importRepo: vi.fn(),
}));

vi.mock("$server/integrations/github-user/broker", () => ({
	getConnectionStatus: mocks.status, disconnect: mocks.disconnect,
	startAuthorization: mocks.authorize, completeAuthorization: mocks.complete,
	listAccessibleRepositories: mocks.list, checkRepository: mocks.check,
}));
vi.mock("$server/integrations/github-personal-prs/service", () => ({
	PersonalPrError: class PersonalPrError extends Error {
		constructor(public code: string, message: string) { super(message); }
	},
	getPersonalPrForRun: mocks.getRun, preparePersonalPr: mocks.prepare,
	getPersonalPrForReviewId: mocks.getReview, confirmPersonalPr: mocks.confirm,
	importApprovedRepository: mocks.importRepo,
}));
vi.mock("$server/runtime/sandbox/controller", () => ({ getSandboxController: () => ({ createSandboxProject: mocks.create }) }));
vi.mock("$lib/server/sandbox-route", () => ({
	LOCAL_MVP_LIMITS: { memoryBytes: 1 }, statusDto: (value: unknown) => value,
	sandboxError: () => Response.json({ error: "Sandbox unavailable" }, { status: 503 }),
}));

const connection = await import("../routes/api/github/connection/+server");
const authorize = await import("../routes/api/github/authorize/+server");
const callback = await import("../routes/api/github/callback/+server");
const repositories = await import("../routes/api/github/repositories/+server");
const check = await import("../routes/api/github/repositories/check/+server");
const sandboxes = await import("../routes/api/github/sandboxes/+server");
const run = await import("../routes/api/github/personal-prs/runs/[runId]/+server");
const prepare = await import("../routes/api/github/personal-prs/runs/[runId]/prepare/+server");
const review = await import("../routes/api/github/personal-prs/proposals/[id]/+server");
const confirm = await import("../routes/api/github/personal-prs/proposals/[id]/confirm/+server");
const importRepo = await import("../routes/api/github/personal-prs/sandboxes/[projectId]/import/+server");
const { personalPrRouteError } = await import("../routes/api/github/personal-prs/_route");
const { PersonalPrError } = await import("$server/integrations/github-personal-prs/service");

const user = { id: "owner-1", email: "owner@example.test", name: "Owner", role: "user" };
const uuid = "00000000-0000-4000-8000-000000000001";
const digest = "a".repeat(64);
const view = { state: "ready", proposalId: uuid, digest, files: [] };
type Handler = (event: any) => Promise<Response> | Response;

function event(path: string, method = "GET", body?: string, locals: Record<string, unknown> = { user, authMethod: "session", sessionId: "session-1" }, params: Record<string, string> = {}) {
	return makeRequestEvent(`http://localhost${path}`, {
		locals, params,
		request: { method, ...(body === undefined ? {} : { body, headers: { "content-type": "application/json" } }) },
	});
}

async function call(handler: Handler, path: string, method = "GET", body?: string, locals?: Record<string, unknown>, params?: Record<string, string>) {
	return handler(event(path, method, body, locals, params));
}

const routes: Array<[string, Handler, string, string?, Record<string, string>?]> = [
	["connection GET", connection.GET, "/api/github/connection"],
	["connection DELETE", connection.DELETE, "/api/github/connection", "DELETE"],
	["authorize", authorize.POST, "/api/github/authorize", "POST"],
	["callback", callback.GET, "/api/github/callback?code=c&state=s"],
	["repositories", repositories.GET, "/api/github/repositories"],
	["check", check.GET, "/api/github/repositories/check?repositoryId=123"],
	["sandbox", sandboxes.POST, "/api/github/sandboxes", "POST"],
	["run", run.GET, "/api/github/personal-prs/runs/r1", "GET", { runId: "r1" }],
	["prepare", prepare.POST, "/api/github/personal-prs/runs/r1/prepare", "POST", { runId: "r1" }],
	["review", review.GET, `/api/github/personal-prs/proposals/${uuid}`, "GET", { id: uuid }],
	["confirm", confirm.POST, `/api/github/personal-prs/proposals/${uuid}/confirm`, "POST", { id: uuid }],
	["import", importRepo.POST, "/api/github/personal-prs/sandboxes/p1/import", "POST", { projectId: "p1" }],
];

beforeEach(() => {
	for (const mock of Object.values(mocks)) mock.mockReset();
	mocks.status.mockResolvedValue({ configured: true, status: "connected" });
	mocks.disconnect.mockResolvedValue({ status: "disconnected" });
	mocks.authorize.mockResolvedValue({ authorizeUrl: "https://github.com/login/oauth/authorize?state=s" });
	mocks.complete.mockResolvedValue({ account: { id: 1, login: "owner" } });
	mocks.list.mockResolvedValue([{ id: 123, fullName: "owner/repo" }]);
	mocks.check.mockResolvedValue({ status: "ready", repository: { id: 123, fullName: "owner/repo" } });
	mocks.create.mockResolvedValue({ projectId: "p1" });
	for (const mock of [mocks.getRun, mocks.prepare, mocks.getReview, mocks.confirm]) mock.mockResolvedValue(view);
	mocks.importRepo.mockResolvedValue({ projectId: "p1", importState: "ready" });
});

describe("personal GitHub session boundary", () => {
	for (const [name, handler, path, method, params] of routes) {
		test(`${name} rejects an absent user and an API key before service access`, async () => {
			const body = method === "GET" || method === undefined ? undefined : "{}";
			const anonymous = await call(handler, path, method, body, {}, params);
			expect(anonymous.status).toBe(401);
			const apiKey = await call(handler, path, method, body, { user, authMethod: "api-key", sessionId: "session-1" }, params);
			expect(apiKey.status).toBe(403);
			expect(Object.values(mocks).every((mock) => mock.mock.calls.length === 0)).toBe(true);
		});
	}

	test("connection endpoints use only the session owner and return no-store DTOs", async () => {
		const get = await call(connection.GET, "/api/github/connection?userId=other");
		expect(await get.json()).toEqual({ configured: true, status: "connected" });
		expect(get.headers.get("cache-control")).toBe("no-store");
		expect(mocks.status).toHaveBeenCalledWith({ userId: user.id });
		const del = await call(connection.DELETE, "/api/github/connection", "DELETE");
		expect(await del.json()).toEqual({ status: "disconnected" });
		expect(del.headers.get("cache-control")).toBe("no-store");
		expect(mocks.disconnect).toHaveBeenCalledWith({ userId: user.id });
	});

	test("connection service failures do not expose exception text", async () => {
		mocks.status.mockRejectedValue(new Error("secret"));
		mocks.disconnect.mockRejectedValue(new Error("secret"));
		for (const [handler, method] of [[connection.GET, "GET"], [connection.DELETE, "DELETE"]] as const) {
			const res = await call(handler, "/api/github/connection", method);
			expect(res.status).toBe(503);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(JSON.stringify(await res.json())).not.toContain("secret");
		}
	});

	test("authorization binds session and only accepts a review UUID", async () => {
		for (const body of ["{", `"${"x".repeat(1025)}"`, JSON.stringify({ returnReviewId: "../../evil" }), JSON.stringify({ returnTo: "https://evil.test" })]) {
			expect((await call(authorize.POST, "/api/github/authorize", "POST", body)).status).toBe(400);
		}
		expect(mocks.authorize).not.toHaveBeenCalled();
		expect((await call(authorize.POST, "/api/github/authorize", "POST", "{}", { user, authMethod: "session" })).status).toBe(403);
		const res = await call(authorize.POST, "/api/github/authorize", "POST", JSON.stringify({ returnReviewId: uuid }));
		expect(res.status).toBe(200);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(mocks.authorize).toHaveBeenCalledWith({ userId: user.id, sessionId: "session-1", returnReviewId: uuid });
		mocks.authorize.mockRejectedValue(new Error("secret"));
		expect((await call(authorize.POST, "/api/github/authorize", "POST", "{}")).status).toBe(503);
	});

	test("callback binds user and session, and restores only an owned internal review path", async () => {
		expect((await call(callback.GET, "/api/github/callback?code=c&state=s", "GET", undefined, { user, authMethod: "session" })).status).toBe(403);
		for (const path of ["/api/github/callback?state=s", "/api/github/callback?code=c", `/api/github/callback?code=${"c".repeat(2049)}&state=s`, `/api/github/callback?code=c&state=${"s".repeat(257)}`]) {
			expect((await call(callback.GET, path)).status).toBe(400);
		}
		expect(mocks.complete).not.toHaveBeenCalled();
		const settings = await call(callback.GET, "/api/github/callback?code=c&state=s");
		expect(settings.status).toBe(303);
		expect(settings.headers.get("location")).toBe("http://localhost/settings/github?connected=1");
		expect(mocks.getReview).not.toHaveBeenCalled();
		mocks.complete.mockResolvedValue({ returnReviewId: uuid });
		mocks.getReview.mockResolvedValue({ ...view, reviewPath: `/project/p1/chat/c1?review=${uuid}` });
		const res = await call(callback.GET, "/api/github/callback?code=c&state=s&returnTo=https://evil.test");
		expect(res.status).toBe(303);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(res.headers.get("location")).toBe(`http://localhost/project/p1/chat/c1?review=${uuid}`);
		expect(mocks.complete).toHaveBeenCalledWith({ userId: user.id, sessionId: "session-1", state: "s", code: "c" });
		expect(mocks.getReview).toHaveBeenCalledWith(user.id, uuid);
		mocks.getReview.mockResolvedValue({ ...view, reviewPath: "//evil.test" });
		expect((await call(callback.GET, "/api/github/callback?code=c&state=s")).headers.get("location")).toBe("http://localhost/settings/github?connected=1");
		mocks.getReview.mockResolvedValue({ ...view });
		expect((await call(callback.GET, "/api/github/callback?code=c&state=s")).headers.get("location")).toBe("http://localhost/settings/github?connected=1");
		mocks.getReview.mockRejectedValue(new Error("not owned"));
		expect((await call(callback.GET, "/api/github/callback?code=c&state=s")).headers.get("location")).toBe("http://localhost/settings/github?connected=1");
		mocks.complete.mockRejectedValue(new Error("secret"));
		const failed = await call(callback.GET, "/api/github/callback?code=c&state=s");
		expect(failed.status).toBe(400);
		expect(JSON.stringify(await failed.json())).not.toContain("secret");
	});

	test("repository listing and check pass owner identity and validate IDs", async () => {
		const list = await call(repositories.GET, "/api/github/repositories?userId=other");
		expect(await list.json()).toEqual({ repositories: [{ id: 123, fullName: "owner/repo" }] });
		expect(list.headers.get("cache-control")).toBe("no-store");
		expect(mocks.list).toHaveBeenCalledWith({ userId: user.id });
		for (const value of ["", "0", "-1", "1.5", "NaN", "9007199254740992"]) {
			const res = await call(check.GET, `/api/github/repositories/check?repositoryId=${value}`);
			expect(res.status).toBe(400);
		}
		const checked = await call(check.GET, "/api/github/repositories/check?repositoryId=123&userId=other");
		expect(checked.headers.get("cache-control")).toBe("no-store");
		expect(mocks.check).toHaveBeenCalledWith({ userId: user.id, repositoryId: 123 });
		mocks.list.mockRejectedValue(new Error("secret"));
		mocks.check.mockRejectedValue(new Error("secret"));
		expect((await call(repositories.GET, "/api/github/repositories")).status).toBe(503);
		expect((await call(check.GET, "/api/github/repositories/check?repositoryId=123")).status).toBe(503);
	});

	test("private sandbox creation enforces body, key, and owner-only pending flags", async () => {
		const path = "/api/github/sandboxes";
		const valid = { name: " My sandbox ", providerInstallationId: uuid, providerId: "local" };
		for (const body of ["{", "{}", JSON.stringify({ ...valid, userId: "other" })]) {
			expect((await call(sandboxes.POST, path, "POST", body)).status).toBe(400);
		}
		const missingKey = await call(sandboxes.POST, path, "POST", JSON.stringify(valid));
		expect(missingKey.status).toBe(400);
		const request = event(path, "POST", JSON.stringify(valid));
		request.request.headers.set("Idempotency-Key", uuid);
		const res = await sandboxes.POST(request);
		expect(res.status).toBe(201);
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(await res.json()).toEqual({ project: { id: "p1" }, sandbox: { projectId: "p1" } });
		expect(mocks.create).toHaveBeenCalledWith(user.id, expect.objectContaining({ name: "My sandbox", providerId: "local", privateOwnerOnly: true, privateInitializing: true, idempotencyKey: uuid }));
		mocks.create.mockRejectedValue(new Error("secret"));
		const failedEvent = event(path, "POST", JSON.stringify(valid));
		failedEvent.request.headers.set("Idempotency-Key", uuid);
		const failed = await sandboxes.POST(failedEvent);
		expect(failed.status).toBe(503);
		expect(failed.headers.get("cache-control")).toBe("no-store");
		expect(JSON.stringify(await failed.json())).not.toContain("secret");
	});
});

describe("personal pull request routes", () => {
	test("run and proposal reads return server state for the session owner", async () => {
		for (const [handler, path, params, mock] of [
			[run.GET, "/api/github/personal-prs/runs/r1", { runId: "r1" }, mocks.getRun],
			[review.GET, `/api/github/personal-prs/proposals/${uuid}`, { id: uuid }, mocks.getReview],
		] as const) {
			const res = await call(handler, path, "GET", undefined, undefined, params);
			expect(await res.json()).toEqual(view);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(mock).toHaveBeenCalledWith(user.id, Object.values(params)[0]);
		}
		mocks.getReview.mockRejectedValue(new PersonalPrError("not_found", "Review not found"));
		expect((await call(review.GET, `/api/github/personal-prs/proposals/${uuid}`, "GET", undefined, undefined, { id: uuid })).status).toBe(404);
	});

	test("prepare and confirm reject malformed input and forward only validated details", async () => {
		for (const [handler, path, params] of [
			[prepare.POST, "/api/github/personal-prs/runs/r1/prepare", { runId: "r1" }],
			[confirm.POST, `/api/github/personal-prs/proposals/${uuid}/confirm`, { id: uuid }],
		] as const) {
			for (const body of ["{", JSON.stringify({ userId: "other" })]) {
				expect((await call(handler, path, "POST", body, undefined, params)).status).toBe(400);
			}
		}
		const prepared = await call(prepare.POST, "/api/github/personal-prs/runs/r1/prepare", "POST", JSON.stringify({ title: " Draft " }), undefined, { runId: "r1" });
		expect(prepared.headers.get("cache-control")).toBe("no-store");
		expect(mocks.prepare).toHaveBeenCalledWith(user.id, { runId: "r1", title: "Draft" });
		const confirmed = await call(confirm.POST, `/api/github/personal-prs/proposals/${uuid}/confirm`, "POST", JSON.stringify({ expectedDigest: digest, title: " Draft ", body: "Body", idempotencyKey: uuid }), undefined, { id: uuid });
		expect(confirmed.headers.get("cache-control")).toBe("no-store");
		expect(mocks.confirm).toHaveBeenCalledWith(user.id, { proposalId: uuid, expectedDigest: digest, title: "Draft", body: "Body", idempotencyKey: uuid });
	});

	test("import requires an approved repository shape and a session owner", async () => {
		const path = "/api/github/personal-prs/sandboxes/p1/import";
		for (const body of ["{", JSON.stringify({ repositoryId: 0, baseRef: "main", idempotencyKey: uuid }), JSON.stringify({ repositoryId: 123, baseRef: "main", idempotencyKey: uuid, userId: "other" })]) {
			expect((await call(importRepo.POST, path, "POST", body, undefined, { projectId: "p1" })).status).toBe(400);
		}
		const res = await call(importRepo.POST, path, "POST", JSON.stringify({ repositoryId: 123, baseRef: "main", idempotencyKey: uuid }), undefined, { projectId: "p1" });
		expect(await res.json()).toEqual({ projectId: "p1", importState: "ready" });
		expect(res.headers.get("cache-control")).toBe("no-store");
		expect(mocks.importRepo).toHaveBeenCalledWith(user.id, { projectId: "p1", repositoryId: 123, baseRef: "main", idempotencyKey: uuid });
	});

	test("service error mapping uses safe status codes and hides unknown exceptions", async () => {
		for (const [code, status] of [["invalid_input", 400], ["not_found", 404], ["forbidden", 403], ["conflict", 409], ["unavailable", 503]] as const) {
			const res = personalPrRouteError(new PersonalPrError(code, "Safe reason"));
			expect(res.status).toBe(status);
			expect(res.headers.get("cache-control")).toBe("no-store");
			expect(await res.json()).toEqual({ code, error: "Safe reason" });
		}
		for (const error of [new SyntaxError("secret"), new Response(null, { status: 413 })]) {
			const res = personalPrRouteError(error);
			expect(res.status).toBe(400);
			expect(JSON.stringify(await res.json())).not.toContain("secret");
		}
		const unknown = personalPrRouteError(new Error("secret"));
		expect(unknown.status).toBe(503);
		expect(JSON.stringify(await unknown.json())).not.toContain("secret");
		mocks.getRun.mockRejectedValue(new PersonalPrError("forbidden", "Access denied"));
		expect((await call(run.GET, "/api/github/personal-prs/runs/r1", "GET", undefined, undefined, { runId: "r1" })).status).toBe(403);
		mocks.prepare.mockRejectedValue(new Error("secret"));
		expect((await call(prepare.POST, "/api/github/personal-prs/runs/r1/prepare", "POST", "{}", undefined, { runId: "r1" })).status).toBe(503);
		mocks.confirm.mockRejectedValue(new PersonalPrError("conflict", "Proposal changed"));
		expect((await call(confirm.POST, `/api/github/personal-prs/proposals/${uuid}/confirm`, "POST", JSON.stringify({ expectedDigest: digest, title: "Draft", body: "Body", idempotencyKey: uuid }), undefined, { id: uuid })).status).toBe(409);
		mocks.importRepo.mockRejectedValue(new PersonalPrError("forbidden", "Not owner"));
		expect((await call(importRepo.POST, "/api/github/personal-prs/sandboxes/p1/import", "POST", JSON.stringify({ repositoryId: 123, baseRef: "main", idempotencyKey: uuid }), undefined, { projectId: "p1" })).status).toBe(403);
	});
});
