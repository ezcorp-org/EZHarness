const BASE = "";

/** Check response for errors, showing 429 toast when rate-limited. On
 *  non-OK responses, throws the server's `data.error` body field when
 *  present (much more useful than `statusText` — e.g. "Pipeline name
 *  already exists" instead of "400 Bad Request"), falling back to
 *  `${status} ${statusText}` when the body is missing or non-JSON. */
async function checkResponse(res: Response): Promise<void> {
	if (res.ok) return;
	if (res.status === 429) {
		// Lazy import toast to avoid breaking non-SvelteKit test environments
		import("$lib/toast.svelte").then(({ addToast }) => {
			const retryAfter = res.headers.get("Retry-After");
			const seconds = retryAfter ? parseInt(retryAfter, 10) : undefined;
			const message = seconds && !isNaN(seconds)
				? `Rate limit exceeded. Try again in ${seconds} seconds.`
				: "Rate limit exceeded. Please wait before trying again.";
			addToast({ type: "warning", message }, (seconds ?? 10) * 1000);
		}).catch(() => {});
	}
	const data = await res.json().catch(() => ({}));
	throw new Error(data.error ?? `${res.status} ${res.statusText}`);
}

export type InputFieldType = "string" | "text" | "number" | "boolean" | "select" | "file-path" | "custom";

export interface InputField {
	type: InputFieldType;
	label: string;
	description?: string;
	required?: boolean;
	default?: unknown;
	options?: string[];
	component?: string;
}

export type InputSchema = Record<string, InputField>;

export interface Agent {
	name: string;
	description: string;
	capabilities: string[];
	inputSchema?: InputSchema;
	source: "file" | "config";
	id: string | null;
	prompt: string | null;
	category: string | null;
	shared?: boolean;
	sharedBy?: string;
	sharedByName?: string;
	permission?: "read" | "edit";
}

export interface LogEntry {
	timestamp: string;
	level: string;
	message: string;
}

export interface AgentResult {
	success: boolean;
	output: unknown;
	error?: string;
}

export interface Run {
	id: string;
	agentName: string;
	status: "idle" | "running" | "success" | "error" | "cancelled";
	startedAt: string;
	finishedAt?: string;
	logs: LogEntry[];
	result?: AgentResult;
	projectId?: string | null;
}

export interface Project {
	id: string;
	name: string;
	path: string;
	icon: string | null;
	variables: Record<string, unknown>;
	createdAt: string;
	updatedAt: string;
}

export type Settings = Record<string, unknown>;

export async function fetchAgents(): Promise<Agent[]> {
	const res = await fetch(`${BASE}/api/agents`);
	await checkResponse(res);
	return res.json();
}

export async function fetchRuns(projectId?: string): Promise<Run[]> {
	const params = projectId ? `?projectId=${projectId}` : "";
	const res = await fetch(`${BASE}/api/runs${params}`);
	await checkResponse(res);
	return res.json();
}

export async function fetchRun(id: string): Promise<Run> {
	const res = await fetch(`${BASE}/api/runs/${id}`);
	await checkResponse(res);
	return res.json();
}

export async function triggerRun(
	agentName: string,
	input: Record<string, unknown>,
	projectId?: string,
): Promise<Run> {
	const res = await fetch(`${BASE}/api/agents/${agentName}/run`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...input, ...(projectId ? { projectId } : {}) }),
	});
	await checkResponse(res);
	return res.json();
}

// ── Filesystem ──────────────────────────────────────────────────────

export interface FsEntry { name: string; isDir: boolean }

export async function fetchDirContents(dir: string): Promise<FsEntry[]> {
	const res = await fetch(`${BASE}/api/fs/list?dir=${encodeURIComponent(dir)}`);
	if (!res.ok) return [];
	return res.json();
}

export async function createDir(path: string): Promise<{ path: string }> {
	const res = await fetch(`${BASE}/api/fs/mkdir`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ path }),
	});
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? "Failed to create folder");
	return data;
}

// ── Projects ────────────────────────────────────────────────────────

export async function fetchProjects(): Promise<Project[]> {
	const res = await fetch(`${BASE}/api/projects`);
	await checkResponse(res);
	return res.json();
}

export async function fetchFavicon(url: string): Promise<string> {
	const res = await fetch(`${BASE}/api/favicon?url=${encodeURIComponent(url)}`);
	const data = await res.json();
	if (!res.ok) throw new Error(data.error ?? "Failed to fetch favicon");
	return data.icon;
}

export async function createProject(data: { name: string; path: string; icon?: string | null; variables?: Record<string, unknown> }): Promise<Project> {
	const res = await fetch(`${BASE}/api/projects`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function updateProject(id: string, data: Partial<{ name: string; path: string; icon: string | null; variables: Record<string, unknown> }>): Promise<Project> {
	const res = await fetch(`${BASE}/api/projects/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function deleteProject(id: string): Promise<void> {
	const res = await fetch(`${BASE}/api/projects/${id}`, { method: "DELETE" });
	await checkResponse(res);
}

// ── Settings ────────────────────────────────────────────────────────

export async function fetchSettings(): Promise<Settings> {
	const res = await fetch(`${BASE}/api/settings`);
	await checkResponse(res);
	return res.json();
}

export async function upsertSetting(key: string, value: unknown): Promise<void> {
	const res = await fetch(`${BASE}/api/settings/${key}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ value }),
	});
	await checkResponse(res);
}

// ── Providers ───────────────────────────────────────────────────────

export interface ProviderStatus {
	provider: string;
	hasKey: boolean;
	source: "byok" | "env" | "none";
	oauthConnected: boolean;
	oauthExpired: boolean;
	oauthSupported: boolean;
	expiresAt: string | null;
}

export async function fetchProviders(): Promise<ProviderStatus[]> {
	const res = await fetch(`${BASE}/api/providers`);
	await checkResponse(res);
	return res.json();
}

export async function saveProviderKey(provider: string, apiKey: string): Promise<void> {
	const res = await fetch(`${BASE}/api/providers`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, apiKey }),
	});
	await checkResponse(res);
}

export async function testProviderConnection(provider: string): Promise<{ success: boolean; error?: string }> {
	const res = await fetch(`${BASE}/api/providers/${provider}/test`, { method: "POST" });
	return res.json();
}

export async function refreshProviderModels(
	provider: string,
): Promise<{ success: boolean; count?: number; ids?: string[]; fetchedAt?: string; error?: string }> {
	const res = await fetch(`${BASE}/api/providers/${provider}/refresh-models`, { method: "POST" });
	return res.json();
}

export async function deleteProviderKey(provider: string): Promise<void> {
	const res = await fetch(`${BASE}/api/providers`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider }),
	});
	await checkResponse(res);
}

export async function initiateOAuth(
	provider: string,
): Promise<{ url: string; state: string; codeVerifier: string; redirectUri: string }> {
	const params = new URLSearchParams({ provider, app_origin: window.location.origin });
	const res = await fetch(`${BASE}/api/auth/oauth?${params}`);
	await checkResponse(res);
	return res.json();
}

export async function completeOAuth(
	provider: string,
	code: string,
	codeVerifier: string,
	redirectUri: string,
	state?: string,
): Promise<void> {
	const res = await fetch(`${BASE}/api/auth/oauth/callback`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider, code, codeVerifier, redirectUri, state }),
	});
	await checkResponse(res);
}

export async function disconnectOAuth(provider: string): Promise<void> {
	const res = await fetch(`${BASE}/api/auth/oauth/callback`, {
		method: "DELETE",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ provider }),
	});
	await checkResponse(res);
}

// ── Local Model Checks ─────────────────────────────────────────────

export interface LocalModelCheckResult {
	reachable: boolean;
	modelAvailable: boolean | null;
	inferenceOk: boolean | null;
	endpointType: "openai-compatible" | "ollama" | null;
	error?: string;
	latencyMs?: number;
}

export async function testLocalModelConnection(
	baseUrl: string,
	modelId: string,
): Promise<LocalModelCheckResult> {
	const res = await fetch(`${BASE}/api/providers/local/test`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ baseUrl, modelId }),
	});
	return res.json();
}

export interface LocalModelListEntry {
	id: string;
	name?: string;
}

export async function listLocalModels(
	baseUrl: string,
): Promise<{ models: LocalModelListEntry[]; endpointType: string | null; error?: string }> {
	const res = await fetch(`${BASE}/api/providers/local/models`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ baseUrl }),
	});
	return res.json();
}

// ── Conversations ───────────────────────────────────────────────────

export interface Conversation {
	id: string;
	projectId: string;
	title: string;
	model: string | null;
	provider: string | null;
	systemPrompt: string | null;
	agentConfigId: string | null;
	modeId: string | null;
	test: boolean | null;
	parentConversationId?: string | null;
	parentMessageId?: string | null;
	forkedFromConversationId?: string | null;
	forkedFromMessageId?: string | null;
	/** Per-conversation tool scoping (extension id → selected tool names). A
	 *  key absent (or mapped to an empty array) means all of that extension's
	 *  tools. This map can only NARROW the active mode's allowlist, never widen
	 *  it. `null` means "inherit from mode" (no override). */
	extensionTools?: Record<string, string[]> | null;
	createdAt: string;
	updatedAt: string;
}

export interface Mode {
	id: string;
	name: string;
	slug: string;
	icon: string | null;
	description: string;
	systemPromptInstruction: string;
	instructionPosition: "prepend" | "append" | "replace";
	preferredModel: string | null;
	preferredProvider: string | null;
	preferredThinkingLevel: string | null;
	temperature: number | null;
	toolRestriction: "all" | "read-only" | "none" | "allowlist";
	/** Built-in allowlist modes (e.g. Ez) carry their explicit tool names
	 *  here; meaningful only when `toolRestriction === "allowlist"`. Optional
	 *  because user-authored modes express scope via `extensionIds` instead. */
	allowedTools?: string[] | null;
	extensionIds: string[] | null;
	/** Per-extension tool subset (extension id → selected tool names). A key
	 *  absent here (or mapped to an empty array) means all of that extension's
	 *  tools are available to the mode. */
	extensionTools: Record<string, string[]> | null;
	builtin: boolean;
}

export interface AttachmentSummary {
	id: string;
	filename: string;
	mimeType: string;
	sizeBytes: number;
	kind: "image" | "text" | "pdf" | "audio" | "extension-handle";
}

export interface Message {
	id: string;
	conversationId: string;
	role: string;
	content: string;
	thinkingContent: string | null;
	model: string | null;
	provider: string | null;
	usage: {
		inputTokens: number;
		outputTokens: number;
		/** WS0 prompt-cache meter: tokens served from / written to the provider
		 *  cache this turn + the derived hit-rate [0,1]. Optional — absent on
		 *  pre-cache rows and non-caching providers. */
		cacheReadTokens?: number;
		cacheWriteTokens?: number;
		cacheHitRate?: number;
		/** Subset of cacheWriteTokens written with 1h retention (Anthropic-only;
		 *  billed at 2× the base input rate). */
		cacheWrite1hTokens?: number;
		/** Routing provenance — requested (pinned) values; null ⇒ Auto/routed.
		 *  Served provider/model live on the message columns. */
		requestedProvider?: string | null;
		requestedModel?: string | null;
		/** Tier the router selected — only present when routing fired. */
		routedTier?: "fast" | "balanced" | "powerful";
		/** True when the served provider ≠ the initially resolved provider. */
		failover?: boolean;
	} | null;
	runId: string | null;
	parentMessageId: string | null;
	/** When true, this message is hidden from the LLM context on subsequent
	 *  turns (filtered server-side in load-history). The row still renders in
	 *  the transcript, struck-through, and can be toggled back on. */
	excluded: boolean;
	createdAt: string;
	/** Memories injected into the system prompt for this assistant turn.
	 *  Sourced server-side from runs.result.output.memoriesUsed. */
	memoriesUsed?: { id: string; content: string; category: string }[];
	/** Files the user uploaded with this turn. Populated by the server
	 *  message-loading paths; served as bytes via /api/attachments/:id. */
	attachments?: AttachmentSummary[];
}

export interface SearchResult {
	id: string;
	title: string;
	updatedAt: string;
	matchingMessageId: string | null;
	snippet: string;
	rank: number;
}

// Phase 65 — message-grained hybrid search contract. The single typed import
// surface Phases 66 (sidebar) and 67 (Cmd+K palette) consume. `createdAt` is a
// `string` here (JSON-serialized over the wire), mirroring SearchResult.updatedAt;
// the server-side MessageSearchHit uses a Date.
export type SearchMode = "hybrid" | "keyword" | "semantic";
export type MatchType = "lexical" | "semantic" | "both";
// Phase 67 — search scope: "project" (single project, default) | "all" (every
// project of the requesting user — the cross-project Cmd+K palette path).
export type SearchScope = "project" | "all";

export interface MessageSearchHit {
	conversationId: string;
	conversationTitle: string;
	messageId: string;
	role: "user" | "assistant";
	createdAt: string;
	snippet: string;
	matchType: MatchType;
	rankLexical: number | null;
	rankSemantic: number | null;
	score: number;
	// Phase 67 — owning project of the hit (cross-project deep-link + grouping).
	projectId: string;
	projectName: string;
}

export interface SearchMessagesResponse {
	hits: MessageSearchHit[];
	degraded: boolean;
	requestedMode: SearchMode;
	servedMode: SearchMode;
}

export async function searchMessages(
	projectId: string,
	query: string,
	opts?: { mode?: SearchMode; limit?: number; offset?: number; scope?: SearchScope },
): Promise<SearchMessagesResponse> {
	const params = new URLSearchParams({ projectId, q: query });
	if (opts?.mode) params.set("mode", opts.mode);
	if (opts?.scope) params.set("scope", opts.scope);
	if (opts?.limit !== undefined) params.set("limit", String(opts.limit));
	if (opts?.offset !== undefined) params.set("offset", String(opts.offset));
	const res = await fetch(`${BASE}/api/search/messages?${params.toString()}`);
	await checkResponse(res);
	return res.json();
}

export async function fetchConversation(id: string): Promise<Conversation> {
	const res = await fetch(`${BASE}/api/conversations/${id}`);
	await checkResponse(res);
	return res.json();
}

export async function fetchConversations(
	projectId: string,
	options?: { limit?: number; offset?: number },
): Promise<Conversation[]> {
	const params = new URLSearchParams({ projectId });
	if (options?.limit !== undefined) params.set("limit", String(options.limit));
	if (options?.offset !== undefined) params.set("offset", String(options.offset));
	const res = await fetch(`${BASE}/api/conversations?${params.toString()}`);
	await checkResponse(res);
	return res.json();
}

export async function createConversation(data: { projectId: string; title?: string; model?: string; provider?: string; agentConfigId?: string; test?: boolean }): Promise<Conversation> {
	const res = await fetch(`${BASE}/api/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function searchConversations(projectId: string, query: string): Promise<SearchResult[]> {
	const res = await fetch(`${BASE}/api/conversations?projectId=${projectId}&search=${encodeURIComponent(query)}`);
	await checkResponse(res);
	return res.json();
}

export async function updateConversation(id: string, data: Partial<{ title: string; model: string; provider: string; systemPrompt: string; modeId: string | null; extensionTools: Record<string, string[]> | null }>): Promise<Conversation> {
	const res = await fetch(`${BASE}/api/conversations/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function deleteConversation(id: string): Promise<void> {
	const res = await fetch(`${BASE}/api/conversations/${id}`, { method: "DELETE" });
	await checkResponse(res);
}

// ── MCP servers ─────────────────────────────────────────────────────

/** A new server connection config for an MCP extension. Mirrors the
 *  discriminated union accepted by /api/mcp-servers (install + edit). For
 *  http/sse, a blank header value means "keep the existing secret". */
export type McpServerSpec =
	| { transport: "stdio"; name: string; command: string; args?: string[]; env?: Record<string, string> }
	| { transport: "http"; name: string; url: string; headers?: Record<string, string> }
	| { transport: "sse"; name: string; url: string; headers?: Record<string, string> };

/** Edit-after-install: re-point an existing MCP extension at a new server
 *  config. The server re-connects + re-lists tools before persisting; a 502
 *  (connection failure) leaves the stored config untouched. Returns the
 *  updated extension record. */
export async function updateMcpServer(
	id: string,
	body: { description?: string; server: McpServerSpec },
): Promise<unknown> {
	const res = await fetch(`${BASE}/api/mcp-servers/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	await checkResponse(res);
	return res.json();
}

/**
 * Fork a subset of turns from an existing conversation into a brand-new one.
 * Server-side also clones associated inline tool calls. Returns the new
 * conversation row so the caller can navigate to its URL.
 */
export async function cloneTurns(
	sourceConvId: string,
	data: { messageIds: string[]; title?: string },
): Promise<Conversation> {
	const res = await fetch(`${BASE}/api/conversations/${sourceConvId}/clone-turns`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

/**
 * Content-only update of a message (no branching, no regen). Used by the
 * assistant-turn "Edit text" affordance on seeded turns in cloned chats.
 */
export async function patchMessageContent(
	conversationId: string,
	messageId: string,
	content: string,
): Promise<Message> {
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages/${messageId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ content }),
	});
	await checkResponse(res);
	return res.json();
}

/**
 * Toggle a message's exclusion from the LLM context. Server keeps the row +
 * still returns it to the UI; load-history filters it out before pi-ai sees
 * the array. Rejected with 409 while the conversation has an active run.
 */
export async function setMessageExcluded(
	conversationId: string,
	messageId: string,
	excluded: boolean,
): Promise<Message> {
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages/${messageId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ excluded }),
	});
	await checkResponse(res);
	return res.json();
}

// ── Modes ───────────────────────────────────────────────────────────

export async function fetchModes(): Promise<Mode[]> {
	const res = await fetch(`${BASE}/api/modes`);
	await checkResponse(res);
	return res.json();
}

export async function createMode(data: Partial<Mode>): Promise<Mode> {
	const res = await fetch(`${BASE}/api/modes`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function updateMode(id: string, data: Partial<Mode>): Promise<Mode> {
	const res = await fetch(`${BASE}/api/modes/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function deleteMode(id: string): Promise<void> {
	const res = await fetch(`${BASE}/api/modes/${id}`, { method: "DELETE" });
	await checkResponse(res);
}

// ── Sub-Conversations ───────────────────────────────────────────────

export async function createSubConversation(parentConversationId: string, opts: {
	parentMessageId: string;
	agentConfigId: string;
	title?: string;
	projectId: string;
}): Promise<Conversation & { parentConversationId: string; parentMessageId: string }> {
	const res = await fetch(`${BASE}/api/conversations`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			projectId: opts.projectId,
			parentConversationId,
			parentMessageId: opts.parentMessageId,
			agentConfigId: opts.agentConfigId,
			title: opts.title,
		}),
	});
	await checkResponse(res);
	return res.json();
}

export async function fetchSubConversations(parentConversationId: string): Promise<Array<Conversation & { parentConversationId: string; parentMessageId: string; agentConfigId: string }>> {
	const res = await fetch(`${BASE}/api/conversations/${parentConversationId}/sub-conversations`);
	await checkResponse(res);
	return res.json();
}

export async function fetchTestConversations(agentName: string): Promise<Conversation[]> {
	const res = await fetch(`${BASE}/api/agents/${agentName}/test-conversations`);
	await checkResponse(res);
	return res.json();
}

export async function deleteTestConversations(agentName: string): Promise<{ deleted: number }> {
	const res = await fetch(`${BASE}/api/agents/${agentName}/test-conversations`, { method: "DELETE" });
	await checkResponse(res);
	return res.json();
}

export async function fetchAllMessages(conversationId: string): Promise<Message[]> {
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/messages?all=true`);
	await checkResponse(res);
	return res.json();
}

/** One node of a conversation's session-backed message tree (Sessions P4). */
export interface ConversationTreeNode {
	id: string;
	parentId: string | null;
	role: string;
	excluded: boolean;
	createdAt: string;
}
/** The conversation's whole message tree + durable leaf pointer. */
export interface ConversationTree {
	conversationId: string;
	currentLeaf: string | null;
	nodes: ConversationTreeNode[];
}

/**
 * Fetch a conversation's session-backed rewind/branch tree.
 *
 * The endpoint 409s when the `sessions:historyProducer` flag is off — which is
 * ALSO how the client learns the feature is enabled (the generic settings
 * endpoint is admin-gated, but rewind must work for the conversation owner).
 * So a 409 resolves to `{ enabled: false }` rather than throwing; any other
 * non-2xx still throws via `checkResponse`.
 */
export async function fetchConversationTree(
	conversationId: string,
): Promise<{ enabled: boolean; tree: ConversationTree | null }> {
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/tree`);
	if (res.status === 409) return { enabled: false, tree: null };
	await checkResponse(res);
	return { enabled: true, tree: await res.json() };
}

/**
 * Rewind/checkpoint a conversation to a message: moves the durable leaf pointer
 * there so the next send continues from that turn (the abandoned tail survives
 * as a switchable sibling). Returns the refreshed tree. Throws on 409 (flag off
 * / active run) or 400 (bad target).
 */
export async function rewindConversation(
	conversationId: string,
	targetMessageId: string,
	summary?: string,
): Promise<ConversationTree> {
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/rewind`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(summary ? { targetMessageId, summary } : { targetMessageId }),
	});
	await checkResponse(res);
	return res.json();
}

/**
 * Clean A/B retry (Sessions P5): re-run the turn that produced `messageId` (an
 * assistant row) from its parent USER message WITHOUT duplicating that user row.
 * The new response is a same-role SIBLING of the original assistant — the honest
 * A/B, distinct from `sendMessage({ editOf })` which forks a new user turn too.
 * `userMessage` in the result is the EXISTING anchor turn (no new row). Throws
 * on 409 (flag off / active run) or 400 (target not an assistant with a user
 * parent). Optional `provider`/`model`/`thinkingLevel` retry against a different
 * model without touching the conversation's pin.
 */
export async function retryMessage(
	conversationId: string,
	messageId: string,
	opts: { provider?: string; model?: string; thinkingLevel?: string } = {},
): Promise<{ userMessage: Message; retriedMessageId: string; runId: string | null }> {
	const res = await fetch(
		`${BASE}/api/conversations/${conversationId}/messages/${messageId}/retry`,
		{
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(opts),
		},
	);
	await checkResponse(res);
	return res.json();
}

export async function sendMessage(
	conversationId: string,
	data: {
		content: string;
		/** Explicit `null` (JSON path only) is the Auto (smart routing)
		 *  sentinel — the server bypasses the conv.model fallback and
		 *  routes the turn. Omitting the field keeps the legacy
		 *  conv.model fallback. */
		provider?: string | null;
		model?: string | null;
		parentMessageId?: string;
		editOf?: string;
		permissionMode?: string;
		thinkingLevel?: string;
		attachments?: File[];
	},
): Promise<{
	userMessage: Message;
	/** Null when the message was action-only (`![EZ:*]` tokens with no
	 *  surrounding prose) — the LLM call is skipped server-side so
	 *  there's no run to stream. Callers MUST short-circuit the
	 *  streaming setup when `runId` is null. */
	runId: string | null;
	attachments?: AttachmentSummary[];
	/** EZ Actions v1: synthetic `role: "ez-action-result"` messages
	 *  persisted server-side for any `![EZ:*]` tokens in the user
	 *  message. Empty array when no action tokens were present.
	 *  Callers should append these to the chat history immediately
	 *  (parented to the user message) so the cards render inline. */
	ezActionResults?: Array<{ id: string; role: string; content: string }>;
}> {
	const url = `${BASE}/api/conversations/${conversationId}/messages`;
	let res: Response;
	if (data.attachments && data.attachments.length > 0) {
		const form = new FormData();
		form.set("content", data.content);
		if (data.provider) form.set("provider", data.provider);
		if (data.model) form.set("model", data.model);
		if (data.parentMessageId) form.set("parentMessageId", data.parentMessageId);
		if (data.editOf) form.set("editOf", data.editOf);
		if (data.permissionMode) form.set("permissionMode", data.permissionMode);
		if (data.thinkingLevel) form.set("thinkingLevel", data.thinkingLevel);
		for (const file of data.attachments) form.append("files", file);
		res = await fetch(url, { method: "POST", body: form });
	} else {
		const { attachments: _drop, ...jsonBody } = data;
		res = await fetch(url, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify(jsonBody),
		});
	}
	await checkResponse(res);
	return res.json();
}

export async function exportConversation(conversationId: string, format: "markdown" | "json", leafMessageId?: string): Promise<void> {
	const params = new URLSearchParams({ format });
	if (leafMessageId) params.set("leafMessageId", leafMessageId);
	const res = await fetch(`${BASE}/api/conversations/${conversationId}/export?${params}`);
	await checkResponse(res);
	const blob = await res.blob();
	const disposition = res.headers.get("Content-Disposition") ?? "";
	const filenameMatch = disposition.match(/filename="(.+?)"/);
	const filename = filenameMatch?.[1] ?? `conversation.${format === "json" ? "json" : "md"}`;
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

// ── Agent Configs ───────────────────────────────────────────────────

export interface TeamMemberOverrides {
	permissionMode?: "ask" | "auto-edit" | "yolo";
	toolRestriction?: "all" | "read-only" | "none";
	modeId?: string;
	allowedTools?: string[];
	deniedTools?: string[];
	provider?: string;
	model?: string;
	systemPromptAppend?: string;
}

export interface TeamMember {
	agentConfigId: string;
	overrides?: TeamMemberOverrides;
	subAgents?: TeamMember[];
}

/**
 * Team-level tool scoping applied to every invoked member. When set,
 * overrides each member's per-member tool configuration.
 */
export interface TeamToolScope {
	allowedTools?: string[];
	deniedTools?: string[];
}

/** Sentinel value meaning "use the parent conversation's current model/provider." */
export const CURRENT_MODEL_SENTINEL = "__current__";

export interface AgentConfig {
	id: string;
	name: string;
	description: string;
	capabilities: string[];
	prompt: string;
	inputSchema?: Record<string, unknown> | null;
	outputFormat?: string | null;
	provider?: string | null;
	model?: string | null;
	temperature?: number | null;
	maxTokens?: number | null;
	category?: string | null;
	extensions?: string[] | null;
	/** Per-extension tool subset (extension id → selected tool names). A key
	 *  absent here (or mapped to an empty array) means all of that extension's
	 *  tools are available when the agent runs. */
	extensionTools?: Record<string, string[]> | null;
	references?: { agents: string[]; extensions: string[]; members?: TeamMember[]; autoSpinUp?: boolean; teamToolScope?: TeamToolScope } | null;
	createdAt: string;
	updatedAt: string;
	[key: string]: unknown;
}

export async function fetchAgentConfigs(): Promise<AgentConfig[]> {
	const res = await fetch(`${BASE}/api/agent-configs`);
	await checkResponse(res);
	return res.json();
}

export async function fetchAgentConfig(id: string): Promise<AgentConfig> {
	const res = await fetch(`${BASE}/api/agent-configs/${id}`);
	await checkResponse(res);
	return res.json();
}

export async function createAgentConfig(data: {
	name: string;
	description?: string;
	prompt: string;
	references?: { agents?: string[]; extensions?: string[]; autoSpinUp?: boolean };
	capabilities?: string[];
	outputFormat?: string;
	provider?: string;
	model?: string;
	temperature?: number;
	maxTokens?: number;
	inputSchema?: Record<string, unknown>;
	category?: string | null;
	extensions?: string[];
	extensionTools?: Record<string, string[]>;
}): Promise<AgentConfig> {
	const res = await fetch(`${BASE}/api/agent-configs`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function updateAgentConfig(
	id: string,
	data: Partial<Parameters<typeof createAgentConfig>[0]>,
): Promise<AgentConfig> {
	const res = await fetch(`${BASE}/api/agent-configs/${id}`, {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

// ── Pipelines ───────────────────────────────────────────────────────

export interface PipelineStep {
	name: string;
	agent: string;
	input?: Record<string, string>;
	dependsOn?: string[];
}

export interface Pipeline {
	name: string;
	description: string;
	steps: PipelineStep[];
	inputSchema?: Record<string, unknown>;
}

export interface PipelineRun {
	id: string;
	pipelineName: string;
	status: string;
	startedAt: number;
	finishedAt?: number;
	steps: { stepName: string; runId: string; status: string }[];
	result?: AgentResult;
}

export async function fetchPipelines(): Promise<Pipeline[]> {
	const res = await fetch(`${BASE}/api/pipelines`);
	await checkResponse(res);
	return res.json();
}

export async function createPipeline(data: Pipeline): Promise<Pipeline> {
	const res = await fetch(`${BASE}/api/pipelines`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function deletePipeline(name: string): Promise<void> {
	const res = await fetch(`${BASE}/api/pipelines/${name}`, { method: "DELETE" });
	await checkResponse(res);
}

export async function triggerPipelineRun(
	name: string,
	input: Record<string, unknown>,
	projectId?: string,
): Promise<PipelineRun> {
	const res = await fetch(`${BASE}/api/pipelines/${name}/run`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ ...input, ...(projectId ? { projectId } : {}) }),
	});
	await checkResponse(res);
	return res.json();
}

// ── Marketplace ─────────────────────────────────────────────────────

export interface MarketplaceListing {
	id: string;
	authorId: string;
	agentConfigId: string;
	name: string;
	description: string;
	category: string;
	tags: string[];
	latestVersion: string;
	installCount: number;
	ratingPositive: number;
	ratingTotal: number;
	ratingPercent: number;
	status: string;
	slug: string;
	authorName?: string;
	createdAt: string;
	updatedAt: string;
}

export interface MarketplaceVersion {
	id: string;
	listingId: string;
	version: string;
	manifest: Record<string, unknown>;
	changelog: string | null;
	createdAt: string;
}

export interface BrowseResult {
	listings: MarketplaceListing[];
	featured?: MarketplaceListing[];
}

export interface InstallResult {
	agentConfig: AgentConfig;
	extensionsNeeded: Array<{ name: string; source: string; version: string; required: boolean }>;
}

export async function browseMarketplace(opts?: {
	q?: string;
	category?: string;
	/**
	 * Phase 49.3 — filter by a single manifest tag (sidebar chip
	 * selection). The API has supported this for a while; only the
	 * client wrapper had no surface for it. Distinct from `category`
	 * which matches the canonical category column (Productivity etc.).
	 */
	tag?: string;
	sort?: string;
	limit?: number;
	offset?: number;
}): Promise<BrowseResult> {
	const params = new URLSearchParams();
	if (opts?.q) params.set("q", opts.q);
	if (opts?.category) params.set("category", opts.category);
	if (opts?.tag) params.set("tag", opts.tag);
	if (opts?.sort) params.set("sort", opts.sort);
	if (opts?.limit) params.set("limit", String(opts.limit));
	if (opts?.offset) params.set("offset", String(opts.offset));
	const qs = params.toString();
	const res = await fetch(`${BASE}/api/marketplace${qs ? `?${qs}` : ""}`);
	await checkResponse(res);
	return res.json();
}

export interface MarketplaceCategoryCount {
	tag: string;
	count: number;
}

/**
 * Phase 49.3 — list of tag chips for the marketplace category sidebar,
 * with live counts aggregated over active listings. Tags come from
 * `manifest.tags` (set on publish; see POST /api/marketplace).
 */
export async function fetchMarketplaceCategories(): Promise<{ categories: MarketplaceCategoryCount[] }> {
	const res = await fetch(`${BASE}/api/marketplace/categories`);
	await checkResponse(res);
	return res.json();
}

export async function getMarketplaceListing(id: string): Promise<{
	listing: MarketplaceListing;
	latestVersion: MarketplaceVersion | null;
	versions: MarketplaceVersion[];
	userRating: { thumbsUp: boolean } | null;
	installed: boolean;
}> {
	const res = await fetch(`${BASE}/api/marketplace/${id}`);
	await checkResponse(res);
	return res.json();
}

export async function publishToMarketplace(
	agentConfigId: string,
	opts?: { version?: string; changelog?: string; tags?: string[] },
): Promise<{ listing: MarketplaceListing; version: MarketplaceVersion }> {
	const res = await fetch(`${BASE}/api/marketplace`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ agentConfigId, ...opts }),
	});
	await checkResponse(res);
	return res.json();
}

export async function installMarketplaceAgent(
	listingId: string,
	version?: string,
): Promise<InstallResult> {
	const res = await fetch(`${BASE}/api/marketplace/${listingId}/install`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ version }),
	});
	await checkResponse(res);
	return res.json();
}

export async function rateMarketplaceListing(
	listingId: string,
	thumbsUp: boolean,
): Promise<void> {
	const res = await fetch(`${BASE}/api/marketplace/${listingId}/rate`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ thumbsUp }),
	});
	await checkResponse(res);
}

export async function exportManifest(listingId: string): Promise<void> {
	const res = await fetch(`${BASE}/api/marketplace/export/${listingId}`);
	await checkResponse(res);
	const blob = await res.blob();
	const disposition = res.headers.get("Content-Disposition") ?? "";
	const filenameMatch = disposition.match(/filename="(.+?)"/);
	const filename = filenameMatch?.[1] ?? "agent-manifest.json";
	const url = URL.createObjectURL(blob);
	const a = document.createElement("a");
	a.href = url;
	a.download = filename;
	a.click();
	URL.revokeObjectURL(url);
}

export async function importManifest(
	manifest: Record<string, unknown>,
): Promise<InstallResult> {
	const res = await fetch(`${BASE}/api/marketplace/import`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ manifest }),
	});
	await checkResponse(res);
	return res.json();
}

// ── Memories ────────────────────────────────────────────────────────

/**
 * v1.4 — flip a single memory's `injectionEligible` flag via
 * `PATCH /api/memories/[id]`. Returns the updated row (full
 * shape, including `projectIds`). Throws via `checkResponse` on
 * non-2xx so callers can wrap in try/catch for revert-on-error
 * UX (the curation tab uses optimistic updates).
 *
 * The helper is intentionally narrow: only `injectionEligible`
 * is accepted in v1.4. Future fields go in their own helpers
 * or a future generalized PATCH.
 */
export async function updateMemoryInjectionEligibility(
	id: string,
	injectionEligible: boolean,
): Promise<Record<string, unknown>> {
	const res = await fetch(`${BASE}/api/memories/${id}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ injectionEligible }),
	});
	await checkResponse(res);
	return res.json();
}

// ── Mentions ────────────────────────────────────────────────────────

export interface MentionResult {
	name: string;
	description: string;
	/**
	 * Concrete kind of the result. For `type=path` searches the server
	 * returns a mix of `"file"` and `"dir"` entries based on the filesystem.
	 * For `type=cmd` the result is always `"command"`. For `type=feature`
	 * the result is always `"feature"`. For `type=lesson` the result is
	 * always `"lesson"`. For `type=EZ` the result is always `"EZ"` —
	 * runtime actions from the in-memory registry (not project-scoped).
	 */
	kind: "agent" | "extension" | "team" | "EZ" | "file" | "dir" | "command" | "feature" | "lesson";
	/**
	 * For `type=cmd` results: the source namespace the command was
	 * discovered from — e.g. `"project:claude-commands"`,
	 * `"user:codex-prompts"`, `"user:db"`. Lets the popover show users
	 * where a command came from (project vs global, which tool's format).
	 */
	source?: string;
	/**
	 * For `type=cmd` results: raw prompt body. Used by the chat-history
	 * chip's hover popover so readers can see what the LLM received.
	 */
	body?: string;
	/**
	 * For `type=feature` results: number of files in the feature's bucket.
	 * Lets the popover show "(12 files)" alongside the feature name +
	 * description so users can scan-pick at a glance.
	 */
	fileCount?: number;
	/**
	 * For built-in literal commands (e.g. `/goal`): the raw text the composer
	 * inserts on selection, in place of a `/[cmd:name]` token. These commands
	 * are handled by a server-side text interceptor and must reach
	 * `body.content` as literal text rather than an expandable mention token.
	 */
	insertText?: string;
}

// ── Command body cache (for /cmd chip hover popover) ────────────────
//
// Chat-history messages persist the raw `/[cmd:name]` token; the LLM
// sees the expanded body (server-side `applyCommandExpansion`). To show
// the body in a hover popover on the chip, the client fetches it after
// the fact via `/api/mentions/search?type=cmd&q=<name>`.
//
// Cache key is `${projectId}::${name}` — project-scoped commands resolve
// differently for different projects (e.g. every project has its own
// `.claude/commands/review.md`). We only cache SUCCESSFUL resolutions;
// a null result (command not found, transient error) is allowed to
// retry on next hover instead of being pinned forever.
const commandBodyCache = new Map<string, string>();
const commandBodyInflight = new Map<string, Promise<string | null>>();

function commandCacheKey(name: string, projectId?: string): string {
	return `${projectId ?? "global"}::${name}`;
}

export async function fetchCommandBody(name: string, projectId?: string): Promise<string | null> {
	const key = commandCacheKey(name, projectId);
	const cached = commandBodyCache.get(key);
	if (cached !== undefined) return cached;

	const inflight = commandBodyInflight.get(key);
	if (inflight) return inflight;

	const promise = (async () => {
		try {
			const results = await searchMentions(name, "cmd", projectId);
			const match = results.find((r) => r.kind === "command" && r.name === name);
			const body = match?.body ?? null;
			if (body !== null) commandBodyCache.set(key, body);
			return body;
		} catch {
			return null;
		} finally {
			commandBodyInflight.delete(key);
		}
	})();
	commandBodyInflight.set(key, promise);
	return promise;
}

/** Test-only escape hatch: drop all cached command bodies. */
export function _resetCommandBodyCache(): void {
	commandBodyCache.clear();
	commandBodyInflight.clear();
}

// ── Feature details cache (for $feature chip hover popover) ─────────
//
// Chat-history messages persist the raw `$[feature:name]` token; the LLM
// sees a system note listing the feature's description + file paths
// (server-side `applyFeatureExpansion`). The chip's hover popover shows
// the same description + a collapsible file tree, fetched here.
//
// Cache key is `${projectId}::${name}`. Features are project-scoped, so
// the same feature name in two projects resolves to different rows.
// We only cache successful resolutions; missing features stay null so a
// later add/rename can still light up the popover without a manual
// reset.
export interface FeatureDetails {
	id: string;
	name: string;
	description: string;
	files: { relpath: string; source: "scan" | "user" }[];
}

const featureDetailsCache = new Map<string, FeatureDetails>();
const featureDetailsInflight = new Map<string, Promise<FeatureDetails | null>>();

function featureCacheKey(name: string, projectId: string): string {
	return `${projectId}::${name}`;
}

export async function fetchFeatureDetails(
	name: string,
	projectId: string,
): Promise<FeatureDetails | null> {
	if (!projectId || projectId === "global" || !name) return null;
	const key = featureCacheKey(name, projectId);
	const cached = featureDetailsCache.get(key);
	if (cached !== undefined) return cached;

	const inflight = featureDetailsInflight.get(key);
	if (inflight) return inflight;

	const promise = (async (): Promise<FeatureDetails | null> => {
		try {
			// Two-step: list endpoint returns name → id; per-id GET returns
			// the full file list. The list response is small (one row per
			// feature, no files) so we don't bother caching it separately.
			const listRes = await fetch(`${BASE}/api/projects/${projectId}/features`);
			if (!listRes.ok) return null;
			const list = (await listRes.json()) as Array<{ id: string; name: string }>;
			const match = list.find((f) => f.name === name);
			if (!match) return null;

			const detailRes = await fetch(
				`${BASE}/api/projects/${projectId}/features/${match.id}`,
			);
			if (!detailRes.ok) return null;
			const detail = (await detailRes.json()) as FeatureDetails;
			featureDetailsCache.set(key, detail);
			return detail;
		} catch {
			return null;
		} finally {
			featureDetailsInflight.delete(key);
		}
	})();
	featureDetailsInflight.set(key, promise);
	return promise;
}

/** Test-only escape hatch: drop all cached feature details. */
export function _resetFeatureDetailsCache(): void {
	featureDetailsCache.clear();
	featureDetailsInflight.clear();
}

export async function searchMentions(
	query: string,
	type?: "ext" | "agent" | "team" | "EZ" | "path" | "cmd" | "feature" | "lesson",
	projectId?: string,
): Promise<MentionResult[]> {
	const params = new URLSearchParams({ q: query });
	if (type) params.set("type", type);
	if (projectId) params.set("projectId", projectId);
	const res = await fetch(`${BASE}/api/mentions/search?${params}`);
	await checkResponse(res);
	return res.json();
}

// ── User Commands (per-user DB-backed slash commands) ─────────────────

// The server strips `userId` at the response boundary (see
// web/src/routes/api/user-commands/+server.ts:toResponseShape) — it's
// redundant on a per-user endpoint. Don't reintroduce it here.
export interface UserCommand {
	id: string;
	name: string;
	description: string;
	body: string;
	frontmatter: Record<string, string>;
	createdAt: string;
	updatedAt: string;
}

export async function fetchUserCommands(): Promise<UserCommand[]> {
	const res = await fetch(`${BASE}/api/user-commands`);
	await checkResponse(res);
	return res.json();
}

export async function fetchUserCommand(name: string): Promise<UserCommand> {
	const res = await fetch(`${BASE}/api/user-commands/${encodeURIComponent(name)}`);
	await checkResponse(res);
	return res.json();
}

export async function createUserCommand(data: {
	name: string;
	description?: string;
	body: string;
	frontmatter?: Record<string, string>;
}): Promise<UserCommand> {
	const res = await fetch(`${BASE}/api/user-commands`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function updateUserCommand(
	name: string,
	data: { description?: string; body?: string; frontmatter?: Record<string, string> },
): Promise<UserCommand> {
	const res = await fetch(`${BASE}/api/user-commands/${encodeURIComponent(name)}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(data),
	});
	await checkResponse(res);
	return res.json();
}

export async function deleteUserCommand(name: string): Promise<void> {
	const res = await fetch(`${BASE}/api/user-commands/${encodeURIComponent(name)}`, {
		method: "DELETE",
	});
	await checkResponse(res);
}

// ── Import wizard ───────────────────────────────────────────────────

export interface ImportPreviewCommand {
	id: string;
	name: string;
	description: string;
	source: string;
}
export interface ImportPreviewSkill {
	id: string;
	name: string;
	rawName: string;
	description: string;
	scriptCount: number;
}
export interface ImportPreviewResult {
	sessionId: string;
	fileCount: number;
	commands: ImportPreviewCommand[];
	skills: ImportPreviewSkill[];
}
export interface ImportItemResult {
	kind: "command" | "skill";
	requested: string;
	finalName?: string;
	extId?: string;
	status: "ok" | "error";
	message?: string;
}

/** Stage an upload (FormData with `projectId` + either `files`+`paths` or `archive`). */
export async function importPreview(form: FormData): Promise<ImportPreviewResult> {
	const res = await fetch(`${BASE}/api/import/preview`, { method: "POST", body: form });
	await checkResponse(res);
	return res.json();
}

export async function importCommit(payload: {
	sessionId: string;
	projectId: string;
	commands: string[];
	skills: string[];
}): Promise<{ results: ImportItemResult[] }> {
	const res = await fetch(`${BASE}/api/import/commit`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(payload),
	});
	await checkResponse(res);
	return res.json();
}

/** Uninstall an extension by id (used by the wizard's undo/remove). */
export async function uninstallExtension(id: string): Promise<void> {
	const res = await fetch(`${BASE}/api/extensions/${encodeURIComponent(id)}`, {
		method: "DELETE",
	});
	if (!res.ok && res.status !== 204) await checkResponse(res);
}
