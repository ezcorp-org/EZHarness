/**
 * Unit tests for the pure deep-link resolution helper (Phase 66 plan 01,
 * Task 1). `resolveDeepLink` encapsulates the Pattern-3 decision math from
 * 66-RESEARCH.md (lines 150-166) WITHOUT touching component state — it only
 * describes WHAT must change (branch switch / window grow) so the ChatThread
 * wiring in 66-03 can apply it.
 *
 * Tree-walk primitives (`pathToRoot`, `findLeafByMessageId`) come from
 * load-messages.ts and are NOT reimplemented here. `pathToRoot` returns
 * root→leaf order, so `distanceFromTail = path.length - idx` (the most-recent
 * / tail message has distanceFromTail === 1).
 */
// Runs under vitest (`.unit.test.ts`), NOT `bun test`: resolveDeepLink imports
// the tree-walk helpers from load-messages.ts, which transitively imports the
// Svelte-rune module `inline-tool-store.svelte.ts` (`$state`). bun can't compile
// runes; vitest (vite-plugin-svelte) can. The `.unit.test.ts` suffix is the
// project's documented runner for pure-utility tests under src/lib.
import { test, expect, describe } from "vitest";
import type { Message } from "$lib/api.js";
import { resolveDeepLink } from "$lib/search/deep-link-resolve.js";

/** Minimal Message factory for an in-memory tree fixture. */
function msg(id: string, parentMessageId: string | null, createdAt: string): Message {
	return {
		id,
		conversationId: "conv-1",
		role: "user",
		content: id,
		thinkingContent: null,
		model: null,
		provider: null,
		usage: null,
		runId: null,
		parentMessageId,
		excluded: false,
		createdAt,
	} as Message;
}

/**
 * Build a tree with a fork:
 *   r → a → b → c   (main branch; leaf "c")
 *           └→ d → e (fork off "b"; leaf "e")
 * Timestamps make "c" the latest child of "b" so the active path defaults to
 * r→a→b→c; "d"/"e" are the non-active fork.
 */
function makeTree(): Message[] {
	return [
		msg("r", null, "2026-01-01T00:00:00.000Z"),
		msg("a", "r", "2026-01-01T00:00:01.000Z"),
		msg("b", "a", "2026-01-01T00:00:02.000Z"),
		// children of b: c (later) is on the active branch, d (earlier) is the fork
		msg("d", "b", "2026-01-01T00:00:03.000Z"),
		msg("e", "d", "2026-01-01T00:00:04.000Z"),
		msg("c", "b", "2026-01-01T00:00:05.000Z"),
	];
}

describe("resolveDeepLink", () => {
	test("Test 1: target not present → { found: false }, no changes", () => {
		const tree = makeTree();
		const res = resolveDeepLink("nope", tree, "c", 15);
		expect(res).toEqual({
			found: false,
			needsBranchSwitch: false,
			newLeafId: null,
			needsWindowGrow: false,
			newVisibleCount: 15,
		});
	});

	test("Test 2: target on active path, within window → no branch switch, no grow", () => {
		const tree = makeTree();
		// active path r→a→b→c (length 4); target "a" distanceFromTail = 4 - 1 = 3 <= 15
		const res = resolveDeepLink("a", tree, "c", 15);
		expect(res).toEqual({
			found: true,
			needsBranchSwitch: false,
			newLeafId: null,
			needsWindowGrow: false,
			newVisibleCount: 15,
		});
	});

	test("Test 3: target on active path but paginated out of window → grow", () => {
		const tree = makeTree();
		// active path r→a→b→c (length 4). target "r" distanceFromTail = 4 - 0 = 4.
		// With visibleMessageCount = 2, 4 > 2 → grow to cover distance.
		const res = resolveDeepLink("r", tree, "c", 2);
		expect(res.found).toBe(true);
		expect(res.needsBranchSwitch).toBe(false);
		expect(res.newLeafId).toBeNull();
		expect(res.needsWindowGrow).toBe(true);
		expect(res.newVisibleCount).toBeGreaterThanOrEqual(4);
	});

	test("Test 4: target on a NON-active fork branch → branch switch + recompute window against new branch", () => {
		const tree = makeTree();
		// active leaf "c" → path r→a→b→c (does NOT contain "e").
		// "e" is on the fork r→a→b→d→e (leaf "e"), length 5.
		// distanceFromTail of "e" on the NEW path = 5 - 4 = 1 → within window, no grow.
		const res = resolveDeepLink("e", tree, "c", 15);
		expect(res.found).toBe(true);
		expect(res.needsBranchSwitch).toBe(true);
		expect(res.newLeafId).toBe("e"); // findLeafByMessageId walks forward from "e" → "e" (leaf)
		expect(res.needsWindowGrow).toBe(false);
		expect(res.newVisibleCount).toBe(15);
	});

	test("Test 4b: off-branch target that is paginated out of the NEW branch → branch switch + grow", () => {
		const tree = makeTree();
		// target "d" on fork; switching to its leaf "e" → path r→a→b→d→e (length 5).
		// "d" distanceFromTail = 5 - 3 = 2. With small window 1, 2 > 1 → grow.
		const res = resolveDeepLink("d", tree, "c", 1);
		expect(res.found).toBe(true);
		expect(res.needsBranchSwitch).toBe(true);
		expect(res.newLeafId).toBe("e");
		expect(res.needsWindowGrow).toBe(true);
		expect(res.newVisibleCount).toBeGreaterThanOrEqual(2);
	});

	test("Test 5: target is the most-recent message (distanceFromTail === 1) → within window, no grow", () => {
		const tree = makeTree();
		// active leaf "c" is the tail of r→a→b→c → distanceFromTail = 1.
		const res = resolveDeepLink("c", tree, "c", 15);
		expect(res).toEqual({
			found: true,
			needsBranchSwitch: false,
			newLeafId: null,
			needsWindowGrow: false,
			newVisibleCount: 15,
		});
	});

	test("null active leaf with present target → branch switch to target's leaf", () => {
		const tree = makeTree();
		// activeLeafId null → active path is []; any present target is "off-branch".
		const res = resolveDeepLink("c", tree, null, 15);
		expect(res.found).toBe(true);
		expect(res.needsBranchSwitch).toBe(true);
		expect(res.newLeafId).toBe("c");
		expect(res.needsWindowGrow).toBe(false);
		expect(res.newVisibleCount).toBe(15);
	});
});
