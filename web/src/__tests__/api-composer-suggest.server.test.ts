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
const resolveSuggestableExtensions = vi.fn();
vi.mock("$lib/server/scoped-tools", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$lib/server/scoped-tools")>();
	return { ...actual, resolveScopedTools, resolveSuggestableExtensions };
});

const generateEmbedding = vi.fn();
const isEmbeddingReady = vi.fn();
const warmupEmbeddings = vi.fn();
vi.mock("$server/memory/embeddings", () => ({ generateEmbedding, isEmbeddingReady, warmupEmbeddings }));

const getToolEmbedding = vi.fn();
const getRawTextEmbedding = vi.fn();
vi.mock("$server/suggest/embedding-cache", () => ({ getToolEmbedding, getRawTextEmbedding }));

// Partial mock: getUserToolPriors is stubbed, but deriveExtensionPriors must
// stay REAL so the extension prior-boost cases exercise its `${ext}__`-prefix
// max semantics against the (mocked) priors map.
const getUserToolPriors = vi.fn();
vi.mock("$server/suggest/user-tool-priors", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$server/suggest/user-tool-priors")>();
	return { ...actual, getUserToolPriors };
});

const getSuggestConfig = vi.fn();
const isSuggestEnabledForProject = vi.fn();
vi.mock("$server/suggest/config", () => ({ getSuggestConfig, isSuggestEnabledForProject }));

const isEnhanceAvailable = vi.fn();
const enhancePrompt = vi.fn();
vi.mock("$server/suggest/enhance", () => ({ isEnhanceAvailable, enhancePrompt }));

vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));

// ── Leaves used ONLY by the real-fn coverage blocks below ──────────
// The handler tests never reach these (they mock resolveScopedTools +
// resolveSuggestableExtensions), but the real functions — reached via
// vi.importActual — drive them. Partial db-query mocks keep every other
// export of those modules intact; the registry/built-in mocks mirror the
// api-tools handler test's shape (only scoped-tools imports them here).
const listExtensions = vi.fn();
vi.mock("$server/db/queries/extensions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$server/db/queries/extensions")>();
	return { ...actual, listExtensions };
});
const getConversationExtensionIds = vi.fn();
vi.mock("$server/db/queries/conversation-extensions", async (importOriginal) => {
	const actual = await importOriginal<typeof import("$server/db/queries/conversation-extensions")>();
	return { ...actual, getConversationExtensionIds };
});

const getAllTools = vi.fn(() => [] as unknown[]);
const getExtensionType = vi.fn((_name: string) => "local");
const getExtensionDescription = vi.fn((_name: string): string | undefined => undefined);
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ getAllTools, getExtensionType, getExtensionDescription }),
	},
}));

const getBuiltInToolMetadata = vi.fn(() => [] as Array<{ name: string; description: string; category: string }>);
const getBuiltInCategoryDescription = vi.fn((_cat: string): string | undefined => undefined);
vi.mock("$server/runtime/tools/builtin-registry", () => ({
	getBuiltInToolMetadata,
	getBuiltInCategoryDescription,
}));

const { POST } = await import("../routes/api/composer/suggest/+server");

// Real (unmocked) scoped-tools exports for direct coverage of the new
// functions + the changed tokenEstimate/pass-through line.
const {
	resolveSuggestableExtensions: realResolveSuggestableExtensions,
	isModeToolRestricted,
	resolveScopedTools: realResolveScopedTools,
} = await vi.importActual<typeof import("$lib/server/scoped-tools")>("$lib/server/scoped-tools");

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
	// Default: embedder warm/ready, so every existing case ranks with the
	// full hybrid (embedding + lexical) signal. The degraded-mode suite
	// re-points this to false per test.
	isEmbeddingReady.mockReturnValue(true);
	getSuggestConfig.mockResolvedValue({ enabled: true, baseUrl: null, model: "qwen3:1.7b", timeoutMs: 12000 });
	isSuggestEnabledForProject.mockResolvedValue(true);
	resolveScopedTools.mockResolvedValue({ tools: SCOPED_TOOLS, orchestrationTools: [], mode: null, projectId: null });
	// Extensions default to none suggestable + a neutral raw-example vector so
	// existing tool-only cases stay byte-identical.
	resolveSuggestableExtensions.mockResolvedValue([]);
	getRawTextEmbedding.mockResolvedValue([0, 0, 1]);
	// Draft aligned with analyzer scan; websearch orthogonal-ish; built-in mid.
	// getToolEmbedding receives the human-readable label ("<extension> <name>"
	// for extension tools, "<category> <name>" for built-ins) — NOT the
	// namespaced key (the key prefix measurably drags the cosine down).
	generateEmbedding.mockResolvedValue([1, 0, 0]);
	getToolEmbedding.mockImplementation(async (label: string) => {
		if (label === "analyzer scan") return [0.95, 0.05, 0];
		if (label === "websearch search") return [0.4, 0.6, 0];
		if (label === "ez task_create") return [0.5, 0.5, 0];
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

	test("lexical rescue: a draft naming the tool ranks it even at zero cosine (live regression)", async () => {
		// Every tool embedding orthogonal to the draft — embedding-only ranking
		// would return nothing. "web search" hits websearch's name tokens.
		getToolEmbedding.mockResolvedValue([0, 0, 1]);
		const res = await call({ draft: "web search for bun release news" });
		const names = (await res.json()).tools.map((t: { name: string }) => t.name);
		expect(names).toEqual(["search"]);
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

describe("POST /api/composer/suggest — extension ranking (include: extensions)", () => {
	test("extensions key is absent + never queried when not requested (old-client byte-compat)", async () => {
		const res = await call({ draft: "find bugs in my code" }); // default include ["tools"]
		const body = await res.json();
		expect("extensions" in body).toBe(false);
		expect(resolveSuggestableExtensions).not.toHaveBeenCalled();
	});

	test("mode-restricted → extensions [] and resolveSuggestableExtensions NOT called", async () => {
		resolveScopedTools.mockResolvedValue({
			tools: SCOPED_TOOLS,
			orchestrationTools: [],
			mode: { extensionIds: ["e1"], toolRestriction: "allowlist" },
			projectId: null,
		});
		const res = await call({ draft: "clean up my downloads folder", include: ["tools", "extensions"] });
		const body = await res.json();
		expect(body.extensions).toEqual([]);
		expect(resolveSuggestableExtensions).not.toHaveBeenCalled();
	});

	test("unwired relevant extensions surface as chips; gate drops the sub-0.35 one", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "file-organizer", description: "Organize and tidy files", suggestExamples: undefined },
			{ name: "calendar", description: "Manage calendar events", suggestExamples: undefined },
			{ name: "weather", description: "Weather forecasts", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) => {
			if (label === "file-organizer") return [0.95, 0.05, 0]; // cosine ≈ 0.998 in
			if (label === "calendar") return [0.5, 0.6, 0]; // cosine ≈ 0.64 in
			if (label === "weather") return [0.3, Math.sqrt(1 - 0.09), 0]; // cosine 0.30 → out
			return [0, 0, 1]; // scoped tools orthogonal → no tool chips, no dedupe
		});
		const res = await call({ draft: "some neutral phrasing text", include: ["extensions"] });
		const body = await res.json();
		expect(body.tools).toBeUndefined(); // tools not requested
		expect(resolveSuggestableExtensions).toHaveBeenCalledWith(null);
		expect(body.extensions.map((e: { name: string }) => e.name)).toEqual(["file-organizer", "calendar"]);
		// Scores rounded to 4 decimals, and each chip carries name + description.
		expect(body.extensions[0]).toMatchObject({ name: "file-organizer", description: "Organize and tidy files" });
		expect(String(body.extensions[0].score)).not.toMatch(/\d{5,}$/);
	});

	test("gate is exactly 0.35: 0.30 cosine dropped, 0.40 cosine kept", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "just-under", description: "aaa bbb ccc", suggestExamples: undefined },
			{ name: "just-over", description: "ddd eee fff", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) => {
			if (label === "just-under") return [0.3, Math.sqrt(1 - 0.09), 0]; // cosine 0.30
			if (label === "just-over") return [0.4, Math.sqrt(1 - 0.16), 0]; // cosine 0.40
			return [0, 0, 1];
		});
		const res = await call({ draft: "zzz qqq vvv wordy stuff", include: ["extensions"] });
		const names = (await res.json()).extensions.map((e: { name: string }) => e.name);
		expect(names).toEqual(["just-over"]);
	});

	test("extension suggestions are capped at top-2 even with more qualifying", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "alpha", description: "aaa", suggestExamples: undefined },
			{ name: "bravo", description: "bbb", suggestExamples: undefined },
			{ name: "charlie", description: "ccc", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) => {
			if (label === "alpha") return [0.99, 0.14, 0];
			if (label === "bravo") return [0.9, 0.44, 0];
			if (label === "charlie") return [0.7, 0.71, 0];
			return [0, 0, 1];
		});
		const names = (await (await call({ draft: "wholly unrelated words here", include: ["extensions"] })).json())
			.extensions.map((e: { name: string }) => e.name);
		expect(names).toEqual(["alpha", "bravo"]);
	});

	test("an extension already surfaced as a ranked TOOL chip is deduped from extension chips", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "websearch", description: "Search the web for pages", suggestExamples: undefined },
			{ name: "file-organizer", description: "Organize and tidy files", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) => {
			if (label === "websearch search") return [0.98, 0.02, 0]; // websearch TOOL ranks
			if (label === "websearch") return [0.98, 0.02, 0]; // would rank as ext too
			if (label === "file-organizer") return [0.9, 0.1, 0];
			return [0, 0, 1];
		});
		const body = await (await call({ draft: "search the web now", include: ["tools", "extensions"] })).json();
		expect(body.tools.map((t: { extension: string }) => t.extension)).toContain("websearch");
		const extNames = body.extensions.map((e: { name: string }) => e.name);
		expect(extNames).not.toContain("websearch"); // deduped against the tool chip
		expect(extNames).toContain("file-organizer");
	});

	test("prefixed tool prior boosts its extension (deriveExtensionPriors max over ext-prefixed keys)", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "cal", description: "calendar stuff", suggestExamples: undefined },
			{ name: "org", description: "organize stuff", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockResolvedValue([0.6, 0.8, 0]); // both tie on cosine 0.6
		// Only `cal` has a usage prior, recorded under its namespaced tool key;
		// the bare built-in key must be ignored by deriveExtensionPriors.
		getUserToolPriors.mockResolvedValue({ cal__add_event: 1, some_builtin: 1 });
		const names = (await (await call({ draft: "totally neutral phrasing here", include: ["extensions"] })).json())
			.extensions.map((e: { name: string }) => e.name);
		expect(names).toEqual(["cal", "org"]); // prior breaks the cosine tie in cal's favor
	});

	test("extension retrieval via authored example: orthogonal description, aligned suggestExample", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "tidy", description: "orthogonal description text", suggestExamples: ["clean up my downloads folder"] },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockResolvedValue([0, 1, 0]); // description cosine 0
		getRawTextEmbedding.mockResolvedValue([0.98, 0.2, 0]); // example cosine ≈ 0.98
		const body = await (await call({ draft: "help with chores today", include: ["extensions"] })).json();
		expect(getRawTextEmbedding).toHaveBeenCalledWith("clean up my downloads folder");
		expect(body.extensions.map((e: { name: string }) => e.name)).toEqual(["tidy"]);
	});

	test("per-TOOL suggestExamples: getRawTextEmbedding called + example tokens fold into the lexical match", async () => {
		resolveScopedTools.mockResolvedValue({
			tools: [
				{
					name: "lookup",
					description: "orthogonal words",
					extension: "websearch",
					extensionType: "extension",
					extensionDescription: undefined,
					suggestExamples: ["search the web for the latest bun runtime release notes"],
					tokenEstimate: 10,
				},
			],
			orchestrationTools: [],
			mode: null,
			projectId: null,
		});
		// Both the description AND the example embeddings are orthogonal to the
		// draft, so ONLY the folded example tokens (in descTokens) can rescue it.
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockResolvedValue([0, 1, 0]);
		getRawTextEmbedding.mockResolvedValue([0, 1, 0]);
		const body = await (await call({ draft: "latest bun runtime release notes", include: ["tools"] })).json();
		expect(getRawTextEmbedding).toHaveBeenCalledWith("search the web for the latest bun runtime release notes");
		expect(body.tools.map((t: { name: string }) => t.name)).toContain("lookup");
	});

	test("no describable tools but extensions requested: tools [] while extensions still rank", async () => {
		resolveScopedTools.mockResolvedValue({
			tools: [
				{ name: "blank", description: "   ", extension: "misc", extensionType: "extension", extensionDescription: undefined, suggestExamples: undefined, tokenEstimate: 5 },
			],
			orchestrationTools: [],
			mode: null,
			projectId: null,
		});
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "file-organizer", description: "Organize and tidy files", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) =>
			label === "file-organizer" ? [0.95, 0.05, 0] : [0, 0, 1],
		);
		const body = await (await call({ draft: "help me organize things", include: ["tools", "extensions"] })).json();
		expect(body.tools).toEqual([]); // rankScopedTools early-returned (no described candidates)
		expect(body.extensions.map((e: { name: string }) => e.name)).toEqual(["file-organizer"]);
	});

	test("the only suggestable extension being deduped yields an empty extensions list", async () => {
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "websearch", description: "Search the web for pages", suggestExamples: undefined },
		]);
		generateEmbedding.mockResolvedValue([1, 0, 0]);
		getToolEmbedding.mockImplementation(async (label: string) =>
			label === "websearch search" ? [0.98, 0.02, 0] : [0, 0, 1],
		);
		const body = await (await call({ draft: "search the web please", include: ["tools", "extensions"] })).json();
		expect(body.tools.map((t: { extension: string }) => t.extension)).toContain("websearch");
		expect(body.extensions).toEqual([]); // deduped against the tool chip → nothing left
	});
});

describe("POST /api/composer/suggest — embedder warm-up (degraded mode)", () => {
	test("embedder not ready: tools rank lexical-only; embedding fns NEVER called; warm-up kicked once", async () => {
		isEmbeddingReady.mockReturnValue(false);
		// "web search" hits websearch's NAME tokens → lexical rescue ranks it
		// even though no embedding is computed (same result as the healthy
		// lexical-rescue case, but with zero embedder work).
		const res = await call({ draft: "web search for bun release news" });
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.degraded).toBe(true);
		expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["search"]);
		// No embedder touched at all while warming.
		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(getToolEmbedding).not.toHaveBeenCalled();
		expect(getRawTextEmbedding).not.toHaveBeenCalled();
		// The route kicked the model load exactly once.
		expect(warmupEmbeddings).toHaveBeenCalledTimes(1);
	});

	test("embedder not ready: extensions rank lexically, tool-chip dedupe still holds", async () => {
		isEmbeddingReady.mockReturnValue(false);
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "websearch", description: "Search the web for pages", suggestExamples: undefined },
			{ name: "file-organizer", description: "Organize and tidy files", suggestExamples: undefined },
		]);
		// Draft lexically hits the websearch TOOL (name "search") AND the
		// file-organizer EXTENSION (desc "organize"/"files") — websearch as an
		// extension is deduped against its own ranked tool chip.
		const body = await (
			await call({ draft: "search the web to organize files", include: ["tools", "extensions"] })
		).json();
		expect(body.degraded).toBe(true);
		expect(body.tools.map((t: { extension: string }) => t.extension)).toContain("websearch");
		const extNames = body.extensions.map((e: { name: string }) => e.name);
		expect(extNames).toEqual(["file-organizer"]); // websearch deduped out
		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(getToolEmbedding).not.toHaveBeenCalled();
	});

	test("embedder not ready + irrelevant draft: relevance gates hold → tools [] and extensions []", async () => {
		isEmbeddingReady.mockReturnValue(false);
		resolveSuggestableExtensions.mockResolvedValue([
			{ name: "calendar", description: "Manage calendar events", suggestExamples: undefined },
		]);
		// Nonsense tokens match no name/description → lexical 0 everywhere, so
		// the 0.28 (tool) and 0.35 (extension) gates drop everything.
		const body = await (
			await call({ draft: "zzz qqq vvv", include: ["tools", "extensions"] })
		).json();
		expect(body.degraded).toBe(true);
		expect(body.tools).toEqual([]);
		expect(body.extensions).toEqual([]);
		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(getToolEmbedding).not.toHaveBeenCalled();
	});

	test("embedder not ready: per-user prior still blends over lexical-only relevance", async () => {
		isEmbeddingReady.mockReturnValue(false);
		// "search and scan" clears the lexical gate for BOTH scan and search at
		// relevance 1.0; without a prior they tie and sort by key
		// (analyzer__scan first). The prior on websearch__search lifts it above.
		getUserToolPriors.mockResolvedValue({ websearch__search: 1 });
		const names = (await (await call({ draft: "search and scan" })).json()).tools.map(
			(t: { name: string }) => t.name,
		);
		expect(names.indexOf("search")).toBeLessThan(names.indexOf("scan"));
		expect(getToolEmbedding).not.toHaveBeenCalled();
	});

	test("embedder not ready: enhance path still works (sidecar reachable), degraded reported", async () => {
		isEmbeddingReady.mockReturnValue(false);
		getSuggestConfig.mockResolvedValue({ enabled: true, baseUrl: "http://ollama:11434", model: "m", timeoutMs: 1000 });
		isEnhanceAvailable.mockResolvedValue(true);
		enhancePrompt.mockResolvedValue({ enhanced: "Better draft", reason: "specific" });
		const body = await (
			await call({ draft: "web search for bun release news", include: ["tools", "enhance"] })
		).json();
		expect(body.degraded).toBe(true);
		expect(body.llmAvailable).toBe(true);
		expect(body.enhancement).toEqual({ enhanced: "Better draft", reason: "specific" });
		// Enhance rode the lexical-only tool ranking; no embedder work.
		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(warmupEmbeddings).toHaveBeenCalledTimes(1);
	});

	test("embedder not ready + empty surface: tools [] with no embedding work, warm-up still kicked", async () => {
		isEmbeddingReady.mockReturnValue(false);
		resolveScopedTools.mockResolvedValue({ tools: [], orchestrationTools: [], mode: null, projectId: null });
		const body = await (await call({ draft: "hello world draft" })).json();
		expect(body.degraded).toBe(true);
		expect(body.tools).toEqual([]);
		expect(generateEmbedding).not.toHaveBeenCalled();
		expect(getToolEmbedding).not.toHaveBeenCalled();
		// Warm-up fires even with nothing rankable, so a later request is warm.
		expect(warmupEmbeddings).toHaveBeenCalledTimes(1);
	});

	test("healthy embedder: degraded=false and warm-up NOT kicked", async () => {
		// isEmbeddingReady defaults to true in beforeEach.
		const body = await (await call({ draft: "find bugs in my code" })).json();
		expect(body.degraded).toBe(false);
		expect(warmupEmbeddings).not.toHaveBeenCalled();
		// The embedder was used (full hybrid ranking).
		expect(generateEmbedding).toHaveBeenCalledTimes(1);
	});

	test("embedder ready but generateEmbedding throws → degraded catch branch, lexical-only", async () => {
		isEmbeddingReady.mockReturnValue(true);
		generateEmbedding.mockRejectedValue(new Error("embedder boom"));
		const body = await (await call({ draft: "web search for bun release news" })).json();
		expect(body.degraded).toBe(true);
		// generateEmbedding was attempted (and threw); per-candidate embedding
		// is then skipped (useEmbeddings=false after the catch).
		expect(generateEmbedding).toHaveBeenCalledTimes(1);
		expect(getToolEmbedding).not.toHaveBeenCalled();
		// Falls back to lexical ranking — websearch's name tokens rescue it.
		expect(body.tools.map((t: { name: string }) => t.name)).toEqual(["search"]);
		// isEmbeddingReady was true, so the boot-style warm-up was NOT kicked.
		expect(warmupEmbeddings).not.toHaveBeenCalled();
	});
});

describe("scoped-tools real functions (direct coverage of the new exports)", () => {
	test("isModeToolRestricted truth table", () => {
		expect(isModeToolRestricted(null)).toBe(false);
		// A pinned extension set restricts, regardless of toolRestriction.
		expect(isModeToolRestricted({ extensionIds: ["e1"], toolRestriction: "all" })).toBe(true);
		// "all" is the stored default on EVERY mode row (notNull default) and
		// applyToolFilters treats it as "no category-level filter" — a plain
		// mode must NOT suppress extension suggestions, or they would never
		// surface inside any mode at all.
		expect(isModeToolRestricted({ extensionIds: [], toolRestriction: "all" })).toBe(false);
		// A narrowing toolRestriction restricts even with no pinned extensions.
		expect(isModeToolRestricted({ extensionIds: [], toolRestriction: "read-only" })).toBe(true);
		expect(isModeToolRestricted({ extensionIds: [], toolRestriction: "none" })).toBe(true);
		expect(isModeToolRestricted({ extensionIds: [], toolRestriction: "allowlist" })).toBe(true);
		expect(isModeToolRestricted({ extensionIds: ["e1"], toolRestriction: null } as never)).toBe(true);
		// Neither → not restricted (synthetic: real rows always set toolRestriction).
		expect(isModeToolRestricted({ extensionIds: null, toolRestriction: null } as never)).toBe(false);
		expect(isModeToolRestricted({ extensionIds: [], toolRestriction: "" } as never)).toBe(false);
	});

	test("resolveSuggestableExtensions: wired-ID exclusion + empty-description drop + field mapping", async () => {
		listExtensions.mockResolvedValue([
			{ id: "e1", name: "file-organizer", manifest: { description: "Tidy files", suggestExamples: ["clean up downloads"] } },
			{ id: "e2", name: "web-search", manifest: { description: "Search the web" } },
			{ id: "e3", name: "blank", manifest: { description: "   " } }, // whitespace-only → dropped
			{ id: "e4", name: "nodesc", manifest: {} }, // missing description → dropped
			{ id: "e5", name: "wired", manifest: { description: "Already wired here" } },
		]);
		getConversationExtensionIds.mockResolvedValue(["e5"]); // wired → excluded by ID
		const out = await realResolveSuggestableExtensions("conv-1");
		expect(listExtensions).toHaveBeenCalledWith(true);
		expect(getConversationExtensionIds).toHaveBeenCalledWith("conv-1");
		expect(out.map((e) => e.name)).toEqual(["file-organizer", "web-search"]);
		expect(out[0]).toEqual({
			name: "file-organizer",
			description: "Tidy files",
			suggestExamples: ["clean up downloads"],
		});
		expect(out[1]!.suggestExamples).toBeUndefined();
	});

	test("resolveSuggestableExtensions: null conversationId skips the wired-ids query", async () => {
		listExtensions.mockResolvedValue([
			{ id: "e1", name: "file-organizer", manifest: { description: "Tidy files" } },
		]);
		const out = await realResolveSuggestableExtensions(null);
		expect(getConversationExtensionIds).not.toHaveBeenCalled();
		expect(out.map((e) => e.name)).toEqual(["file-organizer"]);
	});

	test("resolveScopedTools: tokenEstimate excludes suggestExamples; the field passes through", async () => {
		getBuiltInToolMetadata.mockReturnValue([]);
		const examples = ["clean up my downloads", "organize these files by type"];
		const tool = {
			name: "file-organizer__organize",
			description: "Organize files",
			inputSchema: {},
			suggestExamples: examples,
			extensionId: "e1",
			extensionName: "file-organizer",
			originalName: "organize",
		};
		getAllTools.mockReturnValue([tool]);
		const res = await realResolveScopedTools(owner as never, {
			conversationId: null,
			modeId: null,
			hasModeParam: false,
		});
		const row = res!.tools.find((t) => t.name === "organize")!;
		expect(row.suggestExamples).toEqual(examples);
		const { suggestExamples: _drop, ...billable } = tool;
		void _drop;
		expect(row.tokenEstimate).toBe(Math.ceil(JSON.stringify(billable).length / 4));
		// Sizing WITH the examples would be strictly larger — proving they're excluded.
		expect(row.tokenEstimate).toBeLessThan(Math.ceil(JSON.stringify(tool).length / 4));
	});
});
