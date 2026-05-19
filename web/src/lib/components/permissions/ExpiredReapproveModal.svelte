<script lang="ts">
	/**
	 * Phase 4 (capability-expiry) — settings-side re-approve prompt
	 * component.
	 *
	 * The modal renders on the settings-page surface (banner row →
	 * inline modal). The in-chat surface (`PermissionGate.svelte`'s
	 * expired branch) renders the SAME design doc § 3.2 copy by
	 * importing from the shared `./expiry-copy.ts` module — both
	 * surfaces read title, body, and button labels from one source so
	 * paraphrase drift is impossible. Each surface's component test
	 * asserts the verbatim contract independently.
	 *
	 * Pure presentation: callbacks (`onApproveDefault`, `onApproveForever`,
	 * `onCancel`) are wired by the parent. The component does NOT issue
	 * any network requests — chat-side parents POST
	 * /api/tool-calls/:id/permission; settings-side parents POST
	 * /api/extensions/:id/reapprove.
	 *
	 * Phase 56 (per-capability TTL UI):
	 *   - Renames `newTtlMs` → `initialTtlMs` (number | null). Default
	 *     is `DEFAULT_TTL_FIRST_USE_MS` (30d) when omitted; Plan 56-03
	 *     will wire the per-user/per-kind sticky last-pick into this
	 *     prop at the parent.
	 *   - Adds a native `<select>` picker with 7 options from
	 *     `TTL_OPTIONS` (1h/6h/1d/7d/30d/90d/Never). Selecting a value
	 *     updates the "Approve $ttl" button label live via Svelte 5
	 *     `$derived` (which recomputes when `selectedTtlMs` changes).
	 *   - `onApproveDefault` signature widens to receive the picker's
	 *     current value: `(ttlOverrideMs: number | null) => void`.
	 *     `null` means "Never" (per-row override → unbounded grant,
	 *     sweep skips). The parent POSTs `ttlOverrideMs` verbatim.
	 *
	 * The "Approve forever (admin only)" button stays unchanged — its
	 * semantic is scope escalation (`scope: "forever"`), NOT picker
	 * Never (which sets `ttlOverrideMs: null` on the current scope).
	 * Defense-in-depth on `scope=forever` admin gating is preserved
	 * server-side regardless of which path the user takes.
	 */
	import {
		expiryCopy,
		TTL_OPTIONS,
		DEFAULT_TTL_FIRST_USE_MS,
	} from "./expiry-copy";

	let {
		extensionName,
		capability,
		ageMs,
		initialTtlMs = DEFAULT_TTL_FIRST_USE_MS,
		isAdmin = false,
		loading = false,
		onApproveDefault,
		onApproveForever,
		onCancel,
	}: {
		extensionName: string;
		capability: string;
		ageMs: number;
		/**
		 * Phase 56: initial picker selection. `number` for a positive
		 * TTL value; `null` for the Never option. Defaults to
		 * `DEFAULT_TTL_FIRST_USE_MS` (30d) when omitted by the parent.
		 */
		initialTtlMs?: number | null;
		isAdmin?: boolean;
		loading?: boolean;
		/**
		 * Phase 56: receives the picker's current `ttlOverrideMs` value
		 * (positive number for 1h..90d, `null` for Never). Parents
		 * forward this verbatim into the POST body.
		 */
		onApproveDefault: (ttlOverrideMs: number | null) => void;
		onApproveForever: () => void;
		onCancel: () => void;
	} = $props();

	// Phase 56: picker state. Driven by `bind:value` on the <select>;
	// changing it triggers Svelte 5's reactivity, which recomputes
	// `copy` via `$derived` so the Approve button label updates live.
	// Initializing from the `initialTtlMs` prop is intentional — the
	// prop is the SEED for the picker (sticky last-pick or first-use
	// fallback), not a live two-way binding. Parent changes after mount
	// would be confusing if they yanked the user's mid-edit selection.
	// svelte-ignore state_referenced_locally
	let selectedTtlMs = $state<number | null>(initialTtlMs);

	let copy = $derived(
		expiryCopy(extensionName, capability, ageMs, selectedTtlMs),
	);
</script>

<!--
	Title and body strings below come from `./expiry-copy.ts` (the
	verbatim design doc § 3.2 contract). The chat-side surface
	(`PermissionGate.svelte` expired branch) reads from the same module,
	so the two surfaces are guaranteed to render identical copy.
-->
<div
	class="rounded-md border border-amber-500/40 bg-amber-900/10 p-3"
	data-testid="expired-reapprove-modal"
>
	<div class="mb-2 flex items-center gap-2">
		<svg
			class="h-4 w-4 shrink-0 text-amber-400"
			fill="none"
			viewBox="0 0 24 24"
			stroke="currentColor"
			stroke-width="2"
		>
			<path
				stroke-linecap="round"
				stroke-linejoin="round"
				d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z"
			/>
		</svg>
		<span
			class="text-sm font-medium text-[var(--color-text-primary)]"
			data-testid="expired-reapprove-title"
		>{copy.title}</span>
	</div>
	<p
		class="mb-3 text-sm text-[var(--color-text-primary)]"
		data-testid="expired-reapprove-body"
	>{copy.body}</p>
	<div class="flex flex-wrap items-center gap-2" data-testid="expired-reapprove-actions">
		<!--
			Phase 56 — TTL picker. 7 options sourced from TTL_OPTIONS
			(single source of truth in ./expiry-copy.ts). The selected
			value drives both the Approve button label (via $derived
			above) and the ttlOverrideMs payload forwarded to the
			parent on Approve click.
		-->
		<select
			bind:value={selectedTtlMs}
			data-testid="expired-reapprove-ttl-picker"
			aria-label="Re-approval duration"
			class="rounded bg-[var(--color-surface-secondary)] px-2 py-1 text-xs text-[var(--color-text-primary)] disabled:opacity-50"
			disabled={loading}
		>
			{#each TTL_OPTIONS as opt}
				<option value={opt.value}>{opt.code}</option>
			{/each}
		</select>
		<button
			type="button"
			onclick={() => onApproveDefault(selectedTtlMs)}
			disabled={loading}
			data-testid="expired-reapprove-approve-default"
			class="rounded px-3 py-1.5 text-xs font-medium bg-green-700 hover:bg-green-600 text-white transition-colors disabled:opacity-50"
		>
			{loading ? 'Working...' : copy.approveDefault}
		</button>
		{#if isAdmin}
			<button
				type="button"
				onclick={onApproveForever}
				disabled={loading}
				data-testid="expired-reapprove-approve-forever"
				class="rounded px-3 py-1.5 text-xs font-medium bg-blue-700 hover:bg-blue-600 text-white transition-colors disabled:opacity-50"
			>
				{copy.approveForever}
			</button>
		{/if}
		<button
			type="button"
			onclick={onCancel}
			disabled={loading}
			data-testid="expired-reapprove-cancel"
			class="rounded px-3 py-1.5 text-xs font-medium bg-[var(--color-surface-tertiary)] hover:bg-[var(--color-surface-secondary)] text-[var(--color-text-primary)] transition-colors disabled:opacity-50"
		>
			{copy.cancel}
		</button>
	</div>
</div>
