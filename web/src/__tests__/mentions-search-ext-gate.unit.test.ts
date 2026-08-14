/**
 * `GET /api/mentions/search?type=ext` must not ADVERTISE an extension the
 * caller cannot use (sec U6).
 *
 * The endpoint filtered on `enabled` alone, so the composer offered every
 * installed MCP extension to every member. The member picked one, the
 * `![ext:…]` wiring path then dropped it silently — correctly, since an error
 * there would be an existence oracle — and the product did nothing at all: no
 * tool, no message, no signal. The no-op contract is right; advertising the
 * thing five seconds earlier is what was wrong.
 *
 * `type=ext` is the one branch that reaches `getDb()` exactly once (teams are
 * skipped for this type), which is what makes a route-level test practical
 * here without PGlite. The gate itself is a seam: its branch matrix is unit-
 * tested in `src/__tests__/extension-wire-authz.test.ts` and driven against
 * real grants in `src/__tests__/mcp-wire-gate-bypasses.integration.test.ts`.
 */
import { test, expect, describe, vi, beforeEach } from "vitest";
import { makeRequestEvent } from "./helpers/server-route-test-utils";

vi.mock("$server/db/queries/projects", () => ({ getProject: vi.fn() }));
vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: () => [] }),
	getCommandRegistry: () => ({ listCommands: () => [] }),
	getWorkflows: () => [],
}));
vi.mock("$server/runtime/goal-host", () => ({ parseGoalEnabled: () => false }));
// No built-in categories, so the assertions below see only extension rows.
vi.mock("$server/runtime/tools/builtin-registry", () => ({ getBuiltInCategories: () => [] }));

/** The rows the extensions query returns, in select order. */
let extRows: Array<Record<string, unknown>> = [];
const limit = vi.fn(async () => extRows);
vi.mock("$server/db/connection", () => ({
	getDb: () => ({
		select: () => ({
			from: () => ({ where: () => ({ limit }) }),
		}),
	}),
}));

let deniedNames: string[] = [];
const partitionWirableExtensionsForUser = vi.fn(
	async (_rows: unknown, _actor: unknown) => ({ allowed: [], deniedNames }),
);
vi.mock("$server/auth/extension-wire-authz", () => ({
	partitionWirableExtensionsForUser: (rows: unknown, actor: unknown) =>
		partitionWirableExtensionsForUser(rows, actor),
}));

const { GET } = await import("../routes/api/mentions/search/+server");

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

function makeEvent(search: string) {
	return makeRequestEvent(`http://localhost/api/mentions/search?${search}`, {
		locals: { user },
		request: { method: "GET" },
	});
}

function row(name: string, over: Record<string, unknown> = {}) {
	return {
		id: `id-${name}`,
		name,
		description: `${name} description`,
		manifest: { kind: "subprocess" },
		source: "local",
		isBundled: false,
		creatorUserId: null,
		...over,
	};
}

const MCP = row("weather-mcp", { manifest: { kind: "mcp" }, source: "mcp:stdio" });
const PLAIN = row("notes");

beforeEach(() => {
	extRows = [];
	deniedNames = [];
	limit.mockClear();
	partitionWirableExtensionsForUser.mockClear();
});

describe("GET /api/mentions/search?type=ext — wire-gate filtering", () => {
	test("a denied extension is NOT offered", async () => {
		extRows = [MCP, PLAIN];
		deniedNames = ["weather-mcp"];

		const res = await GET(makeEvent("type=ext"));
		const body = (await res.json()) as Array<{ name: string; kind: string }>;
		expect(body.map((r) => r.name)).toEqual(["notes"]);
	});

	test("an allowed extension is still offered — no regression", async () => {
		extRows = [MCP, PLAIN];
		deniedNames = [];

		const res = await GET(makeEvent("type=ext"));
		const body = (await res.json()) as Array<{ name: string; description: string }>;
		expect(body.map((r) => r.name).sort()).toEqual(["notes", "weather-mcp"]);
		// The description survives the filter — the row shape the gate sees is
		// narrower than the row the endpoint returns.
		expect(body.find((r) => r.name === "notes")!.description).toBe("notes description");
	});

	test("the gate is asked ONCE, with the full rows and the request's actor", async () => {
		// Once per request, not once per candidate — this endpoint runs on
		// every keystroke of an `!` token.
		extRows = [MCP, PLAIN];
		await GET(makeEvent("type=ext&projectId=proj-1"));

		expect(partitionWirableExtensionsForUser).toHaveBeenCalledTimes(1);
		const [rows, actor] = partitionWirableExtensionsForUser.mock.calls[0]!;
		expect(rows).toEqual([MCP, PLAIN]);
		// The gate decides on COLUMNS, so the query must select them — before
		// this fix it selected only `name` + `description`.
		expect((rows as Array<Record<string, unknown>>)[0]).toHaveProperty("manifest");
		expect((rows as Array<Record<string, unknown>>)[0]).toHaveProperty("creatorUserId");
		expect(actor).toEqual({ userId: "u1", projectId: "proj-1" });
	});

	test("a request with no project asks at the all-projects coordinate", async () => {
		extRows = [MCP];
		await GET(makeEvent("type=ext"));
		expect(
			(partitionWirableExtensionsForUser.mock.calls[0]![1] as { projectId: unknown }).projectId,
		).toBeNull();
	});

	test("every denied row drops, leaving an empty list rather than an error", async () => {
		// The endpoint stays a plain list: denial is absence, never a message.
		// A user-visible "you may not use this" here would be the existence
		// oracle the silent-no-op contract exists to avoid.
		extRows = [MCP];
		deniedNames = ["weather-mcp"];
		const res = await GET(makeEvent("type=ext"));
		expect(res.status).toBe(200);
		expect(await res.json()).toEqual([]);
	});
});
