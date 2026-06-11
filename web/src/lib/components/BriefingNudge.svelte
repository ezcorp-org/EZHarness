<script lang="ts">
	/**
	 * One-time discoverability nudge for the Daily Briefing (spec §7.1).
	 *
	 * Shows a dismissible sidebar card linking to /settings/briefing.
	 * Hidden when:
	 *   - the user dismissed it (localStorage, v1 persistence), or
	 *   - the briefing is already enabled, or
	 *   - the config carries a `createdAt` (a stored row exists — the user
	 *     already configured the briefing and chose to disable it; don't
	 *     re-nudge them), or
	 *   - the config can't be confirmed as enabled === false (fail-closed:
	 *     a failed/odd fetch never flashes the card).
	 */
	const DISMISS_KEY = "ezcorp-briefing-nudge-dismissed";

	function loadDismissed(): boolean {
		try {
			return localStorage.getItem(DISMISS_KEY) === "1";
		} catch {
			return false;
		}
	}

	let dismissed = $state(typeof localStorage !== "undefined" ? loadDismissed() : true);
	// `null` until the config check answers — the card never renders early.
	let briefingEnabled = $state<boolean | null>(null);
	// A stored config row exists (createdAt present) — the user already
	// visited the settings and made a choice; never re-nudge them.
	let previouslyConfigured = $state(false);

	let visible = $derived(!dismissed && briefingEnabled === false && !previouslyConfigured);

	$effect(() => {
		if (dismissed) return; // no fetch when it could never show
		fetch("/api/briefing/config")
			.then((r) => (r.ok ? r.json() : null))
			.then((config) => {
				if (config && typeof config.enabled === "boolean") {
					briefingEnabled = config.enabled;
					previouslyConfigured = Boolean(config.createdAt);
				}
			})
			.catch(() => {});
	});

	function dismiss() {
		dismissed = true;
		try {
			localStorage.setItem(DISMISS_KEY, "1");
		} catch {
			// localStorage unavailable — hide for this session only
		}
	}
</script>

{#if visible}
	<div
		class="mt-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-tertiary)] p-3"
		data-testid="briefing-nudge"
	>
		<div class="mb-1 flex items-center justify-between">
			<span class="text-xs font-semibold text-[var(--color-text-secondary)]">Morning briefing</span>
			<button
				onclick={dismiss}
				class="rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
				title="Dismiss"
				aria-label="Dismiss briefing suggestion"
				data-testid="briefing-nudge-dismiss"
			>
				<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
					<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M6 18L18 6M6 6l12 12" />
				</svg>
			</button>
		</div>
		<p class="mb-2 text-xs text-[var(--color-text-muted)]">
			Wake up to a daily recap of your open threads, tasks, and memories.
		</p>
		<a
			href="/settings/briefing"
			class="text-xs font-medium text-[var(--color-accent)] hover:underline"
			data-testid="briefing-nudge-link"
		>
			Set up your morning briefing →
		</a>
	</div>
{/if}
