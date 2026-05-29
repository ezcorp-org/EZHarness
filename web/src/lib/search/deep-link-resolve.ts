/**
 * Pure deep-link resolution helper (Phase 66 — Sidebar Search, plan 01).
 *
 * Given a target `messageId` (from the `?m=` deep-link param), the full
 * message tree, the current active leaf, and the current render-window size,
 * decide WHAT must change so the target becomes a scrolled-to, pulsing
 * bubble: whether the active branch must switch, and whether the render
 * window must grow. It performs NO DOM or component-state writes — the
 * ChatThread wiring (66-03) applies the returned decision.
 *
 * This encapsulates the Pattern-3 decision math from 66-RESEARCH.md
 * (lines 150-166). The risky tree-walk + window arithmetic lives here so it
 * is deterministically unit-testable; the component only consumes the result.
 *
 * Tree-walk primitives are reused verbatim from load-messages.ts (never
 * reimplemented). `pathToRoot` returns messages in **root → leaf** order, so
 * the rendered tail (most-recent message) is the LAST element and
 * `distanceFromTail = path.length - idx` (the tail has distanceFromTail === 1).
 */
import type { Message } from "$lib/api.js";
import { pathToRoot, findLeafByMessageId } from "$lib/chat/page-handlers/load-messages.js";

export interface DeepLinkResolution {
	/** Whether the target message exists in the loaded tree at all. */
	found: boolean;
	/** Whether the active branch must switch to surface the target. */
	needsBranchSwitch: boolean;
	/** The leaf to activate when a branch switch is needed (else null). */
	newLeafId: string | null;
	/** Whether the render window must grow to include the target. */
	needsWindowGrow: boolean;
	/** The window size to use after applying this resolution. */
	newVisibleCount: number;
}

/**
 * Resolve `targetId` to a render decision. Pure — no DOM, no state writes.
 *
 * Window-grow policy: when the target is paginated out of the (possibly new)
 * branch's render window, grow DIRECTLY to `distanceFromTail` — the minimum
 * window that includes the target. We use a direct grow (rather than stepping
 * via `nextWindowSize`) for determinism: the caller can step incrementally if
 * it prefers, but the contract here is "a window large enough to render the
 * target", which `distanceFromTail` exactly expresses.
 */
export function resolveDeepLink(
	targetId: string,
	allMessages: Message[],
	activeLeafId: string | null,
	visibleMessageCount: number,
): DeepLinkResolution {
	// 1. Silent no-op when the target isn't in the loaded tree (deleted /
	//    wrong conversation).
	if (!allMessages.some((m) => m.id === targetId)) {
		return {
			found: false,
			needsBranchSwitch: false,
			newLeafId: null,
			needsWindowGrow: false,
			newVisibleCount: visibleMessageCount,
		};
	}

	// 2. Compute the active path (root→leaf). Guard a null leaf → [].
	let path = activeLeafId ? pathToRoot(allMessages, activeLeafId) : [];
	let needsBranchSwitch = false;
	let newLeafId: string | null = null;

	if (!path.some((m) => m.id === targetId)) {
		// Target is off the active branch — switch to the branch whose leaf
		// descends from the target, then recompute the path against it.
		needsBranchSwitch = true;
		newLeafId = findLeafByMessageId(allMessages, targetId);
		path = pathToRoot(allMessages, newLeafId);
	}

	// 3. distanceFromTail measures distance from the rendered tail (the
	//    most-recent message). pathToRoot is root→leaf, so the tail is the
	//    LAST element: distanceFromTail = path.length - idx.
	const idx = path.findIndex((m) => m.id === targetId);
	const distanceFromTail = path.length - idx;

	// 4/5. Grow the window only when the target sits outside it.
	if (distanceFromTail > visibleMessageCount) {
		return {
			found: true,
			needsBranchSwitch,
			newLeafId,
			needsWindowGrow: true,
			newVisibleCount: Math.max(visibleMessageCount, distanceFromTail),
		};
	}

	return {
		found: true,
		needsBranchSwitch,
		newLeafId,
		needsWindowGrow: false,
		newVisibleCount: visibleMessageCount,
	};
}
