/**
 * Pure-logic helpers for chat-window Select Mode.
 *
 * The chat page binds a Svelte-reactive `Set<string>` of selected message ids
 * and surfaces toggle / clear / has operations via these helpers. Extracting
 * them here (rather than inlining in `+page.svelte`) lets `bun test` cover the
 * selection mechanics without needing a Svelte runtime.
 */

export interface SelectionState {
	selectedIds: Set<string>;
}

/** Immutably returns a fresh Set with `id` toggled. Callers reassign the
 *  returned set so Svelte's `$state` sees a new reference and re-renders. */
export function toggleSelection(selectedIds: Set<string>, id: string): Set<string> {
	const next = new Set(selectedIds);
	if (next.has(id)) {
		next.delete(id);
	} else {
		next.add(id);
	}
	return next;
}

export function clearSelection(): Set<string> {
	return new Set<string>();
}

export function isSelected(selectedIds: Set<string>, id: string): boolean {
	return selectedIds.has(id);
}

export function selectionSize(selectedIds: Set<string>): number {
	return selectedIds.size;
}

/** Order-preserving export of selected ids in the supplied reference order.
 *  The chat page feeds the ordered message list so the resulting array
 *  matches the displayed chronology — server-side order is still enforced
 *  by `cloneTurnsIntoNewConversation`, but surfacing them correctly here
 *  keeps the client send payload predictable for tests. */
export function orderedSelection(selectedIds: Set<string>, orderedIds: string[]): string[] {
	return orderedIds.filter((id) => selectedIds.has(id));
}

/** Apply a range action between `anchorId` and `targetId` (inclusive) in
 *  `orderedIds`. Used by shift+click range selection in the chat window.
 *  Returns a fresh Set so Svelte's `$state` re-renders.
 *
 *  - Direction-agnostic: anchor before or after target both work.
 *  - Returns the input unchanged if either id isn't in `orderedIds` (e.g. the
 *    anchor was a streaming placeholder that has since been swapped).
 *  - `skipPredicate` lets callers exclude specific ids from the range
 *    (e.g. `streaming-*` placeholders that aren't real persisted messages).
 *  - `toggle: true` makes the action target-state aware:
 *      • target NOT selected → ADD the full anchor..target range (additive).
 *      • target IS selected  → REMOVE only the target id (single deselect).
 *    This matches user intuition: shift+click an unselected row to extend
 *    the range, shift+click an already-selected row to drop just that one
 *    without disturbing anything else above or below it. With `toggle: false`
 *    (default) the range is always additive.
 */
export function selectRange(
	current: Set<string>,
	orderedIds: string[],
	anchorId: string,
	targetId: string,
	opts?: { skipPredicate?: (id: string) => boolean; toggle?: boolean },
): Set<string> {
	const anchorIdx = orderedIds.indexOf(anchorId);
	const targetIdx = orderedIds.indexOf(targetId);
	if (anchorIdx === -1 || targetIdx === -1) return current;
	// Toggle off: target is already selected → remove just the target id.
	// Don't touch anything else, so users can pick a single row out of an
	// existing range without destroying the rest of the selection.
	if (opts?.toggle === true && current.has(targetId)) {
		const next = new Set(current);
		next.delete(targetId);
		return next;
	}
	const [start, end] = anchorIdx <= targetIdx ? [anchorIdx, targetIdx] : [targetIdx, anchorIdx];
	const next = new Set(current);
	const skip = opts?.skipPredicate;
	for (let i = start; i <= end; i++) {
		const id = orderedIds[i]!;
		if (skip && skip(id)) continue;
		next.add(id);
	}
	return next;
}
