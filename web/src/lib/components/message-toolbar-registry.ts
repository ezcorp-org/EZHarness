/**
 * Source of truth for every callback prop on `MessageToolbar.svelte`.
 *
 * Two surfaces consume `MessageToolbar`:
 *   1. `ChatMessage.svelte` — hover variant, anchored to a single row.
 *      Every prop here MUST be wired through.
 *   2. `SelectModeActionBar.svelte` — `inline` variant, shown when the
 *      user is in shift+click/long-press multi-select mode. Only props
 *      with `bulkSupported: true` should be wired through; the rest are
 *      single-row-only by design (e.g. `onedit` opens a modal targeting
 *      one message — no bulk meaning).
 *
 * `MessageToolbar.parity.test.ts` reads this registry and asserts:
 *   • Every `on*` prop declared in `MessageToolbar.svelte` has a registry
 *     entry (no orphans).
 *   • Every registry entry is referenced in `ChatMessage.svelte`.
 *   • Every `bulkSupported: true` entry is referenced in
 *     `SelectModeActionBar.svelte`.
 *
 * When adding a new toolbar button: declare it here first, then the test
 * will tell you which surfaces still need wiring.
 */
export interface ToolbarPropMeta {
	/** Exact prop name as declared on `MessageToolbar.svelte`. */
	readonly prop: string;
	/** Which message role the button is gated to inside the toolbar. */
	readonly role: "user" | "assistant" | "both";
	/**
	 * Whether the button must also be wired through
	 * `SelectModeActionBar.svelte` (bulk-select mode).
	 *
	 *  - `true`  → surface in both hover and inline variants.
	 *  - `false` → single-row-only; bulk semantics are absent or
	 *              ambiguous. Document `bulkSkipReason` so reviewers
	 *              don't reopen the question.
	 */
	readonly bulkSupported: boolean;
	/** When `bulkSupported` is `false`, the reason it's intentionally
	 *  excluded from bulk. Surfaces in failure messages from the parity
	 *  test if the rule ever changes. */
	readonly bulkSkipReason?: string;
	/**
	 * `true` when the prop is a fire-and-forget observer (e.g. an
	 * `oncopy` notification fired AFTER the toolbar runs its own copy
	 * logic) rather than a button-gating callback. Observer props are
	 * always optional — surfaces that don't care about the event simply
	 * omit them, and the parity test won't flag missing wiring.
	 * Defaults to `false`.
	 */
	readonly observerOnly?: boolean;
}

export const MESSAGE_TOOLBAR_PROPS: readonly ToolbarPropMeta[] = [
	{
		prop: "oncopy",
		role: "both",
		bulkSupported: true,
		// Observer — the toolbar runs its own clipboard write; the
		// callback is just a "copy happened" notification. ChatMessage
		// doesn't pass it because it doesn't need the signal; the bulk
		// bar wires it to set `bulkStatus: "Copied N turns"`.
		observerOnly: true,
	},
	{
		prop: "onedit",
		role: "user",
		bulkSupported: false,
		bulkSkipReason:
			"Edit opens a modal targeting one specific user message — no bulk equivalent.",
	},
	{ prop: "onrerun", role: "user", bulkSupported: true },
	{
		prop: "onregenerate",
		role: "assistant",
		bulkSupported: false,
		bulkSkipReason:
			"Selection is mixed-role; bulk regenerate would fan out N parallel branches the user can't see at once.",
	},
	{
		prop: "onbranch",
		role: "both",
		bulkSupported: false,
		bulkSkipReason:
			"Fork Chat (the dedicated bulk button) already covers the multi-row branch use case.",
	},
	{
		prop: "onretry",
		role: "both",
		bulkSupported: false,
		bulkSkipReason:
			"Only rendered on the failed-message error state — no bulk equivalent.",
	},
	{ prop: "onsavememory", role: "both", bulkSupported: true },
	{
		prop: "onremovememory",
		role: "both",
		bulkSupported: false,
		bulkSkipReason:
			"Companion to onsavememory; surfaces only when a single row is already saved. Bulk save creates one combined memory, so the inverse is single-row.",
	},
	{
		prop: "onedittext",
		role: "assistant",
		bulkSupported: false,
		bulkSkipReason:
			"Content-only edit of one assistant turn (no regen). Single-row by design.",
	},
	{ prop: "onexclude", role: "both", bulkSupported: true },
];

/** Quick lookup helper used by the parity test. */
export function getToolbarProp(name: string): ToolbarPropMeta | undefined {
	return MESSAGE_TOOLBAR_PROPS.find((p) => p.prop === name);
}
