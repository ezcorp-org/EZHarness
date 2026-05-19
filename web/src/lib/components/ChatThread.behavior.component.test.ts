/**
 * PHASE 0 — Behaviour-pinning regression suite for the CURRENT main chat
 * thread (no src changes).
 *
 * This file freezes the page's thread contract — branch-nav, regenerate,
 * retry, edit-text, streaming render, select-mode, extension-turn refresh,
 * URL sync — exercised through the EXACT factories/helpers the page wires
 * (`makeSendMessage`, `findLeafByMessageId`, `computeLatestLeaf`,
 * `handleExtensionTurnSaved`, `useSelectMode`) plus the runId-keyed
 * streaming store.
 *
 * The DRY proof: after Phase 4 swaps `+page.svelte`'s inlined thread for
 * `<ChatThread variant="page">`, THIS FILE MUST STILL PASS UNCHANGED.
 * That is why it is named `ChatThread.behavior.*` and pinned against the
 * shared factories rather than a private page copy — the harness can be
 * re-pointed at the real `<ChatThread>` with a one-line import change and
 * zero assertion churn (plan risk-register row #1).
 *
 * vitest + jsdom + @testing-library/svelte (component test).
 */

import { render, fireEvent } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";
import type { Message } from "$lib/api.js";

// ── Module stubs (load-time imports of the SUT graph) ────────────────
//
// `send-message.ts` pulls in api / oauth / commands / sub-conv-store /
// mention-logic / fetch-policy. `useSelectMode` pulls `$app/navigation`.
// None of the paths exercised here hit those, but the imports run at
// module load so they need stubs.

const { sendMessageMock } = vi.hoisted(() => ({
	sendMessageMock: vi.fn(
		async (
			_convId: string,
			data: { content: string; editOf?: string; parentMessageId?: string },
		) => ({
			userMessage: {
				id: `srv-${data.editOf ?? data.parentMessageId ?? "u"}-${Math.random()
					.toString(36)
					.slice(2, 7)}`,
				conversationId: "conv-1",
				role: "user",
				content: data.content,
				createdAt: new Date().toISOString(),
				parentMessageId: data.parentMessageId ?? null,
				excluded: false,
			},
			runId: "run-regen-1",
			attachments: [] as unknown[],
		}),
	),
}));

vi.mock("$lib/api.js", () => ({
	sendMessage: sendMessageMock,
	updateConversation: vi.fn(async () => ({ id: "conv-1" })),
	createSubConversation: vi.fn(async () => ({ id: "sub-1", agentConfigId: "" })),
	cloneTurns: vi.fn(async () => ({ id: "x" })),
	setMessageExcluded: vi.fn(async () => undefined),
	fetchAllMessages: vi.fn(async () => []),
	patchMessageContent: vi.fn(async () => ({ content: "" })),
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
		startSubConversation: vi.fn(),
		endSubConversation: vi.fn(() => []),
		addMessage: vi.fn(),
		setStreaming: vi.fn(),
	},
}));

// ChatInput (mounted by the real <ChatThread>) needs the real mention
// segment parser; send-message's parseMentions is also real.
vi.mock("$lib/mention-logic.js", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("$lib/mention-logic.js")>();
	return { ...actual };
});

// Phase-4 re-point: the harness now mounts the REAL <ChatThread>, which
// loads its tree via backgroundFetch. A hoisted box (written by the
// harness from its `initialMessages` prop via the global below) feeds
// the fixture tree to the load. Wiring-only — no assertion changed.
const { seedBox } = vi.hoisted(() => ({
	seedBox: {
		tree: [] as unknown[],
		onInvalidate: undefined as ((k: string) => void) | undefined,
		onLoadMessages: undefined as (() => void) | undefined,
		onHydrate: undefined as (() => void) | undefined,
	},
}));
(
	globalThis as unknown as {
		__chatThreadSeed: (
			t: unknown[],
			spies?: {
				onInvalidate?: (k: string) => void;
				onLoadMessages?: () => void;
				onHydrate?: () => void;
			},
		) => void;
	}
).__chatThreadSeed = (t, spies) => {
	seedBox.tree = t;
	seedBox.onInvalidate = spies?.onInvalidate;
	seedBox.onLoadMessages = spies?.onLoadMessages;
	seedBox.onHydrate = spies?.onHydrate;
};
vi.mock("$lib/utils/fetch-policy.js", () => ({
	userFetch: vi.fn(async () => ({ ok: true, json: async () => ({}) })),
	backgroundFetch: vi.fn(async (_k: string, url: string) => {
		if (url.includes("messages?all=true")) {
			seedBox.onLoadMessages?.();
			return { ok: true, json: async () => seedBox.tree };
		}
		if (url.includes("withToolCalls=true")) {
			seedBox.onHydrate?.();
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
	invalidate: vi.fn((k: string) => {
		seedBox.onInvalidate?.(k);
	}),
}));

vi.mock("$app/navigation", () => ({ goto: vi.fn() }));
vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1", convId: "conv-1" },
		url: new URL("http://localhost/"),
	},
}));

import Harness from "./ChatThreadBehaviorHarness.svelte";

// ── Fixtures ─────────────────────────────────────────────────────────

function msg(id: string, overrides: Partial<Message> = {}): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: `content-${id}`,
		createdAt: `2026-01-01T00:00:0${id.length}.000Z`,
		parentMessageId: null,
		excluded: false,
		...overrides,
	} as Message;
}

/**
 * Linear conversation: u1 → a1 → u2 → a2 (leaf a2).
 */
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
 * Branched tree: u1 has TWO assistant children (a1, a1b — siblings).
 * a1b is newer, so the default leaf walk lands on a1b's branch.
 */
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

beforeEach(() => {
	sendMessageMock.mockClear();
	seedBox.tree = [];
	seedBox.onInvalidate = undefined;
	seedBox.onLoadMessages = undefined;
	seedBox.onHydrate = undefined;
	// jsdom ships neither observer; the real <ChatThread> uses both.
	type AnyCtor = { new (...a: unknown[]): unknown };
	const g = globalThis as unknown as {
		IntersectionObserver?: AnyCtor;
		ResizeObserver?: AnyCtor;
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
});

// ── 1. Branch navigation ─────────────────────────────────────────────

describe("PIN: branch navigation (siblings + ‹ › nav)", () => {
	test("renders the latest sibling branch by default", () => {
		const { getByTestId, queryByTestId } = render(Harness, {
			initialMessages: branchedTree(),
			initialLeafId: "a1b",
		});
		expect(getByTestId("content-a1b")).toHaveTextContent("branch-B");
		expect(queryByTestId("content-a1")).toBeNull();
	});

	test("branch-nav indicator shows position out of sibling count", () => {
		const { getByTestId } = render(Harness, {
			initialMessages: branchedTree(),
			initialLeafId: "a1b",
		});
		// a1b is the 2nd of 2 siblings under u1.
		expect(getByTestId("branch-nav-a1b")).toHaveTextContent("2/2");
	});

	test("‹ navigates to the previous sibling branch", async () => {
		const { getByTestId, queryByTestId } = render(Harness, {
			initialMessages: branchedTree(),
			initialLeafId: "a1b",
		});
		await fireEvent.click(getByTestId("prev-a1b"));
		expect(getByTestId("content-a1")).toHaveTextContent("branch-A");
		expect(queryByTestId("content-a1b")).toBeNull();
	});

	test("› navigates back to the next sibling branch", async () => {
		const { getByTestId } = render(Harness, {
			initialMessages: branchedTree(),
			initialLeafId: "a1",
		});
		expect(getByTestId("content-a1")).toBeInTheDocument();
		await fireEvent.click(getByTestId("next-a1"));
		expect(getByTestId("content-a1b")).toHaveTextContent("branch-B");
	});

	test("no branch-nav UI for messages with a single child", () => {
		const { queryByTestId } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
		});
		expect(queryByTestId("branch-nav-u1")).toBeNull();
		expect(queryByTestId("branch-nav-a2")).toBeNull();
	});
});

// ── 2. Path walk (the page's `messages` $derived) ────────────────────

describe("PIN: activeLeafId→root path walk", () => {
	test("linear tree renders the full root→leaf path in order", () => {
		const { getByTestId } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
		});
		expect(getByTestId("path-count")).toHaveTextContent("4");
		for (const id of ["u1", "a1", "u2", "a2"]) {
			expect(getByTestId(`msg-${id}`)).toBeInTheDocument();
		}
	});

	test("empty path when activeLeafId is null", () => {
		const { getByTestId } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: null,
		});
		expect(getByTestId("path-count")).toHaveTextContent("0");
	});

	test("cyclic parent ref does not infinite-loop the walk", () => {
		const cyclic = [
			msg("x", { parentMessageId: "y" }),
			msg("y", { parentMessageId: "x" }),
		];
		const { getByTestId } = render(Harness, {
			initialMessages: cyclic,
			initialLeafId: "x",
		});
		// visited-set guard caps the walk at the two nodes.
		expect(getByTestId("path-count")).toHaveTextContent("2");
	});
});

// ── 3. Regenerate (forks a sibling via makeSendMessage) ──────────────

describe("PIN: regenerate forks a sibling assistant turn", () => {
	test("handleRegenerate POSTs editOf=<assistant id> and adds the new branch", async () => {
		const tree = linearTree();
		const { getByTestId, component } = render(Harness, {
			initialMessages: tree,
			initialLeafId: "a2",
		});

		await (component as unknown as {
			doRegenerate: (m: Message) => Promise<void>;
		}).doRegenerate(tree[3]!); // a2

		expect(sendMessageMock).toHaveBeenCalledTimes(1);
		const [, data] = sendMessageMock.mock.calls[0]!;
		// regenerate re-sends the PRECEDING user message content, editOf = a2.
		expect(data.editOf).toBe("a2");
		expect(data.content).toBe(tree[2]!.content); // u2's content
		// New sibling user msg + streaming assistant placeholder added.
		expect(getByTestId("path-count")).not.toHaveTextContent("4");
	});
});

// ── 4. Retry (drops failed turn, re-sends preceding user msg) ────────

describe("PIN: retry re-sends the preceding user message", () => {
	test("handleRetry removes the target turn then POSTs the prior user content", async () => {
		const tree = linearTree();
		const { component } = render(Harness, {
			initialMessages: tree,
			initialLeafId: "a2",
		});

		await (component as unknown as {
			doRetry: (m: Message) => Promise<void>;
		}).doRetry(tree[3]!); // a2 (the "failed" assistant)

		expect(sendMessageMock).toHaveBeenCalled();
		const [, data] = sendMessageMock.mock.calls[0]!;
		// retry path goes through handleSend (no editOf) with u2's content.
		expect(data.content).toBe(tree[2]!.content);
		expect(data.editOf).toBeUndefined();
	});
});

// ── 5. Streaming render (runId-keyed store mirror) ───────────────────

describe("PIN: streaming render via runId-keyed store", () => {
	test("tokens appended to streamingMessages[runId] surface in the thread", async () => {
		const { getByTestId, component } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
		});
		expect(getByTestId("streaming-text")).toHaveTextContent("");

		(component as unknown as {
			startRunStream: (id: string) => void;
		}).startRunStream("run-xyz");

		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-xyz": "Hello ",
		};
		await Promise.resolve();
		expect(getByTestId("streaming-text")).toHaveTextContent("Hello");

		store.streamingMessages = {
			...store.streamingMessages,
			"run-xyz": "Hello world",
		};
		await Promise.resolve();
		expect(getByTestId("streaming-text")).toHaveTextContent("Hello world");
	});

	test("a different run's tokens do NOT leak into this thread", async () => {
		const { getByTestId, component } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
		});
		(component as unknown as {
			startRunStream: (id: string) => void;
		}).startRunStream("run-mine");

		const { store } = await import("$lib/stores.svelte.js");
		store.streamingMessages = {
			...store.streamingMessages,
			"run-other": "not for me",
		};
		await Promise.resolve();
		expect(getByTestId("streaming-text")).not.toHaveTextContent(
			"not for me",
		);
	});
});

// ── 6. Select-mode toggle reactivity ─────────────────────────────────

describe("PIN: select-mode (useSelectMode wrapper)", () => {
	test("toggling select-mode then clicking a row bumps the count", async () => {
		const { getByTestId } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
		});
		expect(getByTestId("select-count")).toHaveTextContent("0");

		await fireEvent.click(getByTestId("toggle-select"));
		await fireEvent.click(getByTestId("rowsel-u1"));

		expect(getByTestId("select-count")).toHaveTextContent("1");
		expect(getByTestId("rowsel-u1")).toHaveAttribute(
			"aria-checked",
			"true",
		);
	});
});

// ── 7. Extension-turn refresh (cooldown-bust) ────────────────────────

describe("PIN: extension-turn refresh busts cooldowns + reloads", () => {
	test("unknown extension messageId triggers invalidate + loadMessages + hydrate", () => {
		const onLoadMessages = vi.fn();
		const onInvalidate = vi.fn();
		const onHydrate = vi.fn();
		const { component } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
			onLoadMessages,
			onInvalidate,
			onHydrate,
		});

		const dispatched = (component as unknown as {
			fireExtensionTurn: (id: string) => boolean;
		}).fireExtensionTurn("ext-new-msg");

		expect(dispatched).toBe(true);
		expect(onInvalidate).toHaveBeenCalledWith("messages-all:conv-1");
		expect(onInvalidate).toHaveBeenCalledWith("messages-tools:conv-1");
		expect(onLoadMessages).toHaveBeenCalled();
		expect(onHydrate).toHaveBeenCalled();
	});

	test("already-known messageId is a no-op (dedupe)", () => {
		const onLoadMessages = vi.fn();
		const { component } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: "a2",
			onLoadMessages,
		});
		const dispatched = (component as unknown as {
			fireExtensionTurn: (id: string) => boolean;
		}).fireExtensionTurn("u1"); // already in the tree
		expect(dispatched).toBe(false);
		expect(onLoadMessages).not.toHaveBeenCalled();
	});
});

// ── 8. URL sync (activeLeafId → ?leaf= echo) ─────────────────────────

describe("PIN: URL sync echoes the active leaf", () => {
	test("?leaf= echo tracks the active leaf and updates on branch nav", async () => {
		const { getByTestId } = render(Harness, {
			initialMessages: branchedTree(),
			initialLeafId: "a1b",
		});
		expect(getByTestId("leaf-query")).toHaveTextContent("?leaf=a1b");

		await fireEvent.click(getByTestId("prev-a1b"));
		expect(getByTestId("leaf-query")).toHaveTextContent("?leaf=a1");
	});

	test("null leaf yields an empty query echo", () => {
		const { getByTestId } = render(Harness, {
			initialMessages: linearTree(),
			initialLeafId: null,
		});
		expect(getByTestId("leaf-query")).toHaveTextContent("");
	});
});
