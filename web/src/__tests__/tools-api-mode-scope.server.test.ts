/**
 * GET /api/tools — mode/conversation scoping integration tests.
 *
 * Runs the REAL +server.ts handler with the REAL computeModeToolScope +
 * applyToolFilters (the exact pair the executor uses), mocking only the
 * IO leaves: extension registry contents, mode row, conversation row,
 * and ensureInitialized. This is the validation that the header badge's
 * listing is in lock-step with the runtime tool surface:
 *
 *   - mode with attached extensions → the response contains EXACTLY the
 *     mode's tools — built-in (ez) tools and other extensions' tools are
 *     absent (no "random" tools alongside the mode surface)
 *   - per-conversation narrowing applies on top (narrow-only)
 *   - explicit ?modeId= wins over the conversation's persisted modeId
 *   - no params → unfiltered listing (back-compat)
 *   - unknown conversation / unowned conversation → 404 (fail-closed)
 *
 * vitest, node env — no PGlite, no network.
 */
import { describe, test, expect, vi, beforeEach } from "vitest";

const getAllTools = vi.fn();
const getExtensionType = vi.fn(() => "extension");
const getExtensionDescription = vi.fn((_ext: string): string | undefined => undefined);
const getToolsForExtension = vi.fn();
vi.mock("$server/extensions/registry", () => ({
	ExtensionRegistry: {
		getInstance: () => ({ getAllTools, getExtensionType, getExtensionDescription, getToolsForExtension }),
	},
}));

const getMode = vi.fn();
vi.mock("$server/db/queries/modes", () => ({ getMode }));

const getConversation = vi.fn();
vi.mock("$server/db/queries/conversations", () => ({ getConversation }));

vi.mock("$lib/server/context", () => ({ ensureInitialized: vi.fn(async () => {}) }));

const { GET } = await import("../routes/api/tools/+server");

const owner = { id: "user-1", email: "u@x", name: "U", role: "member" };

function call(query = "", user: unknown = owner) {
	return GET({
		locals: { user },
		url: new URL(`http://localhost/api/tools${query}`),
	} as never);
}

async function names(res: Response): Promise<string[]> {
	const body = await res.json();
	return body.tools.map((t: { extension: string; name: string }) => `${t.extension}__${t.name}`).sort();
}

beforeEach(() => {
	vi.clearAllMocks();
	getExtensionType.mockReturnValue("extension");
	// Two extensions registered: analyzer (2 tools) + websearch (1 tool).
	getAllTools.mockReturnValue([
		{ name: "analyzer__scan", description: "Scan code" },
		{ name: "analyzer__lint", description: "Lint files" },
		{ name: "websearch__search", description: "Search the web" },
	]);
	getToolsForExtension.mockImplementation((extId: string) => {
		if (extId === "ext-analyzer") {
			return [
				{ name: "analyzer__scan", originalName: "scan" },
				{ name: "analyzer__lint", originalName: "lint" },
			];
		}
		if (extId === "ext-websearch") {
			return [{ name: "websearch__search", originalName: "search" }];
		}
		return [];
	});
});

describe("GET /api/tools — auth gates", () => {
	test("API key without 'read' scope → 403", async () => {
		const res = await GET({
			locals: { user: owner, apiKeyScopes: [] },
			url: new URL("http://localhost/api/tools"),
		} as never);
		expect(res.status).toBe(403);
	});
});

describe("GET /api/tools — unscoped (back-compat)", () => {
	test("no params → full listing incl. built-in ez tools", async () => {
		const res = await call();
		expect(res.status).toBe(200);
		const body = await res.json();
		const extNames = body.tools.filter((t: { extensionType: string }) => t.extensionType !== "built-in");
		expect(extNames).toHaveLength(3);
		// Built-in ez tools present when no mode scopes the listing.
		expect(body.tools.some((t: { extension: string }) => t.extension === "ez")).toBe(true);
		expect(getMode).not.toHaveBeenCalled();
		expect(getConversation).not.toHaveBeenCalled();
	});
});

describe("GET /api/tools — ?modeId= scoping", () => {
	test("mode with attached extension → EXACTLY that extension's tools, nothing else", async () => {
		getMode.mockResolvedValue({
			id: "mode-1",
			extensionIds: ["ext-analyzer"],
			extensionTools: null,
		});
		const res = await call("?modeId=mode-1");
		expect(res.status).toBe(200);
		// Exact-set equality: the mode's two tools and NOTHING else — no
		// websearch, no built-in ez tools, no strays.
		expect(await names(res)).toEqual(["analyzer__lint", "analyzer__scan"]);
		expect(getMode).toHaveBeenCalledWith("mode-1");
	});

	test("mode per-extension subset narrows the listing", async () => {
		getMode.mockResolvedValue({
			id: "mode-1",
			extensionIds: ["ext-analyzer", "ext-websearch"],
			extensionTools: { "ext-analyzer": ["scan"] },
		});
		const res = await call("?modeId=mode-1");
		expect(await names(res)).toEqual(["analyzer__scan", "websearch__search"]);
	});

	test("legacy toolRestriction 'none' → empty listing (only orchestration survives, none registered)", async () => {
		getMode.mockResolvedValue({ id: "mode-1", extensionIds: null, toolRestriction: "none" });
		const res = await call("?modeId=mode-1");
		const body = await res.json();
		expect(body.tools).toEqual([]);
		expect(body.count).toBe(0);
	});

	test("unknown mode id → unfiltered listing (parity with executor's non-fatal lookup)", async () => {
		getMode.mockResolvedValue(undefined);
		const res = await call("?modeId=mode-ghost");
		const body = await res.json();
		expect(body.tools.filter((t: { extensionType: string }) => t.extensionType !== "built-in")).toHaveLength(3);
	});
});

describe("GET /api/tools — ?conversationId= scoping", () => {
	test("uses the conversation's persisted modeId + extensionTools narrowing", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-1",
			extensionTools: { "ext-analyzer": ["lint"] },
		});
		getMode.mockResolvedValue({
			id: "mode-1",
			extensionIds: ["ext-analyzer", "ext-websearch"],
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1");
		expect(res.status).toBe(200);
		// Mode grants analyzer{scan,lint}+websearch{search}; the conversation
		// narrows analyzer to lint only. websearch passes through (absent key).
		expect(await names(res)).toEqual(["analyzer__lint", "websearch__search"]);
	});

	test("explicit ?modeId= wins over the conversation's persisted modeId", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-old",
			extensionTools: null,
		});
		getMode.mockResolvedValue({
			id: "mode-new",
			extensionIds: ["ext-websearch"],
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1&modeId=mode-new");
		expect(await names(res)).toEqual(["websearch__search"]);
		expect(getMode).toHaveBeenCalledWith("mode-new");
		expect(getMode).not.toHaveBeenCalledWith("mode-old");
	});

	test("explicit EMPTY modeId (cleared mode) overrides the persisted modeId → unfiltered", async () => {
		// The composer just cleared the mode back to Default; the PUT that
		// nulls conv.modeId may not have landed yet. A present-but-empty
		// modeId param must be authoritative — no fallback to the stale row.
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-old",
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1&modeId=");
		const body = await res.json();
		expect(body.tools.filter((t: { extensionType: string }) => t.extensionType !== "built-in")).toHaveLength(3);
		expect(getMode).not.toHaveBeenCalled();
	});

	test("conversation without a mode → unfiltered listing", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: null,
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1");
		const body = await res.json();
		expect(body.tools.filter((t: { extensionType: string }) => t.extensionType !== "built-in")).toHaveLength(3);
	});

	test("no mode: the conversation's extensionTools narrow the listing (composer toggle)", async () => {
		// The composer's Tools dropdown unchecked analyzer's `lint` with NO
		// mode active. The listing must drop exactly that tool — other
		// extensions and the built-in ez tools stay (deny path, narrow-only).
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: null,
			extensionTools: { "ext-analyzer": ["scan"] },
		});
		const res = await call("?conversationId=conv-1");
		const body = await res.json();
		const extTools = body.tools
			.filter((t: { extensionType: string }) => t.extensionType !== "built-in")
			.map((t: { extension: string; name: string }) => `${t.extension}__${t.name}`)
			.sort();
		expect(extTools).toEqual(["analyzer__scan", "websearch__search"]);
		// Built-in ez tools are untouched by the deny path.
		expect(body.tools.some((t: { extension: string }) => t.extension === "ez")).toBe(true);
	});

	test("no mode: an extension toggled OFF ({ext: []}) disappears from the listing entirely", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: null,
			extensionTools: { "ext-analyzer": [] },
		});
		const res = await call("?conversationId=conv-1");
		const body = await res.json();
		const extTools = body.tools
			.filter((t: { extensionType: string }) => t.extensionType !== "built-in")
			.map((t: { extension: string; name: string }) => `${t.extension}__${t.name}`)
			.sort();
		expect(extTools).toEqual(["websearch__search"]);
	});

	test("with a mode: master-toggle OFF removes the whole extension from the mode surface", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-1",
			extensionTools: { "ext-analyzer": [] },
		});
		getMode.mockResolvedValue({
			id: "mode-1",
			extensionIds: ["ext-analyzer", "ext-websearch"],
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1");
		expect(await names(res)).toEqual(["websearch__search"]);
	});

	test("rows carry extensionDescription (manifest description / built-in category)", async () => {
		getExtensionDescription.mockImplementation((ext: string) =>
			ext === "analyzer" ? "Static analysis helpers" : undefined,
		);
		const res = await call();
		const body = await res.json();
		const scan = body.tools.find((t: { name: string }) => t.name === "scan");
		expect(scan.extensionDescription).toBe("Static analysis helpers");
		// Built-in ez rows get the category description.
		const ezRow = body.tools.find((t: { extension: string }) => t.extension === "ez");
		expect(ezRow.extensionDescription).toContain("Ez");
	});

	test("response carries the orchestrationTools list (for the composer dropdown)", async () => {
		// Only LOADED orchestration tools are advertised: ask-user is registered,
		// scratchpad is not (extension disabled) → not in the list.
		getAllTools.mockReturnValue([
			{ name: "analyzer__scan", description: "Scan code" },
			{ name: "ask-user__ask_user_question", description: "Ask the user" },
		]);
		const res = await call();
		const body = await res.json();
		expect(Array.isArray(body.orchestrationTools)).toBe(true);
		expect(body.orchestrationTools).toContain("ask-user__ask_user_question");
		expect(body.orchestrationTools).not.toContain("scratchpad__scratchpad_write");
	});

	test("orchestrationTools is conv-independent: a conv toggle hides the TOOL but not the dropdown entry", async () => {
		getAllTools.mockReturnValue([
			{ name: "analyzer__scan", description: "Scan code" },
			{ name: "ask-user__ask_user_question", description: "Ask the user" },
		]);
		getToolsForExtension.mockImplementation((extId: string) => {
			if (extId === "ext-analyzer") return [{ name: "analyzer__scan", originalName: "scan" }];
			if (extId === "ext-askuser") {
				return [{ name: "ask-user__ask_user_question", originalName: "ask_user_question" }];
			}
			return [];
		});
		// The conversation explicitly toggled ask-user's extension OFF.
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: null,
			extensionTools: { "ext-askuser": [] },
		});
		const res = await call("?conversationId=conv-1");
		const body = await res.json();
		const toolNames = body.tools.map(
			(t: { extension: string; name: string }) => `${t.extension}__${t.name}`,
		);
		// The scoped TOOLS list omits it…
		expect(toolNames).not.toContain("ask-user__ask_user_question");
		// …but the dropdown list still advertises it so the user can re-enable it.
		expect(body.orchestrationTools).toContain("ask-user__ask_user_question");
	});

	test("ask-user survives a mode allowlist but an explicit conv toggle removes it", async () => {
		getAllTools.mockReturnValue([
			{ name: "analyzer__scan", description: "Scan code" },
			{ name: "ask-user__ask_user_question", description: "Ask the user" },
		]);
		getToolsForExtension.mockImplementation((extId: string) => {
			if (extId === "ext-analyzer") return [{ name: "analyzer__scan", originalName: "scan" }];
			if (extId === "ext-askuser") {
				return [{ name: "ask-user__ask_user_question", originalName: "ask_user_question" }];
			}
			return [];
		});
		getMode.mockResolvedValue({ id: "mode-1", extensionIds: ["ext-analyzer"], extensionTools: null });

		// Mode active, ask-user NOT attached → still listed (orchestration).
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-1",
			extensionTools: null,
		});
		expect(await names(await call("?conversationId=conv-1"))).toEqual([
			"analyzer__scan",
			"ask-user__ask_user_question",
		]);

		// Same mode, but the conversation explicitly toggled ask-user OFF.
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "user-1",
			parentConversationId: null,
			modeId: "mode-1",
			extensionTools: { "ext-askuser": [] },
		});
		expect(await names(await call("?conversationId=conv-1"))).toEqual(["analyzer__scan"]);
	});

	test("missing conversation → 404 (fail-closed)", async () => {
		getConversation.mockResolvedValue(undefined);
		const res = await call("?conversationId=conv-ghost");
		expect(res.status).toBe(404);
	});

	test("conversation owned by someone else → 404 for non-admin (no existence leak)", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "someone-else",
			parentConversationId: null,
			modeId: null,
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1");
		expect(res.status).toBe(404);
	});

	test("admin may scope to any conversation", async () => {
		getConversation.mockResolvedValue({
			id: "conv-1",
			userId: "someone-else",
			parentConversationId: null,
			modeId: null,
			extensionTools: null,
		});
		const res = await call("?conversationId=conv-1", { ...owner, role: "admin" });
		expect(res.status).toBe(200);
	});
});
