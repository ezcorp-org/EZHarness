/**
 * Phase 4 (capability-expiry) — single source of the design doc § 3.2
 * verbatim copy contract.
 *
 * Two surfaces render the re-approve modal:
 *   1. The in-chat `PermissionGate.svelte` expired branch (chat-side).
 *   2. The settings-page banner's `ExpiredReapproveModal.svelte`
 *      (settings-side).
 *
 * Before this module each surface inlined its own template literal —
 * a paraphrase drift waiting to happen. Both now read from `expiryCopy()`
 * so the title and body strings live in one place; the component tests
 * for either surface assert against the same constants.
 *
 * Phase 56 (per-capability TTL UI) — the same module now also owns the
 * 7-option `TTL_OPTIONS` picker contract (locked by roadmap success
 * criteria #1) and the `DEFAULT_TTL_FIRST_USE_MS` first-use sticky
 * fallback. Both UI surfaces (settings modal + chat-side gate) import
 * from here so the picker stays in ONE place (Pattern 2 — verbatim-copy
 * contract). A future 8th option needs a single-line edit here.
 *
 * Pure (no Svelte runes, no DOM); safe to import from anywhere.
 */
import { humanizeDuration } from "$lib/utils/relative-time";

export interface ExpiryCopy {
	title: string;
	body: string;
	approveDefault: string;
	approveForever: string;
	cancel: string;
	ageText: string;
	ttlText: string;
}

/**
 * Phase 56: 7-option TTL picker for the re-approve modal + chat-side
 * PermissionGate. Locked by roadmap success criteria #1; verbatim-copy
 * contract — both UI surfaces consume this single export.
 *
 * `value === null` is the "Never" branch (sweep skips, expiresAt=null).
 * Other entries carry a positive `ms` value used both as the option
 * `value` and the humanized button-label input. Codes (`"1h"`, `"30d"`,
 * `"Never"`) are the display text for the <option> element.
 */
export const TTL_OPTIONS = [
	{ value: 1 * 60 * 60 * 1000, code: "1h", ms: 1 * 60 * 60 * 1000 },
	{ value: 6 * 60 * 60 * 1000, code: "6h", ms: 6 * 60 * 60 * 1000 },
	{ value: 1 * 24 * 60 * 60 * 1000, code: "1d", ms: 1 * 24 * 60 * 60 * 1000 },
	{ value: 7 * 24 * 60 * 60 * 1000, code: "7d", ms: 7 * 24 * 60 * 60 * 1000 },
	{ value: 30 * 24 * 60 * 60 * 1000, code: "30d", ms: 30 * 24 * 60 * 60 * 1000 },
	{ value: 90 * 24 * 60 * 60 * 1000, code: "90d", ms: 90 * 24 * 60 * 60 * 1000 },
	{ value: null, code: "Never", ms: null },
] as const satisfies readonly { value: number | null; code: string; ms: number | null }[];

/**
 * Phase 56: first-use sticky fallback (the picker default when no
 * sticky last-pick is on record for this user/kind tuple).
 *
 * Today this is 30 days — neither too eager (1h would force the user to
 * re-prompt within hours of a fresh grant) nor too generous (90 days
 * would leak trust accidentally for users who never tweak the picker).
 * Plan 56-03 will replace this fallback at the call site with a
 * batch-loaded sticky last-pick from the per-user/per-kind KV namespace.
 */
export const DEFAULT_TTL_FIRST_USE_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Return the verbatim § 3.2 copy for a re-approve prompt.
 *
 * Phase 56 widened the last param to accept `number | null`:
 *   • `number` — humanized via `humanizeDuration(newTtlMs)` (e.g.
 *     `"Approve 30 days"`, `"Approve 1 hour"`).
 *   • `null`   — the user picked "Never". `approveDefault` reads
 *     `"Approve forever"` — distinct from the admin-only "Approve
 *     forever (admin only)" button (the parenthetical disambiguates).
 *     The mental model is "this grant has no expiry"; scope-escalation
 *     remains a separate, admin-gated action.
 *
 * @param extensionName  Display name (or id) of the extension whose
 *                       capability expired.
 * @param capability     The expiry-kind string (`"shell"`,
 *                       `"filesystem-write"`, etc).
 * @param ageMs          How long ago the grant expired.
 * @param newTtlMs       Length of the next TTL window if the user
 *                       clicks "Approve $newTtl". `null` → "forever"
 *                       (Phase 56 picker Never branch).
 */
export function expiryCopy(
	extensionName: string,
	capability: string,
	ageMs: number,
	newTtlMs: number | null,
): ExpiryCopy {
	const ageText = humanizeDuration(ageMs);
	const ttlText = newTtlMs === null ? "forever" : humanizeDuration(newTtlMs);
	return {
		title: `Re-approve ${extensionName}: ${capability}`,
		body: `Your permission for ${capability} expired ${ageText} ago. Continue to grant for another ${ttlText}, or cancel.`,
		approveDefault: `Approve ${ttlText}`,
		approveForever: "Approve forever (admin only)",
		cancel: "Cancel",
		ageText,
		ttlText,
	};
}
