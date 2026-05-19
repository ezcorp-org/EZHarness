/**
 * Phase 6 (H7) — server-side SSE filter scoping for `tool:permission_request`.
 *
 * Pre-Phase-6: events fan out to every SSE subscriber for the matching
 * conversation, so admins/teamshares/multi-tab users see other users'
 * permission prompts including args. PII / secret material can leak.
 *
 * Phase 6 closes the gap: when the event payload carries a top-level
 * `userId`, `shouldDeliverEvent` delivers ONLY to the matching
 * subscriber. Legacy emits without `userId` (built-in tool gates) keep
 * pre-Phase-6 conversation-scoped behavior — those gates are origin-
 * scoped by `toolCallId`, so cross-user delivery there is harmless.
 */

import { describe, test, expect, beforeEach } from "bun:test";
import {
	shouldDeliverEvent,
	__clearMembershipCacheForTests,
} from "../runtime/sse-conversation-filter";

beforeEach(() => {
	__clearMembershipCacheForTests();
});

const ownedConv = async (id: string) =>
	id === "conv-A" ? { userId: "user-A" } : id === "conv-B" ? { userId: "user-B" } : null;

describe("tool:permission_request event scoping (H7)", () => {
	test("originating user receives the scoped event", async () => {
		const deliver = await shouldDeliverEvent(
			"tool:permission_request",
			{ conversationId: "conv-A", userId: "user-A", toolCallId: "tc-1", toolName: "x", input: {} },
			{ userId: "user-A", conversationId: "conv-A" },
			ownedConv,
		);
		expect(deliver).toBe(true);
	});

	test("different user on the same conversation does NOT receive the event", async () => {
		// Even if user-B were authorized for conv-A (admin/teamshare),
		// the userId-cross-check in shouldDeliverEvent must still drop
		// the event because it's user-A's prompt.
		const deliver = await shouldDeliverEvent(
			"tool:permission_request",
			{ conversationId: "conv-A", userId: "user-A", toolCallId: "tc-1", toolName: "x", input: {} },
			{ userId: "user-B", conversationId: "conv-A" },
			// Pretend user-B IS authorized for conv-A — the filter
			// SHOULD still drop the event.
			async (id: string) => (id === "conv-A" ? { userId: "user-B" } : null),
		);
		expect(deliver).toBe(false);
	});

	test("event for a conversation the subscribing user does NOT own is dropped", async () => {
		// user-B subscribes; the event names conv-A whose owner is
		// user-A. The userId cross-check fires first (event userId =
		// user-A; subscriber = user-B → drop). Even without that check,
		// the conversation-membership lookup would reject because user-B
		// doesn't own conv-A.
		const deliver = await shouldDeliverEvent(
			"tool:permission_request",
			{ conversationId: "conv-A", userId: "user-A", toolCallId: "tc-1", toolName: "x", input: {} },
			{ userId: "user-B", conversationId: "conv-A" },
			ownedConv,
		);
		expect(deliver).toBe(false);
	});

	test("legacy emit without userId falls back to conversation-scoped delivery", async () => {
		// Built-in tool gates (read/write/execute on built-in tools)
		// don't populate userId. The filter must keep the prior
		// behavior so existing modals stay live.
		const deliver = await shouldDeliverEvent(
			"tool:permission_request",
			{ conversationId: "conv-A", toolCallId: "tc-1", toolName: "x", input: {} },
			{ userId: "user-A", conversationId: "conv-A" },
			ownedConv,
		);
		expect(deliver).toBe(true);
	});

	test("non-conversation event types pass through unchanged", async () => {
		// Sanity: the new userId scoping ONLY applies to
		// tool:permission_request. Other direct-carrier events use the
		// existing conversation-scope path.
		const deliver = await shouldDeliverEvent(
			"tool:start",
			{ conversationId: "conv-A", userId: "user-B", toolName: "x", input: {} },
			{ userId: "user-A", conversationId: "conv-A" },
			ownedConv,
		);
		// user-A owns conv-A, so tool:start delivers (no userId
		// cross-check on tool:start).
		expect(deliver).toBe(true);
	});
});
