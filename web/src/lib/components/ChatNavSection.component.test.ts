/**
 * ChatNavSection — DOM tests for the sidebar's collapsible "Chat" section,
 * which replaced the separate 280px conversation column.
 *
 * Covers: default open/closed (open while in Chat, closed elsewhere), a stored
 * choice winning in both directions and being remembered, blocked storage,
 * the RECENT cap + "Show all" (and its absence), date-group labels, the
 * active-thread highlight, unread dots (shown for others, never the open
 * thread), the untitled fallback, every load outcome (in-flight, empty,
 * thrown), a project switch mid-fetch, both refresh events (same project,
 * other project, unscoped, and while collapsed), "+ New chat" (success,
 * failure, double-click guard), and `onnavigate`.
 */
import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { tick } from "svelte";

const api = vi.hoisted(() => ({
	fetchConversations: vi.fn(),
	createConversation: vi.fn(),
}));
const nav = vi.hoisted(() => ({ goto: vi.fn(async () => {}) }));
const stores = vi.hoisted(() => ({ refreshQuickstart: vi.fn(async () => {}) }));

vi.mock("$lib/api.js", () => api);
vi.mock("$app/navigation", () => nav);
// The real event contract (name + dispatch), without the app store's SSE setup.
vi.mock("$lib/stores.svelte.js", () => ({
	CONVERSATIONS_CHANGED: "conversations:changed",
	notifyConversationsChanged: (projectId?: string) =>
		window.dispatchEvent(new CustomEvent("conversations:changed", { detail: { projectId } })),
	refreshQuickstart: stores.refreshQuickstart,
}));

import ChatNavSection from "./ChatNavSection.svelte";

/** The sidebar shows eight threads, then "All chats" — the behaviour under test. */
const CHAT_NAV_RECENT_LIMIT = 8;
import { unreadStore } from "$lib/unread.js";
import type { Conversation } from "$lib/api.js";

const NOW = Date.now();
function conv(id: string, title: string, minutesAgo = 1, extra: Partial<Conversation> = {}): Conversation {
	const at = new Date(NOW - minutesAgo * 60_000).toISOString();
	return {
		id,
		projectId: "global",
		title,
		model: null,
		provider: null,
		systemPrompt: null,
		agentConfigId: null,
		modeId: null,
		test: null,
		createdAt: at,
		updatedAt: at,
		...extra,
	} as Conversation;
}

const BASE = "/project/global/chat";

function mount(props: Partial<{ active: boolean; currentPath: string; projectId: string; onnavigate: () => void }> = {}) {
	return render(ChatNavSection, {
		props: { chatBase: BASE, projectId: "global", currentPath: "/", ...props },
	});
}

beforeEach(() => {
	localStorage.clear();
	unreadStore._reset();
	api.fetchConversations.mockReset();
	api.createConversation.mockReset();
	nav.goto.mockClear();
	stores.refreshQuickstart.mockClear();
	api.fetchConversations.mockResolvedValue([conv("c1", "Is this program able to run local models?"), conv("c2", "hello", 4)]);
});

afterEach(() => vi.restoreAllMocks());

describe("open or closed", () => {
	test("closed outside Chat, and nothing is fetched", async () => {
		const { getByTestId, queryByTestId } = mount({ active: false });
		expect(getByTestId("chat-nav-toggle")).toHaveAttribute("aria-expanded", "false");
		expect(queryByTestId("chat-nav-threads")).toBeNull();
		await tick();
		expect(api.fetchConversations).not.toHaveBeenCalled();
	});

	test("open while in Chat, fetching exactly what it shows", async () => {
		const { getByTestId, findAllByTestId } = mount({ active: true });
		expect(getByTestId("chat-nav-toggle")).toHaveAttribute("aria-expanded", "true");
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(2);
		expect(api.fetchConversations).toHaveBeenCalledWith("global", { limit: CHAT_NAV_RECENT_LIMIT, offset: 0 });
	});

	test("a stored 'closed' wins over being in Chat", async () => {
		localStorage.setItem("ezcorp:chat-nav-expanded", "0");
		const { getByTestId } = mount({ active: true });
		expect(getByTestId("chat-nav-toggle")).toHaveAttribute("aria-expanded", "false");
	});

	test("a stored 'open' wins outside Chat", async () => {
		localStorage.setItem("ezcorp:chat-nav-expanded", "1");
		const { findAllByTestId } = mount({ active: false });
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(2);
	});

	test("toggling remembers the choice, and labels the caret for screen readers", async () => {
		const { getByTestId } = mount({ active: false });
		const toggle = getByTestId("chat-nav-toggle");
		expect(toggle).toHaveAttribute("aria-label", "Expand chat threads");
		await fireEvent.click(toggle);
		expect(toggle).toHaveAttribute("aria-expanded", "true");
		expect(toggle).toHaveAttribute("aria-label", "Collapse chat threads");
		expect(localStorage.getItem("ezcorp:chat-nav-expanded")).toBe("1");
		await fireEvent.click(toggle);
		expect(localStorage.getItem("ezcorp:chat-nav-expanded")).toBe("0");
	});

	test("blocked storage still toggles for the session", async () => {
		vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
			throw new Error("blocked");
		});
		const { getByTestId } = mount({ active: false });
		await fireEvent.click(getByTestId("chat-nav-toggle"));
		expect(getByTestId("chat-nav-toggle")).toHaveAttribute("aria-expanded", "true");
	});
});

describe("what it lists", () => {
	test("caps at the recent limit and links to all chats, bypassing the redirect", async () => {
		api.fetchConversations.mockResolvedValue(
			Array.from({ length: CHAT_NAV_RECENT_LIMIT + 1 }, (_, i) => conv(`c${i}`, `Chat ${i}`, i + 1)),
		);
		const { findAllByTestId, getByTestId } = mount({ active: true });
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(CHAT_NAV_RECENT_LIMIT);
		expect(getByTestId("chat-nav-show-all")).toHaveAttribute("href", `${BASE}?all=1`);
	});

	test("when the cap is spent inside one group, older groups are not shown at all", async () => {
		// Eight today plus one from last week: the "Previous 7 Days" heading
		// must not appear with nothing under it.
		api.fetchConversations.mockResolvedValue([
			...Array.from({ length: CHAT_NAV_RECENT_LIMIT }, (_, i) => conv(`t${i}`, `Today ${i}`, i + 1)),
			conv("old", "Last week", 60 * 24 * 3),
		]);
		const { findAllByTestId } = mount({ active: true });
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(CHAT_NAV_RECENT_LIMIT);
		expect((await findAllByTestId("chat-nav-group")).map((el) => el.textContent?.trim())).toEqual(["Today"]);
	});

	test("a fork shows beneath its parent, marked and indented, and highlights while open", async () => {
		api.fetchConversations.mockResolvedValue([
			conv("parent", "Source Chat", 5),
			conv("fork", "Forked: Source Chat", 1, { forkedFromConversationId: "parent" }),
		]);
		const { findAllByTestId } = mount({ active: true, currentPath: `${BASE}/fork` });
		const rows = await findAllByTestId("chat-nav-thread");
		expect(rows.map((r) => r.getAttribute("data-conversation-id"))).toEqual(["parent", "fork"]);
		expect(rows[0]).not.toHaveAttribute("data-fork");
		expect(rows[1]).toHaveAttribute("data-fork", "true");
		expect(rows[1]).toHaveTextContent("↳");
		expect(rows[1]).toHaveAttribute("aria-current", "page");
	});

	test("forks count against the cap like any other row", async () => {
		const forks = Array.from({ length: CHAT_NAV_RECENT_LIMIT + 2 }, (_, i) =>
			conv(`f${i}`, `Fork ${i}`, i + 1, { forkedFromConversationId: "root" }),
		);
		api.fetchConversations.mockResolvedValue([conv("root", "Root", 1), ...forks]);
		const { findAllByTestId } = mount({ active: true });
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(CHAT_NAV_RECENT_LIMIT);
	});

	test("links to all chats even when everything fits — search, rename and delete live there", async () => {
		// Gating this link on overflow left those unreachable for anyone with a
		// short history, since the Chat label jumps to the last chat instead.
		const { findAllByTestId, getByTestId } = mount({ active: true });
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(2);
		expect(getByTestId("chat-nav-show-all")).toHaveAttribute("href", `${BASE}?all=1`);
		expect(getByTestId("chat-nav-show-all")).toHaveTextContent("All chats");
	});

	test("groups by recency with the full list's labels", async () => {
		api.fetchConversations.mockResolvedValue([conv("a", "today", 1), conv("b", "last week", 60 * 24 * 3)]);
		const { findAllByTestId } = mount({ active: true });
		const labels = (await findAllByTestId("chat-nav-group")).map((el) => el.textContent?.trim());
		expect(labels).toEqual(["Today", "Previous 7 Days"]);
	});

	test("marks the open thread, and links each thread to its page", async () => {
		const { findAllByTestId } = mount({ active: true, currentPath: `${BASE}/c2` });
		const rows = await findAllByTestId("chat-nav-thread");
		expect(rows[0]).toHaveAttribute("href", `${BASE}/c1`);
		expect(rows[0]).not.toHaveAttribute("aria-current");
		expect(rows[1]).toHaveAttribute("aria-current", "page");
	});

	test("shows unread on other threads but never on the open one", async () => {
		unreadStore.markUnread("c1");
		unreadStore.markUnread("c2");
		const { findAllByTestId } = mount({ active: true, currentPath: `${BASE}/c2` });
		await findAllByTestId("chat-nav-thread");
		const dots = await findAllByTestId("chat-nav-unread");
		expect(dots).toHaveLength(1);
		expect(dots[0]!.closest("a")).toHaveAttribute("data-conversation-id", "c1");
	});

	test("an untitled thread reads as a new conversation", async () => {
		api.fetchConversations.mockResolvedValue([conv("u", "   ")]);
		const { findByText } = mount({ active: true });
		expect(await findByText("New conversation")).toBeInTheDocument();
	});
});

describe("loading outcomes", () => {
	test("shows Loading while the first fetch is in flight", async () => {
		let release!: (v: Conversation[]) => void;
		api.fetchConversations.mockReturnValue(new Promise((r) => (release = r)));
		const { findByTestId, findAllByTestId } = mount({ active: true });
		expect(await findByTestId("chat-nav-loading")).toBeInTheDocument();
		release([conv("c1", "one")]);
		expect(await findAllByTestId("chat-nav-thread")).toHaveLength(1);
	});

	test("no threads yet", async () => {
		api.fetchConversations.mockResolvedValue([]);
		const { findByTestId } = mount({ active: true });
		expect(await findByTestId("chat-nav-empty")).toHaveTextContent("No chats yet");
	});

	test("a failed fetch degrades to the empty state instead of breaking the menu", async () => {
		api.fetchConversations.mockRejectedValue(new Error("offline"));
		const { findByTestId, getByTestId } = mount({ active: true });
		expect(await findByTestId("chat-nav-empty")).toBeInTheDocument();
		expect(getByTestId("chat-nav-link")).toHaveAttribute("href", BASE);
	});

	test("a project switch mid-fetch never paints the old project's threads", async () => {
		let releaseOld!: (v: Conversation[]) => void;
		api.fetchConversations
			.mockReturnValueOnce(new Promise((r) => (releaseOld = r)))
			.mockResolvedValueOnce([conv("new", "In the new project")]);
		const view = mount({ active: true, projectId: "p-old" });
		await view.rerender({ chatBase: BASE, projectId: "p-new", currentPath: "/", active: true });
		expect(await view.findByText("In the new project")).toBeInTheDocument();
		releaseOld([conv("old", "From the old project")]);
		await tick();
		expect(view.queryByText("From the old project")).toBeNull();
	});
});

describe("staying current", () => {
	test("reloads on a change to this project, or an unscoped change", async () => {
		const { findAllByTestId } = mount({ active: true });
		await findAllByTestId("chat-nav-thread");
		const before = api.fetchConversations.mock.calls.length;
		window.dispatchEvent(new CustomEvent("conversations:changed", { detail: { projectId: "global" } }));
		window.dispatchEvent(new CustomEvent("conversations:changed", { detail: {} }));
		window.dispatchEvent(new CustomEvent("conversation:created", { detail: { projectId: "global" } }));
		await waitFor(() => expect(api.fetchConversations.mock.calls.length).toBe(before + 3));
	});

	test("ignores another project's changes", async () => {
		const { findAllByTestId } = mount({ active: true });
		await findAllByTestId("chat-nav-thread");
		const before = api.fetchConversations.mock.calls.length;
		window.dispatchEvent(new CustomEvent("conversations:changed", { detail: { projectId: "other" } }));
		await tick();
		expect(api.fetchConversations.mock.calls.length).toBe(before);
	});

	test("while closed it does not fetch, but the next open is fresh", async () => {
		const { getByTestId } = mount({ active: false });
		window.dispatchEvent(new CustomEvent("conversations:changed", { detail: { projectId: "global" } }));
		await tick();
		expect(api.fetchConversations).not.toHaveBeenCalled();
		await fireEvent.click(getByTestId("chat-nav-toggle"));
		await waitFor(() => expect(api.fetchConversations).toHaveBeenCalledTimes(1));
	});
});

describe("+ New chat and navigation", () => {
	test("creates, tells the other lists, then opens it", async () => {
		api.createConversation.mockResolvedValue(conv("fresh", ""));
		const heard = vi.fn();
		window.addEventListener("conversations:changed", heard);
		const onnavigate = vi.fn();
		const { getByTestId } = mount({ active: false, onnavigate });
		await fireEvent.click(getByTestId("chat-nav-new"));
		await waitFor(() => expect(nav.goto).toHaveBeenCalledWith(`${BASE}/fresh`));
		expect(api.createConversation).toHaveBeenCalledWith({ projectId: "global" });
		expect(stores.refreshQuickstart).toHaveBeenCalled();
		expect(heard).toHaveBeenCalled();
		expect(onnavigate).toHaveBeenCalled();
		window.removeEventListener("conversations:changed", heard);
	});

	test("a failed create is logged and the button comes back", async () => {
		api.createConversation.mockRejectedValue(new Error("nope"));
		const logged = vi.spyOn(console, "error").mockImplementation(() => {});
		const { getByTestId } = mount({ active: false });
		await fireEvent.click(getByTestId("chat-nav-new"));
		await waitFor(() => expect(logged).toHaveBeenCalled());
		expect(nav.goto).not.toHaveBeenCalled();
		await waitFor(() => expect(getByTestId("chat-nav-new")).not.toBeDisabled());
	});

	test("a double click creates one chat, not two", async () => {
		let release!: (c: Conversation) => void;
		api.createConversation.mockReturnValue(new Promise((r) => (release = r)));
		const { getByTestId } = mount({ active: false });
		const btn = getByTestId("chat-nav-new");
		await fireEvent.click(btn);
		await fireEvent.click(btn);
		release(conv("once", ""));
		await waitFor(() => expect(nav.goto).toHaveBeenCalledTimes(1));
		expect(api.createConversation).toHaveBeenCalledTimes(1);
	});

	test("thread, label and Show all clicks tell the drawer to close", async () => {
		api.fetchConversations.mockResolvedValue(
			Array.from({ length: CHAT_NAV_RECENT_LIMIT + 1 }, (_, i) => conv(`c${i}`, `Chat ${i}`, i + 1)),
		);
		const onnavigate = vi.fn();
		const { findAllByTestId, getByTestId } = mount({ active: true, onnavigate });
		const rows = await findAllByTestId("chat-nav-thread");
		for (const el of [rows[0]!, getByTestId("chat-nav-link"), getByTestId("chat-nav-show-all")]) {
			el.addEventListener("click", (e) => e.preventDefault(), { once: true });
			await fireEvent.click(el);
		}
		expect(onnavigate).toHaveBeenCalledTimes(3);
	});

	test("without onnavigate (desktop) clicks are harmless", async () => {
		const { findAllByTestId, getByTestId } = mount({ active: true });
		const rows = await findAllByTestId("chat-nav-thread");
		for (const el of [rows[0]!, getByTestId("chat-nav-link")]) {
			el.addEventListener("click", (e) => e.preventDefault(), { once: true });
			await fireEvent.click(el);
		}
		expect(rows[0]).toBeInTheDocument();
	});
});
