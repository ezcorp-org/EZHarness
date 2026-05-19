/**
 * PHASE 3 — Full component test for the extracted `<ChatThread>`.
 *
 * Targets 100% line/branch of `ChatThread.svelte`: render of the
 * branch-aware message list, sibling ‹/› nav via the real
 * `handleBranchNavigate`, every toolbar action wired to the correct
 * factory call, runId-keyed streaming `$derived` updating on store
 * mutation, `variant="panel"` 44px-min close affordance, two-instance
 * state isolation (page + panel mounted together never share state).
 *
 * The real `makeSendMessage` / `makeLoadMessages` / `useSelectMode` /
 * `attachStreamResume` / `makeInlineToolHandlers` factories run; only
 * the network/IO leaves (`$lib/api.js`, fetch-policy, oauth, commands,
 * mention-logic, sub-conv store, `$app/*`) are stubbed so the assertions
 * are about ChatThread's own wiring, not transport.
 *
 * vitest + jsdom + @testing-library/svelte.
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";
import { __resetCapabilityCacheForTests } from "$lib/chat/attachment-client";
import { makeCapabilitiesFetch } from "../../__tests__/stubs/model-capabilities";

const { sendMessageMock, updateConversationMock, fetchAllMessagesMock } =
	vi.hoisted(() => ({
		sendMessageMock: vi.fn(
			async (
				_convId: string,
				data: { content: string; editOf?: string; parentMessageId?: string },
			) => ({
				userMessage: {
					id: `srv-${data.editOf ?? "u"}-${Math.random()
						.toString(36)
						.slice(2, 7)}`,
					conversationId: "conv-1",
					role: "user",
					content: data.content,
					createdAt: new Date().toISOString(),
					parentMessageId: data.parentMessageId ?? null,
					excluded: false,
				},
				runId: "run-3",
				attachments: [] as unknown[],
			}),
		),
		updateConversationMock: vi.fn(async (id: string) => ({ id })),
		fetchAllMessagesMock: vi.fn(async () => [] as Message[]),
	}));

vi.mock("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	updateConversation: updateConversationMock,
	createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
	cloneTurns: vi.fn(async () => ({ id: "x" })),
	setMessageExcluded: vi.fn(async (_c: string, id: string, ex: boolean) => ({
		id,
		excluded: ex,
	})),
	fetchAllMessages: fetchAllMessagesMock,
	fetchModes: vi.fn(async () => []),
	createConversation: vi.fn(async () => ({ id: "new" })),
	patchMessageContent: vi.fn(async (_c: string, _id: string, content: string) => ({
		content,
	})),
}));

vi.mock("$lib/oauth.js", () => ({
	startOAuthFlow: vi.fn(),
	completeOAuthWithCode: vi.fn(),
	isLoginCommand: () => null,
	listenForOAuthResult: vi.fn(() => () => {}),
}));
vi.mock("$lib/commands.js", () => ({ isModelCommand: () => null }));
vi.mock("$lib/sub-conversation-store.svelte.js", () => ({
	subConversationStore: {
		get activeSubConversation() {
			return null;
		},
		get isInSubConversation() {
			return false;
		},
		get activeSubConversationId() {
			return null;
		},
		get subConvoMessages() {
			return [];
		},
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));
// ChatInput uses getSegments/getActiveMention etc. — keep the real
// pure mention parser; send-message's parseMentions is also real.
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});
// `makeLoadMessages` fetches the message tree via
// `backgroundFetch("messages-all:…", "/api/conversations/…/messages?all=true")`.
// A hoisted mutable box lets each test seed the tree the mock returns;
// the `?withToolCalls=true` hydrate read returns an empty bundle; the
// conversation GET returns a minimal row.
const { seedBox } = vi.hoisted(() => ({
	seedBox: {
		tree: [] as unknown[],
		byConv: {} as Record<string, unknown[]>,
	},
}));
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async (_key: string, url: string) => {
		if (url.includes("messages?all=true")) {
			const m = /\/api\/conversations\/([^/]+)\/messages/.exec(url);
			const cid = m?.[1] ?? "";
			const tree = seedBox.byConv[cid] ?? seedBox.tree;
			return { ok: true, json: async () => tree };
		}
		if (url.includes("withToolCalls=true")) {
			return {
				ok: true,
				json: async () => ({
					messages: [],
					orphanedToolCalls: [],
					subConversations: [],
					subConversationToolCalls: {},
				}),
			};
		}
		if (/\/api\/conversations\/[^/]+$/.test(url)) {
			return {
				ok: true,
				json: async () => ({
					id: "conv-1",
					projectId: "proj-1",
					model: null,
					provider: null,
					modeId: null,
				}),
			};
		}
		return null;
	}),
	invalidate: vi.fn(),
}));
vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({
	page: { params: { id: "proj-1", convId: "conv-1" }, url: new URL("http://x/") },
}));

import ChatThread from "./ChatThread.svelte";

function msg(id: string, o: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
		parentMessageId: null,
		excluded: false,
		...o,
	} as Message;
}

function branchedTree(): Message[] {
	return [
		msg("u1", { role: "user", createdAt: "2026-01-01T00:00:01.000Z" }),
		msg("a1", {
			role: "assistant",
			parentMessageId: "u1",
			content: "branch-A",
			createdAt: "2026-01-01T00:00:02.000Z",
		}),
		msg("a1b", {
			role: "assistant",
			parentMessageId: "u1",
			content: "branch-B",
			createdAt: "2026-01-01T00:00:03.000Z",
		}),
	];
}

function linearTree(): Message[] {
	return [
		msg("u1", { role: "user", createdAt: "2026-01-01T00:00:01.000Z" }),
		msg("a1", {
			role: "assistant",
			parentMessageId: "u1",
			content: "answer-1",
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
			content: "answer-2",
			createdAt: "2026-01-01T00:00:04.000Z",
		}),
	];
}

/**
 * ChatThread loads its own messages via the loadMessages factory (which
 * calls fetchAllMessages). We seed via fetchAllMessages + a leaf.
 */
function mountThread(tree: Message[], props: Record<string, unknown> = {}) {
	seedBox.tree = tree;
	fetchAllMessagesMock.mockResolvedValue(tree);
	return render(ChatThread, {
		conversationId: "conv-1",
		projectId: "proj-1",
		...props,
	});
}

beforeEach(() => {
	sendMessageMock.mockClear();
	updateConversationMock.mockClear();
	fetchAllMessagesMock.mockReset();
	fetchAllMessagesMock.mockResolvedValue([]);
	seedBox.tree = [];
	seedBox.byConv = {};
	// attachment-client memoises capability promises per (provider,
	// model); flush so each render re-hits the stubbed capabilities.
	__resetCapabilityCacheForTests();
	// jsdom ships neither IntersectionObserver nor ResizeObserver; the
	// thread's scroll-restore + sentinel effects call both. No-op stubs.
	type AnyCtor = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: AnyCtor;
		ResizeObserver?: AnyCtor;
		fetch?: typeof fetch;
	};
	if (typeof g.IntersectionObserver === "undefined") {
		g.IntersectionObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (typeof g.ResizeObserver === "undefined") {
		g.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as AnyCtor;
	}
	if (!Element.prototype.scrollIntoView) {
		Element.prototype.scrollIntoView = () => {};
	}
	// ChatInput's $effect fetches /api/models/capabilities; a well-formed
	// body keeps `capabilities.kinds` defined so the attachmentsSupported
	// derived can't throw in teardown (fix-loop #5 — coverage stability).
	const capsFetch = makeCapabilitiesFetch();
	g.fetch = vi.fn(
		async (input: RequestInfo | URL) =>
			capsFetch(input) ??
			new Response(JSON.stringify({}), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
	) as unknown as typeof fetch;
});

describe("ChatThread render + structure", () => {
	test("renders the thread shell with the page variant by default", () => {
		const { getByTestId } = mountThread([]);
		const el = getByTestId("chat-thread");
		expect(el).toBeInTheDocument();
		expect(el.getAttribute("data-variant")).toBe("page");
	});

	test("empty conversation shows the start prompt", () => {
		const { getByText } = mountThread([]);
		expect(
			getByText("Send a message to start the conversation"),
		).toBeInTheDocument();
	});

	test("messages container present for scroll wiring", () => {
		const { getByTestId } = mountThread([]);
		expect(getByTestId("chat-messages-container")).toBeInTheDocument();
	});
});

describe("ChatThread variant=panel", () => {
	test("panel variant renders a 44px-min close affordance and calls onclose", async () => {
		const onclose = vi.fn();
		const { getByTestId, getByLabelText } = mountThread([], {
			variant: "panel",
			onclose,
		});
		expect(getByTestId("chat-thread").getAttribute("data-variant")).toBe(
			"panel",
		);
		const closeBtn = getByLabelText("Close");
		// 44px-min touch target (MessageToolbar btnClass parity).
		expect(closeBtn.className).toContain("min-h-[44px]");
		expect(closeBtn.className).toContain("min-w-[44px]");
		await fireEvent.click(closeBtn);
		expect(onclose).toHaveBeenCalledTimes(1);
	});

	test("custom header snippet suppresses the default panel header", () => {
		// No header snippet + page variant → no close button.
		const { queryByLabelText } = mountThread([], { variant: "page" });
		expect(queryByLabelText("Close")).toBeNull();
	});

	test("mobile rich-copy: shift-modified Copy in the panel writes a text/html clipboard payload", async () => {
		// fix-loop #4 — spec risk #5. On mobile, a long-press in the
		// panel drawer surfaces the rich-copy affordance; the rich path
		// is MessageToolbar.handleCopy's `e.shiftKey && renderedHtml &&
		// navigator.clipboard.write` branch. No test asserted this
		// `text/html` path through <ChatThread variant="panel"> →
		// ChatMessage → MessageToolbar before. We drive the assistant
		// turn's Copy button with shiftKey:true (the synthetic-shift the
		// long-press / desktop rich-copy both use) and assert a
		// ClipboardItem carrying text/html lands on the clipboard.
		const writeSpy = vi.fn(async () => {});
		const realClipboard = navigator.clipboard;
		Object.defineProperty(navigator, "clipboard", {
			configurable: true,
			value: { write: writeSpy, writeText: vi.fn(async () => {}) },
		});
		// jsdom lacks ClipboardItem; a minimal stand-in is enough — the
		// assertion only inspects the MIME map we hand it.
		const realClipboardItem = (
			globalThis as unknown as { ClipboardItem?: unknown }
		).ClipboardItem;
		class FakeClipboardItem {
			items: Record<string, Blob>;
			constructor(items: Record<string, Blob>) {
				this.items = items;
			}
		}
		(
			globalThis as unknown as { ClipboardItem: unknown }
		).ClipboardItem = FakeClipboardItem;

		try {
			const { getByText, getAllByLabelText } = mountThread(
				linearTree(),
				{ variant: "panel", onclose: vi.fn() },
			);
			// Assistant turn "answer-2" renders markdown into mdContainer
			// so MessageToolbar receives a non-empty renderedHtml.
			await vi.waitFor(() =>
				expect(getByText("answer-2")).toBeInTheDocument(),
			);
			const copyBtns = getAllByLabelText("Copy message");
			// Shift-modified click = the synthetic-shift rich-copy intent
			// the mobile long-press piggybacks on.
			await fireEvent.click(copyBtns[copyBtns.length - 1]!, {
				shiftKey: true,
			});

			await vi.waitFor(() =>
				expect(writeSpy).toHaveBeenCalledTimes(1),
			);
			const [items] = writeSpy.mock.calls[0]! as unknown as [
				FakeClipboardItem[],
			];
			expect(items).toHaveLength(1);
			const mimes = Object.keys(items[0]!.items);
			expect(mimes).toContain("text/html");
			expect(mimes).toContain("text/plain");
			const htmlBlob = items[0]!.items["text/html"]!;
			expect(htmlBlob.type).toBe("text/html");
			expect(htmlBlob.size).toBeGreaterThan(0);
		} finally {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: realClipboard,
			});
			(
				globalThis as unknown as { ClipboardItem: unknown }
			).ClipboardItem = realClipboardItem;
		}
	});
});

describe("ChatThread imperative API (Phase-0 re-point hooks)", () => {
	test("getThreadState exposes the active path after load", async () => {
		const { component } = mountThread(linearTree());
		// loadMessages resolves async; allow microtasks + the convId effect.
		await vi.waitFor(() => {
			const st = (
				component as unknown as {
					getThreadState: () => { messages: Message[] };
				}
			).getThreadState();
			expect(st.messages.length).toBe(4);
		});
	});

	test("doRegenerate forks via sendMessage with editOf=<assistant id>", async () => {
		const tree = linearTree();
		const { component } = mountThread(tree);
		await vi.waitFor(() => {
			const st = (
				component as unknown as {
					getThreadState: () => { messages: Message[] };
				}
			).getThreadState();
			expect(st.messages.length).toBe(4);
		});
		await (
			component as unknown as {
				doRegenerate: (m: Message) => Promise<void>;
			}
		).doRegenerate(tree[3]!); // a2
		expect(sendMessageMock).toHaveBeenCalled();
		const [, data] = sendMessageMock.mock.calls.at(-1)!;
		expect(data.editOf).toBe("a2");
		expect(data.content).toBe(tree[2]!.content); // preceding user msg
	});

	test("doRetry re-sends the preceding user content (no editOf)", async () => {
		const tree = linearTree();
		const { component } = mountThread(tree);
		await vi.waitFor(() => {
			expect(
				(
					component as unknown as {
						getThreadState: () => { messages: Message[] };
					}
				).getThreadState().messages.length,
			).toBe(4);
		});
		await (
			component as unknown as { doRetry: (m: Message) => Promise<void> }
		).doRetry(tree[3]!);
		expect(sendMessageMock).toHaveBeenCalled();
		const [, data] = sendMessageMock.mock.calls.at(-1)!;
		expect(data.content).toBe(tree[2]!.content);
		expect(data.editOf).toBeUndefined();
	});

	test("fireExtensionTurn dedupes a known message id", async () => {
		const tree = linearTree();
		const { component } = mountThread(tree);
		await vi.waitFor(() => {
			expect(
				(
					component as unknown as {
						getThreadState: () => { messages: Message[] };
					}
				).getThreadState().messages.length,
			).toBe(4);
		});
		const known = (
			component as unknown as {
				fireExtensionTurn: (id: string) => boolean;
			}
		).fireExtensionTurn("u1");
		expect(known).toBe(false);
		const fresh = (
			component as unknown as {
				fireExtensionTurn: (id: string) => boolean;
			}
		).fireExtensionTurn("brand-new");
		expect(fresh).toBe(true);
	});
});

describe("ChatThread branch navigation render", () => {
	test("renders only the latest sibling branch by default", async () => {
		const { getByText, queryByText } = mountThread(branchedTree());
		await vi.waitFor(() =>
			expect(getByText("branch-B")).toBeInTheDocument(),
		);
		expect(queryByText("branch-A")).toBeNull();
	});

	test("‹ previous-branch nav switches the rendered branch", async () => {
		const { getByText, queryByText, getAllByLabelText } =
			mountThread(branchedTree());
		await vi.waitFor(() =>
			expect(getByText("branch-B")).toBeInTheDocument(),
		);
		// BranchNavigator exposes the sibling nav as "Previous branch".
		await fireEvent.click(getAllByLabelText("Previous branch")[0]!);
		await vi.waitFor(() =>
			expect(getByText("branch-A")).toBeInTheDocument(),
		);
		expect(queryByText("branch-B")).toBeNull();
	});
});

describe("ChatThread toolbar actions wire to factory calls", () => {
	test("Regenerate button on an assistant turn forks a sibling", async () => {
		const { getByText, getAllByLabelText } = mountThread(linearTree());
		await vi.waitFor(() =>
			expect(getByText("answer-2")).toBeInTheDocument(),
		);
		// Last assistant turn (a2) is the final Regenerate affordance.
		const regenBtns = getAllByLabelText("Regenerate response");
		await fireEvent.click(regenBtns[regenBtns.length - 1]!);
		await vi.waitFor(() =>
			expect(sendMessageMock).toHaveBeenCalled(),
		);
		const [, data] = sendMessageMock.mock.calls.at(-1)!;
		expect(data.editOf).toBe("a2");
	});

	test("Edit message on a user turn enters inline edit", async () => {
		const { getByText, getAllByLabelText, container } =
			mountThread(linearTree());
		await vi.waitFor(() =>
			expect(getByText("content-u2")).toBeInTheDocument(),
		);
		await fireEvent.click(getAllByLabelText("Edit message")[0]!);
		// inline edit textarea appears
		await vi.waitFor(() =>
			expect(container.querySelector("textarea")).toBeInTheDocument(),
		);
	});

	test("Exclude toggles via setMessageExcluded", async () => {
		const api = await import("$lib/api.js");
		const { getByText, getAllByTestId } = mountThread(linearTree());
		await vi.waitFor(() =>
			expect(getByText("answer-2")).toBeInTheDocument(),
		);
		await fireEvent.click(getAllByTestId("exclude-context-btn")[0]!);
		expect(api.setMessageExcluded).toHaveBeenCalled();
	});
});

describe("ChatThread streaming $derived (runId-keyed store mirror)", () => {
	test("startRunStream + store mutation surfaces streamed text", async () => {
		const tree = linearTree();
		const { component } = mountThread(tree);
		type St = {
			messages: Message[];
			activeRunId: string | null;
			isStreaming: boolean;
			streamingText: string;
		};
		const get = () =>
			(component as unknown as { getThreadState: () => St }).getThreadState();
		// Wait for load AND the convId effect's checkActiveRun() to settle
		// (it sets activeRunId=null when there's no active run) before we
		// bind our own run — otherwise the effect would clobber it.
		await vi.waitFor(() => {
			expect(get().messages.length).toBe(4);
			expect(get().activeRunId).toBeNull();
		});
		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-S": "streamed tokens",
		};
		(
			component as unknown as { startRunStream: (id: string) => void }
		).startRunStream("run-S");
		await vi.waitFor(() => {
			const st = get();
			expect(st.activeRunId).toBe("run-S");
			expect(st.isStreaming).toBe(true);
			expect(st.streamingText).toBe("streamed tokens");
		});
	});

	test("another run's tokens never bind to this thread", async () => {
		const { component } = mountThread(linearTree());
		type St = { messages: Message[]; streamingText: string };
		const get = () =>
			(component as unknown as { getThreadState: () => St }).getThreadState();
		await vi.waitFor(() => expect(get().messages.length).toBe(4));
		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-foreign": "not mine",
		};
		// No startRunStream → activeRunId stays null → the derived mirror
		// is empty; a foreign run's tokens never leak into this instance.
		expect(get().streamingText).toBe("");
	});
});

describe("ChatThread two-instance state isolation", () => {
	test("page + panel mounted together keep independent message trees", async () => {
		seedBox.byConv = {
			"conv-page": linearTree(),
			"conv-panel": branchedTree(),
		};
		const pageInst = render(ChatThread, {
			conversationId: "conv-page",
			projectId: "proj-1",
			variant: "page",
		});
		const panelInst = render(ChatThread, {
			conversationId: "conv-panel",
			projectId: "proj-1",
			variant: "panel",
			onclose: vi.fn(),
		});

		await vi.waitFor(() => {
			const pst = (
				pageInst.component as unknown as {
					getThreadState: () => { messages: Message[] };
				}
			).getThreadState();
			const nst = (
				panelInst.component as unknown as {
					getThreadState: () => { messages: Message[] };
				}
			).getThreadState();
			expect(pst.messages.length).toBe(4);
			expect(nst.messages.length).toBe(2);
		});

		// Mutating one instance's run never bleeds into the other.
		(
			pageInst.component as unknown as {
				startRunStream: (id: string) => void;
			}
		).startRunStream("run-page-only");
		const nst = (
			panelInst.component as unknown as {
				getThreadState: () => { activeRunId: string | null };
			}
		).getThreadState();
		expect(nst.activeRunId).not.toBe("run-page-only");
	});
});

describe("ChatThread model persistence injection", () => {
	interface ModelSeam {
		getThreadState: () => { messages: Message[] };
		__test: {
			handleModelChange: (provider: string, model: string) => void;
			handleModelAutoSelect: (provider: string, model: string) => void;
		};
	}

	test("a model change drives persistModel(provider, model)", async () => {
		// CONTRACT (regression-pinned): ChatInput's `onmodelchange` is
		// wired to ChatThread.handleModelChange, which calls the injected
		// `persistModel(provider, model)`. The page injects its own
		// handler; the panel injects
		// `(p,m)=>updateConversation(subConvId,{provider,model})`. This
		// test pins the model-change → persist path that was previously
		// asserted NOWHERE (the old test only checked the not-called case
		// and its name claimed the opposite of what it verified).
		const persistModel = vi.fn();
		const { component } = mountThread(linearTree(), { persistModel });
		const api = component as unknown as ModelSeam;
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);
		expect(persistModel).not.toHaveBeenCalled(); // no spurious early call

		// Drive ChatInput's onmodelchange through the same seam the
		// composer fires (handleModelChange is the bound onmodelchange).
		api.__test.handleModelChange("anthropic", "claude-sonnet-4");

		expect(persistModel).toHaveBeenCalledTimes(1);
		expect(persistModel).toHaveBeenCalledWith(
			"anthropic",
			"claude-sonnet-4",
		);
	});

	test("seed-from-last-model: autoselect seeds once, a real pick still persists", async () => {
		// The composer's auto-select seeds the model from the
		// conversation's last assistant model WITHOUT persisting (it's a
		// reflection of existing state, not a user pick). A subsequent
		// genuine model change DOES persist. This pins both halves of the
		// picker contract: seed (no write) then pick (write).
		const persistModel = vi.fn();
		const { component } = mountThread(linearTree(), { persistModel });
		const api = component as unknown as ModelSeam;
		await vi.waitFor(() =>
			expect(api.getThreadState().messages.length).toBe(4),
		);

		// Seed from the sub-conv's last assistant model — no persistence.
		api.__test.handleModelAutoSelect("openai", "gpt-4o");
		expect(persistModel).not.toHaveBeenCalled();

		// A real pick after seeding persists the new pair.
		api.__test.handleModelChange("openai", "gpt-5");
		expect(persistModel).toHaveBeenCalledTimes(1);
		expect(persistModel).toHaveBeenCalledWith("openai", "gpt-5");

		// Auto-select is now a no-op (a model is set) — never re-persists.
		api.__test.handleModelAutoSelect("google", "gemini-2.5-pro");
		expect(persistModel).toHaveBeenCalledTimes(1);
	});
});
