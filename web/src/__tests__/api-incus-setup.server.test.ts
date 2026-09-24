import { beforeEach, expect, test, vi } from "vitest";

const calls: string[] = [];
const activeReleaseCalls: Promise<unknown>[] = [];
let hasBootstrap = true;
let recipeFailure: Error | null = null;
const recipePaths: string[] = [];
const serviceRecipes: unknown[] = [];
let failure: unknown = null;
let queryCount = 0;
vi.mock("$server/auth/middleware", () => ({
	requireAdminSession: (locals: { user?: { id: string; role: string }; authMethod?: string }) =>
		locals.user?.role === "admin" && locals.authMethod === "session" ? locals.user
			: Response.json({}, { status: locals.user ? 403 : 401 }),
}));
vi.mock("$server/infrastructure/incus-operator/service", () => ({
	bootstrapFromEnvironment: () => hasBootstrap ? { host: "pinned" } : null,
	loadReviewedIncusRecipe: (path: string) => { recipePaths.push(path); if (recipeFailure) throw recipeFailure; return { id: "reviewed" }; },
	IncusOperatorSetupService: class {
		constructor(options: { activeRelease: (installationId: string) => Promise<unknown>; recipe: unknown }) {
			serviceRecipes.push(options.recipe);
			activeReleaseCalls.push(options.activeRelease("provider"));
		}
		async latest(id: string) { calls.push(`latest:${id}`); if (failure) throw failure; return { id }; }
		async plan(id: string, user: string) { calls.push(`plan:${id}:${user}`); if (failure) throw failure; return { id: "setup-a" }; }
		async apply(id: string, digest: string, user: string) { calls.push(`apply:${id}:${digest}:${user}`); if (failure) throw failure; return { id }; }
		async probe(id: string) { calls.push(`probe:${id}`); if (failure) throw failure; return { ready: true }; }
	},
}));
vi.mock("$server/extensions/extension-lifecycle-service", () => ({ getExtensionLifecycle: async () => { calls.push("lifecycle"); } }));
vi.mock("$server/infrastructure/provider-connections/store", () => ({ ProviderConnectionStore: class {} }));
vi.mock("$server/db/connection", () => ({ getDb: () => ({ execute: async () => {
	queryCount++;
	return queryCount % 2 === 1 ? [{ id: "active-a" }, { id: "other" }, { id: "inactive" }]
		: [{ id: "active-a", releaseId: "old", generation: 1 }, { id: "inactive", releaseId: "old", generation: 2 }];
} }) }));
vi.mock("$server/db/queries/extension-releases", () => ({ releaseRows: (rows: unknown) => rows }));
vi.mock("$server/extensions/release-process", () => ({
	getReleaseRuntime: () => ({}),
	resolveActiveRelease: async (id: string) => {
		calls.push(`release:${id}`);
		if (id === "inactive") throw new Error("inactive");
		return { release: { id: "release-a", manifest: { sandboxProviders: id === "active-a" ? [{ id: "incus", kind: "sandbox" }] : [] } }, installation: { generation: 3 } };
	},
}));

const { GET, POST } = await import("../routes/api/infrastructure/incus/setup/+server");
const admin = { user: { id: "admin", role: "admin" }, authMethod: "session" };
function getEvent(search = "", locals: Record<string, unknown> = admin): Parameters<typeof GET>[0] {
	return { locals, url: new URL(`http://localhost/api/infrastructure/incus/setup${search}`) } as unknown as Parameters<typeof GET>[0];
}
function postEvent(body: unknown, locals: Record<string, unknown> = admin): Parameters<typeof POST>[0] {
	return { locals, request: new Request("http://localhost/api/infrastructure/incus/setup", {
		method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
	}) } as unknown as Parameters<typeof POST>[0];
}

beforeEach(() => {
	calls.length = 0; activeReleaseCalls.length = 0; recipePaths.length = 0; serviceRecipes.length = 0;
	hasBootstrap = true; recipeFailure = null; failure = null; queryCount = 0;
	process.env.EZCORP_INCUS_SETUP_RECIPE_FILE = "/host/reviewed-recipe.json";
});

test("setup requires an administrator session before reading host configuration", async () => {
	expect((await GET(getEvent("", {}))).status).toBe(401);
	expect((await POST(postEvent({ action: "plan", installationId: "provider" }, { ...admin, authMethod: "api-key" }))).status).toBe(403);
	expect((await POST(postEvent({ action: "plan", installationId: "provider" }, { user: { id: "member", role: "member" }, authMethod: "session" }))).status).toBe(403);
	expect(calls).toEqual([]);
});

test("setup rejects injected authority, malformed IDs, and invalid digests", async () => {
	expect((await GET(getEvent("?installationId=bad%2Fid"))).status).toBe(400);
	for (const body of [null, [], {}, { action: "unknown" },
		{ action: "plan", installationId: "provider", sshIdentityFile: "/tmp/key" },
		{ action: "plan", installationId: "bad/id" }, { action: "probe", setupId: "bad/id" },
		{ action: "apply", setupId: "setup", planDigest: "bad" },
		{ action: "apply", setupId: "setup", planDigest: "a".repeat(64), privateKeyPem: "secret" }]) {
		expect((await POST(postEvent(body))).status).toBe(400);
	}
	expect(calls).toEqual([]);
});

test("setup reports missing host bootstrap without loading a release", async () => {
	hasBootstrap = false;
	expect(await (await GET(getEvent("?installationId=provider"))).json()).toMatchObject({ code: "bootstrap_not_configured" });
	expect(await (await POST(postEvent({ action: "plan", installationId: "provider" }))).json()).toMatchObject({ code: "bootstrap_not_configured" });
	expect(calls).toEqual([]);
});

test("Plan requires a host-owned recipe and passes it to the operator service", async () => {
	delete process.env.EZCORP_INCUS_SETUP_RECIPE_FILE;
	expect(await (await POST(postEvent({ action: "plan", installationId: "provider" }))).json()).toMatchObject({ code: "recipe_not_configured" });
	expect(recipePaths).toEqual([]);
	process.env.EZCORP_INCUS_SETUP_RECIPE_FILE = "/host/reviewed-recipe.json";
	expect((await POST(postEvent({ action: "plan", installationId: "provider" }))).status).toBe(200);
	expect(recipePaths).toEqual(["/host/reviewed-recipe.json"]);
	expect(serviceRecipes).toEqual([{ id: "reviewed" }]);
	recipeFailure = new Error("Reviewed Incus recipe must pin the image");
	expect(await (await POST(postEvent({ action: "plan", installationId: "provider" }))).json()).toMatchObject({
		code: "setup_failed", message: "Reviewed Incus recipe must pin the image",
	});
});

test("saved setup reads, Apply, and probe remain reachable when the current recipe is stale or missing", async () => {
	recipeFailure = new Error("private recipe details");
	expect(await (await GET(getEvent("?installationId=provider"))).json()).toEqual({ setup: { id: "provider" } });
	expect(await (await POST(postEvent({ action: "apply", setupId: "setup-a", planDigest: "a".repeat(64) }))).json()).toEqual({ setup: { id: "setup-a" } });
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toEqual({ ready: true });
	expect(recipePaths).toEqual([]);
	expect(serviceRecipes).toEqual([undefined, undefined, undefined]);
	const stalePlan = await POST(postEvent({ action: "plan", installationId: "provider" }));
	expect(stalePlan.status).toBe(409);
	const stalePlanBody = await stalePlan.json();
	expect(stalePlanBody).toMatchObject({ code: "setup_failed", message: "Incus setup failed. Check host logs and inspect the saved plan." });
	expect(JSON.stringify(stalePlanBody)).not.toContain("private recipe details");
	delete process.env.EZCORP_INCUS_SETUP_RECIPE_FILE;
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toEqual({ ready: true });
	expect(recipePaths).toEqual(["/host/reviewed-recipe.json"]);
});

test("lists active Incus releases and prior inactive setups", async () => {
	const response = await GET(getEvent());
	expect(response.status).toBe(200);
	expect(await response.json()).toEqual({ installations: [
		{ id: "active-a", releaseId: "release-a", generation: 3 },
		{ id: "inactive", releaseId: "old", generation: 2, inactive: true },
	] });
	expect(calls).toEqual(["lifecycle", "release:provider", "release:active-a", "release:other", "release:inactive"]);
});

test("reads a saved plan and dispatches plan, apply, and probe with the admin ID", async () => {
	expect(await (await GET(getEvent("?installationId=provider"))).json()).toEqual({ setup: { id: "provider" } });
	expect(await (await POST(postEvent({ action: "plan", installationId: "provider" }))).json()).toEqual({ setup: { id: "setup-a" } });
	expect(await (await POST(postEvent({ action: "apply", setupId: "setup-a", planDigest: "a".repeat(64) }))).json()).toEqual({ setup: { id: "setup-a" } });
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toEqual({ ready: true });
	expect(calls).toContain(`apply:setup-a:${"a".repeat(64)}:admin`);
	expect(calls).toContain("probe:setup-a");
	expect((await Promise.all(activeReleaseCalls)).length).toBe(4);
	expect(calls).toContain("release:provider");
});

test("returns safe known and unknown errors from GET and POST", async () => {
	failure = new Error("Provider release has changed");
	expect(await (await GET(getEvent("?installationId=provider"))).json()).toMatchObject({ code: "setup_failed", message: "Provider release has changed" });
	failure = new Error("secret from host");
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toMatchObject({ code: "setup_failed", message: "Incus setup failed. Check host logs and inspect the saved plan." });
	failure = "opaque";
	expect(await (await POST(postEvent({ action: "plan", installationId: "provider" }))).json()).toMatchObject({
		code: "setup_failed", diagnostic: { errorType: "unknown", source: "other" },
	});
});

test("probe reports bounded provider diagnostics without exposing error text", async () => {
	const transportFailure = Object.assign(new Error("secret client key material"), { code: "UNAVAILABLE" });
	failure = transportFailure;
	const transportResponse = await POST(postEvent({ action: "probe", setupId: "setup-a" }));
	expect(transportResponse.status).toBe(409);
	expect(await transportResponse.json()).toEqual({
		code: "provider_probe_failed",
		message: "Incus provider transport is unavailable. Check the HTTPS endpoint, server pin, and client trust.",
	});
	failure = Object.assign(new Error("Incus required controls are unavailable: boundedOutput, durableProcesses"), { code: "UNSUPPORTED_PROVIDER" });
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toEqual({
		code: "provider_preflight_unverified",
		message: "Incus provider preflight could not verify the required capabilities. Unverified controls: boundedOutput, durableProcesses.",
	});
	failure = Object.assign(new Error("Incus required controls are unavailable: privateKey=secret"), { code: "UNSUPPORTED_PROVIDER" });
	expect(await (await POST(postEvent({ action: "probe", setupId: "setup-a" }))).json()).toEqual({
		code: "provider_preflight_unverified",
		message: "Incus provider preflight could not verify the required capabilities.",
	});
});

test("unknown probe failures expose only fixed diagnostic labels", async () => {
	failure = Object.assign(new Error("private-key-must-never-escape"), { name: "ContractError", code: "INTERNAL",
		stack: "ContractError: private-key-must-never-escape\n    at probe (/host/src/extensions/release-process.ts:1:1)" });
	const response = await POST(postEvent({ action: "probe", setupId: "setup-a" }));
	const body = await response.json();
	expect(response.status).toBe(409);
	expect(body).toEqual({ code: "setup_failed", message: "Incus setup failed. Check host logs and inspect the saved plan.",
		diagnostic: { errorType: "ContractError", errorCode: "INTERNAL", source: "release_process" } });
	expect(JSON.stringify(body)).not.toContain("private-key-must-never-escape");
});
