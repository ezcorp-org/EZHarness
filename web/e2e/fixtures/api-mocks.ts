import type { Page } from "@playwright/test";
import { makeProject, makeAgent, makeRun, makeConversation, makeMessage, makePipeline, makeAgentConfig, makeMemory, makeKBFile, makeProviderStatus, makeMode, type ModeData } from "./data.js";
import { fuzzyScore } from "../../src/lib/fuzzy-match.js";

export interface SubConversationMock {
	id: string;
	agentName: string;
	agentConfigId: string;
	parentMessageId: string;
	parentConversationId: string;
	title?: string;
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
	providers?: ReturnType<typeof makeProviderStatus>[];
	modes?: ModeData[];
	extensions?: any[];
	marketplace?: { listings: any[]; featured?: any[] };
	settings?: Record<string, unknown>;
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
	 * description.
	 */
	commands?: Array<{ name: string; description: string; source?: string; body?: string }>;
	/** Override specific routes: URL pattern -> handler */
	routes?: Record<string, (url: URL) => unknown>;
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
	const providers = overrides.providers ?? [];
	const extensions = overrides.extensions ?? [];
	const files = overrides.files ?? [];
	const commands = overrides.commands ?? [];
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
			const conv = conversations.find((c) => c.id === id);
			return route.fulfill({ json: { ...(conv ?? makeConversation({ id })), ...body } });
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
						messages: convMessages.map(m => ({ ...m, toolCalls: [] })),
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
		if (path.match(/^\/api\/conversations\/[^/]+\/messages$/) && method === "POST") {
			const convId = path.split("/")[3]!;
			const req = route.request();
			const ct = req.headers()["content-type"] ?? "";
			let content = "sent";
			const attachments: Array<{ filename: string; mimeType: string }> = [];
			if (ct.startsWith("multipart/form-data")) {
				// Playwright doesn't parse multipart, but we can extract the
				// boundary and filenames from the raw body for verification.
				const raw = req.postDataBuffer()?.toString("binary") ?? "";
				const contentMatch = /name="content"\r\n\r\n([\s\S]*?)\r\n--/.exec(raw);
				if (contentMatch) content = contentMatch[1]!;
				const fileRe = /name="files";\s*filename="([^"]+)"\r\nContent-Type: ([^\r\n]+)/g;
				let m: RegExpExecArray | null;
				while ((m = fileRe.exec(raw)) !== null) {
					attachments.push({ filename: m[1]!, mimeType: m[2]! });
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
			});
			return route.fulfill({ json: { userMessage: userMsg, runId: "run-stream", attachments } });
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
		if (path.match(/^\/api\/providers\/[^/]+\/test$/) && method === "POST") {
			return route.fulfill({ json: { success: true } });
		}
		// Local model test
		if (path === "/api/providers/local/test" && method === "POST") {
			return route.fulfill({ json: { reachable: true, modelAvailable: true, inferenceOk: true, endpointType: "openai-compatible", latencyMs: 150 } });
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

			// Slash-command search is mutually exclusive with other kinds.
			// Mirror the real server's scoping rule: when no `projectId`
			// query param is provided, project-scoped commands
			// (`project:*`) are hidden from results. This keeps the mock
			// honest — callers that forget to pass projectId will see the
			// same empty result the real server returns.
			if (type === "cmd") {
				const searchProjectId = url.searchParams.get("projectId");
				const list = commands
					.filter((c) =>
						searchProjectId || !(c.source ?? "").startsWith("project:"),
					)
					.map((c) => ({
						name: c.name,
						description: c.description,
						kind: "command" as const,
						source: c.source,
						body: c.body,
					}));
				const filtered = q
					? list.filter((m) =>
						m.name.toLowerCase().includes(q.toLowerCase()) ||
						m.description.toLowerCase().includes(q.toLowerCase()),
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

		// Default: empty OK
		return route.fulfill({ json: {} });
	});
}
