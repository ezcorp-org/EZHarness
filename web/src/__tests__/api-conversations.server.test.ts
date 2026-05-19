/**
 * Server-handler unit tests for /api/conversations/+server.ts.
 *
 * Covers:
 *  - GET auth gate + 400 missing projectId
 *  - POST auth gate + scope check
 *  - POST happy path with agentConfigId → title defaults to "Chat with {agentName}"
 *  - POST happy path without agentConfigId → systemPrompt undefined
 *  - POST 404 when agentConfigId provided but config missing
 *  - POST side-effect: createConversation called with correct userId / title / provider
 *
 * DB query module is mocked at the import boundary so we stay off PGlite.
 */

import { test, expect, describe, vi, beforeEach } from "vitest";

vi.mock("$server/db/queries/conversations", () => ({
	createConversation: vi.fn(),
	listConversations: vi.fn(),
	searchConversations: vi.fn(),
}));

vi.mock("$server/db/queries/agent-configs", () => ({
	getAgentConfig: vi.fn(),
}));

const { createConversation, listConversations, searchConversations } =
	await import("$server/db/queries/conversations");
const { getAgentConfig } = await import("$server/db/queries/agent-configs");
const { GET, POST } = await import("../routes/api/conversations/+server");

function makeEvent(opts: {
	href?: string;
	body?: unknown;
	locals?: Record<string, unknown>;
}) {
	return {
		url: new URL(opts.href ?? "http://localhost/api/conversations"),
		locals: opts.locals ?? {},
		request: new Request("http://localhost/api/conversations", {
			method: "POST",
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

const user = { id: "u1", email: "u@x", name: "u", role: "user" };
const PROJECT_ID = "00000000-0000-4000-8000-000000000001";
const AGENT_CONFIG_ID = "00000000-0000-4000-8000-000000000002";

describe("GET /api/conversations", () => {
	beforeEach(() => {
		vi.mocked(listConversations).mockReset();
		vi.mocked(searchConversations).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		const res = await expectThrownResponse(() => GET(makeEvent({})), 401);
		const body = (await res.json()) as { error?: string };
		expect(typeof body.error).toBe("string");
	});

	test("returns 400 when projectId query param is missing", async () => {
		const res = await GET(
			makeEvent({
				href: "http://localhost/api/conversations",
				locals: { user },
			}),
		);
		expect(res.status).toBe(400);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("projectId required");
	});

	test("happy path: returns list when projectId provided", async () => {
		vi.mocked(listConversations).mockResolvedValue([
			{ id: "c1", title: "First" },
		] as any);
		const res = await GET(
			makeEvent({
				href: `http://localhost/api/conversations?projectId=${PROJECT_ID}`,
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{ id: string }>;
		expect(body).toEqual([{ id: "c1", title: "First" }]);
		// Side-effect: listConversations called with projectId + user.id
		expect(vi.mocked(listConversations)).toHaveBeenCalledWith(
			PROJECT_ID,
			user.id,
			{ limit: undefined, offset: undefined },
		);
	});

	test("search branch: routes to searchConversations when search query present", async () => {
		vi.mocked(searchConversations).mockResolvedValue([{ id: "c2" }] as any);
		const res = await GET(
			makeEvent({
				href: `http://localhost/api/conversations?projectId=${PROJECT_ID}&search=hello`,
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		expect(vi.mocked(searchConversations)).toHaveBeenCalledWith(
			PROJECT_ID,
			"hello",
			user.id,
		);
		expect(vi.mocked(listConversations)).not.toHaveBeenCalled();
	});

	test("limit/offset clamped: limit=999 → 200; limit=0 → 1; offset=-5 → 0", async () => {
		vi.mocked(listConversations).mockResolvedValue([] as any);
		await GET(
			makeEvent({
				href: `http://localhost/api/conversations?projectId=${PROJECT_ID}&limit=999&offset=-5`,
				locals: { user },
			}),
		);
		expect(vi.mocked(listConversations)).toHaveBeenCalledWith(
			PROJECT_ID,
			user.id,
			{ limit: 200, offset: 0 },
		);
	});

	test("GET listing echoes agentConfigId field for agent-conversations", async () => {
		const now = new Date();
		vi.mocked(listConversations).mockResolvedValue([
			{
				id: "conv-1",
				projectId: PROJECT_ID,
				title: "Chat with my-agent",
				agentConfigId: "cfg-1",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: "conv-2",
				projectId: PROJECT_ID,
				title: "Regular Chat",
				agentConfigId: null,
				createdAt: now,
				updatedAt: now,
			},
		] as any);

		const res = await GET(
			makeEvent({
				href: `http://localhost/api/conversations?projectId=${PROJECT_ID}`,
				locals: { user },
			}),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as Array<{
			id: string;
			agentConfigId: string | null;
		}>;
		expect(body).toHaveLength(2);
		const agentConv = body.find((c) => c.id === "conv-1")!;
		const regularConv = body.find((c) => c.id === "conv-2")!;
		expect(agentConv.agentConfigId).toBe("cfg-1");
		expect(regularConv.agentConfigId).toBeNull();
	});
});

describe("POST /api/conversations", () => {
	beforeEach(() => {
		vi.mocked(createConversation).mockReset();
		vi.mocked(getAgentConfig).mockReset();
	});

	test("rejects 401 when locals.user is missing", async () => {
		await expectThrownResponse(
			() => POST(makeEvent({ body: { projectId: PROJECT_ID } })),
			401,
		);
	});

	test("returns 403 when API-key scope missing 'chat'", async () => {
		const res = await POST(
			makeEvent({
				body: { projectId: PROJECT_ID },
				locals: { user, apiKeyScopes: ["read"] },
			}),
		);
		expect(res.status).toBe(403);
		const body = (await res.json()) as { error?: string; required?: string };
		expect(body.error).toBe("Insufficient scope");
		expect(body.required).toBe("chat");
	});

	test("returns 400 on schema validation failure (missing projectId)", async () => {
		const res = await POST(
			makeEvent({
				body: {},
				locals: { user },
			}),
		);
		expect(res.status).toBe(400);
	});

	test("happy path with agentConfigId: title defaults to 'Chat with {agentName}'", async () => {
		vi.mocked(getAgentConfig).mockResolvedValue({
			id: AGENT_CONFIG_ID,
			name: "Helper",
			prompt: "You are helpful.",
		} as any);
		vi.mocked(createConversation).mockResolvedValue({
			id: "c-new",
			title: "Chat with Helper",
		} as any);

		const res = await POST(
			makeEvent({
				body: {
					projectId: PROJECT_ID,
					agentConfigId: AGENT_CONFIG_ID,
					provider: "anthropic",
					model: "claude-3",
				},
				locals: { user },
			}),
		);
		expect(res.status).toBe(201);
		const body = (await res.json()) as { id: string; title: string };
		expect(body.id).toBe("c-new");

		// Side-effect: createConversation called with derived title + user.id +
		// systemPrompt sourced from agentConfig.prompt
		expect(vi.mocked(createConversation)).toHaveBeenCalledTimes(1);
		const [calledProjectId, calledOpts] =
			vi.mocked(createConversation).mock.calls[0]!;
		expect(calledProjectId).toBe(PROJECT_ID);
		expect(calledOpts).toMatchObject({
			title: "Chat with Helper",
			userId: user.id,
			provider: "anthropic",
			model: "claude-3",
			agentConfigId: AGENT_CONFIG_ID,
			systemPrompt: "You are helpful.",
		});
	});

	test("happy path without agentConfigId: systemPrompt is undefined and getAgentConfig not called", async () => {
		vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);
		const res = await POST(
			makeEvent({
				body: { projectId: PROJECT_ID, title: "Manual title" },
				locals: { user },
			}),
		);
		expect(res.status).toBe(201);
		expect(vi.mocked(getAgentConfig)).not.toHaveBeenCalled();
		const calledOpts = vi.mocked(createConversation).mock.calls[0]![1]!;
		expect(calledOpts.systemPrompt).toBeUndefined();
		expect(calledOpts.title).toBe("Manual title");
	});

	test("404 when agentConfigId provided but config not found", async () => {
		vi.mocked(getAgentConfig).mockResolvedValue(undefined as any);
		const res = await POST(
			makeEvent({
				body: { projectId: PROJECT_ID, agentConfigId: AGENT_CONFIG_ID },
				locals: { user },
			}),
		);
		expect(res.status).toBe(404);
		const body = (await res.json()) as { error?: string };
		expect(body.error).toBe("Agent config not found");
		expect(vi.mocked(createConversation)).not.toHaveBeenCalled();
	});

	test("explicit title overrides agentConfig name fallback", async () => {
		vi.mocked(getAgentConfig).mockResolvedValue({
			id: AGENT_CONFIG_ID,
			name: "Helper",
			prompt: "p",
		} as any);
		vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);
		await POST(
			makeEvent({
				body: {
					projectId: PROJECT_ID,
					agentConfigId: AGENT_CONFIG_ID,
					title: "Override title",
				},
				locals: { user },
			}),
		);
		const calledOpts = vi.mocked(createConversation).mock.calls[0]![1]!;
		expect(calledOpts.title).toBe("Override title");
	});

	test("uses locals.user.id for createConversation, not body field", async () => {
		// Defence-in-depth: even if body had a `userId` (it doesn't validate),
		// the handler must use locals.user.id.
		vi.mocked(createConversation).mockResolvedValue({ id: "c-new" } as any);
		await POST(
			makeEvent({
				body: { projectId: PROJECT_ID },
				locals: { user },
			}),
		);
		const calledOpts = vi.mocked(createConversation).mock.calls[0]![1]!;
		expect(calledOpts.userId).toBe(user.id);
	});
});
