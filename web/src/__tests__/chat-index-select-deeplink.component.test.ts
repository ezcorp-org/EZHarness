/**
 * Regression test for the chat-index page deep-link forwarding (UI-03 /
 * PAL-07).
 *
 * `/project/[id]/chat/+page.svelte` (the empty chat-index / mobile landing
 * view) passes `handleSelect` as `onselect` to `<ConversationList>`. The
 * list's `onselect` emits `(id, messageId?)` — the optional `messageId`
 * carries a sidebar message-search deep-link. A prior bug dropped that
 * second arg, so clicking a message-search hit from the index navigated
 * WITHOUT `?m=<messageId>` and the thread never scrolled/pulsed to the
 * target. This pins that `handleSelect` forwards `messageId` into the URL,
 * matching the `[convId]` sibling route exactly.
 *
 * `ConversationList` is replaced with a stub exposing the same `onselect`
 * contract via two buttons (plain select + deep-link select). `matchMedia`
 * is forced to mobile so `onMount` short-circuits to the list view without
 * an auto-redirect.
 */

import "@testing-library/jest-dom/vitest";
import { render, fireEvent, waitFor } from "@testing-library/svelte";
import { describe, test, expect, vi, beforeEach } from "vitest";

const { gotoMock } = vi.hoisted(() => ({ gotoMock: vi.fn() }));

vi.mock("$app/state", () => ({
	page: {
		params: { id: "proj-1" },
		url: new URL("http://localhost/project/proj-1/chat"),
	},
}));
vi.mock("$app/navigation", () => ({ goto: gotoMock }));
vi.mock("$lib/api.js", () => ({
	createConversation: vi.fn(async () => ({ id: "new" })),
	fetchConversations: vi.fn(async () => []),
	fetchConversation: vi.fn(async () => null),
}));
vi.mock("$lib/components/ConversationList.svelte", async () => {
	const stub = await import("./fixtures/ConversationListStub.svelte");
	return { default: stub.default };
});
vi.mock("$lib/components/EmptyState.svelte", async () => {
	const stub = await import("./stubs/empty-component.js");
	return { default: stub.default };
});
vi.mock("$lib/components/chat/NoProviderBanner.svelte", async () => {
	const stub = await import("./stubs/empty-component.js");
	return { default: stub.default };
});
vi.mock("$lib/components/ProjectRail.svelte", async () => {
	const stub = await import("./stubs/empty-component.js");
	return { default: stub.default };
});

import ChatIndexPage from "../routes/(app)/project/[id]/chat/+page.svelte";

beforeEach(() => {
	gotoMock.mockReset();
	// Force the mobile branch so onMount renders the list (checked=true)
	// instead of auto-redirecting to a conversation.
	(window as unknown as { matchMedia: unknown }).matchMedia = vi.fn(() => ({
		matches: true,
		media: "",
		onchange: null,
		addEventListener: () => {},
		removeEventListener: () => {},
		addListener: () => {},
		removeListener: () => {},
		dispatchEvent: () => false,
	})) as unknown as typeof window.matchMedia;
});

describe("chat-index handleSelect — deep-link forwarding", () => {
	test("forwards messageId into the URL as ?m=", async () => {
		const { findAllByTestId } = render(ChatIndexPage);
		const buttons = await findAllByTestId("stub-select-deeplink");
		await fireEvent.click(buttons[0]!);
		await waitFor(() => expect(gotoMock).toHaveBeenCalledTimes(1));
		expect(gotoMock).toHaveBeenCalledWith(
			"/project/proj-1/chat/conv-9?m=msg-42",
		);
	});

	test("plain select (no messageId) navigates without ?m=", async () => {
		const { findAllByTestId } = render(ChatIndexPage);
		const buttons = await findAllByTestId("stub-select-plain");
		await fireEvent.click(buttons[0]!);
		await waitFor(() => expect(gotoMock).toHaveBeenCalledTimes(1));
		expect(gotoMock).toHaveBeenCalledWith("/project/proj-1/chat/conv-9");
	});
});
