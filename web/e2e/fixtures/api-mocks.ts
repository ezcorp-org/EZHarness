import type { Page } from "@playwright/test";
import { makeProject, makeAgent, type makeRun, makeConversation, makeMessage, type makePipeline, makeAgentConfig, makeMemory, type makeKBFile, type makeProviderStatus, makeMode, type ModeData, type makeLesson, type ExtensionData, type makeSearchHit } from "./data.js";
import { fuzzyScore } from "../../src/lib/fuzzy-match.js";
import type { SearchMode } from "../../src/lib/api.js";

export interface SubConversationMock {
	id: string;
	agentName: string;
	agentConfigId: string;
	parentMessageId: string;
	parentConversationId: string;
	title?: string;
	/**
	 * Mirrors the real `SubConvoRecord`. `loadMessages` reads
	 * `messageCount` to derive the agent-chip status: `>= 1` →
	 * `complete` (clickable <AgentChip>); `0`/undefined → `error`
	 * (renders the non-clickable "Agent did not respond" banner). Specs
	 * that need the chip to OPEN the panel must set `messageCount >= 1`.
	 */
	messageCount?: number;
	lastMessagePreview?: string | null;
}

export interface MockOverrides {
	projects?: ReturnType<typeof makeProject>[];
	agents?: ReturnType<typeof makeAgent>[];
	runs?: ReturnType<typeof makeRun>[];
	conversations?: ReturnType<typeof makeConversation>[];
	messages?: ReturnType<typeof makeMessage>[];
	pipelines?: ReturnType<typeof makePipeline>[];
	agentConfigs?: ReturnType<typeof makeAgentConfig>[];
	memories?: ReturnType<typeof makeMemory>[];
	kbFiles?: ReturnType<typeof makeKBFile>[];
	/**
	 * Lessons surfaced on the v1.5 `/memories → Lessons` curation tab
	 * AND filtered by the `%`-popover (`/api/mentions/search?type=lesson`).
	 * Mutable in-memory: DELETE drops the row, PATCH updates `visibility`
	 * — and those mutations are reflected through subsequent GETs and
	 * mention-search calls so e2e specs can assert post-curation popover
	 * behavior without a real DB.
	 */
	lessons?: ReturnType<typeof makeLesson>[];
	providers?: ReturnType<typeof makeProviderStatus>[];
	modes?: ModeData[];
	/**
	 * Extension rows surfaced through `/api/extensions` (list) and the
	 * per-id GET fallthrough. Each entry follows the `ExtensionData` shape
	 * exported from `./data.ts` — created via `makeExtension()`. Legacy
	 * spec sites that passed `any` still type-check via structural width.
	 */
	extensions?: ExtensionData[];
	marketplace?: { listings: any[]; featured?: any[] };
	settings?: Record<string, unknown>;
	/**
	 * Composer-suggestion responses for `POST /api/composer/suggest`.
	 * `tools` fills the tool-chip row; `extensions` fills the 🧩 whole-extension
	 * chip row (emitted only when the request `include` carries "extensions");
	 * `enhancement` (with `llmAvailable` defaulting to its presence) fills the
	 * ✨ rewrite row; `enabled:false` simulates the admin kill-switch short-circuit.
	 */
	composerSuggest?: {
		enabled?: boolean;
		tools?: Array<{
			name: string;
			extension: string;
			extensionType: string;
			description: string;
			score: number;
		}>;
		extensions?: Array<{
			name: string;
			description: string;
			score: number;
		}>;
		enhancement?: { enhanced: string; reason: string } | null;
		llmAvailable?: boolean;
	};
	subConversations?: SubConversationMock[];
	/**
	 * Tool calls produced inside sub-conversations, keyed by sub-conversation id.
	 * Returned in the `withToolCalls=true` response so the Diff Summary panel
	 * can render edits made by team members / invoked agents.
	 */
	subConversationToolCalls?: Record<string, Array<{
		id: string;
		extensionId: string;
		toolName: string;
		input: Record<string, unknown> | null;
		outputSummary: string | null;
		fullOutput?: string | null;
		success: boolean;
		durationMs: number;
		status: "success" | "error" | "interrupted";
		messageId?: string | null;
		cardType?: string | null;
	}>>;
	/**
	 * Path listings that the mention search API returns for `type=path` queries.
	 * Each entry must expose `name` (relative path), `description` (absolute
	 * path), and optionally `kind` (defaults to `"file"`; pass `"dir"` for
	 * folder entries). The mock fuzzy-ranks entries by `name`.
	 */
	files?: Array<{ name: string; description: string; kind?: "file" | "dir" }>;
	/**
	 * Slash commands returned by `type=cmd` queries. Each entry mirrors the
	 * server shape: `name`, `description`, optional `source` namespace,
	 * optional `body` (raw prompt body — surfaced in the chip's hover
	 * popover in the chat history). Mock filters by substring on name or
	 * description. `insertText` mirrors the real server's built-in literal
	 * commands (e.g. `/goal`): present ⇒ selecting the entry commits this raw
	 * text instead of a `/[cmd:name]` token.
	 */
	commands?: Array<{ name: string; description: string; source?: string; body?: string; insertText?: string }>;
	/**
	 * Per-user DB-backed slash commands exposed under /api/user-commands.
	 * Mutable in-memory: POST appends (with -2 / -3 / … auto-suffix on
	 * collision), PATCH updates body/description/frontmatter, DELETE
	 * drops the row. Subsequent GETs reflect every mutation.
	 *
	 * Each entry mirrors the server row shape (id, userId, name,
	 * description, body, frontmatter, createdAt, updatedAt). The mock
	 * fills in any missing fields with defaults so specs only need to
	 * pass `{ name, body }` for happy-path coverage.
	 */
	userCommands?: Array<{
		id?: string;
		userId?: string;
		name: string;
		description?: string;
		body: string;
		frontmatter?: Record<string, string>;
		createdAt?: string;
		updatedAt?: string;
	}>;
	/**
	 * Feature Index entries returned by the per-project /features endpoints.
	 * Each entry is a Feature row WITHOUT files (file rows live on
	 * `featureFiles` keyed by featureId). The mock supports GET (list),
	 * POST (create), PATCH (rename / edit / add+remove files with the
	 * source-flip policy), DELETE (cascade), POST /scan (returns the
	 * "after" list — the spec drives the post-scan state directly), and
	 * the `/api/mentions/search?type=feature` branch.
	 */
	features?: Array<{
		id: string;
		projectId: string;
		name: string;
		description: string;
		source: "user" | "agent";
		fileCount?: number;
	}>;
	/** Pre-populated feature_files keyed by featureId. */
	featureFiles?: Record<string, Array<{ relpath: string; source: "user" | "scan" }>>;
	/**
	 * Optional override for what `POST /scan` returns. When present, the
	 * scan handler returns this verbatim (replacing the in-memory feature
	 * list); use it to drive the "rescan invariant" specs that need a
	 * specific post-scan shape (e.g. user-renamed feature still present).
	 */
	scanResult?: Array<{
		id: string;
		projectId: string;
		name: string;
		description: string;
		source: "user" | "agent";
		fileCount?: number;
	}>;
	/**
	 * Simulate a `POST /scan` failure (e.g. the 400 an unresolvable working
	 * directory now returns). When `scanStatus >= 400` the scan handler
	 * replies with `{ error: scanError }` and that status instead of the
	 * post-scan list — drives the "red banner on scan failure" spec.
	 */
	scanStatus?: number;
	scanError?: string;
	/**
	 * Explanatory `notice` string returned alongside the post-scan feature
	 * list (mirrors the real endpoint's `{ features, notice }` envelope).
	 * Drives the "info banner on a 0-feature scan" spec. Defaults to null.
	 */
	scanNotice?: string | null;
	/** Override specific routes: URL pattern -> handler */
	routes?: Record<string, (url: URL) => unknown>;
	/**
	 * Per-message inline tool calls, keyed by `messageId`. Returned on the
	 * conversation's `withToolCalls=true` GET alongside the message row, and
	 * propagated through the `/clone-turns` mock so seeded turns in a forked
	 * conversation still render their cards (matches the real server's
	 * tool-call re-parenting during clone).
	 */
	messageToolCalls?: Record<string, Array<{
		id: string;
		extensionId: string;
		toolName: string;
		input: Record<string, unknown> | null;
		outputSummary: string | null;
		fullOutput?: string | null;
		success: boolean;
		durationMs: number;
		status: "success" | "error" | "interrupted";
		messageId?: string | null;
		cardType?: string | null;
	}>>;
	/**
	 * Phase 48 — fixtures for the Ez panel API.
	 * `ezConversation`: the find-or-create response for `GET /api/ez/conversation`.
	 * `ezDrafts`: keyed by draft id; serves `GET /api/ez/drafts/<id>` and
	 *   the consume sub-route. Marks `consumed: true` when consumed but
	 *   keeps the row available so the spec can assert subsequent reads.
	 * `ezMessages`: messages returned by `GET /api/conversations/<ezConv>/messages`.
	 *   Lets specs seed propose-result tool messages so the panel renders
	 *   the EzToolResultCard immediately.
	 */
	ezConversation?: { conversationId: string; modeId?: string; title?: string | null };
	ezDrafts?: Record<string, { kind: string; payload: Record<string, unknown>; expiresAtMs?: number; consumed?: boolean }>;
	ezMessages?: ReturnType<typeof makeMessage>[];
	/**
	 * Phase 59 TEST-01 — additive v1.3 endpoint fixtures.
	 * Each field below seeds one of the 14 new handlers added before the
	 * default catch-all. All fields are optional so existing specs compile
	 * unchanged. See `.planning/phases/59-test-debt-repair/59-02-PLAN.md`.
	 */
	/** Audit entries returned by /api/audit, /api/extensions/[id]/audit, /api/conversations/[id]/audit. */
	auditEntries?: Array<{
		id: string;
		action: string;
		extensionId?: string;
		conversationId?: string;
		capabilityKind?: string;
		decision?: string;
		metadata?: Record<string, unknown>;
		createdAt: string;
	}>;
	/** Stats counts returned by /api/audit/stats. */
	auditStats?: Record<string, number>;
	/** Expired grants keyed by extensionId, returned by /api/extensions/[id]/expired-grants. */
	expiredGrants?: Record<string, Array<{
		capability: string;
		expiredAt: string;
		extensionId: string;
	}>>;
	/** Active-run payload keyed by conversationId, returned by /api/conversations/[id]/active-run. */
	activeRun?: Record<string, { runId: string | null; agentId?: string; startedAt?: string }>;
	/** Extension toolbar items keyed by conversationId, returned by /api/conversations/[id]/extension-toolbar. */
	extensionToolbarItems?: Record<string, Array<{
		id: string;
		extensionId: string;
		label: string;
		action: string;
	}>>;
	/** Extension settings keyed by extensionId, returned by /api/extensions/[id]/settings. */
	extensionSettings?: Record<string, { schema: unknown; values: unknown }>;
	/** Extension violations keyed by extensionId, returned by /api/extensions/[id]/violations. */
	extensionViolations?: Record<string, Array<{ id: string; rule: string; at: string }>>;
	/** Active agents list returned by /api/active-agents. */
	activeAgents?: Array<{ id: string; name: string; status: string }>;
	/**
	 * Phase 66 — message-grained hybrid-search fixture for
	 * `GET /api/search/messages`. Configures the hits + degraded flag a spec
	 * wants back. `requestedMode`/`servedMode` default to echoing the `mode`
	 * query param (or "hybrid"); override `servedMode`/`degraded` to exercise
	 * the degraded-fallback UI. Default (omitted) → empty hits, not degraded.
	 */
	searchMessages?: {
		hits?: ReturnType<typeof makeSearchHit>[];
		degraded?: boolean;
		servedMode?: SearchMode;
	};
}

const DEFAULT_PROJECT = makeProject({ id: "proj-1", name: "My Project" });
const DEFAULT_AGENT = makeAgent({ name: "summarizer", description: "Summarizes text" });
const DEFAULT_CONV = makeConversation({ id: "conv-1", projectId: "proj-1", title: "Hello Chat" });

export async function setupApiMocks(page: Page, overrides: MockOverrides = {}) {
	const projects = overrides.projects ?? [DEFAULT_PROJECT];
	const agents = overrides.agents ?? [DEFAULT_AGENT];
	const runs = overrides.runs ?? [];
	const conversations = overrides.conversations ?? [DEFAULT_CONV];
	const messages = overrides.messages ?? [];
	const pipelines = overrides.pipelines ?? [];
	const agentConfigs = overrides.agentConfigs ?? [];
	const mems = overrides.memories ?? [];
	const kbFiles = overrides.kbFiles ?? [];
	// Lessons — mutable copy so DELETE/PATCH reflect through later GETs
	// and mention-search calls. Each row gets a default projectId of
	// "proj-1" if the spec didn't override.
	const lessons = (overrides.lessons ?? []).map((l) => ({
		...l,
		projectId: (l as any).projectId ?? "proj-1",
	}));
	const providers = overrides.providers ?? [];
	const extensions = overrides.extensions ?? [];
	const files = overrides.files ?? [];
	const commands = overrides.commands ?? [];
	// /api/user-commands — mutable in-memory state for the /commands UI
	// specs. Seed defaults filled in here so the spec only needs to
	// pass `{ name, body }` for happy-path cases.
	type UserCommandRow = {
		id: string;
		userId: string;
		name: string;
		description: string;
		body: string;
		frontmatter: Record<string, string>;
		createdAt: string;
		updatedAt: string;
	};
	const userCommands: UserCommandRow[] = (overrides.userCommands ?? []).map(
		(c, i) => ({
			id: c.id ?? `ucmd-${i + 1}`,
			userId: c.userId ?? "u1",
			name: c.name,
			description: c.description ?? "",
			body: c.body,
			frontmatter: c.frontmatter ?? {},
			createdAt: c.createdAt ?? new Date().toISOString(),
			updatedAt: c.updatedAt ?? new Date().toISOString(),
		}),
	);
	/**
	 * Mirror of the server-side `findFreeName` helper. Returns the
	 * smallest free `${name}-N` suffix when the desired name is taken;
	 * `ignoreName` lets an updateUserCommand-equivalent ignore the row
	 * being renamed.
	 */
	function findFreeUserCommandName(desired: string, ignoreName?: string): string {
		const taken = new Set(
			userCommands
				.map((c) => c.name)
				.filter((n) => n !== ignoreName),
		);
		if (!taken.has(desired)) return desired;
		for (let i = 2; ; i++) {
			const c = `${desired}-${i}`;
			if (!taken.has(c)) return c;
		}
	}
	const marketplace = overrides.marketplace ?? { listings: [], featured: [] };
	const modes = overrides.modes ?? [
		makeMode({ id: "mode-1", name: "Code Review", slug: "code-review", icon: "\u{1F50D}", description: "Focused code review mode", systemPromptInstruction: "Review code carefully", instructionPosition: "prepend", toolRestriction: "read-only", builtin: true }),
		makeMode({ id: "mode-2", name: "Full Auto", slug: "full-auto", icon: "\u{1F916}", description: "Autonomous agent mode", systemPromptInstruction: "Act autonomously", instructionPosition: "prepend", toolRestriction: "all", builtin: false }),
		makeMode({ id: "mode-3", name: "Chat Only", slug: "chat-only", icon: "\u{1F4AC}", description: "No tools, just conversation", systemPromptInstruction: "Chat naturally", instructionPosition: "prepend", toolRestriction: "none", builtin: true }),
	];
	const subConversations = overrides.subConversations ?? [];
	const subConversationToolCalls = overrides.subConversationToolCalls ?? {};
	const settings = overrides.settings ?? {};
	const routes = overrides.routes ?? {};

	// Feature Index — mutable in-memory state so PATCH / DELETE / POST
	// reflect through subsequent GETs. `scanResult` overrides the post-scan
	// state for specs that need a specific outcome.
	const features: Array<{
		id: string;
		projectId: string;
		name: string;
		description: string;
		source: "user" | "agent";
		createdAt: string;
		updatedAt: string;
		fileCount: number;
	}> = (overrides.features ?? []).map((f) => ({
		createdAt: new Date().toISOString(),
		updatedAt: new Date().toISOString(),
		fileCount: f.fileCount ?? 0,
		...f,
	}));
	const featureFiles: Record<string, Array<{ featureId: string; relpath: string; source: "user" | "scan"; addedAt: string }>> = {};
	for (const [featId, fileRows] of Object.entries(overrides.featureFiles ?? {})) {
		featureFiles[featId] = fileRows.map((r) => ({
			featureId: featId,
			relpath: r.relpath,
			source: r.source,
			addedAt: new Date().toISOString(),
		}));
	}
	function recomputeCount(featId: string) {
		const f = features.find((x) => x.id === featId);
		if (f) f.fileCount = (featureFiles[featId] ?? []).length;
	}
	for (const f of features) recomputeCount(f.id);
	const scanResult = overrides.scanResult;
	const scanStatus = overrides.scanStatus;
	const scanError = overrides.scanError;
	const scanNotice = overrides.scanNotice ?? null;
	const messageToolCalls: Record<string, Array<any>> = { ...(overrides.messageToolCalls ?? {}) };

	// Phase 48 — Ez panel state. Mutable so the consume route can flip
	// `consumed` and a subsequent GET reflects it.
	const ezConversation = overrides.ezConversation ?? { conversationId: "ez-conv-1", modeId: "mode-ez", title: null };
	const ezDrafts: Record<string, { kind: string; payload: Record<string, unknown>; expiresAtMs?: number; consumed: boolean }> = {};
	for (const [id, d] of Object.entries(overrides.ezDrafts ?? {})) {
		ezDrafts[id] = { kind: d.kind, payload: d.payload, expiresAtMs: d.expiresAtMs, consumed: !!d.consumed };
	}
	const ezConvId = ezConversation.conversationId;
	const ezMessages = (overrides.ezMessages ?? []).map((m) => ({ ...m, conversationId: ezConvId }));

	// Phase 59 TEST-01 — additive bindings for v1.3 endpoint fixtures.
	const auditEntries = overrides.auditEntries ?? [];
	const auditStats = overrides.auditStats ?? {};
	const expiredGrants = overrides.expiredGrants ?? {};
	const activeRun = overrides.activeRun ?? {};
	const extensionToolbarItems = overrides.extensionToolbarItems ?? {};
	const extensionSettings = overrides.extensionSettings ?? {};
	const extensionViolations = overrides.extensionViolations ?? {};
	const activeAgents = overrides.activeAgents ?? [];

	// Phase 66 — message-search fixture. Default: empty hits, not degraded.
	const searchMessages = overrides.searchMessages ?? {};

	// Composer suggestions — default: enabled, no matches (popover stays shut).
	const composerSuggest = overrides.composerSuggest ?? {};

	await page.route("**/api/**", (route) => {
		const url = new URL(route.request().url());
		const path = url.pathname;
		const method = route.request().method();

		// Check custom route overrides first
		for (const [pattern, handler] of Object.entries(routes)) {
			if (path.includes(pattern)) {
				return route.fulfill({ json: handler(url) });
			}
		}

		// Phase 48 — Ez API. Lives near the top so per-spec tests get
		// deterministic responses without falling through to "default empty".
		if (path === "/api/ez/conversation" && (method === "GET" || method === "POST")) {
			return route.fulfill({
				json: {
					conversationId: ezConversation.conversationId,
					kind: "ez",
					modeId: ezConversation.modeId ?? "mode-ez",
					title: ezConversation.title ?? null,
					createdAt: "2026-04-01T00:00:00.000Z",
					updatedAt: "2026-04-01T00:00:00.000Z",
				},
			});
		}
		const draftMatch = path.match(/^\/api\/ez\/drafts\/([^/]+)(?:\/(consume))?$/);
		if (draftMatch) {
			const id = decodeURIComponent(draftMatch[1]!);
			const isConsumeSub = !!draftMatch[2];
			const draft = ezDrafts[id];
			if (!draft) {
				return route.fulfill({ status: 404, json: { error: "Draft not found" } });
			}
			const expiresAt = new Date(draft.expiresAtMs ?? Date.now() + 24 * 60 * 60 * 1000).toISOString();
			const consumedAt = draft.consumed ? new Date().toISOString() : null;
			const body = {
				id,
				kind: draft.kind,
				payload: draft.payload,
				createdAt: "2026-04-01T00:00:00.000Z",
				expiresAt,
				consumedAt,
				consumed: !!draft.consumed,
			};
			if (method === "GET") return route.fulfill({ json: body });
			if (method === "POST") {
				if (isConsumeSub) {
					draft.consumed = true;
					return route.fulfill({ json: { ...body, consumed: true, consumedAt: new Date().toISOString() } });
				}
				draft.consumed = true;
				return route.fulfill({ json: { ...body, consumed: true, consumedAt: new Date().toISOString() } });
			}
		}
		// Mode-lock guard: PUT /api/conversations/<ezConvId> attempting to
		// change `modeId` returns 403, mirroring the real route's behavior
		// (`api-conversations-ez-lock.server.test.ts`). Order matters — the
		// generic conversation-PUT handler below would otherwise let it
		// through with a fake JSON.
		if (
			method === "PUT" &&
			path === `/api/conversations/${ezConvId}` &&
			route.request().postDataJSON()?.modeId !== undefined
		) {
			return route.fulfill({
				status: 403,
				json: { error: "Cannot change the mode on the Ez conversation" },
			});
		}
		// Messages list for the Ez conversation — must precede the generic
		// /messages handler so seeded ezMessages are returned even when the
		// caller didn't pass them via `overrides.messages`.
		if (
			method === "GET" &&
			path === `/api/conversations/${ezConvId}/messages` &&
			ezMessages.length > 0 &&
			!url.searchParams.get("withToolCalls")
		) {
			return route.fulfill({ json: ezMessages });
		}

		// Projects
		if (path === "/api/projects" && method === "GET") {
			return route.fulfill({ json: projects });
		}
		if (path.match(/^\/api\/projects\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const proj = projects.find((p) => p.id === id);
			return route.fulfill(proj ? { json: proj } : { status: 404, json: { error: "Not found" } });
		}
		if (path === "/api/projects" && method === "POST") {
			return route.fulfill({ json: makeProject({ id: "new-proj" }) });
		}

		// Agents
		if (path === "/api/agents" && method === "GET") {
			return route.fulfill({ json: agents });
		}
		if (path.match(/^\/api\/agents\/[^/]+\/run$/) && method === "POST") {
			const agentName = path.split("/")[3]!;
			return route.fulfill({ json: { runId: "run-new", agentName } });
		}
		if (path.match(/^\/api\/agents\/[^/]+\/test-conversations$/) && method === "GET") {
			return route.fulfill({ json: [] });
		}

		// Runs
		if (path === "/api/runs" && method === "GET") {
			const projectId = url.searchParams.get("projectId");
			const filtered = projectId ? runs.filter((r) => r.projectId === projectId) : runs;
			return route.fulfill({ json: filtered });
		}
		if (path.match(/^\/api\/runs\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const run = runs.find((r) => r.id === id);
			return route.fulfill(run ? { json: run } : { status: 404, json: { error: "Not found" } });
		}

		// Phase 66 — message-grained hybrid search. The query string
		// (?projectId=&q=&mode=) is parsed off `url` for the served-mode echo
		// only; routing matches on the path alone. Returns a
		// SearchMessagesResponse-shaped body so 66-02/66-03/66-04 specs can
		// drive the sidebar Messages section + deep-link.
		if (path === "/api/search/messages" && method === "GET") {
			const requestedMode = (url.searchParams.get("mode") as SearchMode | null) ?? "hybrid";
			return route.fulfill({
				json: {
					hits: searchMessages.hits ?? [],
					degraded: searchMessages.degraded ?? false,
					requestedMode,
					servedMode: searchMessages.servedMode ?? requestedMode,
				},
			});
		}

		// Conversations
		if (path === "/api/conversations" && method === "GET") {
			const projectId = url.searchParams.get("projectId");
			const search = url.searchParams.get("search");
			let filtered = projectId ? conversations.filter((c) => c.projectId === projectId) : conversations;
			if (search) {
				filtered = filtered.filter((c) => c.title.toLowerCase().includes(search.toLowerCase()));
			} else {
				// Match server behavior: sort by updatedAt desc, then apply limit/offset
				filtered = [...filtered].sort(
					(a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
				);
				const offsetParam = url.searchParams.get("offset");
				const limitParam = url.searchParams.get("limit");
				const offset = offsetParam !== null ? Math.max(parseInt(offsetParam, 10) || 0, 0) : 0;
				if (offset > 0) filtered = filtered.slice(offset);
				if (limitParam !== null) {
					const limit = Math.min(Math.max(parseInt(limitParam, 10) || 0, 1), 200);
					filtered = filtered.slice(0, limit);
				}
			}
			return route.fulfill({ json: filtered });
		}
		if (path.match(/^\/api\/conversations\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const conv = conversations.find((c) => c.id === id);
			return route.fulfill(conv ? { json: conv } : { status: 404, json: { error: "Not found" } });
		}
		if (path === "/api/conversations" && method === "POST") {
			const body = route.request().postDataJSON();
			return route.fulfill({ json: makeConversation({
				id: "new-conv",
				projectId: body?.projectId ?? "proj-1",
				title: body?.title ?? "New Conversation",
				agentConfigId: body?.agentConfigId ?? null,
				systemPrompt: body?.systemPrompt ?? null,
			}) });
		}
		if (path.match(/^\/api\/conversations\/[^/]+$/) && method === "PUT") {
			const id = path.split("/").pop()!;
			const body = route.request().postDataJSON();
			const idx = conversations.findIndex((c) => c.id === id);
			const merged = { ...(idx >= 0 ? conversations[idx] : makeConversation({ id })), ...body };
			// Persist into the in-memory list so a subsequent GET (e.g. a page
			// reload) reflects the update — used by the per-conversation tool
			// scoping e2e to assert the narrowed map survives a reload.
			if (idx >= 0) conversations[idx] = merged;
			else conversations.push(merged);
			return route.fulfill({ json: merged });
		}
		if (path.match(/^\/api\/conversations\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ json: { success: true } });
		}

		// Messages
		if (path.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === "GET") {
			const convId = path.split("/")[3]!;
			const convMessages = messages.filter((m) => m.conversationId === convId);
			const urlStr = route.request().url();
			if (urlStr.includes("withToolCalls=true")) {
				const convSubConvos = subConversations.filter(sc => sc.parentConversationId === convId);
				// Include only the tool calls belonging to THIS parent's sub-conversations.
				const subToolCallsForConv: Record<string, unknown[]> = {};
				for (const sc of convSubConvos) {
					const calls = subConversationToolCalls[sc.id];
					if (calls) subToolCallsForConv[sc.id] = calls;
				}
				return route.fulfill({
					json: {
						messages: convMessages.map(m => ({ ...m, toolCalls: messageToolCalls[m.id] ?? [] })),
						subConversations: convSubConvos,
						orphanedToolCalls: [],
						subConversationToolCalls: subToolCallsForConv,
					},
				});
			}
			return route.fulfill({ json: convMessages });
		}
		// Sub-conversations
		if (path.match(/^\/api\/conversations\/[^/]+\/sub-conversations$/) && method === "GET") {
			const convId = path.split("/")[3]!;
			const convSubConvos = subConversations.filter(sc => sc.parentConversationId === convId);
			return route.fulfill({ json: convSubConvos });
		}
		// Clone selected turns → new conversation (Select Mode → New Chat).
		// Copies the picked messages into a fresh conv+id so the post-navigate
		// GET /api/conversations/:newId/messages returns the seeded history.
		if (path.match(/^\/api\/conversations\/[^/]+\/clone-turns$/) && method === "POST") {
			const sourceConvId = path.split("/")[3]!;
			const body = route.request().postDataJSON() as { messageIds: string[]; title?: string };
			const source = conversations.find((c) => c.id === sourceConvId);
			const srcTitle = source?.title ?? "Source";
			const newConvId = "cloned-conv";
			// Mirror the real backend: anchor = last selected message in createdAt order.
			const orderedSelected = messages
				.filter((m) => m.conversationId === sourceConvId && body.messageIds.includes(m.id))
				.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
			const newConv = makeConversation({
				id: newConvId,
				projectId: source?.projectId ?? "proj-1",
				title: body.title ?? `Forked: ${srcTitle}`,
				forkedFromConversationId: sourceConvId,
				forkedFromMessageId: orderedSelected[orderedSelected.length - 1]?.id ?? null,
			});
			conversations.push(newConv);

			// Copy each selected message with a fresh id, preserving order via
			// the original createdAt. Rebuild the parent chain linearly.
			const selected = orderedSelected;
			let prevId: string | null = null;
			for (let i = 0; i < selected.length; i++) {
				const src = selected[i]!;
				const newMsgId = `cloned-msg-${i + 1}`;
				const cloned = makeMessage({
					id: newMsgId,
					conversationId: newConvId,
					role: src.role,
					content: src.content,
					parentMessageId: prevId,
					createdAt: src.createdAt,
				});
				messages.push(cloned);
				// Re-parent inline tool calls onto the cloned message id so the
				// post-clone `withToolCalls=true` fetch finds them (mirrors the
				// real server's behavior in `cloneTurnsIntoNewConversation`).
				const srcCalls = messageToolCalls[src.id];
				if (srcCalls && srcCalls.length > 0) {
					messageToolCalls[newMsgId] = srcCalls.map((c, j) => ({
						...c,
						id: `cloned-tc-${i + 1}-${j}`,
						messageId: newMsgId,
					}));
				}
				prevId = newMsgId;
			}

			return route.fulfill({ status: 201, json: newConv });
		}

		// Message PATCH — XOR-validated single-object schema on the real
		// route (`patchMessageSchema` in +server.ts). Two payload shapes:
		//   { content }   → "Edit text" (seeded assistant turns)
		//   { excluded }  → strikethrough / restore-to-context toggle
		// Mirror the real route's ambiguity rejection so e2e tests catch
		// regressions where a client accidentally sends both fields.
		if (path.match(/^\/api\/conversations\/[^/]+\/messages\/[^/]+$/) && method === "PATCH") {
			const segments = path.split("/");
			const convId = segments[3]!;
			const messageId = segments[5]!;
			const body = route.request().postDataJSON() as { content?: string; excluded?: boolean };
			const hasContent = typeof body.content === "string" && body.content.length > 0;
			const hasExcluded = typeof body.excluded === "boolean";
			if (hasContent === hasExcluded) {
				// Either both present (ambiguous) or neither (empty) — same
				// 400 the refine on the real route emits.
				return route.fulfill({ status: 400, json: { error: "exactly one of `content` or `excluded` is required" } });
			}
			const idx = messages.findIndex((m) => m.id === messageId && m.conversationId === convId);
			if (idx < 0) return route.fulfill({ status: 404, json: { error: "Not found" } });
			if (hasExcluded) {
				messages[idx] = { ...messages[idx]!, excluded: body.excluded! };
			} else {
				messages[idx] = { ...messages[idx]!, content: body.content! };
			}
			return route.fulfill({ json: messages[idx] });
		}

		if (path.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === "POST") {
			const convId = path.split("/")[3]!;
			const req = route.request();
			const ct = req.headers()["content-type"] ?? "";
			let content = "sent";
			// Match AttachmentSummary shape returned by the real server:
			// { id, filename, mimeType, sizeBytes, kind }. Tests that inspect
			// the optimistic card render rely on all five fields.
			type AttachmentKind = "image" | "text" | "pdf" | "audio";
			const attachments: Array<{
				id: string; filename: string; mimeType: string; sizeBytes: number; kind: AttachmentKind;
			}> = [];
			if (ct.startsWith("multipart/form-data")) {
				const raw = req.postDataBuffer()?.toString("binary") ?? "";
				const contentMatch = /name="content"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
				if (contentMatch) content = contentMatch[1]!;
				const fileRe = /name="files";\s*filename="([^"]+)"\r\nContent-Type: ([^\r\n]+)/g;
				let m: RegExpExecArray | null;
				let i = 0;
				while ((m = fileRe.exec(raw)) !== null) {
					const mime = m[2]!.trim();
					const kind: AttachmentKind =
						mime.startsWith("image/") ? "image" :
						mime === "application/pdf" ? "pdf" :
						mime.startsWith("audio/") ? "audio" : "text";
					attachments.push({
						id: `att-sent-${++i}`,
						filename: m[1]!,
						mimeType: mime,
						sizeBytes: 1,
						kind,
					});
				}
			} else {
				const body = req.postDataJSON();
				content = body?.content ?? "sent";
			}
			const userMsg = makeMessage({
				id: "sent-msg",
				conversationId: convId,
				role: "user",
				content,
				// Merge attachments onto userMessage so the optimistic replacement
				// path exercises its attachments render.
				...(attachments.length > 0 ? { attachments } as any : {}),
			});

			// EZ Actions v1 e2e support: detect `![EZ:*]` tokens in the
			// content. For each, synthesize a result message; if the
			// stripped content is whitespace-only, return `runId: null`
			// (action-only no-LLM mode). Mirrors the real server's
			// stripEzActionTokens + dispatch loop in
			// web/src/routes/api/conversations/[id]/messages/+server.ts.
			//
			// The synthesized result depends on the action name:
			//   - `distill` → success card with a fake lesson slug for
			//     ref-link assertions
			//   - any other name → silent strip (no result message
			//     persisted; matches real "unknown action" behavior)
			//
			// Tests that need to exercise specific decline/error paths
			// can override this by using page.route() with a more
			// specific URL pattern BEFORE mockApi runs.
			const EZ_RE = /!\[EZ:([^\]]+)\]/g;
			const ezMatches: string[] = [];
			let ezMatch: RegExpExecArray | null;
			while ((ezMatch = EZ_RE.exec(content)) !== null) {
				ezMatches.push(ezMatch[1]!);
			}
			const stripped = content.replace(/!\[EZ:[^\]]+\]\s?/g, "");
			const ezActionResults: Array<{
				id: string;
				role: string;
				content: string;
			}> = [];
			let ezResultIdx = 0;
			for (const name of ezMatches) {
				if (name !== "distill") continue; // unknown → silent strip
				const synthResult = {
					kind: "success",
					card: {
						title: "Lesson captured",
						body: `e2e-mock lesson body (action: ${name})`,
						variant: "success",
					},
					ref: { kind: "lesson", slug: "e2e-mock-slug" },
				};
				ezActionResults.push({
					id: `ez-result-${++ezResultIdx}`,
					role: "ez-action-result",
					content: JSON.stringify(synthResult),
				});
			}
			const isActionOnly =
				ezMatches.length > 0 && stripped.trim().length === 0;

			return route.fulfill({
				json: {
					userMessage: userMsg,
					runId: isActionOnly ? null : "run-stream",
					attachments,
					ezActionResults,
				},
			});
		}

		// Attachment bytes — tests that render history images hit this route
		// via AttachmentCard. Tests install a per-id route.fulfill via
		// page.route BEFORE `mockApi` to serve specific bytes; this fallback
		// catches the case where no override is installed, returning a 1×1
		// transparent PNG so the <img> onload fires and the card stays in
		// its "image" rendering path.
		if (path.match(/^\/api\/attachments\/[^/]+$/) && method === "GET") {
			const ONE_PIXEL_PNG = Buffer.from(
				"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
				"base64",
			);
			return route.fulfill({
				status: 200,
				contentType: "image/png",
				body: ONE_PIXEL_PNG,
			});
		}

		// Model capabilities — keyed by provider+model query params
		if (path === "/api/models/capabilities" && method === "GET") {
			const provider = url.searchParams.get("provider") ?? "";
			const model = url.searchParams.get("model") ?? "";
			const isVision = !/text-only|local/i.test(model);
			return route.fulfill({ json: {
				provider, model,
				kinds: isVision ? ["text", "image", "pdf"] : ["text", "pdf"],
				acceptedMimeTypes: isVision
					? ["image/png", "image/jpeg", "image/webp", "text/plain", "text/markdown", "application/pdf"]
					: ["text/plain", "text/markdown", "application/pdf"],
				maxBytesPerFile: 20 * 1024 * 1024,
				maxFilesPerMessage: 10,
			} });
		}

		// Settings
		if (path === "/api/settings" && method === "GET") {
			return route.fulfill({ json: settings });
		}
		if (path.match(/^\/api\/settings\//) && method === "PUT") {
			return route.fulfill({ json: { ok: true } });
		}
		// Developer API keys — ApiKeyManager.svelte reads `data.keys` and
		// dereferences `.length` on the result, so the fallback `{}` body
		// would trigger a runtime TypeError that propagates up Svelte's
		// reactive graph and blocks click handlers on the same page (notably
		// the Custom Modes "Create Mode" button). Provide an empty list by
		// default; specs that exercise the API-key flow can override.
		if (path === "/api/settings/developer/api-keys" && method === "GET") {
			return route.fulfill({ json: { keys: [] } });
		}

		// Modes
		if (path === "/api/modes" && method === "GET") {
			return route.fulfill({ json: modes });
		}
		if (path === "/api/modes" && method === "POST") {
			const body = route.request().postDataJSON();
			return route.fulfill({ json: makeMode({ name: body?.name, slug: body?.slug, ...body }) });
		}
		if (path.match(/^\/api\/modes\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const mode = modes.find((m) => m.id === id);
			return route.fulfill(mode ? { json: mode } : { status: 404, json: { error: "Not found" } });
		}
		if (path.match(/^\/api\/modes\/[^/]+$/) && method === "PUT") {
			const id = path.split("/").pop()!;
			const body = route.request().postDataJSON();
			const mode = modes.find((m) => m.id === id);
			return route.fulfill({ json: { ...(mode ?? makeMode({ id })), ...body } });
		}
		if (path.match(/^\/api\/modes\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ json: { ok: true } });
		}

		// Models
		if (path === "/api/models" && method === "GET") {
			return route.fulfill({ json: [
				{ provider: "anthropic", model: "claude-sonnet-4-20250514", tier: "balanced", costTier: "medium", displayName: "Claude Sonnet 4", available: true },
				{ provider: "anthropic", model: "claude-opus-4-20250514", tier: "powerful", costTier: "high", displayName: "Claude Opus 4", available: true, reasoning: true },
				{ provider: "openai", model: "gpt-4o", tier: "balanced", costTier: "medium", displayName: "GPT-4o", available: true },
				{ provider: "google", model: "gemini-2.0-flash", tier: "fast", costTier: "low", displayName: "Gemini 2.0 Flash", available: true },
			]});
		}

		// System health — SystemHealth.svelte (admin settings) renders
		// `health.db.status` / `health.embeddings.status` from this payload.
		// Without a complete default shape the catch-all `{}` fulfillment
		// makes that render THROW, which poisons Svelte's effect scheduler
		// and silently blocks every subsequent UI update on the page (this
		// was the long-standing "team-expand {#if} never re-renders" bug).
		if (path === "/api/health" && method === "GET") {
			return route.fulfill({
				json: {
					status: "healthy",
					db: { status: "up" },
					embeddings: { status: "ready" },
					providers: {},
				},
			});
		}

		// Providers
		if (path === "/api/providers" && method === "GET") {
			return route.fulfill({ json: providers });
		}
		if (path === "/api/providers" && method === "POST") {
			return route.fulfill({ json: { success: true } });
		}
		if (path === "/api/providers" && method === "DELETE") {
			return route.fulfill({ json: { success: true } });
		}
		// Local model test — MUST precede the generic /:provider/test matcher
		// below, otherwise "local" matches [^/]+ and the response gets the
		// wrong shape ({ success } instead of { reachable, ..., latencyMs }).
		if (path === "/api/providers/local/test" && method === "POST") {
			return route.fulfill({ json: { reachable: true, modelAvailable: true, inferenceOk: true, endpointType: "openai-compatible", latencyMs: 150 } });
		}
		if (path.match(/^\/api\/providers\/[^/]+\/test$/) && method === "POST") {
			return route.fulfill({ json: { success: true } });
		}
		if (path.match(/^\/api\/providers\/[^/]+\/refresh-models$/) && method === "POST") {
			return route.fulfill({
				json: {
					success: true,
					count: 3,
					ids: ["gpt-5.2", "gpt-4o", "o3"],
					fetchedAt: new Date().toISOString(),
				},
			});
		}
		if (path === "/api/auth/oauth/callback" && method === "DELETE") {
			return route.fulfill({ json: { success: true } });
		}

		// Agent Configs
		if (path === "/api/agent-configs" && method === "GET") {
			return route.fulfill({ json: agentConfigs });
		}
		if (path === "/api/agent-configs" && method === "POST") {
			const body = route.request().postDataJSON();
			return route.fulfill({ json: makeAgentConfig({ name: body?.name, prompt: body?.prompt, ...body }) });
		}
		if (path.match(/^\/api\/agent-configs\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const config = agentConfigs.find((c: any) => c.id === id);
			return route.fulfill(config ? { json: config } : { status: 404, json: { error: "Not found" } });
		}
		if (path.match(/^\/api\/agent-configs\/[^/]+$/) && method === "PUT") {
			const id = path.split("/").pop()!;
			const body = route.request().postDataJSON();
			const config = agentConfigs.find((c: any) => c.id === id);
			return route.fulfill({ json: { ...(config ?? makeAgentConfig({ id })), ...body } });
		}

		// User Commands (per-user DB-backed slash commands).
		// Order: collection routes before [name] routes so the regex
		// match doesn't pick `/api/user-commands` as a name match.
		if (path === "/api/user-commands" && method === "GET") {
			return route.fulfill({ json: userCommands });
		}
		if (path === "/api/user-commands" && method === "POST") {
			const body = route.request().postDataJSON() as {
				name: string;
				body: string;
				description?: string;
				frontmatter?: Record<string, string>;
			};
			const saved = findFreeUserCommandName(body.name);
			const now = new Date().toISOString();
			const row: UserCommandRow = {
				id: `ucmd-${userCommands.length + 1}`,
				userId: "u1",
				name: saved,
				description: body.description ?? "",
				body: body.body,
				frontmatter: body.frontmatter ?? {},
				createdAt: now,
				updatedAt: now,
			};
			userCommands.push(row);
			return route.fulfill({ status: 201, json: row });
		}
		const ucmdMatch = path.match(/^\/api\/user-commands\/([^/]+)$/);
		if (ucmdMatch) {
			const name = decodeURIComponent(ucmdMatch[1]!);
			const idx = userCommands.findIndex((c) => c.name === name);
			if (method === "GET") {
				if (idx < 0) return route.fulfill({ status: 404, json: { error: "Not found" } });
				return route.fulfill({ json: userCommands[idx] });
			}
			if (method === "PATCH") {
				if (idx < 0) return route.fulfill({ status: 404, json: { error: "Not found" } });
				const body = route.request().postDataJSON() as {
					description?: string;
					body?: string;
					frontmatter?: Record<string, string>;
				};
				const row = userCommands[idx]!;
				if (body.description !== undefined) row.description = body.description;
				if (body.body !== undefined) row.body = body.body;
				if (body.frontmatter !== undefined) row.frontmatter = body.frontmatter;
				row.updatedAt = new Date().toISOString();
				return route.fulfill({ json: row });
			}
			if (method === "DELETE") {
				if (idx < 0) return route.fulfill({ status: 404, json: { error: "Not found" } });
				userCommands.splice(idx, 1);
				return route.fulfill({ status: 204, body: "" });
			}
		}

		// Pipelines
		if (path === "/api/pipelines" && method === "GET") {
			return route.fulfill({ json: pipelines });
		}
		if (path.match(/^\/api\/pipelines\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ json: { success: true } });
		}
		if (path.match(/^\/api\/pipelines\/[^/]+\/run$/) && method === "POST") {
			return route.fulfill({ json: { pipelineRunId: "prun-1" } });
		}

		// Memories
		if (path === "/api/memories" && method === "GET") {
			let filtered = [...mems];
			const status = url.searchParams.get("status");
			const category = url.searchParams.get("category");
			const search = url.searchParams.get("search");
			if (status) filtered = filtered.filter((m) => m.status === status);
			if (category) filtered = filtered.filter((m) => m.category === category);
			if (search) filtered = filtered.filter((m) => m.content.toLowerCase().includes(search.toLowerCase()));
			return route.fulfill({ json: filtered });
		}
		if (path.match(/^\/api\/memories\/[^/]+$/) && method === "GET") {
			const id = path.split("/").pop()!;
			const mem = mems.find((m) => m.id === id);
			return route.fulfill(mem ? { json: mem } : { status: 404, json: { error: "Not found" } });
		}
		if (path.match(/^\/api\/memories\/[^/]+$/) && method === "PUT") {
			const id = path.split("/").pop()!;
			const mem = mems.find((m) => m.id === id);
			const body = route.request().postDataJSON();
			return route.fulfill({ json: { ...(mem ?? makeMemory({ id })), ...body } });
		}
		if (path.match(/^\/api\/memories\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ status: 204, body: "" });
		}

		// Lessons (v1.5 curation tab + post-mutation popover behavior)
		if (path === "/api/lessons" && method === "GET") {
			const pid = url.searchParams.get("projectId");
			if (!pid) return route.fulfill({ status: 400, json: { error: "projectId required" } });
			const filtered = lessons
				.filter((l) => (l as any).projectId === pid)
				.map(({ /* projectId stripped */ ...rest }) => rest);
			return route.fulfill({ json: filtered });
		}
		const lessonIdMatch = path.match(/^\/api\/lessons\/([^/]+)$/);
		if (lessonIdMatch) {
			const id = lessonIdMatch[1]!;
			const idx = lessons.findIndex((l) => l.id === id);
			if (method === "DELETE") {
				if (idx < 0) return route.fulfill({ status: 404, json: { error: "Lesson not found" } });
				const target = lessons[idx]!;
				if (!target.ownedByMe) {
					// Server collapses not-found + not-owned to 404 — match.
					return route.fulfill({ status: 404, json: { error: "Lesson not found" } });
				}
				lessons.splice(idx, 1);
				return route.fulfill({ status: 204, body: "" });
			}
			if (method === "PATCH") {
				if (idx < 0) return route.fulfill({ status: 404, json: { error: "Lesson not found" } });
				const target = lessons[idx]!;
				if (!target.ownedByMe) {
					return route.fulfill({ status: 404, json: { error: "Lesson not found" } });
				}
				const body = route.request().postDataJSON() as { visibility?: string };
				const next = body?.visibility;
				if (next !== "user" && next !== "project" && next !== "global") {
					return route.fulfill({ status: 400, json: { error: "visibility invalid" } });
				}
				const order: Record<string, number> = { user: 0, project: 1, global: 2 };
				if (order[next] < order[target.visibility]) {
					return route.fulfill({
						status: 409,
						json: { error: "Visibility ladder is monotonic — cannot demote" },
					});
				}
				target.visibility = next;
				return route.fulfill({ json: { ...target } });
			}
		}

		// Knowledge Base
		if (path === "/api/knowledge-base" && method === "GET") {
			const pid = url.searchParams.get("projectId");
			if (!pid) return route.fulfill({ status: 400, json: { error: "projectId required" } });
			const filtered = kbFiles.filter((f) => f.projectId === pid);
			return route.fulfill({ json: filtered });
		}
		if (path.match(/^\/api\/knowledge-base\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ status: 204, body: "" });
		}
		if (path === "/api/knowledge-base" && method === "POST") {
			return route.fulfill({ status: 201, json: { id: "kb-new", status: "processing" } });
		}

		// Extensions
		if (path === "/api/extensions" && method === "GET") {
			return route.fulfill({ json: extensions });
		}
		if (path === "/api/extensions" && method === "POST") {
			return route.fulfill({ json: { id: "ext-new", name: "test-ext" } });
		}
		if (path.match(/^\/api\/extensions\/[^/]+$/) && method === "PATCH") {
			return route.fulfill({ json: { success: true } });
		}
		if (path.match(/^\/api\/extensions\/[^/]+$/) && method === "DELETE") {
			return route.fulfill({ status: 204, body: "" });
		}
		if (path.match(/^\/api\/extensions\/[^/]+\/tools$/) && method === "GET") {
			return route.fulfill({ json: { tools: [{ name: "analyze", description: "Analyze code", inputSchema: { type: "object", properties: { file: { type: "string", description: "File path" } } } }] } });
		}

		// Marketplace
		if (path === "/api/marketplace" && method === "GET") {
			return route.fulfill({ json: marketplace });
		}

		// ── Feature Index ────────────────────────────────────────────
		// Pattern: /api/projects/:id/features (and sub-paths). Rather than
		// regex-match in the dispatcher, peel the segments manually.
		const featurePathMatch = path.match(/^\/api\/projects\/([^/]+)\/features(?:\/(.+))?$/);
		if (featurePathMatch) {
			const projectId = featurePathMatch[1]!;
			const tail = featurePathMatch[2] ?? "";

			// POST /api/projects/:id/features/scan
			if (tail === "scan" && method === "POST") {
				// Simulate the endpoint's failure surface (e.g. 400 on an
				// unresolvable working directory).
				if (scanStatus && scanStatus >= 400) {
					return route.fulfill({
						status: scanStatus,
						json: { error: scanError ?? "Scan failed" },
					});
				}
				if (scanResult) {
					// Replace the in-memory list with the override.
					features.length = 0;
					for (const f of scanResult) {
						features.push({
							createdAt: new Date().toISOString(),
							updatedAt: new Date().toISOString(),
							fileCount: f.fileCount ?? 0,
							...f,
						});
					}
				}
				// New envelope: { features, notice } (was a bare array).
				return route.fulfill({
					json: {
						features: features.filter((f) => f.projectId === projectId),
						notice: scanNotice,
					},
				});
			}

			// GET /api/projects/:id/features
			if (tail === "" && method === "GET") {
				const list = features
					.filter((f) => f.projectId === projectId)
					.sort((a, b) => a.name.localeCompare(b.name));
				return route.fulfill({ json: list });
			}

			// POST /api/projects/:id/features
			if (tail === "" && method === "POST") {
				const body = (route.request().postDataJSON() ?? {}) as {
					name?: string;
					description?: string;
				};
				if (!body.name) {
					return route.fulfill({
						status: 400,
						json: {
							error: "Validation failed",
							fields: { name: "Feature name is required." },
						},
					});
				}
				if (!/^[a-z0-9_-]+$/i.test(body.name)) {
					return route.fulfill({
						status: 400,
						json: {
							error: "Validation failed",
							fields: {
								name: "Feature name can only contain letters, numbers, hyphens, and underscores — no spaces or other punctuation.",
							},
						},
					});
				}
				if (features.find((f) => f.projectId === projectId && f.name === body.name)) {
					return route.fulfill({
						status: 409,
						json: { error: "Feature with this name already exists" },
					});
				}
				const now = new Date().toISOString();
				const created = {
					id: `feat-${Math.random().toString(36).slice(2, 10)}`,
					projectId,
					name: body.name,
					description: body.description ?? "",
					source: "user" as const,
					createdAt: now,
					updatedAt: now,
					fileCount: 0,
				};
				features.push(created);
				return route.fulfill({ status: 201, json: created });
			}

			// PATCH/DELETE /api/projects/:id/features/:featureId
			const featureId = tail;
			const target = features.find(
				(f) => f.projectId === projectId && f.id === featureId,
			);
			if (!target) {
				return route.fulfill({
					status: 404,
					json: { error: "Feature not found" },
				});
			}

			if (method === "DELETE") {
				const idx = features.indexOf(target);
				features.splice(idx, 1);
				delete featureFiles[featureId];
				return route.fulfill({ json: { ok: true } });
			}

			// GET /api/projects/:id/features/:featureId — per-feature read
			// (used by FeatureIndex.svelte's row expand to fetch the file
			// list lazily; the list endpoint only includes counts).
			if (method === "GET") {
				const filesArr = (featureFiles[featureId] ?? [])
					.slice()
					.sort((a, b) => a.relpath.localeCompare(b.relpath));
				return route.fulfill({
					json: {
						...target,
						files: filesArr,
						fileCount: filesArr.length,
					},
				});
			}

			if (method === "PATCH") {
				const body = (route.request().postDataJSON() ?? {}) as {
					name?: string;
					description?: string;
					addFiles?: string[];
					removeFiles?: string[];
				};
				if (
					body.name === undefined &&
					body.description === undefined &&
					(!body.addFiles || body.addFiles.length === 0) &&
					(!body.removeFiles || body.removeFiles.length === 0)
				) {
					return route.fulfill({
						status: 400,
						json: {
							error: "Validation failed",
							fields: {
								"": "Provide at least one field to change: name, description, addFiles, or removeFiles.",
							},
						},
					});
				}
				// Slug validation mirrors the real schema (web/.../features/schema.ts)
				// so e2e tests can exercise the field-level validation surface.
				if (body.name !== undefined && !/^[a-z0-9_-]+$/i.test(body.name)) {
					return route.fulfill({
						status: 400,
						json: {
							error: "Validation failed",
							fields: {
								name: "Feature name can only contain letters, numbers, hyphens, and underscores — no spaces or other punctuation.",
							},
						},
					});
				}
				if (body.name !== undefined && body.name !== target.name) {
					if (
						features.find(
							(f) => f.projectId === projectId && f.name === body.name,
						)
					) {
						return route.fulfill({
							status: 409,
							json: { error: "Feature with this name already exists" },
						});
					}
				}
				if (body.name !== undefined) target.name = body.name;
				if (body.description !== undefined) target.description = body.description;
				// Source-flip: any non-empty PATCH on agent flips to user.
				if (target.source === "agent") target.source = "user";
				target.updatedAt = new Date().toISOString();
				if (body.addFiles) {
					featureFiles[featureId] = featureFiles[featureId] ?? [];
					for (const rel of body.addFiles) {
						if (!featureFiles[featureId]!.find((r) => r.relpath === rel)) {
							featureFiles[featureId]!.push({
								featureId,
								relpath: rel,
								source: "user",
								addedAt: new Date().toISOString(),
							});
						}
					}
				}
				if (body.removeFiles && featureFiles[featureId]) {
					featureFiles[featureId] = featureFiles[featureId]!.filter(
						(r) => !body.removeFiles!.includes(r.relpath),
					);
				}
				recomputeCount(featureId);
				const filesArr = (featureFiles[featureId] ?? [])
					.slice()
					.sort((a, b) => a.relpath.localeCompare(b.relpath));
				return route.fulfill({
					json: {
						...target,
						files: filesArr,
						fileCount: filesArr.length,
					},
				});
			}
		}

		// Mention search
		if (path === "/api/mentions/search" && method === "GET") {
			const q = url.searchParams.get("q") ?? "";
			const type = url.searchParams.get("type");
			const projectId = url.searchParams.get("projectId");

			// Path searches are mutually exclusive with other kinds. The mock
			// mirrors the real route's two modes:
			//   - no slash in q → flat root + 1-level-deep listing, fuzzy-ranked
			//   - slash in q    → descent: walk ONE folder and return its
			//                     direct children; fuzzy-match tail if any.
			if (type === "path") {
				if (!projectId) return route.fulfill({ json: [] });
				const pathList = files.map((f) => ({
					name: f.name,
					description: f.description,
					kind: (f.kind ?? "file") as "file" | "dir",
				}));

				const lastSlash = q.lastIndexOf("/");
				if (lastSlash >= 0) {
					const dirPrefix = q.slice(0, lastSlash);
					const tail = q.slice(lastSlash + 1);
					const prefixDepth = dirPrefix ? dirPrefix.split("/").length : 0;
					// Direct children of dirPrefix = entries that start with
					// `${dirPrefix}/` (or, if dirPrefix is empty, have no
					// parent segments) AND have exactly one more segment.
					const children = pathList.filter((e) => {
						if (dirPrefix && !e.name.startsWith(`${dirPrefix}/`)) return false;
						if (!dirPrefix && e.name.includes("/")) {
							// Could still be a direct root child with a `/` in the
							// name — reject unless depth === 1.
							return e.name.split("/").length === 1;
						}
						return e.name.split("/").length === prefixDepth + 1;
					});
					if (!tail) return route.fulfill({ json: children.slice(0, 10) });
					const scored = children
						.map((e) => {
							const lastIdx = e.name.lastIndexOf("/");
							const basename = lastIdx >= 0 ? e.name.slice(lastIdx + 1) : e.name;
							return { e, score: fuzzyScore(tail, basename) };
						})
						.filter((x) => x.score !== null) as Array<{
							e: typeof children[number];
							score: number;
						}>;
					scored.sort((a, b) => b.score - a.score);
					return route.fulfill({ json: scored.slice(0, 10).map((x) => x.e) });
				}

				if (!q) return route.fulfill({ json: pathList.slice(0, 10) });
				const scored = pathList
					.map((f) => ({ f, score: fuzzyScore(q, f.name) }))
					.filter((x) => x.score !== null) as Array<{ f: typeof pathList[number]; score: number }>;
				scored.sort((a, b) => b.score - a.score);
				return route.fulfill({ json: scored.slice(0, 10).map((x) => x.f) });
			}

			// Feature Index — `type=feature` mirrors the real route's
			// project-scoped fuzzy lookup over the `features` table.
			if (type === "feature") {
				if (!projectId) return route.fulfill({ json: [] });
				const projFeatures = features.filter((f) => f.projectId === projectId);
				const matched = q
					? projFeatures.filter(
							(f) =>
								f.name.toLowerCase().includes(q.toLowerCase()) ||
								f.description.toLowerCase().includes(q.toLowerCase()),
						)
					: projFeatures;
				return route.fulfill({
					json: matched.slice(0, 10).map((f) => ({
						name: f.name,
						description: f.description,
						kind: "feature" as const,
						fileCount: f.fileCount,
					})),
				});
			}

			// EZ Actions search — `type=EZ` mirrors the real route's
			// in-memory registry lookup. Static list scoped to the
			// in-test action set; substring match on name + description.
			// No DB / project scope — actions are global.
			if (type === "EZ") {
				const allActions = [
					{
						name: "distill",
						description:
							"Force-trigger lesson distillation on this conversation (bypasses the trigger gate)",
					},
				];
				const matched = q
					? allActions.filter(
							(a) =>
								a.name.toLowerCase().includes(q.toLowerCase()) ||
								a.description.toLowerCase().includes(q.toLowerCase()),
						)
					: allActions;
				return route.fulfill({
					json: matched.slice(0, 10).map((a) => ({
						name: a.name,
						description: a.description,
						kind: "EZ" as const,
					})),
				});
			}

			// Lesson search — mirror the real route's `type=lesson` branch.
			// Project-scoped, returns `{name: slug, description, kind: "lesson"}`.
			// Reads from the same mutable `lessons` array as /api/lessons,
			// so deletes + visibility changes propagate to the popover
			// without an extra mock invalidation step.
			if (type === "lesson") {
				if (!projectId) return route.fulfill({ json: [] });
				const matched = lessons.filter((l) => (l as any).projectId === projectId);
				const filtered = q
					? matched.filter(
							(l) =>
								l.title.toLowerCase().includes(q.toLowerCase()) ||
								l.slug.toLowerCase().includes(q.toLowerCase()),
						)
					: matched;
				return route.fulfill({
					json: filtered.slice(0, 10).map((l) => ({
						name: l.slug,
						description:
							l.body.length > 60 ? l.body.slice(0, 59) + "…" : l.body,
						kind: "lesson" as const,
					})),
				});
			}

			// Slash-command search is mutually exclusive with other kinds.
			// Mirror the real server's scoping rule: when no `projectId`
			// query param is provided, project-scoped commands
			// (`project:*`) are hidden from results. This keeps the mock
			// honest — callers that forget to pass projectId will see the
			// same empty result the real server returns.
			if (type === "cmd") {
				const searchProjectId = url.searchParams.get("projectId");
				// Mirror the real server: user-DB commands (the rows under
				// /api/user-commands) are merged into the same `type=cmd`
				// result set with `source: "user:db"`, which the popover
				// renders as the "Saved" badge via commandSourceLabel().
				// Without this merge the mock would diverge from the real
				// registry (src/runtime/commands/registry.ts) and chat-
				// popover e2e for user-authored commands wouldn't be
				// possible.
				const dbList = userCommands.map((c) => ({
					name: c.name,
					description: c.description,
					kind: "command" as const,
					source: "user:db",
					body: c.body,
				}));
				const fsList = commands
					.filter((c) =>
						searchProjectId || !(c.source ?? "").startsWith("project:"),
					)
					.map((c) => ({
						name: c.name,
						description: c.description,
						kind: "command" as const,
						source: c.source,
						body: c.body,
						...(c.insertText ? { insertText: c.insertText } : {}),
					}));
				const list = [...dbList, ...fsList];
				const filtered = q
					? list.filter((m) =>
						m.name.toLowerCase().includes(q.toLowerCase()) ||
						(m.description ?? "").toLowerCase().includes(q.toLowerCase()),
					)
					: list;
				return route.fulfill({ json: filtered.slice(0, 10) });
			}

			// Add teams from agentConfigs with category "team"
			const teams = agentConfigs
				.filter((c: any) => c.category === "team")
				.map((c: any) => ({ name: c.name, description: c.description, kind: "team" as const }));
			const allMentions = [
				...(type !== "ext" && type !== "agent" ? teams : []),
				...(type !== "ext" && type !== "team" ? agents.map((a) => ({ name: a.name, description: a.description, kind: "agent" as const })) : []),
				...(type !== "agent" && type !== "team" ? extensions.map((e: any) => ({ name: e.name, description: e.description ?? "", kind: "extension" as const })) : []),
			];
			const filtered = q
				? allMentions.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()) || m.description.toLowerCase().includes(q.toLowerCase()))
				: allMentions;
			return route.fulfill({ json: filtered.slice(0, 10) });
		}

		// Orchestrator
		if (path === "/api/orchestrator/human-input" && method === "POST") {
			return route.fulfill({ json: { success: true } });
		}

		// Tools
		if (path === "/api/tools" && method === "GET") {
			return route.fulfill({ json: {
				tools: [
					{ name: "scan", description: "Scan code for issues", extension: "analyzer", extensionType: "extension" },
					{ name: "lint", description: "Lint source files", extension: "analyzer", extensionType: "extension" },
					{ name: "search", description: "Search the web", extension: "web-tools", extensionType: "mcp" },
					{ name: "format", description: "Format code files", extension: "formatter", extensionType: "extension" },
				],
				count: 4,
			}});
		}

		// Composer suggestions — POST, body-aware: the `include` field picks
		// which halves the response carries (mirrors the real route's split
		// so tool chips never wait on the enhance half). Overridable via
		// mockApi's `composerSuggest` option; feedback events 201 into the
		// void (specs that assert telemetry intercept the request instead).
		if (path === "/api/composer/suggest/feedback" && method === "POST") {
			return route.fulfill({ status: 201, json: { ok: true } });
		}
		if (path === "/api/composer/suggest" && method === "POST") {
			if (composerSuggest.enabled === false) {
				return route.fulfill({ json: { enabled: false, tools: [], enhancement: null, llmAvailable: false } });
			}
			const body = (route.request().postDataJSON() ?? {}) as { include?: string[] };
			const include = body.include ?? ["tools"];
			const json: Record<string, unknown> = { enabled: true, latencyMs: 5 };
			if (include.includes("tools")) json.tools = composerSuggest.tools ?? [];
			// Whole-extension chips ride the same fast half as tool chips — but only
			// when the client opted in via include:["…","extensions"]. Old clients
			// (include:["tools"]) get no `extensions` key at all (byte-compatible).
			if (include.includes("extensions")) json.extensions = composerSuggest.extensions ?? [];
			if (include.includes("enhance")) {
				const enhancement = composerSuggest.enhancement ?? null;
				json.llmAvailable = composerSuggest.llmAvailable ?? enhancement !== null;
				json.enhancement = enhancement;
			}
			return route.fulfill({ json });
		}


		// Account sessions
		if (path === "/api/account/sessions" && method === "GET") {
			return route.fulfill({ json: { sessions: [] } });
		}
		if (path === "/api/account/sessions" && method === "DELETE") {
			return route.fulfill({ json: { success: true } });
		}

		// Login history
		if (path === "/api/account/login-history" && method === "GET") {
			return route.fulfill({ json: { entries: [] } });
		}

		// Admin sessions
		if (path === "/api/admin/sessions" && method === "GET") {
			return route.fulfill({ json: { sessions: [] } });
		}
		if (path === "/api/admin/sessions" && method === "DELETE") {
			return route.fulfill({ json: { success: true, revokedCount: 0 } });
		}

		// Admin analytics & system
		if (path === "/api/admin/analytics" && method === "GET") {
			return route.fulfill({ json: { chatActivity: [], modelUsage: [], agentStats: [], extensionStats: [], userStats: { totalUsers: 0, activeUsers30d: 0, signupsLast30d: [] } } });
		}
		if (path === "/api/admin/system" && method === "GET") {
			return route.fulfill({ json: { health: { dbSizeBytes: 0, uptimeSeconds: 0, tableRowCounts: {} }, activityFeed: [], errorSummary: { totalErrors: 0, errorRate: [], recentErrors: [] } } });
		}
		if (path === "/api/admin/errors" && method === "GET") {
			return route.fulfill({ json: { errors: [], total: 0 } });
		}

		// API docs
		if (path === "/api/docs" && method === "GET") {
			return route.fulfill({ json: { routes: [] } });
		}

		// Favicon
		if (path === "/api/favicon") {
			return route.fulfill({ json: { icon: "" } });
		}

		// Filesystem
		if (path === "/api/fs/list") {
			return route.fulfill({ json: [] });
		}

		// ============================================================
		// v1.3 endpoint handlers (added Phase 59 TEST-01).
		// Strictly additive — see 59-CONTEXT.md "Baseline-preserving discipline".
		// All new routes are matched BEFORE the default `{}` catch-all so
		// chat-page `waitForResponse` consumers receive realistic envelopes
		// instead of timing out at 30s.
		// ============================================================

		// /api/audit drill-down — capability-event-pills, audit-global consumers
		if (path === "/api/audit" && method === "GET") {
			const extensionId = url.searchParams.get("extensionId");
			const action = url.searchParams.get("action");
			const limit = parseInt(url.searchParams.get("limit") ?? "50", 10);
			let filtered = auditEntries;
			if (extensionId) filtered = filtered.filter((e) => e.extensionId === extensionId);
			if (action) filtered = filtered.filter((e) => e.action === action);
			return route.fulfill({ json: { entries: filtered.slice(0, limit), total: filtered.length } });
		}

		// /api/audit-log — legacy alias of /api/audit
		if (path === "/api/audit-log" && method === "GET") {
			return route.fulfill({ json: { entries: auditEntries, total: auditEntries.length } });
		}

		// /api/audit/stats — audit-global drill-down counts
		if (path === "/api/audit/stats" && method === "GET") {
			return route.fulfill({ json: { counts: auditStats } });
		}

		// /api/extensions/[id]/audit — per-extension audit drilldown
		const extAuditMatch = path.match(/^\/api\/extensions\/([^/]+)\/audit$/);
		if (extAuditMatch && method === "GET") {
			const extId = extAuditMatch[1]!;
			return route.fulfill({ json: { entries: auditEntries.filter((e) => e.extensionId === extId) } });
		}

		// /api/extensions/[id]/expired-grants — Phase-56 expired-grants banner consumer
		const expiredMatch = path.match(/^\/api\/extensions\/([^/]+)\/expired-grants$/);
		if (expiredMatch && method === "GET") {
			const extId = expiredMatch[1]!;
			return route.fulfill({ json: { grants: expiredGrants[extId] ?? [] } });
		}

		// /api/extensions/[id]/reapprove — re-approve POST
		const reapproveMatch = path.match(/^\/api\/extensions\/([^/]+)\/reapprove$/);
		if (reapproveMatch && method === "POST") {
			const body = (route.request().postDataJSON?.() ?? {}) as Record<string, unknown>;
			return route.fulfill({ json: { reapproved: true, capability: body.capability ?? null } });
		}

		// /api/extensions/[id]/violations — extensions detail page load
		const violMatch = path.match(/^\/api\/extensions\/([^/]+)\/violations$/);
		if (violMatch && method === "GET") {
			const extId = violMatch[1]!;
			return route.fulfill({ json: { violations: extensionViolations[extId] ?? [] } });
		}

		// /api/extensions/[id]/settings — extensions detail page load
		const settingsMatch = path.match(/^\/api\/extensions\/([^/]+)\/settings$/);
		if (settingsMatch && method === "GET") {
			const extId = settingsMatch[1]!;
			return route.fulfill({ json: extensionSettings[extId] ?? { schema: null, values: {} } });
		}
		if (settingsMatch && method === "PUT") {
			return route.fulfill({ json: { ok: true } });
		}

		// /api/extensions/[name]/events/[event] — SEC-06 sentinel + extension event posts
		const eventMatch = path.match(/^\/api\/extensions\/([^/]+)\/events\/([^/]+)$/);
		if (eventMatch && method === "POST") {
			return route.fulfill({ json: { ok: true } });
		}

		// /api/conversations/[id]/audit — conversation-audit-drilldown consumer
		const convAuditMatch = path.match(/^\/api\/conversations\/([^/]+)\/audit$/);
		if (convAuditMatch && method === "GET") {
			const convId = convAuditMatch[1]!;
			return route.fulfill({ json: { entries: auditEntries.filter((e) => e.conversationId === convId) } });
		}

		// /api/conversations/[id]/extension-toolbar — streaming-toolbar.spec.ts (12 fails) consumer
		const toolbarMatch = path.match(/^\/api\/conversations\/([^/]+)\/extension-toolbar$/);
		if (toolbarMatch && method === "GET") {
			const convId = toolbarMatch[1]!;
			return route.fulfill({ json: { items: extensionToolbarItems[convId] ?? [] } });
		}

		// /api/conversations/[id]/active-run — chat-page mount + active-run-resume consumer
		const activeRunMatch = path.match(/^\/api\/conversations\/([^/]+)\/active-run$/);
		if (activeRunMatch && method === "GET") {
			const convId = activeRunMatch[1]!;
			return route.fulfill({ json: activeRun[convId] ?? { runId: null } });
		}

		// /api/tool-calls/[id]/permission — permission grant POST (F-trio fixme flips)
		const permMatch = path.match(/^\/api\/tool-calls\/([^/]+)\/permission$/);
		if (permMatch && method === "POST") {
			return route.fulfill({ json: { ok: true } });
		}

		// /api/active-agents — active-agents-grouping consumer
		if (path === "/api/active-agents" && method === "GET") {
			return route.fulfill({ json: { agents: activeAgents } });
		}

		// Default: empty OK
		return route.fulfill({ json: {} });
	});
}
