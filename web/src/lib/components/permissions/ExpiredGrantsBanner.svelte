<script lang="ts">
	/**
	 * Phase 4 (capability-expiry) — settings-page banner listing
	 * permission grants the sweep revoked in the last 7 days.
	 *
	 * Rendering rules:
	 *   • Empty list → render nothing (no empty-state placeholder; the
	 *     banner is a notification, not a hero card).
	 *   • Non-empty  → render the heading + a row per grant. Each row
	 *     shows the capability + age + a "Re-approve" action button.
	 *
	 * The banner does NOT itself open the modal — clicking a row's
	 * action invokes the `onReapprove` callback with the grant
	 * metadata, and the parent page wires that up. Keeps this
	 * component pure-presentation; the parent owns modal state.
	 *
	 * `isAdmin` is forwarded only so consumers can opt to hide the
	 * banner entirely on non-admin views; the actual "Approve forever
	 * (admin only)" gating lives in the modal itself, not on the
	 * banner's reapprove button (per orchestrator brief).
	 */
	import { formatTtl } from "$lib/utils/relative-time";

	export interface ExpiredGrant {
		extensionId: string;
		capability: string;
		ageMs: number;
		expiredAt: number; // unix ms
		auditId: string;
		/**
		 * Phase 56 (per-capability TTL UI): the per-row TTL override the
		 * user chose at re-approve time, projected through the sweep onto
		 * this expired row.
		 *   • number  → "Approved for {formatTtl(n, 'absolute')}" copy.
		 *   • null    → "Approved forever" copy (Never sentinel).
		 *   • absent  → legacy row; banner does not render the TTL cell.
		 *
		 * The endpoint surfaces this from the audit row's `ttlMs` metadata
		 * field (the sweep's applied TTL) — see
		 * `src/db/queries/expired-grants.ts` for the wire projection. The
		 * picker's separately-tracked sticky-pick is plumbed via the
		 * `stickyTtlMs` field on the response, NOT here.
		 */
		ttlOverrideMs?: number | null;
		/**
		 * Phase 56 (per-capability TTL UI): the user's previously-chosen
		 * picker TTL for this capability kind. Forwarded through
		 * `onReapprove` so the parent page can seed the modal's
		 * `initialTtlMs` without re-fetching. `null` → first use; the
		 * parent should fall back to `DEFAULT_TTL_FIRST_USE_MS`.
		 */
		stickyTtlMs?: number | null;
	}

	// `isAdmin` is accepted on the prop interface for symmetry with
	// PermissionGate's expired branch and as a hook for future banner-
	// side admin affordances (e.g. an inline "Approve forever" shortcut
	// the orchestrator brief explicitly leaves on the modal). v1
	// doesn't render anything role-conditioned on the banner itself —
	// the role gate lives on the modal — so we destructure but never
	// read it. We deliberately do NOT add a `void isAdmin` discard
	// because Svelte 5 treats that as a non-reactive read and emits
	// the `state_referenced_locally` warning at compile time.
	// Suppressing TS' unused-prop diagnostic via the
	// `// @ts-expect-error` comment would also be load-bearing on the
	// lint config; the destructure-without-read pattern is the path
	// other components in this repo follow (search for `// @ts-expect`
	// in `web/src/lib/components`).
	// biome-ignore lint/correctness/noUnusedVariables: forwarded prop, unused in v1
	let {
		expiredGrants,
		isAdmin = false,
		onReapprove,
	}: {
		expiredGrants: ExpiredGrant[];
		isAdmin?: boolean;
		onReapprove: (grant: {
			capability: string;
			ageMs: number;
			stickyTtlMs?: number | null;
		}) => void;
	} = $props();
</script>

{#if expiredGrants.length > 0}
	<div
		class="rounded-lg border border-amber-500/40 bg-amber-900/10 p-4"
		data-testid="expired-grants-banner"
	>
		<h3 class="mb-1 text-sm font-medium text-amber-300">
			Recent permission expirations
		</h3>
		<p class="mb-3 text-xs text-[var(--color-text-secondary)]">
			These grants expired in the last 7 days. Re-approve to keep using
			the affected capabilities.
		</p>
		<ul class="space-y-2" data-testid="expired-grants-list">
			{#each expiredGrants as grant (grant.auditId)}
				<li
					class="flex items-center justify-between gap-3 rounded-md border border-amber-500/30 bg-[var(--color-surface)]/40 px-3 py-2 text-sm"
					data-testid="expired-grants-row"
					data-capability={grant.capability}
				>
					<div class="flex min-w-0 flex-1 items-center gap-2">
						<span
							class="rounded-full bg-amber-500/20 px-2 py-0.5 text-xs font-medium text-amber-300"
							data-testid="expired-grants-row-capability"
						>{grant.capability}</span>
						<span
							class="text-xs text-[var(--color-text-secondary)]"
							data-testid="expired-grants-row-age"
						>expired {formatTtl(grant.ageMs, "past")}</span>
						{#if grant.ttlOverrideMs !== undefined}
							<span
								class="text-xs text-[var(--color-text-muted)]"
								data-testid="expired-grants-row-ttl"
							>{grant.ttlOverrideMs === null
								? "Approved forever"
								: `Approved for ${formatTtl(grant.ttlOverrideMs, "absolute")}`}</span>
						{/if}
					</div>
					<button
						type="button"
						onclick={() =>
							onReapprove({
								capability: grant.capability,
								ageMs: grant.ageMs,
								stickyTtlMs: grant.stickyTtlMs,
							})}
						data-testid="expired-grants-row-reapprove"
						class="rounded px-3 py-1 text-xs font-medium bg-blue-600 hover:bg-blue-500 text-white transition-colors"
					>
						Re-approve
					</button>
				</li>
			{/each}
		</ul>
	</div>
{/if}
