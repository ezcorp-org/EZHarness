import type { Page } from "@playwright/test";
import { makeProject, makeAgent, type makeRun, makeConversation, makeMessage, type makePipeline, makeAgentConfig, makeMemory, type makeKBFile, type makeProviderStatus, makeMode, type ModeData } from "./data.js";
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
			return route.fulfill({ json: { userMessage: userMsg, runId: "run-stream", attachments } });
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
