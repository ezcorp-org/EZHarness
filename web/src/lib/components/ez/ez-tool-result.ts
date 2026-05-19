/**
 * Shared render-prop contract for `EzToolResultCard.svelte`.
 *
 * Extracted to a `.ts` module (single source of truth) so non-Svelte
 * consumers — e.g. `tool-cards/ez-install-card-logic.ts`, which maps an
 * `install_draft` tool result into this shape — can `import type` it
 * without going through the ambient `*.svelte` module declaration
 * (which only surfaces a default export under the web tsconfig).
 */
export interface EzProposeResult {
	draftId?: string;
	openUrl: string;
	title?: string;
	summary?: string;
	/**
	 * D1: optional override for the action's visible label. Defaults to
	 * the tool-name-derived text (propose_* → "Open prefilled form").
	 * The agent install card sets this to "Open extension". Kept on the
	 * result (not a separate prop) so a single host-shaped tool-result
	 * object fully drives the card.
	 */
	openUrlLabel?: string;
}
