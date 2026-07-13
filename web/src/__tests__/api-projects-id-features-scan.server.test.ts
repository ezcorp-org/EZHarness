/**
 * POST /api/projects/[id]/features/scan — route-layer contract.
 *
 * The scanner itself (`src/runtime/scan/feature-scan.ts`) and the
 * upsert/hybrid-ownership invariants are integration-tested against real
 * PGlite in `src/__tests__/feature-endpoints.test.ts`. THIS suite pins the
 * HTTP surface and — critically — is the coverage-authoritative leg for the
 * `+server.ts` route (bun `mock.module` tests of web routes are excluded
 * from the merged lcov, so route coverage counts ONLY via vitest `vi.mock`;
 * precedent: `api-extensions-id-reapprove-drift.server.test.ts`).
 *
 * Covered here: auth/scope gating, 404/400 mapping, the new 400 on an
 * unresolvable working directory (with/without the relative-path hint),
 * the full scanned-candidate upsert matrix (new / originPath match / name
 * fallback + backfill / user-owned / agent description refresh), and the
 * `{ features, notice }` envelope including all three notice outcomes.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";

// ── Auth middleware (real contract: requireAuth throws a 401 Response) ──
vi.mock("$server/auth/middleware", () => ({
	requireAuth: (locals: Record<string, unknown>) => {
		const user = locals.user as { id: string; role: string } | undefined;
		if (!user) throw new Response("Unauthorized", { status: 401 });
		return user;
	},
}));

// Real contract: null for cookie auth / matching scope; 403 Response otherwise.
vi.mock("$lib/server/security/api-keys", () => ({
	requireScope: (
		locals: { apiKeyScopes?: string[] },
		scope: string,
	): Response | null => {
		if (!locals.apiKeyScopes) return null;
		if (locals.apiKeyScopes.includes(scope)) return null;
		return new Response(JSON.stringify({ error: "Insufficient scope" }), {
			status: 403,
		});
	},
}));

vi.mock("$lib/server/http-errors", () => ({
	errorJson: (status: number, message: string) =>
		new Response(JSON.stringify({ error: message }), {
			status,
			headers: { "Content-Type": "application/json" },
		}),
}));

// ── Project lookup (per-test row) ───────────────────────────────────
type ProjectRow = { id: string; path: string | null; name: string } | null;
let projectRow: ProjectRow;

vi.mock("$server/db/queries/projects", () => ({
	getProject: vi.fn(async (_id: string) => projectRow),
}));

// ── Scanner result (per-test) ───────────────────────────────────────
type ScannedFeature = {
	name: string;
	description: string;
	originPath: string;
	files: string[];
};
type ScanResult =
	| { ok: false; reason: "unresolvable-root"; requestedRoot: string }
	| {
			ok: true;
			realRoot: string;
			features: ScannedFeature[];
			usedTopLevelFallback: boolean;
	  };
let scanResult: ScanResult;
const scanProject = vi.fn(async (_root: string) => scanResult);

vi.mock("$server/runtime/scan/feature-scan", () => ({
	scanProject: (...args: unknown[]) =>
		(scanProject as unknown as (...a: unknown[]) => unknown)(...args),
}));

// ── Feature queries (spies with per-test behavior) ──────────────────
type ExistingRow = {
	id: string;
	name: string;
	originPath: string | null;
	source: "user" | "agent";
	description: string;
};
let existingRows: ExistingRow[];

const listFeatures = vi.fn(async (_projectId: string) => existingRows);
const createFeature = vi.fn(async (_input: unknown) => ({ id: "created-1" }));
const updateFeature = vi.fn(async (_id: string, _patch: unknown) => ({}));
const replaceAgentFiles = vi.fn(async (_id: string, _files: string[]) => {});

vi.mock("$server/db/queries/features", () => ({
	listFeatures: (...a: unknown[]) =>
		(listFeatures as unknown as (...a: unknown[]) => unknown)(...a),
	createFeature: (...a: unknown[]) =>
		(createFeature as unknown as (...a: unknown[]) => unknown)(...a),
	updateFeature: (...a: unknown[]) =>
		(updateFeature as unknown as (...a: unknown[]) => unknown)(...a),
	replaceAgentFiles: (...a: unknown[]) =>
		(replaceAgentFiles as unknown as (...a: unknown[]) => unknown)(...a),
}));

// ── Import handler AFTER mocks ──────────────────────────────────────
const { POST } = await import(
	"../routes/api/projects/[id]/features/scan/+server"
);

// ── Helpers ─────────────────────────────────────────────────────────
interface EventLike {
	params: { id: string };
	locals: Record<string, unknown>;
}

function makeEvent(opts: {
	user?: { id: string; role: string } | null;
	id?: string;
	apiKeyScopes?: string[];
} = {}): EventLike {
	const locals: Record<string, unknown> = {
		user: opts.user === undefined ? { id: "u1", role: "member" } : opts.user,
	};
	if (opts.apiKeyScopes) locals.apiKeyScopes = opts.apiKeyScopes;
	return { params: { id: opts.id ?? "proj-1" }, locals };
}

async function expectThrownOrResponse(
	fn: () => Promise<Response> | Response,
): Promise<Response> {
	try {
		return await fn();
	} catch (thrown) {
		expect(thrown).toBeInstanceOf(Response);
		return thrown as Response;
	}
}

const feature = (over: Partial<ScannedFeature> = {}): ScannedFeature => ({
	name: "alpha",
	description: "Files under src/alpha",
	originPath: "src/alpha",
	files: ["src/alpha/a.ts", "src/alpha/b.ts"],
	...over,
});

beforeEach(() => {
	projectRow = { id: "proj-1", path: "/abs/project", name: "P" };
	scanResult = {
		ok: true,
		realRoot: "/abs/project",
		features: [feature()],
		usedTopLevelFallback: false,
	};
	existingRows = [];
	scanProject.mockClear();
	listFeatures.mockClear();
	// existing (call 1) then updated (call 2). Default: empty existing,
	// then the post-scan list.
	listFeatures.mockImplementation(async () => existingRows);
	createFeature.mockClear();
	createFeature.mockResolvedValue({ id: "created-1" });
	updateFeature.mockClear();
	replaceAgentFiles.mockClear();
});

describe("POST /api/projects/[id]/features/scan — gating", () => {
	test("API key missing the chat scope → 403; scanner never called", async () => {
		const res = await expectThrownOrResponse(() =>
			POST(makeEvent({ apiKeyScopes: ["read"] }) as never),
		);
		expect(res.status).toBe(403);
		expect(scanProject).not.toHaveBeenCalled();
	});

	test("unauthenticated → 401", async () => {
		const res = await expectThrownOrResponse(() =>
			POST(makeEvent({ user: null }) as never),
		);
		expect(res.status).toBe(401);
		expect(scanProject).not.toHaveBeenCalled();
	});

	test("unknown project → 404", async () => {
		projectRow = null;
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(404);
	});

	test("project with no filesystem path → 400", async () => {
		projectRow = { id: "proj-1", path: "", name: "P" };
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toMatch(/no filesystem path/i);
	});
});

describe("POST /api/projects/[id]/features/scan — unresolvable working dir", () => {
	test("relative path → 400 with resolved-path message AND the absolute-path hint", async () => {
		projectRow = { id: "proj-1", path: "app/ezAppTest", name: "P" };
		scanResult = {
			ok: false,
			reason: "unresolvable-root",
			requestedRoot: "/app/app/ezAppTest",
		};
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain('Working directory "app/ezAppTest" does not exist on the server');
		expect(body.error).toContain("resolved to");
		// Relative path → hint appended.
		expect(body.error).toContain("Set an absolute path in project settings.");
	});

	test("absolute path → 400 WITHOUT the relative-path hint", async () => {
		projectRow = { id: "proj-1", path: "/does/not/exist", name: "P" };
		scanResult = {
			ok: false,
			reason: "unresolvable-root",
			requestedRoot: "/does/not/exist",
		};
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error: string };
		expect(body.error).toContain("does not exist on the server");
		expect(body.error).not.toContain("Set an absolute path");
	});
});

describe("POST /api/projects/[id]/features/scan — upsert matrix", () => {
	test("no prior row → createFeature + replaceAgentFiles; 200 with notice=null", async () => {
		existingRows = [];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { features: unknown[]; notice: string | null };
		expect(body.notice).toBeNull();
		expect(createFeature).toHaveBeenCalledTimes(1);
		expect(createFeature).toHaveBeenCalledWith({
			projectId: "proj-1",
			name: "alpha",
			description: "Files under src/alpha",
			source: "agent",
			originPath: "src/alpha",
		});
		expect(replaceAgentFiles).toHaveBeenCalledWith("created-1", [
			"src/alpha/a.ts",
			"src/alpha/b.ts",
		]);
	});

	test("originPath match, agent-owned, description differs → updateFeature(description) + replaceAgentFiles", async () => {
		existingRows = [
			{ id: "e1", name: "alpha", originPath: "src/alpha", source: "agent", description: "STALE" },
		];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		expect(createFeature).not.toHaveBeenCalled();
		expect(updateFeature).toHaveBeenCalledWith("e1", { description: "Files under src/alpha" });
		expect(replaceAgentFiles).toHaveBeenCalledWith("e1", ["src/alpha/a.ts", "src/alpha/b.ts"]);
	});

	test("originPath match, agent-owned, description unchanged → NO updateFeature", async () => {
		existingRows = [
			{
				id: "e1",
				name: "alpha",
				originPath: "src/alpha",
				source: "agent",
				description: "Files under src/alpha",
			},
		];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		expect(updateFeature).not.toHaveBeenCalled();
		expect(replaceAgentFiles).toHaveBeenCalledWith("e1", ["src/alpha/a.ts", "src/alpha/b.ts"]);
	});

	test("name fallback with null originPath on a user row → backfill originPath, preserve user fields", async () => {
		existingRows = [
			{ id: "u1", name: "alpha", originPath: null, source: "user", description: "user desc" },
		];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		// Backfill fires (matched by name, originPath was null).
		expect(updateFeature).toHaveBeenCalledWith("u1", { originPath: "src/alpha" });
		// User-owned: description untouched (only the backfill call), files refreshed.
		expect(updateFeature).toHaveBeenCalledTimes(1);
		expect(replaceAgentFiles).toHaveBeenCalledWith("u1", ["src/alpha/a.ts", "src/alpha/b.ts"]);
		expect(createFeature).not.toHaveBeenCalled();
	});

	test("name collision where the existing row already has a DIFFERENT originPath → treated as new", async () => {
		// byName hit but the row is already linked to another dir → not a
		// valid fallback; the candidate is created fresh.
		existingRows = [
			{ id: "e2", name: "alpha", originPath: "src/other", source: "agent", description: "x" },
		];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		expect(createFeature).toHaveBeenCalledTimes(1);
		expect(updateFeature).not.toHaveBeenCalled();
	});
});

describe("POST /api/projects/[id]/features/scan — notice envelope", () => {
	test("zero features via top-level fallback → notice names the fallback + realRoot", async () => {
		scanResult = {
			ok: true,
			realRoot: "/app/TESTENV",
			features: [],
			usedTopLevelFallback: true,
		};
		existingRows = [];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { features: unknown[]; notice: string | null };
		expect(body.notice).toBe(
			"No feature directories found under /app/TESTENV (scanned top-level fallback)",
		);
		expect(createFeature).not.toHaveBeenCalled();
	});

	test("zero features with real source roots → notice names the source-root scan", async () => {
		scanResult = {
			ok: true,
			realRoot: "/repo",
			features: [],
			usedTopLevelFallback: false,
		};
		existingRows = [];
		const res = await expectThrownOrResponse(() => POST(makeEvent() as never));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { notice: string | null };
		expect(body.notice).toBe("No feature directories found under /repo (scanned source roots)");
	});
});
