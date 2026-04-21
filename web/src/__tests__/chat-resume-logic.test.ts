/**
 * Unit tests for chat resume localStorage key logic.
 *
 * Tests the key format and resolution logic used by:
 * - /project/[id]/chat/+page.svelte (reads key to redirect)
 * - /project/[id]/chat/[convId]/+page.svelte (writes key on open)
 */
import { test, expect, describe } from "bun:test";

// The key format used in the chat pages
function getLastChatKey(projectId: string): string {
	return `ezcorp-last-chat:${projectId}`;
}

// The redirect resolution logic from +page.svelte
type Conv = { id: string; projectId: string };
function resolveRedirectTarget(
	lastConvId: string | null,
	conversations: Conv[],
	projectId: string,
	fetchConversation: (id: string) => Conv | null,
): string | null {
	// 1. Try last-opened chat
	if (lastConvId) {
		const conv = fetchConversation(lastConvId);
		if (conv && conv.projectId === projectId) {
			return lastConvId;
		}
	}
	// 2. Fall back to most recent
	if (conversations.length > 0) {
		return conversations[0].id;
	}
	// 3. No conversations
	return null;
}

describe("chat resume key format", () => {
	test("key is project-scoped", () => {
		expect(getLastChatKey("proj-1")).toBe("ezcorp-last-chat:proj-1");
		expect(getLastChatKey("proj-2")).toBe("ezcorp-last-chat:proj-2");
	});

	test("different projects produce different keys", () => {
		expect(getLastChatKey("a")).not.toBe(getLastChatKey("b"));
	});
});

describe("chat resume redirect resolution", () => {
	const conversations: Conv[] = [
		{ id: "conv-recent", projectId: "proj-1" },
		{ id: "conv-older", projectId: "proj-1" },
	];

	const fetchConv = (id: string) => {
		const all: Conv[] = [
			...conversations,
			{ id: "conv-other-project", projectId: "proj-2" },
		];
		return all.find(c => c.id === id) ?? null;
	};

	test("returns last-opened chat when valid and same project", () => {
		const result = resolveRedirectTarget("conv-older", conversations, "proj-1", fetchConv);
		expect(result).toBe("conv-older");
	});

	test("returns most recent when last-opened is deleted", () => {
		const result = resolveRedirectTarget("conv-deleted", conversations, "proj-1", fetchConv);
		expect(result).toBe("conv-recent");
	});

	test("returns most recent when last-opened belongs to different project", () => {
		const result = resolveRedirectTarget("conv-other-project", conversations, "proj-1", fetchConv);
		expect(result).toBe("conv-recent");
	});

	test("returns most recent when no localStorage entry", () => {
		const result = resolveRedirectTarget(null, conversations, "proj-1", fetchConv);
		expect(result).toBe("conv-recent");
	});

	test("returns null when no conversations exist", () => {
		const result = resolveRedirectTarget(null, [], "proj-1", fetchConv);
		expect(result).toBeNull();
	});

	test("returns null when last-opened is invalid and no conversations", () => {
		const result = resolveRedirectTarget("conv-gone", [], "proj-1", fetchConv);
		expect(result).toBeNull();
	});

	test("last-opened takes priority over most recent", () => {
		// conv-older is not the first in the list, but it was last opened
		const result = resolveRedirectTarget("conv-older", conversations, "proj-1", fetchConv);
		expect(result).toBe("conv-older");
		// Not conv-recent (which is first/most recent)
		expect(result).not.toBe("conv-recent");
	});
});
