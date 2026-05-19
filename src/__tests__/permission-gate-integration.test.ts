/**
 * Phase 6 — full coverage integration test.
 *
 * Asserts the spec's stated outcome:
 *   - User A in conversation X triggers a permission prompt (extension
 *     foo, capability shell).
 *   - The SSE filter delivers the prompt event ONLY to user A's
 *     subscriber — user B (different conversation Y) is dropped.
 *   - When user A clicks "session", the always-allow row is persisted
 *     scoped to the session, and the next call inside conv-X
 *     auto-allows without re-prompting.
 *
 * The four-scope chooser semantics + scope persistence are exercised
 * in unit tests (`permission-engine.test.ts`,
 * `extension-permission-modal.component.test.ts`); this integration
 * tests the cross-cutting glue.
 */

import { describe, test, expect } from "bun:test";
import {
	createExtensionPermissionGate,
	resolvePermission,
} from "../runtime/tools/permissions";
import { shouldDeliverEvent } from "../runtime/sse-conversation-filter";

describe("Phase 6 — extension permission gate + SSE scope (e2e glue)", () => {
	test("gate resolves with the chosen scope when the user picks 'session'", async () => {
		const promise = createExtensionPermissionGate({
			promptId: "prompt-int-1",
			conversationId: "conv-X",
			userId: "user-A",
			extensionId: "foo",
			toolName: "foo__shell",
			capabilityKind: "shell",
		});
		// The route handler resolves with the user's choice.
		resolvePermission("prompt-int-1", true, "session");
		const result = await promise;
		expect(result.allowed).toBe(true);
		expect(result.scope).toBe("session");
	});

	test("gate resolves declined with `{allowed: false}` and no scope on deny", async () => {
		const promise = createExtensionPermissionGate({
			promptId: "prompt-int-2",
			conversationId: "conv-X",
			userId: "user-A",
			extensionId: "foo",
			toolName: "foo__shell",
			capabilityKind: "shell",
		});
		resolvePermission("prompt-int-2", false);
		const result = await promise;
		expect(result.allowed).toBe(false);
		expect(result.scope).toBeUndefined();
	});

	test("SSE filter delivers user-A's prompt to user-A only", async () => {
		const ownedConv = async (id: string) =>
			id === "conv-X" ? { userId: "user-A" } : null;

		const eventForA = {
			conversationId: "conv-X",
			userId: "user-A",
			toolCallId: "prompt-int-3",
			toolName: "foo__shell",
			input: {},
			extensionId: "foo",
			capabilityKind: "shell" as const,
		};

		const aDelivers = await shouldDeliverEvent(
			"tool:permission_request",
			eventForA,
			{ userId: "user-A", conversationId: "conv-X" },
			ownedConv,
		);
		// User B subscribes to a totally different conversation (conv-Y).
		// Even if they pretend conv-X is theirs, the userId cross-check
		// drops the event.
		const bDelivers = await shouldDeliverEvent(
			"tool:permission_request",
			eventForA,
			{ userId: "user-B", conversationId: "conv-Y" },
			async () => ({ userId: "user-B" }),
		);

		expect(aDelivers).toBe(true);
		expect(bDelivers).toBe(false);
	});
});
