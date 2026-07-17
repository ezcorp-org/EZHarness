import { test, expect, describe, beforeAll, afterAll, beforeEach, mock } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ── Stubs identical in shape to mention-search-file-api.test.ts ──

let nextProject: { id: string; path: string } | null = null;

mock.module("$server/db/queries/projects", () => ({
	getProject: async (_id: string) => nextProject,
}));

mock.module("$server/auth/middleware", () => ({
	requireAuth: () => ({ id: "test-user", role: "admin" }),
}));

mock.module("$lib/server/security/api-keys", () => ({
	requireScope: () => null,
}));

// Shared mutable registry used by the context mock. Individual tests
// swap out its backing array to simulate different discovery outcomes.
let nextCommands: Array<{
	name: string;
	description: string;
	body: string;
	frontmatter: Record<string, string>;
	source: string;
	namespace: string;
	path: string;
}> = [];

mock.module("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: () => [] }),
	getBus: () => ({ emit: () => {}, on: () => () => {} }),
	getWorkflowExecutor: () => null,
	getStateMediator: () => null,
	getWorkflows: () => [],
	getCommandRegistry: () => ({
		listCommands: async () => nextCommands,
		findCommand: async ({ name }: { name: string }) =>
			nextCommands.find((c) => c.name === name) ?? null,
		invalidate: () => {},
	}),
}));

mock.module("$server/db/connection", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit: () => Promise.resolve([]) }) }),
		}),
	}),
}));

mock.module("$server/db/schema", () => ({
	extensions: {},
	agentConfigs: {},
}));

mock.module("drizzle-orm", () => ({
	eq: () => ({}),
	and: () => ({}),
	or: () => ({}),
	ilike: () => ({}),
}));

mock.module("$server/runtime/tools/builtin-registry", () => ({
	getBuiltInCategories: () => [],
}));

// Controllable goal kill-switch. The search endpoint imports
// `parseGoalEnabled` to decide whether to advertise the built-in `/goal`
// command in the slash-command menu. Mocked here so tests can toggle it
// deterministically (without env mutation) AND so importing the endpoint
// doesn't drag goal-host's full runtime import graph into this test.
let goalEnabled = false;
mock.module("$server/runtime/goal-host", () => ({
	parseGoalEnabled: () => goalEnabled,
}));

const { GET } = await import("../routes/api/mentions/search/+server");

let projectRoot: string;

beforeAll(async () => {
	projectRoot = await mkdtemp(join(tmpdir(), "cmd-search-proj-"));
	await mkdir(join(projectRoot), { recursive: true });
	nextProject = { id: "proj-1", path: projectRoot };
});

afterAll(async () => {
	await rm(projectRoot, { recursive: true, force: true });
});

beforeEach(() => {
	nextCommands = [];
	// Default OFF so the existing registry-only assertions are unaffected by
	// the built-in `/goal` injection; goal-specific tests opt in explicitly.
	goalEnabled = false;
});

function cmd(name: string, description = "", body = "body") {
	return {
		name,
		description,
		body,
		frontmatter: {},
		source: "project:claude-commands",
		namespace: "project:claude-commands",
		path: `/tmp/${name}.md`,
	};
}

async function call(url: string): Promise<Response> {
	// Minimal locals that requireAuth + requireScope stubs don't care about.
	const handler = GET as unknown as (args: {
		url: URL;
		locals: Record<string, never>;
	}) => Promise<Response>;
	return handler({ url: new URL(url, "http://test"), locals: {} });
}

describe("mentions/search — type=cmd", () => {
	test("empty query returns all (capped)", async () => {
		nextCommands = [
			cmd("review", "Review code"),
			cmd("deploy", "Deploy app"),
			cmd("test", "Run tests"),
		];
		const res = await call("/api/mentions/search?type=cmd&projectId=proj-1");
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toHaveLength(3);
		expect(body.every((r: { kind: string }) => r.kind === "command")).toBe(true);
	});

	test("each result carries its source namespace", async () => {
		nextCommands = [
			{ ...cmd("review", "Project review"), source: "project:claude-commands" },
			{ ...cmd("global", "Home review"), source: "user:codex-prompts" },
			{ ...cmd("db-one", "DB cmd"), source: "user:db" },
		];
		const res = await call("/api/mentions/search?type=cmd&projectId=proj-1");
		const body = await res.json();
		const sourcesByName = Object.fromEntries(
			body.map((r: { name: string; source: string }) => [r.name, r.source]),
		);
		expect(sourcesByName).toEqual({
			review: "project:claude-commands",
			global: "user:codex-prompts",
			"db-one": "user:db",
		});
	});

	test("query filters by fuzzy-matching name or description", async () => {
		nextCommands = [
			cmd("review", "Review code"),
			cmd("deploy", "Deploy app"),
		];
		const res = await call(
			"/api/mentions/search?type=cmd&q=rev&projectId=proj-1",
		);
		const body = await res.json();
		expect(body.map((r: { name: string }) => r.name)).toEqual(["review"]);
	});

	test("works without projectId (global context)", async () => {
		nextCommands = [cmd("global-only", "Home cmd")];
		const res = await call("/api/mentions/search?type=cmd");
		const body = await res.json();
		expect(body).toHaveLength(1);
		expect(body[0].name).toBe("global-only");
	});

	test("returns at most MAX_RESULTS (10)", async () => {
		nextCommands = Array.from({ length: 25 }, (_, i) =>
			cmd(`cmd${i}`, `d${i}`),
		);
		const res = await call(
			"/api/mentions/search?type=cmd&q=cmd&projectId=proj-1",
		);
		const body = await res.json();
		expect(body.length).toBeLessThanOrEqual(10);
	});

	test("ranks prefix matches above subsequence matches", async () => {
		nextCommands = [
			cmd("rewrite", "Rewrite something"),
			cmd("review", "Review code"),
			cmd("deprecate", "Deprecate API"),
		];
		const res = await call(
			"/api/mentions/search?type=cmd&q=re&projectId=proj-1",
		);
		const body = await res.json();
		// "review" and "rewrite" both prefix-match "re"; "deprecate" does not.
		const names = body.map((r: { name: string }) => r.name);
		expect(names).toContain("review");
		expect(names).toContain("rewrite");
		expect(names[0] === "review" || names[0] === "rewrite").toBe(true);
	});
});

describe("mentions/search — type=cmd — built-in /goal entry", () => {
	test("injects /goal at the top when enabled and the query matches", async () => {
		goalEnabled = true;
		nextCommands = [cmd("deploy", "Deploy app")];
		const res = await call("/api/mentions/search?type=cmd&q=go&projectId=proj-1");
		const body = await res.json();
		expect(body[0]).toMatchObject({
			name: "goal",
			kind: "command",
			source: "builtin",
			insertText: "/goal ",
		});
	});

	test("injects /goal for the empty query", async () => {
		goalEnabled = true;
		nextCommands = [cmd("deploy", "Deploy app")];
		const res = await call("/api/mentions/search?type=cmd&projectId=proj-1");
		const body = await res.json();
		expect(
			body.some(
				(r: { name: string; insertText?: string }) =>
					r.name === "goal" && r.insertText === "/goal ",
			),
		).toBe(true);
	});

	test("does NOT inject /goal when the query can't match it", async () => {
		goalEnabled = true;
		nextCommands = [cmd("deploy", "Deploy app")];
		const res = await call("/api/mentions/search?type=cmd&q=deploy&projectId=proj-1");
		const body = await res.json();
		expect(body.some((r: { name: string }) => r.name === "goal")).toBe(false);
	});

	test("does NOT inject /goal when the feature is disabled, even on a matching query", async () => {
		goalEnabled = false;
		nextCommands = [cmd("deploy", "Deploy app")];
		const res = await call("/api/mentions/search?type=cmd&q=goal&projectId=proj-1");
		const body = await res.json();
		expect(body.some((r: { name: string }) => r.name === "goal")).toBe(false);
	});

	test("respects MAX_RESULTS (10) after prepending the built-in entry", async () => {
		goalEnabled = true;
		nextCommands = Array.from({ length: 25 }, (_, i) => cmd(`goal${i}`, `d${i}`));
		const res = await call("/api/mentions/search?type=cmd&q=goal&projectId=proj-1");
		const body = await res.json();
		expect(body.length).toBeLessThanOrEqual(10);
		expect(body[0].name).toBe("goal"); // built-in is surfaced first
	});
});
