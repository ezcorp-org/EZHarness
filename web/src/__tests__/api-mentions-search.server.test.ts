/**
 * Server-handler unit tests for /api/mentions/search/+server.ts.
 *
 * Branchy handler with five distinct flows:
 *  - scope/auth gates
 *  - type=cmd  → command registry only (mutually exclusive with others)
 *  - type=path → filesystem listing (mutually exclusive)
 *  - type=team → DB-backed (skipped: requires real DB)
 *  - default   → teams + agents + extensions union (skipped: real DB)
 *
 * We mock the project query, command registry, and executor. The DB-backed
 * branches (type=agent / type=ext / default) require getDb() and are
 * intentionally NOT covered to avoid PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/projects", () => ({
	getProject: vi.fn(),
}));

const mockListCommands = vi.fn();
const mockListAgents = vi.fn();

vi.mock("$lib/server/context", () => ({
	getExecutor: () => ({ listAgents: mockListAgents }),
	getCommandRegistry: () => ({ listCommands: mockListCommands }),
}));

const { getProject } = await import("$server/db/queries/projects");
const { GET } = await import("../routes/api/mentions/search/+server");

function makeEvent(opts: {
	href?: string;
	locals?: Record<string, unknown>;
}) {
	const href = opts.href ?? "http://localhost/api/mentions/search";
	return {
		url: new URL(href),
		locals: opts.locals ?? {},
		request: new Request(href, { method: "GET" }),
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

const user = { id: "u1", email: "u@x", name: "u", role: "user" };

describe("GET /api/mentions/search", () => {
	beforeEach(() => {
		vi.mocked(getProject).mockReset();
		mockListCommands.mockReset();
		mockListAgents.mockReset();
	});

	test("returns 403 when API-key scope missing 'read'", async () => {
		const res = await GET(
			makeEvent({
				locals: {
					user,
					apiKeyScopes: ["chat"],
				},
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("read");
	});

	test("throws 401 when unauthenticated", async () => {
		const res = await expectThrownResponse(
			() => GET(makeEvent({ locals: {} })),
			401,
		);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Authentication required");
	});

	test("type=path with no projectId returns [] (short-circuit before FS)", async () => {
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=path&q=foo",
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(Array.isArray(body)).toBe(true);
		expect(body.length).toBe(0);
	});

	test("type=path with unknown project returns []", async () => {
		// Project lookup misses — handler short-circuits to [] before reading FS.
		vi.mocked(getProject).mockResolvedValue(undefined as any);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=path&projectId=p1&q=foo",
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
		expect(vi.mocked(getProject)).toHaveBeenCalledWith("p1");
	});

	test("type=path with project that has no path returns []", async () => {
		vi.mocked(getProject).mockResolvedValue({
			id: "p1",
			name: "Empty",
			path: null,
		} as any);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=path&projectId=p1",
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as unknown[];
		expect(body).toEqual([]);
	});

	test("type=cmd with no q: returns commands from registry (mapped to {kind:'command'})", async () => {
		mockListCommands.mockResolvedValue([
			{
				name: "review",
				description: "Review PR",
				source: "project",
				body: "Run the reviewer",
			},
			{
				name: "summarize",
				description: "Summarize text",
				source: "home",
				body: "Make it short",
			},
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=cmd",
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			name: string;
			kind: string;
			source?: string;
			body?: string;
		}>;
		expect(body).toHaveLength(2);
		expect(body[0]).toMatchObject({
			name: "review",
			kind: "command",
			source: "project",
		});
		// Side-effect: registry listCommands called with userId from locals + projectId fallback
		expect(mockListCommands).toHaveBeenCalledWith({
			userId: user.id,
			projectId: "global",
			projectPath: null,
		});
	});

	test("type=cmd with q: fuzzy-ranks by name/description", async () => {
		mockListCommands.mockResolvedValue([
			{
				name: "review",
				description: "Review PR",
				source: "project",
				body: "x",
			},
			{
				name: "summarize",
				description: "Summarize text",
				source: "home",
				body: "y",
			},
			{
				name: "deploy",
				description: "Ship to prod",
				source: "project",
				body: "z",
			},
		]);
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=cmd&q=rev",
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ name: string }>;
		// "review" has the closest fuzzy match to "rev"; "deploy" should not
		// appear (no fuzzy match for "rev").
		expect(body.length).toBeGreaterThan(0);
		expect(body[0]!.name).toBe("review");
		expect(body.some((b) => b.name === "deploy")).toBe(false);
	});

	test("type=cmd with projectId: passes resolved project path to registry", async () => {
		vi.mocked(getProject).mockResolvedValue({
			id: "p1",
			name: "Proj",
			path: "/tmp",
		} as any);
		mockListCommands.mockResolvedValue([]);
		await GET(
			makeEvent({
				href: "http://localhost/api/mentions/search?type=cmd&projectId=p1",
				locals: { user },
			}),
		);
		expect(mockListCommands).toHaveBeenCalledTimes(1);
		const arg = mockListCommands.mock.calls[0]![0];
		expect(arg.userId).toBe(user.id);
		expect(arg.projectId).toBe("p1");
		// Path is resolve()'d so absolute — exact path is implementation
		// detail, but it must be a non-null string ending in "/tmp".
		expect(typeof arg.projectPath).toBe("string");
		expect((arg.projectPath as string).endsWith("/tmp")).toBe(true);
	});
});
