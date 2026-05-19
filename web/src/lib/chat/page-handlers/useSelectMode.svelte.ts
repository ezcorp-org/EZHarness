/**
 * Select-mode rune-host extracted from
 * `routes/(app)/project/[id]/chat/[convId]/+page.svelte` (W6 of the chat-page
 * split).
 *
 * Owns all of the per-conversation "select / fork / bulk-op" reactive state:
 *   - `selectMode`            — whether the action bar is visible at all.
 *   - `selectedIds`           — `SvelteSet` of selected message ids. A plain
 *                               `$state(new Set())` is NOT reactive on
 *                               mutation — Svelte 5 only proxies plain
 *                               objects/arrays, not built-in `Set`/`Map`
 *                               instances. Use `SvelteSet` so `.add`,
 *                               `.delete`, `.has`, `.size`, and iteration
 *                               all flow through the reactive container.
 *   - `selectCloning`         — true while `cloneTurns` is in flight.
 *   - `bulkBusy`              — true while a fan-out bulk op is in flight.
 *   - `bulkStatus`            — transient confirmation text shown in the
 *                               action bar after a successful op.
 *   - `selectError`           — error text for failed bulk ops.
 *
 * Plus three derived values (`selectedCount`, `allSelectedExcluded`,
 * `bulkCopyContent`) and the corresponding handlers.
 *
 * `lastSelectionAnchor` is owned internally — the page never read it
 * directly, so it lives only in this module.
 *
 * The escape-key listener is also owned here: it's a `$effect` that reads
 * `selectMode` / `selectCloning` / `bulkBusy`, all of which live in this
 * module. Hosting it in the page would force it to read across module
 * boundaries via accessors and is unnecessary.
 *
 * ## Why two layers
 *
 * The handler bodies are exported as plain factory functions in the
 * `selectModeCore` block below. They operate on a plain `SelectModeState`
 * object (no runes) so `bun test` can drive them with no Svelte runtime
 * present. `useSelectMode()` is a thin rune-wrapper that creates the
 * `$state`/`$derived`/`$effect` slots and binds them to the same core
 * functions. This mirrors the `panel-persistence.svelte.ts` split (plain
 * `restorePanelsForConv` / `resolvePendingAgent` / `persistPanelSnapshot`
 * underneath the rune-using `attachPanelPersistence`).
 */

import { goto } from "$app/navigation";
import { SvelteSet } from "svelte/reactivity";
import {
	cloneTurns,
	setMessageExcluded,
	type Message,
} from "$lib/api.js";
import { orderedSelection, selectRange } from "$lib/select-mode.js";
import { formatMessageForCopy } from "$lib/message-copy.js";
import { userFetch } from "$lib/utils/fetch-policy.js";
import type { ToolCallState } from "$lib/stores.svelte.js";

export interface SavedMemoriesSlot {
	get(): Map<string, string>;
	set(v: Map<string, string>): void;
}

export interface AllMessagesSlot {
	get(): Message[];
	set(v: Message[]): void;
}

export interface SelectModeHost {
	convId(): string;
	projectId(): string;
	/**
	 * Full message tree for the active conversation. Read by ordering /
	 * exclusion-check helpers; mutated by `handleBulkExclude` to mirror
	 * the optimistic-flip pattern from the page's per-message
	 * `handleToggleExclude`.
	 */
	allMessages: AllMessagesSlot;
	/** Currently-rendered (windowed) messages. Used as the anchor lookup
	 *  for shift+click range selection — anchor & target indices come from
	 *  THIS list, matching the original page logic exactly. Read-only —
	 *  the page wires this from `computeVisibleMessages`'s `readonly T[]`
	 *  return type, so the interface must accept the wider shape. */
	visibleMessages(): readonly Message[];
	/** Messageid → memoryId map. Mutated in place via the slot setter
	 *  when bulk-save creates a new memory entry that covers the selected
	 *  rows. */
	savedMemories: SavedMemoriesSlot;
	/** Read by the action-bar render gate (hides destructive bulk ops
	 *  while a stream is active). */
	isStreaming(): boolean;
	/** Read by `bulkCopyContent` so assistant turns include their tool
	 *  calls in the copied text. Mirrors the page-level helper of the
	 *  same name. */
	getHistoricalToolCalls(messageId: string): ToolCallState[];
	/** Sidebar component handle. Optional so tests don't need to stub it.
	 *  `handleForkSelection` calls `.refresh()` after a successful clone so
	 *  the new fork (and the parent's chevron) appear in the sidebar
	 *  immediately — without it the user lands on a chat that isn't in any
	 *  visible list until a manual reload. Same shape as the convList slot
	 *  in `send-message.ts`. */
	convList?(): { refresh?: () => void } | null | undefined;
}

/** Plain mutable state shape — backed by `$state` slots in the rune
 *  wrapper, but plain fields here so the core handlers can be unit-tested
 *  without standing up a Svelte runtime. */
export interface SelectModeState {
	selectMode: boolean;
	selectedIds: Set<string>;
	selectCloning: boolean;
	bulkBusy: boolean;
	bulkStatus: string | null;
	selectError: string | null;
	/** Anchor for shift+click range select. Owned by the module — the
	 *  page never read this directly. */
	lastSelectionAnchor: string | null;
}

/** Create a fresh state with all slots at their initial values. */
export function createSelectModeState(): SelectModeState {
	return {
		selectMode: false,
		selectedIds: new Set(),
		selectCloning: false,
		bulkBusy: false,
		bulkStatus: null,
		selectError: null,
		lastSelectionAnchor: null,
	};
}

// ── Plain core handlers (testable without rune scope) ────────────────────

/** Toggle select-mode on/off. Clears selection + transient status when
 *  exiting. Idempotent in the sense that consecutive calls flip back. */
export function toggleSelectMode(state: SelectModeState): void {
	state.selectMode = !state.selectMode;
	if (!state.selectMode) {
		state.selectedIds.clear();
		state.lastSelectionAnchor = null;
		state.selectError = null;
		state.bulkStatus = null;
	}
}

/** Imperative reset called on conversation switch. Mirrors the cleanup
 *  half of `toggleSelectMode` plus the `selectMode = false` flip. */
export function resetForConvSwitch(state: SelectModeState): void {
	state.selectMode = false;
	state.selectedIds.clear();
	state.lastSelectionAnchor = null;
	state.bulkStatus = null;
	state.selectError = null;
}

/** Escape-key handler. Pure — no DOM coupling beyond `event.preventDefault`.
 *  Returns true if the keypress was consumed (so callers wiring this up
 *  in tests can assert behavior). */
export function handleEscapeKey(
	state: SelectModeState,
	event: KeyboardEvent,
): boolean {
	if (event.key !== "Escape") return false;
	// Disabled while a bulk op is in flight — matches the Cancel
	// button's `disabled` state, so users can't dismiss the action bar
	// mid-fan-out.
	if (state.selectCloning || state.bulkBusy) return false;
	event.preventDefault();
	toggleSelectMode(state);
	return true;
}

/** Plain toggle / shift+click range / shift+click outside select mode.
 *  Mirrors the original page logic exactly. */
export function toggleSelectedMessage(
	state: SelectModeState,
	host: Pick<SelectModeHost, "visibleMessages">,
	id: string,
	event?: MouseEvent | KeyboardEvent,
): void {
	const isShift = event && "shiftKey" in event && event.shiftKey;
	// Auto-enter select mode on shift+click outside select mode — the
	// row becomes the anchor and the action bar opens. Lets the user
	// start a multi-select without first clicking the toolbar's Select
	// button.
	if (isShift && !state.selectMode) {
		state.selectMode = true;
		state.selectedIds.clear();
		state.selectedIds.add(id);
		state.lastSelectionAnchor = id;
		if (typeof window !== "undefined") {
			window.getSelection()?.removeAllRanges();
		}
		return;
	}
	// Shift+click in select mode → toggle the range from anchor to this
	// row. If the target is already selected, the range is REMOVED (lets
	// users back out of an over-shot range with another shift+click).
	// Otherwise the range is added. First-ever click (no anchor yet)
	// falls through to a plain toggle below.
	if (isShift && state.lastSelectionAnchor) {
		const orderedIds = host.visibleMessages().map((m) => m.id);
		const next = selectRange(
			state.selectedIds,
			orderedIds,
			state.lastSelectionAnchor,
			id,
			{
				skipPredicate: (mid) => mid.startsWith("streaming-"),
				toggle: true,
			},
		);
		// `selectRange` returns a fresh Set; copy into our state Set in
		// place so identity is preserved (the rune wrapper relies on
		// this — the proxied Set must keep its identity for template
		// reactivity).
		syncSet(state.selectedIds, next);
		if (typeof window !== "undefined") {
			window.getSelection()?.removeAllRanges();
		}
		return;
	}
	// Plain toggle.
	if (state.selectedIds.has(id)) {
		state.selectedIds.delete(id);
	} else {
		state.selectedIds.add(id);
	}
	state.lastSelectionAnchor = id;
}

export async function handleForkSelection(
	state: SelectModeState,
	host: Pick<SelectModeHost, "convId" | "projectId" | "allMessages" | "convList">,
): Promise<void> {
	if (state.selectedIds.size === 0 || state.selectCloning) return;
	const orderedIds = orderedSelection(
		state.selectedIds,
		host.allMessages.get().map((m) => m.id),
	);
	state.selectCloning = true;
	state.selectError = null;
	try {
		const newConv = await cloneTurns(host.convId(), {
			messageIds: orderedIds,
		});
		state.selectedIds.clear();
		state.lastSelectionAnchor = null;
		state.selectMode = false;
		// Refetch the sidebar BEFORE navigating so the new fork (and the
		// chevron on its source) are present by the time the new chat page
		// renders. Without this, the user lands on a chat that doesn't exist
		// in any visible list until they manually reload.
		host.convList?.()?.refresh?.();
		goto(`/project/${host.projectId()}/chat/${newConv.id}`);
	} catch (err) {
		state.selectError =
			err instanceof Error
				? err.message
				: "Failed to fork selected turns";
		console.error("Failed to fork turns:", err);
	} finally {
		state.selectCloning = false;
	}
}

/** Returns true when at least one message is selected AND every selected
 *  message is currently `excluded`. Drives the bulk-toggle button label
 *  ("Include in context" vs "Exclude from context"). */
export function computeAllSelectedExcluded(
	state: Pick<SelectModeState, "selectedIds">,
	allMessages: Message[],
): boolean {
	if (state.selectedIds.size === 0) return false;
	for (const id of state.selectedIds) {
		const msg = allMessages.find((m) => m.id === id);
		if (!msg || !msg.excluded) return false;
	}
	return true;
}

/** Concatenated copy content for the bulk toolbar — fed into
 *  MessageToolbar's `content` prop. Each turn includes its tool calls
 *  (if any), separated by `---`. */
export function computeBulkCopyContent(
	state: Pick<SelectModeState, "selectedIds">,
	allMessages: Message[],
	getHistoricalToolCalls: (messageId: string) => ToolCallState[],
): string {
	const orderedIds = orderedSelection(
		state.selectedIds,
		allMessages.map((m) => m.id),
	);
	return orderedIds
		.map((id) => {
			const msg = allMessages.find((m) => m.id === id);
			if (!msg) return "";
			const tcs =
				msg.role === "assistant"
					? getHistoricalToolCalls(msg.id)
					: undefined;
			return formatMessageForCopy(msg.content, tcs);
		})
		.filter(Boolean)
		.join("\n\n---\n\n");
}

export function handleBulkCopied(state: SelectModeState): void {
	// MessageToolbar's internal copy already wrote to the clipboard;
	// this callback just surfaces the status confirmation in the action
	// bar.
	const n = state.selectedIds.size;
	state.bulkStatus = `Copied ${n} ${n === 1 ? "turn" : "turns"}`;
}

export async function handleBulkSaveMemory(
	state: SelectModeState,
	host: Pick<SelectModeHost, "allMessages" | "savedMemories">,
): Promise<void> {
	if (state.selectedIds.size === 0 || state.bulkBusy) return;
	const all = host.allMessages.get();
	const ids = orderedSelection(
		state.selectedIds,
		all.map((m) => m.id),
	);
	const targets = ids
		.map((id) => all.find((m) => m.id === id))
		.filter((m): m is Message => !!m);
	if (targets.length === 0) return;
	// Combine every selected turn into a single memory entry — just the
	// raw message text, in render order, joined by blank lines. No role
	// labels or `---` separators (memory should read as continuous
	// text).
	const combined = targets
		.map((m) => m.content.trim())
		.filter(Boolean)
		.join("\n\n");
	state.bulkBusy = true;
	state.bulkStatus = null;
	state.selectError = null;
	try {
		const res = await userFetch("/api/memories", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				content: combined,
				category: "preferences",
				confidence: "medium",
			}),
		});
		if (res.status !== 201)
			throw new Error(
				`POST /api/memories returned ${res.status}`,
			);
		const memory = (await res.json()) as { id: string };
		// Mark every selected message as saved-as-memory pointing at the
		// same memory id, so the per-message indicator reflects bulk
		// save.
		const next = new Map(host.savedMemories.get());
		for (const m of targets) next.set(m.id, memory.id);
		host.savedMemories.set(next);
		state.bulkStatus = `Saved ${targets.length} ${
			targets.length === 1 ? "turn" : "turns"
		} to memory`;
	} catch (err) {
		state.selectError =
			err instanceof Error
				? err.message
				: "Failed to save to memory";
	} finally {
		state.bulkBusy = false;
	}
}

export async function handleBulkExclude(
	state: SelectModeState,
	host: Pick<SelectModeHost, "convId" | "allMessages">,
): Promise<void> {
	if (state.selectedIds.size === 0 || state.bulkBusy) return;
	// If all already excluded → re-include; else exclude.
	const target = !computeAllSelectedExcluded(state, host.allMessages.get());
	const ids = Array.from(state.selectedIds);
	state.bulkBusy = true;
	state.selectError = null;
	state.bulkStatus = null;
	try {
		await Promise.all(
			ids.map((id) => setMessageExcluded(host.convId(), id, target)),
		);
		// Reconcile local state — mirrors the optimistic flip in
		// `handleToggleExclude`.
		const idSet = new Set(ids);
		const all = host.allMessages.get();
		host.allMessages.set(
			all.map((m) =>
				idSet.has(m.id) ? { ...m, excluded: target } : m,
			),
		);
		// Keep select mode open so the user sees the status
		// confirmation. They can run another bulk op, or click Cancel
		// to return to the composer.
		state.selectedIds.clear();
		state.lastSelectionAnchor = null;
		state.bulkStatus = `${target ? "Excluded" : "Included"} ${
			ids.length
		} ${ids.length === 1 ? "turn" : "turns"}`;
	} catch (err) {
		state.selectError =
			err instanceof Error
				? err.message
				: "Failed to update selection";
		console.error("Bulk exclude failed:", err);
	} finally {
		state.bulkBusy = false;
	}
}

/**
 * Replace the contents of `target` with the contents of `source` in place,
 * preserving target's identity. Used to fold the result of `selectRange`
 * (which returns a fresh Set) back into the proxied `$state` Set without
 * losing reactivity.
 */
function syncSet<T>(target: Set<T>, source: Set<T>): void {
	for (const v of Array.from(target)) {
		if (!source.has(v)) target.delete(v);
	}
	for (const v of source) {
		if (!target.has(v)) target.add(v);
	}
}

// ── Rune wrapper ─────────────────────────────────────────────────────────

export interface UseSelectModeReturn {
	state: {
		selectMode: boolean;
		selectedIds: Set<string>;
		selectCloning: boolean;
		bulkBusy: boolean;
		bulkStatus: string | null;
		selectError: string | null;
	};
	derived: {
		readonly selectedCount: number;
		readonly allSelectedExcluded: boolean;
		readonly bulkCopyContent: string;
	};
	toggleSelectMode: () => void;
	toggleSelectedMessage: (
		id: string,
		event?: MouseEvent | KeyboardEvent,
	) => void;
	handleForkSelection: () => Promise<void>;
	handleBulkCopied: () => void;
	handleBulkSaveMemory: () => Promise<void>;
	handleBulkExclude: () => Promise<void>;
	/** Imperative reset — called by the page's `onConvSwitch` hook so
	 *  selection-mode state never carries across conversation switches.
	 *  Kept on the returned object instead of being baked into a
	 *  `$effect` here because the page-level `attachPanelPersistence`
	 *  already owns the convId-change choreography (selection clear is
	 *  one step in that sequence). */
	resetForConvSwitch: () => void;
}

export function useSelectMode(host: SelectModeHost): UseSelectModeReturn {
	// Owned reactive state. Each slot below is a `$state`; together they
	// reproduce `SelectModeState` shape. The rune-tracked individual
	// slots are what makes `selectMode.state.*` reactive in the calling
	// component's template.
	let selectMode = $state(false);
	// `SvelteSet` from `svelte/reactivity`, NOT `$state(new Set())`.
	// Svelte 5 doesn't proxy built-in `Set`/`Map` instances — `.add` /
	// `.delete` / `.has` mutations on a plain Set wouldn't trigger
	// re-renders. SvelteSet is the supported reactive replacement.
	const selectedIds = new SvelteSet<string>();
	let selectCloning = $state(false);
	let bulkBusy = $state(false);
	let bulkStatus = $state<string | null>(null);
	let selectError = $state<string | null>(null);
	// `lastSelectionAnchor` is owned by the module but doesn't drive any
	// UI directly, so it's a plain closure variable rather than a
	// `$state`.
	let lastSelectionAnchor: string | null = null;

	/** Build a per-call `SelectModeState` view onto the rune-tracked
	 *  slots. Each handler reads the latest values via these
	 *  property accessors, so writes flow back through the runes. */
	function viewState(): SelectModeState {
		return {
			get selectMode() { return selectMode; },
			set selectMode(v) { selectMode = v; },
			// `selectedIds` is exposed as a single read of the SvelteSet —
			// callers mutate `.add`/`.delete`/`.clear` on the SAME instance
			// (NOT replacing it), preserving subscriber identity.
			get selectedIds() { return selectedIds; },
			set selectedIds(_v) {
				// Forbidden — would break the SvelteSet identity. Throw so
				// regressions surface immediately rather than silently
				// killing template reactivity.
				throw new Error(
					"useSelectMode: selectedIds must be mutated in place; replacing the SvelteSet instance breaks template reactivity",
				);
			},
			get selectCloning() { return selectCloning; },
			set selectCloning(v) { selectCloning = v; },
			get bulkBusy() { return bulkBusy; },
			set bulkBusy(v) { bulkBusy = v; },
			get bulkStatus() { return bulkStatus; },
			set bulkStatus(v) { bulkStatus = v; },
			get selectError() { return selectError; },
			set selectError(v) { selectError = v; },
			get lastSelectionAnchor() { return lastSelectionAnchor; },
			set lastSelectionAnchor(v) { lastSelectionAnchor = v; },
		};
	}

	// Escape exits select mode. Listener only attaches WHILE select
	// mode is active so we never swallow Escape in other contexts
	// (composer, modals, etc.).
	$effect(() => {
		if (!selectMode) return;
		function onKeydown(e: KeyboardEvent) {
			handleEscapeKey(viewState(), e);
		}
		window.addEventListener("keydown", onKeydown);
		return () => window.removeEventListener("keydown", onKeydown);
	});

	const selectedCount = $derived(selectedIds.size);

	const allSelectedExcluded = $derived.by(() =>
		computeAllSelectedExcluded(
			{ selectedIds },
			host.allMessages.get(),
		),
	);

	const bulkCopyContent = $derived.by(() =>
		computeBulkCopyContent(
			{ selectedIds },
			host.allMessages.get(),
			(id) => host.getHistoricalToolCalls(id),
		),
	);

	// `state` and `derived` use property accessors so the `$state` /
	// `$derived` slots above stay live across the module boundary. The
	// caller can still freely read `state.selectMode`,
	// `state.selectedIds`, etc., and Svelte will track the read.
	const state = {
		get selectMode() { return selectMode; },
		set selectMode(v: boolean) { selectMode = v; },
		// `selectedIds` is exposed without a setter — the spec requires
		// in-place mutation only. Re-assigning the slot would lose the
		// SvelteSet identity and break reactivity in the template.
		get selectedIds() { return selectedIds; },
		get selectCloning() { return selectCloning; },
		set selectCloning(v: boolean) { selectCloning = v; },
		get bulkBusy() { return bulkBusy; },
		set bulkBusy(v: boolean) { bulkBusy = v; },
		get bulkStatus() { return bulkStatus; },
		set bulkStatus(v: string | null) { bulkStatus = v; },
		get selectError() { return selectError; },
		set selectError(v: string | null) { selectError = v; },
	};

	const derived = {
		get selectedCount() { return selectedCount; },
		get allSelectedExcluded() { return allSelectedExcluded; },
		get bulkCopyContent() { return bulkCopyContent; },
	};

	return {
		state,
		derived,
		toggleSelectMode: () => toggleSelectMode(viewState()),
		toggleSelectedMessage: (id, event) =>
			toggleSelectedMessage(viewState(), host, id, event),
		handleForkSelection: () => handleForkSelection(viewState(), host),
		handleBulkCopied: () => handleBulkCopied(viewState()),
		handleBulkSaveMemory: () => handleBulkSaveMemory(viewState(), host),
		handleBulkExclude: () => handleBulkExclude(viewState(), host),
		resetForConvSwitch: () => resetForConvSwitch(viewState()),
	};
}
