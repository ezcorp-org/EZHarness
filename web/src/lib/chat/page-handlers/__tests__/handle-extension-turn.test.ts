/**
 * Regression test for the chat page's extension-runId branch in
 * `handleTurnSaved`. The bug being guarded against:
 *
 *   1. The chat page mounts, calls `loadMessages()`, which goes through
 *      `backgroundFetch("messages-all:<convId>", ..., { minIntervalMs: 5000 })`.
 *   2. Within 5s the user clicks a messageToolbar icon that fires an
 *      extension subprocess. The subprocess calls `ezcorp/append-message`
 *      and the WS push surfaces an `ez:turn_saved` event with
 *      `runId = "ext:<...>"`.
 *   3. The naïve handler called `loadMessages()` again — but the throttle
 *      key was still cooling down, so `backgroundFetch` returned null and
 *      the new extension turn never made it into `allMessages`. The chat
 *      UI silently stayed stale.
 *
 * The fix: invalidate both `messages-all:` and `messages-tools:` cooldowns
 * before re-running `loadMessages`, then also call `hydrateToolCallsFromApi`
 * so any new `running` tool-call rows reach `inlineToolStore` (otherwise
 * cards like KokoroTtsPlayerCard never mount).
 *
 * This mirrors the existing `handleAgentComplete` pattern in the same
 * +page.svelte file.
 */

import { test, expect, describe, beforeEach, mock } from "bun:test";
import { handleExtensionTurnSaved } from "../handle-extension-turn.ts";

function makeDeps() {
	return {
		invalidateFetchPolicy: mock((_key: string) => {}),
		loadMessages: mock(() => Promise.resolve()),
		hydrateToolCallsFromApi: mock(() => Promise.resolve()),
	};
}

describe("handleExtensionTurnSaved", () => {
	let deps: ReturnType<typeof makeDeps>;

	beforeEach(() => {
		deps = makeDeps();
	});

	test("invalidates cooldowns and refreshes when message is unknown", () => {
		const refreshed = handleExtensionTurnSaved(deps, {
			convId: "c-123",
			messageId: "m-new",
			knownMessageIds: new Set<string>(["m-existing"]),
		});

		expect(refreshed).toBe(true);

		// Both throttle keys must be busted — and exactly with these names.
		// If a future refactor changes the keys, this test pins the
		// contract with `fetch-policy.ts` + `load-messages.ts`.
		expect(deps.invalidateFetchPolicy.mock.calls).toEqual([
			["messages-all:c-123"],
			["messages-tools:c-123"],
		]);

		// Both reload paths must run.
		expect(deps.loadMessages).toHaveBeenCalledTimes(1);
		expect(deps.hydrateToolCallsFromApi).toHaveBeenCalledTimes(1);
	});

	test("invalidates BEFORE calling loadMessages (otherwise the throttle still wins)", () => {
		const order: string[] = [];
		const trackedDeps = {
			invalidateFetchPolicy: mock((key: string) => {
				order.push(`invalidate:${key}`);
			}),
			loadMessages: mock(() => {
				order.push("loadMessages");
				return Promise.resolve();
			}),
			hydrateToolCallsFromApi: mock(() => {
				order.push("hydrateToolCallsFromApi");
				return Promise.resolve();
			}),
		};

		handleExtensionTurnSaved(trackedDeps, {
			convId: "c-1",
			messageId: "m-x",
			knownMessageIds: new Set<string>(),
		});

		expect(order.indexOf("invalidate:messages-all:c-1"))
			.toBeLessThan(order.indexOf("loadMessages"));
		expect(order.indexOf("invalidate:messages-tools:c-1"))
			.toBeLessThan(order.indexOf("loadMessages"));
	});

	test("dedupes when the message is already known (no refresh)", () => {
		const refreshed = handleExtensionTurnSaved(deps, {
			convId: "c-123",
			messageId: "m-existing",
			knownMessageIds: new Set<string>(["m-existing"]),
		});

		expect(refreshed).toBe(false);
		expect(deps.invalidateFetchPolicy).not.toHaveBeenCalled();
		expect(deps.loadMessages).not.toHaveBeenCalled();
		expect(deps.hydrateToolCallsFromApi).not.toHaveBeenCalled();
	});

	test("accepts any object exposing has() — not just Set", () => {
		const knownMessageIds = {
			has: (id: string) => id === "m-known",
		};

		// Unknown id → refresh
		expect(
			handleExtensionTurnSaved(deps, {
				convId: "c-2",
				messageId: "m-other",
				knownMessageIds,
			}),
		).toBe(true);

		// Known id → no-op
		const deps2 = makeDeps();
		expect(
			handleExtensionTurnSaved(deps2, {
				convId: "c-2",
				messageId: "m-known",
				knownMessageIds,
			}),
		).toBe(false);
		expect(deps2.loadMessages).not.toHaveBeenCalled();
	});

	test("uses the convId from input, not a global", () => {
		handleExtensionTurnSaved(deps, {
			convId: "alpha",
			messageId: "m-new",
			knownMessageIds: new Set<string>(),
		});

		const keys = deps.invalidateFetchPolicy.mock.calls.map((c) => c[0]);
		expect(keys).toContain("messages-all:alpha");
		expect(keys).toContain("messages-tools:alpha");
		expect(keys.every((k) => k.endsWith(":alpha"))).toBe(true);
	});
});
