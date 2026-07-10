/**
 * POST /api/composer/suggest — handler tests.
 *
 * Runs the REAL handler + REAL intent-rank scoring + REAL scopedToolKey,
 * mocking the IO leaves: scoped-tool resolution, embeddings, priors,
 * config, and the local-LLM enhance calls. Covers the auth/validation
 * gates, the disabled short-circuit, ownership 404, ranking payload
 * shape (incl. the bare-name prior fallback and built-in keys), and the
 * enhance include with both sidecar-present and sidecar-absent paths.
 *
 * vitest, node env — no PGlite, no network, no MiniLM download.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const resolveScopedTools = vi.fn();
vi.mock("$lib/server/scoped-tools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/scoped-tools")>();
	return { ...actual, resolveScopedTools };
});

const generateEmbedding = vi.fn();
vi.mock("$server/memory/embeddings", () => ({ generateEmbedding }));

const getToolEmbedding = vi.fn();
vi.mock("$server/suggest/embedding-cache", () => ({ getToolEmbedding }));

const getUserToolPriors = vi.fn();
vi.mock("$server/suggest/user-tool-priors", () => ({ getUserToolPriors }));

const getSuggestConfig = vi.fn();
const isSuggestEnabledForProject = vi.fn();
vi.mock("$server/suggest/config", () => ({ getSuggestConfig, isSuggestEnabledForProject }));

const isEnhanceAvailable = vi.fn();
const enhancePrompt = vi.fn();
vi.mock("$server/suggest/enhance", () => ({ isEnhanceAvailable, enhancePrompt }));

vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));

const { POST } = await import("../routes/api/composer/suggest/+server");

const owner = { id: "user-1", email: "u@x", name: "U", role: "member" };

function call(body: unknown, locals: Record<string, unknown> = { user: owner }) {
	return POST({
		locals,
		request: new Request("http://localhost/api/composer/suggest", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: typeof body === "string" ? body : JSON.stringify(body),
		}),
	} as never);
}

const SCOPED_TOOLS = [
	{ name: "scan", description: "Scan source code for problems", extension: "analyzer", extensionType: "extension", extensionDescription: undefined, tokenEstimate: 10 },
	{ name: "search", description: "Search the web for pages", extension: "websearch", extensionType: "extension", extensionDescription: undefined, tokenEstimate: 10 },
	{ name: "task_create", description: "Create a task", extension: "ez", extensionType: "built-in", extensionDescription: "Ez", tokenEstimate: 10 },
	{ name: "no_desc", description: "  ", extension: "misc", extensionType: "extension", extensionDescription: undefined, tokenEstimate: 10 },
];

beforeEach(() => {
	vi.clearAllMocks();
	getSuggestConfig.mockResolvedValue({ enabled: true, baseUrl: null, model: "qwen3:1.7b", timeoutMs: 12000 });
	isSuggestEnabledForProject.mockResolvedValue(true);
	resolveScopedTools.mockResolvedValue({ tools: SCOPED_TOOLS, orchestrationTools: [], mode: null, projectId: null });
	// Draft aligned with analyzer__scan; websearch orthogonal-ish; built-in mid.
	generateEmbedding.mockResolvedValue([1, 0, 0]);
	getToolEmbedding.mockImplementation(async (key: string) => {
		if (key === "analyzer__scan") return [0.95, 0.05, 0];
		if (key === "websearch__search") return [0.4, 0.6, 0];
		if (key === "task_create") return [0.5, 0.5, 0];
		return [0, 0, 1];
	});
	getUserToolPriors.mockResolvedValue({});
	isEnhanceAvailable.mockResolvedValue(false);
	enhancePrompt.mockResolvedValue(null);
});

describe("POST /api/composer/suggest — gates", () => {
	test("API key without 'read' scope → 403", async () => {
		const res = await call({ draft: "hello world draft" }, { user: owner, apiKeyScopes: [] });
		expect(res.status).toBe(403);
	});

	test("unauthenticated → 401", async () => {
		// requireAuth throws the Response; a returned 401 would also count.
		const status = await Promise.resolve()
			.then(() => call({ draft: "hello world draft" }, {}))
			.then((res) => res.status)
			.catch((thrown) => (thrown as Response).status);
		expect(status).toBe(401);
	});

	test("invalid body (missing draft) → 400", async () => {
		const res = await call({});
		expect(res.status).toBe(400);
	});

	test("unknown keys are rejected (strict schema) → 400", async () => {
		const res = await call({ draft: "hello", evil: true });
		expect(res.status).toBe(400);
	});

	test("malformed JSON body → 400", async () => {
		const res = await call("{not json");
		expect(res.status).toBe(400);
	});

	test("suggest:enabled=false short-circuits before any scoping work", async () => {
		getSuggestConfig.mockResolvedValue({ enabled: false, baseUrl: null, model: "m", timeoutMs: 1 });
		const res = await call({ draft: "hello world draft" });
		expect(await res.json()).toEqual({ enabled: false, tools: [], enhancement: null, llmAvailable: false });
		expect(resolveScopedTools).not.toHaveBeenCalled();
	});

	test("unowned/missing conversation → 404 (fail-closed)", async () => {
		resolveScopedTools.mockResolvedValue(null);
		const res = await call({ draft: "hello world draft", conversationId: "conv-ghost" });
		expect(res.status).toBe(404);
	});

	test("project toggle off → disabled response; conversation's project is authoritative", async () => {
		resolveScopedTools.mockResolvedValue({
			tools: SCOPED_TOOLS,
			orchestrationTools: [],
			mode: null,
			projectId: "proj-conv",
		});
		isSuggestEnabledForProject.mockResolvedValue(false);
		// Client-supplied projectId must LOSE to the conversation's project.
		const res = await call({ draft: "hello world draft", conversationId: "conv-1", projectId: "proj-spoofed" });
		expect(await res.json()).toEqual({ enabled: false, tools: [], enhancement: null, llmAvailable: false });
		expect(isSuggestEnabledForProject).toHaveBeenCalledWith("proj-conv");
		expect(generateEmbedding).not.toHaveBeenCalled();
	});

	test("no conversation: body projectId feeds the per-project gate", async () => {
		await call({ draft: "hello world draft", projectId: "proj-body" });
		expect(isSuggestEnabledForProject).toHaveBeenCalledWith("proj-body");
	});

	test("no project context at all → gate consulted with null (global-only)", async () => {
		await call({ draft: "hello world draft" });
		expect(isSuggestEnabledForProject).toHaveBeenCalledWith(null);
	});
});

describe("POST /api/composer/suggest — tool ranking", () => {
	test("returns cosine-ranked tools; blank-description tools never rank", async () => {
		const res = await call({ draft: "find bugs in my code" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.enabled).toBe(true);
		expect(typeof body.latencyMs).toBe("number");
		const names = body.tools.map((t: { extension: string; name: string }) => `${t.extension}__${t.name}`);
		expect(names[0]).toBe("analyzer__scan");
		expect(names).not.toContain("misc__no_desc");
		// Enhancement not requested → absent.
		expect(body.enhancement).toBeUndefined();
		expect(body.llmAvailable).toBeUndefined();
	});

	test("scores are rounded to 4 decimals and carry tool metadata", async () => {
		const res = await call({ draft: "find bugs" });
		const [top] = (await res.json()).tools;
		expect(top).toMatchObject({
			name: "scan",
			extension: "analyzer",
			extensionType: "extension",
			description: "Scan source code for problems",
		});
		// cosine([1,0,0],[0.95,0.05,0]) ≈ 0.99862 → ×(1-0.25 priorWeight) ≈ 0.749
		expect(top.score).toBeCloseTo(0.749, 4);
		expect(String(top.score)).not.toMatch(/\d{5,}$/);
	});

	test("per-user prior reorders relevant candidates (bare-name fallback)", async () => {
		// websearch/task_create tie on cosine; a prior recorded under the BARE
		// name (built-in) must still apply to task_create.
		getUserToolPriors.mockResolvedValue({ task_create: 1 });
		const res = await call({ draft: "find stuff" });
		const names = (await res.json()).tools.map((t: { name: string }) => t.name);
		expect(names.indexOf("task_create")).toBeLessThan(names.indexOf("search"));
	});

	test("modeId presence semantics forward to resolveScopedTools", async () => {
		await call({ draft: "hello world draft", modeId: "mode-9", conversationId: "conv-1" });
		expect(resolveScopedTools).toHaveBeenCalledWith(owner, {
			conversationId: "conv-1",
			modeId: "mode-9",
			hasModeParam: true,
		});

		await call({ draft: "hello world draft" });
		expect(resolveScopedTools).toHaveBeenLastCalledWith(owner, {
			conversationId: null,
			modeId: null,
			hasModeParam: false,
		});
	});

	test("empty candidate list → empty tools without embedding work", async () => {
		resolveScopedTools.mockResolvedValue({ tools: [], orchestrationTools: [], mode: null });
		const res = await call({ draft: "hello world draft" });
		expect((await res.json()).tools).toEqual([]);
		expect(generateEmbedding).not.toHaveBeenCalled();
	});
});

describe("POST /api/composer/suggest — enhance include", () => {
	test("no baseUrl configured → llmAvailable=false, enhancement=null, probe skipped", async () => {
		const res = await call({ draft: "hello world draft", include: ["enhance"] });
		const body = await res.json();
		expect(body.llmAvailable).toBe(false);
		expect(body.enhancement).toBeNull();
		expect(body.tools).toBeUndefined(); // tools not requested
		expect(isEnhanceAvailable).not.toHaveBeenCalled();
		expect(enhancePrompt).not.toHaveBeenCalled();
	});

	test("configured but unreachable sidecar → llmAvailable=false", async () => {
		getSuggestConfig.mockResolvedValue({ enabled: true, baseUrl: "http://ollama:11434", model: "m", timeoutMs: 1 });
		isEnhanceAvailable.mockResolvedValue(false);
		const body = await (await call({ draft: "hello world draft", include: ["enhance"] })).json();
		expect(body.llmAvailable).toBe(false);
		expect(enhancePrompt).not.toHaveBeenCalled();
	});

	test("reachable sidecar → enhancement generated with mode + ranked-tool context", async () => {
		getSuggestConfig.mockResolvedValue({ enabled: true, baseUrl: "http://ollama:11434", model: "qwen3:1.7b", timeoutMs: 12000 });
		resolveScopedTools.mockResolvedValue({
			tools: SCOPED_TOOLS,
			orchestrationTools: [],
			mode: { name: "Plan", description: "Planning mode" },
		});
		isEnhanceAvailable.mockResolvedValue(true);
		enhancePrompt.mockResolvedValue({ enhanced: "Better draft", reason: "specific" });

		const body = await (
			await call({ draft: "hello world draft", include: ["tools", "enhance"] })
		).json();
		expect(body.llmAvailable).toBe(true);
		expect(body.enhancement).toEqual({ enhanced: "Better draft", reason: "specific" });
		expect(body.tools.length).toBeGreaterThan(0);

		const [draftArg, ctxArg, cfgArg] = enhancePrompt.mock.calls[0]!;
		expect(draftArg).toBe("hello world draft");
		expect(ctxArg.modeName).toBe("Plan");
		expect(ctxArg.modeDescription).toBe("Planning mode");
		expect(ctxArg.tools[0]).toEqual({ name: "scan", description: "Scan source code for problems" });
		expect(cfgArg).toEqual({ baseUrl: "http://ollama:11434", model: "qwen3:1.7b", timeoutMs: 12000 });
	});
});
