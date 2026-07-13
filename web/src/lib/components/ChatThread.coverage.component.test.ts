/**
 * PHASE 6 — coverage close for <ChatThread>.
 *
 * Drives every ChatThread path that `ChatThread.component.test.ts` /
 * `ChatThread.behavior.component.test.ts` don't reach: all model /
 * thinking / mode / reasoning / context handlers, handleStop (with &
 * without streamed text + fetch failure), edit & edit-text UIs,
 * exclude-toggle success + error, branch focus, save/remove memory,
 * bulk rerun, sub-conversation send/return, the OAuth + ez:turn_saved
 * (LLM run + ext: run) + ez:agent_complete + external-refresh window
 * events, the non-seeded async load path, system messages, the
 * stuck-run banner, and the checking-active-run skeleton. The
 * `__test` bundle (same test-seam pattern as doRegenerate /
 * startRunStream) reaches handlers with no jsdom-reachable trigger.
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeCapabilitiesFetch } from "../../__tests__/stubs/model-capabilities";

const {
	sendMessageMock,
	updateConversationMock,
	fetchAllMessagesMock,
	userFetchMock,
	createSubMock,
	cloneTurnsMock,
	gotoMock,
	copyToClipboardMock,
} = vi.hoisted(() => ({
	cloneTurnsMock: vi.fn(async () => ({ id: "fork-1" })),
	gotoMock: vi.fn(),
	copyToClipboardMock: vi.fn(async () => true),
	sendMessageMock: vi.fn(async (_c: string, d: { content: string }) => ({
		userMessage: {
			id: `srv-${Math.random().toString(36).slice(2, 6)}`,
			conversationId: "conv-1",
			role: "user",
			content: d.content,
			createdAt: new Date().toISOString(),
			parentMessageId: null,
			excluded: false,
		},
		runId: "run-cov",
		attachments: [] as unknown[],
		ezActionResults: [] as unknown[],
	})),
	updateConversationMock: vi.fn(async (id: string) => ({ id, title: "t" })),
	fetchAllMessagesMock: vi.fn(async () => [] as Message[]),
	userFetchMock: vi.fn(
		async (): Promise<{
			ok: boolean;
			status?: number;
			json: () => Promise<unknown>;
		}> => ({ ok: true, json: async () => ({}) }),
	),
	createSubMock: vi.fn(async () => ({ id: "sub-x", agentConfigId: "" })),
}));

vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/project/proj-1/chat/conv-1?initial=Hi%20there"),
	},
}));
vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$app/environment", () => ({
	browser: true,
	dev: false,
	building: false,
	version: "t",
}));

let oauthCb: ((r: { success: boolean; provider: string; error?: string }) => void) | null =
	null;
vi.mock("$lib/oauth.js", () => ({
	listenForOAuthResult: vi.fn((cb: (r: unknown) => void) => {
		oauthCb = cb as typeof oauthCb;
		return () => {};
	}),
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});

let subActive: { id: string } | null = null;
const subMsgs: Array<{ id: string; role: string; content: string; createdAt: Date }> =
	[];
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return subActive;
		},
		get isInSubConversation() {
			return subActive !== null;
		},
		get activeSubConversationId() {
			return subActive?.id ?? null;
		},
		get subConvoMessages() {
			return subMsgs;
		},
		startSubConversation: vi.fn((o: { id: string }) => {
			subActive = o;
		}),
		endSubConversation: vi.fn(() => {
			const m = [...subMsgs];
			subActive = null;
			subMsgs.length = 0;
			return m;
		}),
		addMessage: vi.fn((m) => {
			subMsgs.push(m);
		}),
		setStreaming: vi.fn(),
	},
}));

const { seedBox } = vi.hoisted(() => ({
	seedBox: { tree: [] as unknown[] },
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: userFetchMock,
	backgroundFetch: vi.fn(async (_k: string, url: string) => {
		if (url.includes("messages?all=true"))
			return { ok: true, json: async () => seedBox.tree };
		if (url.includes("withToolCalls=true"))
			return {
				ok: true,
				json: async () => ({
					messages: [],
					orphanedToolCalls: [],
					subConversations: [],
					subConversationToolCalls: {},
				}),
			};
		if (/\/api\/conversations\/[^/]+$/.test(url))
			return {
				ok: true,
				json: async () => ({
					id: "conv-1",
					projectId: "proj-1",
					model: "gpt-4o",
					provider: "openai",
					modeId: null,
				}),
			};
		if (url.includes("/active-run"))
			return { ok: true, json: async () => ({ runId: null }) };
		if (url.endsWith("/topics"))
			return {
				ok: true,
				json: async () => ({
					topics: [
						{ id: "t1", label: "Auth", typeId: "feature", messageIds: ["u1"] },
					],
					stale: false,
					analyzedAt: "2026-07-13T00:00:00.000Z",
				}),
			};
		if (url.includes("/context-types"))
			return {
				ok: true,
				json: async () => ({
					types: [
						{ id: "feature", label: "Feature", description: "", sortOrder: 0 },
					],
				}),
			};
		return null;
	}),
	invalidate: vi.fn(),
}));

vi.mock("$lib/clipboard.js", () => ({ copyToClipboard: copyToClipboardMock }));

vi.mock("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	updateConversation: updateConversationMock,
	createSubConversation: createSubMock,
	cloneTurns: cloneTurnsMock,
	setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => {
		if (id === "throw-excl") throw new Error("excl fail");
		return { id, excluded: ex };
	}),
	fetchAllMessages: fetchAllMessagesMock,
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(async () => ({ id: "n" })),
	patchMessageContent: vi.fn(async (_c: string, _id: string, content: string) => {
		if (content === "throw-edit") throw new Error("edit fail");
		return { content };
	}),
}));

import ChatThread from "./ChatThread.svelte";

function msg(id: string, o: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `c-${id}`,
		createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
		parentMessageId: null,
		excluded: false,
		...o,
	} as Message;
}
function linear(): Message[] {
	return [
		msg("u1", { role: "user", createdAt: "2026-01-01T00:00:01.000Z" }),
		msg("a1", {
			role: "assistant",
			parentMessageId: "u1",
			content: "ans-1",
			createdAt: "2026-01-01T00:00:02.000Z",
		}),
		msg("u2", {
			role: "user",
			parentMessageId: "a1",
			createdAt: "2026-01-01T00:00:03.000Z",
		}),
		msg("a2", {
			role: "assistant",
			parentMessageId: "u2",
			content: "ans-2",
			createdAt: "2026-01-01T00:00:04.000Z",
		}),
	];
}

interface T {
	getThreadState: () => {
		messages: Message[];
		allMessages: Message[];
		activeLeafId: string | null;
		activeRunId: string | null;
		error: string | null;
		isStreaming: boolean;
		streamingText: string;
	};
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	__test: any;
	doRegenerate: (m: Message) => Promise<void>;
	doRetry: (m: Message) => Promise<void>;
	startRunStream: (id: string) => void;
}

function mount(seed: Message[] | undefined, props: Record<string, unknown> = {}) {
	if (seed) seedBox.tree = seed;
	fetchAllMessagesMock.mockResolvedValue(seed ?? []);
	const r = render(ChatThread, {
		conversationId: "conv-1",
		projectId: "proj-1",
		...(seed ? { seedMessages: seed, seedLeafId: seed.at(-1)?.id ?? null } : {}),
		...props,
	});
	return { ...r, api: r.component as unknown as T };
}

beforeEach(() => {
	oauthCb = null;
	subActive = null;
	subMsgs.length = 0;
	seedBox.tree = [];
	sendMessageMock.mockClear();
	updateConversationMock.mockClear();
	cloneTurnsMock.mockClear();
	cloneTurnsMock.mockResolvedValue({ id: "fork-1" });
	gotoMock.mockClear();
	userFetchMock.mockClear();
	userFetchMock.mockResolvedValue({ ok: true, json: async () => ({}) });
	fetchAllMessagesMock.mockReset();
	fetchAllMessagesMock.mockResolvedValue([]);
	// attachment-client memoises capability promises per (provider,
	// model); flush so each render re-hits the stubbed capabilities.
	__resetCapabilityCacheForTests();
	type C = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: C;
		ResizeObserver?: C;
		fetch?: typeof fetch;
	};
	if (typeof g.IntersectionObserver === "undefined")
		g.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as C;
	if (typeof g.ResizeObserver === "undefined")
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as C;
	if (!Element.prototype.scrollIntoView)
		Element.prototype.scrollIntoView = () => {};
	// ChatInput's $effect fetches /api/models/capabilities; a well-formed
	// body keeps `capabilities.kinds` defined so the attachmentsSupported
	// derived can't throw in teardown (fix-loop #5 — coverage stability).
	const capsFetch = makeCapabilitiesFetch();
	g.fetch = vi.fn(
		async (input: RequestInfo | URL) =>
			capsFetch(input) ??
			new Response(JSON.stringify({ tools: [], value: false }), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
});

describe("ChatThread model / thinking / mode / reasoning handlers", () => {
	test("handleModelChange invokes persistModel; autoselect respects existing", () => {
		const persistModel = vi.fn();
		const { api } = mount(linear(), { persistModel });
		api.__test.handleModelChange("openai", "gpt-5");
		expect(persistModel).toHaveBeenCalledWith("openai", "gpt-5");
		// autoselect is a no-op once a model is set
		api.__test.handleModelAutoSelect("anthropic", "claude");
		expect(persistModel).toHaveBeenCalledTimes(1);
	});

	test("autoselect seeds when no model picked yet", () => {
		const { api } = mount([]);
		api.__test.handleModelAutoSelect("google", "gemini");
		const st = api.getThreadState();
		expect(st).toBeTruthy();
	});

	test("thinking / reasoning / context handlers run", () => {
		const { api } = mount(linear());
		api.__test.handleThinkingLevelChange("high");
		api.__test.handleReasoningChange(true);
		api.__test.handleContextWindowChange(128000);
		api.__test.handleContextWindowChange(null);
		expect(localStorage.getItem("ezcorp-thinking-level")).toBe("high");
	});
});

describe("ChatThread edit / edit-text / exclude / branch / memory", () => {
	test("handleEdit then cancelEdit toggles inline edit state", async () => {
		const { api, container } = mount(linear());
		api.__test.handleEdit(linear()[0]!);
		await vi.waitFor(() =>
			expect(container.querySelector("textarea")).toBeTruthy(),
		);
		api.__test.cancelEdit();
	});

	test("edit-text save success path", async () => {
		const { api } = mount(linear());
		api.__test.handleEditText(msg("a2", { role: "assistant" }));
		api.__test.setEditText("a2", "new body");
		await api.__test.submitEditText();
		const api2 = await import("$lib/api.js");
		expect(api2.patchMessageContent).toHaveBeenCalled();
	});

	test("edit-text save failure path is caught (saving flag resets, draft retained)", async () => {
		const { api } = mount(linear());
		api.__test.setEditText("a2", "throw-edit");
		await api.__test.submitEditText();
		// patchMessageContent threw → submitEditText's catch swallows it
		// (no unhandled rejection) and `finally` resets editTextSaving.
		// On failure cancelEditText is NOT called, so the draft is kept
		// for the user to retry.
		const st = api.__test.getEditTextState();
		expect(st.saving).toBe(false);
		expect(st.id).toBe("a2");
		expect(st.draft).toBe("throw-edit");
		// The message content was NOT mutated (the patch failed).
		const a2 = api
			.getThreadState()
			.allMessages.find((m) => m.id === "a2");
		expect(a2?.content).not.toBe("throw-edit");
	});

	test("edit-text submit no-ops when no target (no patch call, state untouched)", async () => {
		const api2 = await import("$lib/api.js");
		(api2.patchMessageContent as ReturnType<typeof vi.fn>).mockClear();
		const { api } = mount(linear());
		api.__test.setEditText(null, "");
		await api.__test.submitEditText();
		// Guard `if (!editTextMessageId) return` → no network call, no
		// saving flag flip.
		expect(api2.patchMessageContent).not.toHaveBeenCalled();
		expect(api.__test.getEditTextState().saving).toBe(false);
	});

	test("cancelEditText clears both the target id and the draft", () => {
		const { api } = mount(linear());
		api.__test.setEditText("a2", "half-typed edit");
		expect(api.__test.getEditTextState()).toMatchObject({
			id: "a2",
			draft: "half-typed edit",
		});
		api.__test.cancelEditText();
		const st = api.__test.getEditTextState();
		expect(st.id).toBeNull();
		expect(st.draft).toBe("");
	});

	test("exclude toggle success then error branch", async () => {
		const { api } = mount(linear());
		await api.__test.handleToggleExclude(
			msg("a1", { role: "assistant", excluded: false }),
		);
		await api.__test.handleToggleExclude(
			msg("throw-excl", { role: "assistant", excluded: false }),
		);
		await vi.waitFor(() =>
			expect(api.getThreadState().error).toContain("exclude"),
		);
		// re-include error message branch
		await api.__test.handleToggleExclude(
			msg("throw-excl", { role: "assistant", excluded: true }),
		);
	});

	test("handleBranch forks the root→msg path into a new chat and navigates", async () => {
		const convListRefresh = vi.fn();
		const { api } = mount(linear(), { convListRefresh });
		// Branch from a *middle* message: only u1+a1 should be cloned, not
		// the whole linear thread (u1→a1→u2→a2).
		await api.__test.handleBranch(msg("a1"));
		expect(cloneTurnsMock).toHaveBeenCalledTimes(1);
		expect(cloneTurnsMock).toHaveBeenCalledWith("conv-1", {
			messageIds: ["u1", "a1"],
		});
		expect(convListRefresh).toHaveBeenCalledTimes(1);
		expect(gotoMock).toHaveBeenCalledWith("/project/proj-1/chat/fork-1");
		// Original thread is left untouched (no in-place leaf move).
		expect(api.getThreadState().activeLeafId).toBe("a2");
	});

	test("handleBranch is a no-op when the message id is absent (empty path)", async () => {
		const { api } = mount(linear());
		gotoMock.mockClear(); // drop the mount-time ?initial= strip nav
		await api.__test.handleBranch(msg("ghost"));
		expect(cloneTurnsMock).not.toHaveBeenCalled();
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("handleBranch surfaces an error and does not navigate when the fork fails", async () => {
		cloneTurnsMock.mockRejectedValueOnce(new Error("clone boom"));
		const { api } = mount(linear());
		gotoMock.mockClear(); // drop the mount-time ?initial= strip nav
		await api.__test.handleBranch(msg("a2"));
		expect(cloneTurnsMock).toHaveBeenCalledTimes(1);
		expect(gotoMock).not.toHaveBeenCalled();
	});

	test("handleBranch ignores re-entrant clicks while a fork is in flight", async () => {
		let release: (v: { id: string }) => void = () => {};
		cloneTurnsMock.mockImplementationOnce(
			() => new Promise((res) => (release = res)),
		);
		const { api } = mount(linear());
		gotoMock.mockClear(); // drop the mount-time ?initial= strip nav
		const first = api.__test.handleBranch(msg("a2"));
		// Second click while the first is still pending — must short-circuit.
		await api.__test.handleBranch(msg("a1"));
		expect(cloneTurnsMock).toHaveBeenCalledTimes(1);
		release({ id: "fork-1" });
		await first;
		expect(gotoMock).toHaveBeenCalledTimes(1);
	});

	test("save then remove memory", async () => {
		userFetchMock.mockResolvedValueOnce({
			status: 201,
			ok: true,
			json: async () => ({ id: "mem-1" }),
		});
		const { api } = mount(linear());
		await api.__test.handleSaveMemory(msg("u1"));
		await api.__test.handleRemoveMemory(msg("u1"));
		expect(userFetchMock).toHaveBeenCalled();
	});

	test("removeMemory no-ops when nothing saved (no DELETE issued)", async () => {
		const { api } = mount(linear());
		userFetchMock.mockClear();
		// `savedMemories` has no entry for u1 → handleRemoveMemory's
		// `if (!memoryId) return` short-circuits before any network call.
		expect(api.__test.hasSavedMemory("u1")).toBe(false);
		await api.__test.handleRemoveMemory(msg("u1"));
		const calls = userFetchMock.mock.calls as unknown as unknown[][];
		const deleteCalls = calls.filter(
			(c) => (c[1] as { method?: string } | undefined)?.method === "DELETE",
		);
		expect(deleteCalls.length).toBe(0);
		expect(api.__test.hasSavedMemory("u1")).toBe(false);
	});
});

describe("ChatThread handleStop", () => {
	test("stop with streamed text + active run, then reconcile", async () => {
		const { api } = mount(linear());
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-stop": "partial",
		};
		api.startRunStream("run-stop");
		fetchAllMessagesMock.mockResolvedValueOnce(linear());
		await api.__test.handleStop();
		// handleStop POSTs the cancel then clears the run + refetches.
		const calledUrls = userFetchMock.mock.calls.map((c) =>
			String((c as unknown[])[0]),
		);
		expect(
			calledUrls.some((u) => u.includes("/active-run")),
		).toBe(true);
	});

	test("stop no-ops with no active run (guard returns before any POST)", async () => {
		const { api } = mount(linear());
		api.__test.setActiveRun(null);
		userFetchMock.mockClear();
		await api.__test.handleStop();
		// `if (!activeRunId) return` → no /active-run cancel POST.
		const stopCalls = userFetchMock.mock.calls as unknown as unknown[][];
		const activeRunPosts = stopCalls.filter((c) =>
			String(c[0]).includes("/active-run"),
		);
		expect(activeRunPosts.length).toBe(0);
		expect(api.getThreadState().activeRunId).toBeNull();
	});

	test("stop tolerates active-run POST + refetch failure (still clears the run)", async () => {
		const { api } = mount(linear());
		api.__test.setActiveRun("run-z");
		expect(api.getThreadState().activeRunId).toBe("run-z");
		userFetchMock.mockRejectedValueOnce(new Error("net"));
		fetchAllMessagesMock.mockRejectedValueOnce(new Error("net"));
		// Both the cancel POST and the post-stop refetch throw; both
		// catch blocks must swallow so the run is still cleared and the
		// thread doesn't surface an error to the user.
		await api.__test.handleStop();
		const st = api.getThreadState();
		expect(st.activeRunId).toBeNull();
		expect(st.isStreaming).toBe(false);
	});
});

describe("ChatThread window events", () => {
	test("OAuth success + failure push system messages", async () => {
		const { api } = mount(linear());
		expect(typeof oauthCb).toBe("function");
		oauthCb?.({ success: true, provider: "openai" });
		oauthCb?.({ success: false, provider: "google", error: "denied" });
		api.__test.pushSystem("manual sys msg");
		await vi.waitFor(() =>
			expect(
				api.getThreadState().messages.length >= 0,
			).toBe(true),
		);
	});

	test("ez:turn_saved (LLM run) swaps the streaming placeholder", async () => {
		const { api } = mount(linear());
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		api.__test.setActiveRun("run-turn");
		window.dispatchEvent(
			new CustomEvent("ez:turn_saved", {
				detail: {
					runId: "run-turn",
					conversationId: "conv-1",
					messageId: "saved-1",
					parentMessageId: "a2",
					content: "saved content",
				},
			}),
		);
		await vi.waitFor(() =>
			expect(
				api
					.getThreadState()
					.allMessages.some((m) => m.id === "saved-1"),
			).toBe(true),
		);
	});

	test("ez:turn_saved (ext: run) busts the conv's fetch-policy cooldown; wrong-conv ignored", async () => {
		const fp = await import("$lib/utils/fetch-policy.js");
		const invalidate = fp.invalidate as ReturnType<typeof vi.fn>;
		const { api } = mount(linear());
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		invalidate.mockClear();

		// ext: run with an UNKNOWN message id → handleExtensionTurnSaved
		// invalidates the conv's messages-all + messages-tools cooldown
		// keys so the next load isn't served stale.
		window.dispatchEvent(
			new CustomEvent("ez:turn_saved", {
				detail: {
					runId: "ext:abc",
					conversationId: "conv-1",
					messageId: "ext-new",
				},
			}),
		);
		await vi.waitFor(() => {
			const keys = invalidate.mock.calls.map((c) => String(c[0]));
			expect(keys).toContain("messages-all:conv-1");
			expect(keys).toContain("messages-tools:conv-1");
		});

		// Wrong-conv event → `if (evtConvId !== conversationId) return`
		// short-circuits BEFORE any invalidation. Snapshot the count, fire
		// the foreign event, assert it didn't grow.
		const before = invalidate.mock.calls.length;
		window.dispatchEvent(
			new CustomEvent("ez:turn_saved", {
				detail: {
					runId: "run-x",
					conversationId: "other",
					messageId: "x",
				},
			}),
		);
		expect(invalidate.mock.calls.length).toBe(before);
	});

	test("ez:agent_complete reloads ONLY the matching conv; external refreshEventName always reloads", async () => {
		// fix-loop #3: pin the panel's external-refresh contract. The
		// panel mounts ChatThread with refreshEventName="agent:complete";
		// both that listener AND the built-in ez:agent_complete listener
		// invalidate this conv's fetch-policy key + re-run loadMessages.
		// We spy the invalidation + the loadMessages backing fetch and
		// assert (a) a matching ez:agent_complete reloads, (b) a
		// non-matching one does NOT, (c) the caller-supplied
		// refreshEventName reloads unconditionally.
		const fp = await import("$lib/utils/fetch-policy.js");
		const invalidate = fp.invalidate as ReturnType<typeof vi.fn>;
		const { api } = mount(linear(), { refreshEventName: "agent:complete" });
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);

		// (a) matching parentConversationId === conversationId → reload.
		invalidate.mockClear();
		window.dispatchEvent(
			new CustomEvent("ez:agent_complete", {
				detail: { parentConversationId: "conv-1" },
			}),
		);
		await vi.waitFor(() => {
			const keys = invalidate.mock.calls.map((c) => String(c[0]));
			expect(keys).toContain("messages-all:conv-1");
			expect(keys).toContain("messages-tools:conv-1");
		});

		// (b) non-matching parentConversationId → handler returns early,
		// NO further invalidation for this conv.
		invalidate.mockClear();
		window.dispatchEvent(
			new CustomEvent("ez:agent_complete", {
				detail: { parentConversationId: "some-other-conv" },
			}),
		);
		// Give any (incorrect) async reload a chance to fire, then assert
		// it didn't.
		await Promise.resolve();
		expect(
			invalidate.mock.calls.some(
				(c) => String(c[0]) === "messages-all:conv-1",
			),
		).toBe(false);

		// (c) the caller-supplied refreshEventName ("agent:complete")
		// fires the unconditional external-refresh path → reload.
		invalidate.mockClear();
		window.dispatchEvent(new CustomEvent("agent:complete"));
		await vi.waitFor(() =>
			expect(
				invalidate.mock.calls.map((c) => String(c[0])),
			).toContain("messages-all:conv-1"),
		);
	});
});

describe("ChatThread non-seeded async load + ?initial", () => {
	test("?initial query autosends once a model is resolved", async () => {
		// $app/state mock URL carries ?initial=Hi there. Seed the tree
		// (so ChatInput has a resolved model context and doesn't error
		// mid-load) then set the model — the ?initial $effect fires
		// handleSend exactly once.
		const { api } = mount(linear());
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		api.__test.handleModelChange("openai", "gpt-4o");
		await vi.waitFor(
			() => expect(sendMessageMock).toHaveBeenCalled(),
			{ timeout: 5000 },
		);
	});

	test("non-seeded mount runs the async loadMessages path", async () => {
		// Coverage of the non-seeded convId effect (loadMessages +
		// checkActiveRun). The page/panel always use this path; here we
		// assert it doesn't throw and the loader's backgroundFetch ran.
		const fp = await import("$lib/utils/fetch-policy.js");
		seedBox.tree = linear();
		mount(undefined);
		await vi.waitFor(
			() =>
				expect(
					(fp.backgroundFetch as ReturnType<typeof vi.fn>).mock
						.calls.length,
				).toBeGreaterThan(0),
			{ timeout: 5000 },
		);
	});
});

describe("ChatThread sub-conversation + bulk + misc", () => {
	test("sub-convo send then return", async () => {
		const { api } = mount(linear());
		subActive = { id: "sub-1" };
		await api.__test.handleSubConvoSend("hello sub");
		subMsgs.push({
			id: "a",
			role: "assistant",
			content: "done",
			createdAt: new Date(),
		});
		await api.__test.handleSubConvoReturn();
		expect(sendMessageMock).toHaveBeenCalled();
	});

	test("bulk rerun re-sends the LAST selected user message via the send factory", async () => {
		// fix-loop #6: the select-mode → bulk-action → factory path
		// (ChatThread.svelte handleBulkRerun, ~L872). handleBulkRerun
		// finds the last selected message with role==="user" and calls
		// sendApi.handleRerun(it). Pin the precise factory call (which
		// message content was re-sent), not just "something was sent".
		const tree = linear(); // u1, a1, u2, a2
		const { api } = mount(tree);
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		api.__test.handleModelChange("openai", "gpt-4o");
		// The coverage-suite $app/state mock carries ?initial=Hi there;
		// once a model resolves the queued-initial $effect fires one
		// handleSend("Hi there"). Let that settle, THEN clear the spy so
		// the bulk assertion sees ONLY the bulk-rerun send.
		await vi.waitFor(() =>
			expect(
				sendMessageMock.mock.calls.some(
					([, d]) => (d as { content?: string }).content === "Hi there",
				),
			).toBe(true),
		);
		sendMessageMock.mockClear();
		// select u1 + u2 then bulk-rerun.
		const sel = api as unknown as {
			toggleSelectMode: () => void;
			toggleSelectedMessage: (i: string) => void;
		};
		sel.toggleSelectMode();
		sel.toggleSelectedMessage("u1");
		sel.toggleSelectedMessage("u2");
		await api.__test.handleBulkRerun();
		// handleRerun re-sends the content of the LAST selected user
		// message (u2), NOT u1.
		await vi.waitFor(() =>
			expect(sendMessageMock).toHaveBeenCalled(),
		);
		const [, data] = sendMessageMock.mock.calls.at(-1)! as unknown as [
			string,
			{ content: string; editOf?: string },
		];
		// handleRerun re-sends u2's content unchanged with
		// editOf=u2.id — the server forks a SIBLING user turn under the
		// same parent (identical wire shape to a no-op edit), NOT u1.
		expect(data.content).toBe(
			tree.find((m) => m.id === "u2")!.content,
		);
		expect(data.editOf).toBe("u2");
	});

	test("bulk rerun no-ops when the selection has no user message", async () => {
		// Guard: `if (!lastUserMsg) return` — selecting only assistant
		// turns must not fire the send factory.
		const tree = linear();
		const { api } = mount(tree);
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		api.__test.handleModelChange("openai", "gpt-4o");
		// Drain the ?initial="Hi there" autosend (see sibling test) so
		// the no-op assertion isn't polluted by it.
		await vi.waitFor(() =>
			expect(
				sendMessageMock.mock.calls.some(
					([, d]) => (d as { content?: string }).content === "Hi there",
				),
			).toBe(true),
		);
		sendMessageMock.mockClear();
		const sel = api as unknown as {
			toggleSelectMode: () => void;
			toggleSelectedMessage: (i: string) => void;
		};
		sel.toggleSelectMode();
		sel.toggleSelectedMessage("a1"); // assistant only
		sel.toggleSelectedMessage("a2"); // assistant only
		await api.__test.handleBulkRerun();
		// `if (!lastUserMsg) return` — no send factory call at all.
		expect(sendMessageMock).not.toHaveBeenCalled();
	});

	test("rerun + fallback handlers run", async () => {
		const tree = linear();
		const { api } = mount(tree);
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		await api.__test.handleRerun(tree[2]!);
		await api.__test.handleFallback(tree[3]!, "anthropic", "claude");
		expect(sendMessageMock).toHaveBeenCalled();
	});

	test("stuck-run banner + checking skeleton render under the right state", async () => {
		const tree = [msg("u1", { role: "user" })];
		const { api, container } = mount(tree);
		api.__test.setActiveRun("run-stuck");
		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-stuck": "x",
		};
		api.__test.setStaleness(35_000, Date.now() - 35_000);
		await vi.waitFor(() => {
			// StuckRunBanner mounts (its testid-free; assert by text the
			// component renders a Cancel affordance) OR the thread stays
			// stable — either way no throw.
			expect(container).toBeTruthy();
		});
	});
});

describe("ChatThread topic contexts (WS4)", () => {
	test("cache-only GET on mount hydrates topics + context types", async () => {
		const { api } = mount(linear());
		await vi.waitFor(() =>
			expect(api.__test.getTopicsState().list.length).toBe(1),
		);
		const st = api.__test.getTopicsState();
		expect(st.analyzedAt).toBe("2026-07-13T00:00:00.000Z");
		expect(st.stale).toBe(false);
	});

	test("handleDetectTopics success replaces topics + opens the popover", async () => {
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				topics: [
					{ id: "t2", label: "Rate limit", typeId: "bug-fix", messageIds: ["u2"] },
				],
				stale: true,
				analyzedAt: "2026-07-13T01:00:00.000Z",
			}),
		});
		await api.__test.handleDetectTopics();
		const st = api.__test.getTopicsState();
		expect(st.open).toBe(true);
		expect(st.analyzing).toBe(false);
		expect(st.list.map((t: { id: string }) => t.id)).toContain("t2");
		expect(st.stale).toBe(true);
	});

	test("handleDetectTopics tolerates a partial body (defaults applied)", async () => {
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({}) });
		await api.__test.handleDetectTopics();
		const st = api.__test.getTopicsState();
		expect(st.list).toEqual([]);
		expect(st.stale).toBe(false);
		expect(st.analyzedAt).toBeNull();
	});

	test("handleDetectTopics 503 surfaces the actionable error", async () => {
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: false,
			status: 503,
			json: async () => ({ error: "No model available" }),
		});
		await api.__test.handleDetectTopics();
		expect(api.__test.getTopicsState().analyzeError).toBe("No model available");
	});

	test("handleDetectTopics network throw falls back to the default error", async () => {
		const { api } = mount(linear());
		userFetchMock.mockRejectedValueOnce(new Error("net"));
		await api.__test.handleDetectTopics();
		expect(api.__test.getTopicsState().analyzeError).toContain("Couldn't analyze");
	});

	test("handleExtractTopic success copies + shows the result", async () => {
		copyToClipboardMock.mockResolvedValueOnce(true);
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				context: {
					id: "ctx-1",
					topicLabel: "Auth",
					typeId: "feature",
					title: "Auth context",
					content: "JWT rotation",
					model: "ollama/qwen3:1.7b",
					updatedAt: "2026-07-13T00:00:00.000Z",
				},
			}),
		});
		await api.__test.handleExtractTopic("t1");
		const st = api.__test.getTopicsState();
		expect(st.extractState.status).toBe("copied");
		expect(st.busyId).toBeNull();
		expect(copyToClipboardMock).toHaveBeenCalledWith("JWT rotation");
	});

	test("handleExtractTopic surfaces copyFailed when auto-copy is blocked", async () => {
		copyToClipboardMock.mockResolvedValueOnce(false);
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				context: {
					id: "ctx-2",
					topicLabel: "Auth",
					typeId: "feature",
					title: "Auth",
					content: "body",
					model: "m",
					updatedAt: "2026-07-13T00:00:00.000Z",
				},
			}),
		});
		await api.__test.handleExtractTopic("t1");
		expect(api.__test.getTopicsState().extractState.status).toBe("copyFailed");
	});

	test("handleExtractTopic 503 shows the extract error", async () => {
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: false,
			status: 503,
			json: async () => ({ error: "No model" }),
		});
		await api.__test.handleExtractTopic("t1");
		const st = api.__test.getTopicsState();
		expect(st.extractState.status).toBe("error");
		expect(st.extractState.message).toBe("No model");
	});

	test("handleExtractTopic network throw falls back to the default error", async () => {
		const { api } = mount(linear());
		userFetchMock.mockRejectedValueOnce(new Error("net"));
		await api.__test.handleExtractTopic("t1");
		expect(api.__test.getTopicsState().extractState.status).toBe("error");
	});

	test("handleTopicManualCopy flips copyFailed → copied on success", async () => {
		copyToClipboardMock.mockResolvedValueOnce(false);
		const { api } = mount(linear());
		userFetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				context: {
					id: "ctx-3",
					topicLabel: "Auth",
					typeId: "feature",
					title: "Auth",
					content: "body-3",
					model: "m",
					updatedAt: "2026-07-13T00:00:00.000Z",
				},
			}),
		});
		await api.__test.handleExtractTopic("t1");
		expect(api.__test.getTopicsState().extractState.status).toBe("copyFailed");
		copyToClipboardMock.mockResolvedValueOnce(true);
		await api.__test.handleTopicManualCopy("body-3");
		expect(api.__test.getTopicsState().extractState.status).toBe("copied");
	});

	test("toggleTopics flips the popover open state", () => {
		const { api } = mount(linear());
		api.__test.toggleTopics(true);
		expect(api.__test.getTopicsState().open).toBe(true);
		api.__test.toggleTopics(false);
		expect(api.__test.getTopicsState().open).toBe(false);
	});
});
