<script lang="ts">
	import { onMount } from "svelte";

	// `/api/settings` deny-lists `provider:apiKey:*` and `provider:oauth:*`,
	// so `store.settings` never carries provider creds — we have to ask the
	// server. `/api/quickstart` returns a flat boolean per onboarding step
	// and is gated only by `requireAuth`, so it works for non-admin users.
	// `null` while loading so we don't flash the warning before the answer.
	let hasProvider = $state<boolean | null>(null);

	onMount(async () => {
		try {
			const res = await fetch("/api/quickstart");
			if (!res.ok) {
				hasProvider = false;
				return;
			}
			const data = (await res.json()) as { steps?: { provider?: boolean } };
			hasProvider = data.steps?.provider === true;
		} catch {
			hasProvider = false;
		}
	});
</script>

{#if hasProvider === false}
	<div
		class="mx-4 mt-4 rounded-md border border-amber-700 bg-amber-900/20 p-4 text-sm"
		role="status"
		data-testid="no-provider-banner"
	>
		<!-- Theme token, not a fixed amber step. Any single amber shade fails
		     contrast on one of the two themes (amber-300 failed on light,
		     amber-200 worse); the tinted-background + primary-text pairing is
		     what RoutingExperimentsSection's ERROR_CLASS uses for the same
		     reason, and it survives both. -->
		<p class="font-medium text-[var(--color-text-primary)]">Connect a provider to start chatting</p>
		<p class="mt-1 text-[var(--color-text-secondary)]">
			You haven't connected an LLM provider yet. Add an API key or sign in with OAuth to send your first message.
		</p>
		<!-- White on amber-600 is ~3.2:1, below the 4.5:1 AA floor. amber-700
		     clears it at ~5:1, and hover goes DARKER (amber-800, ~7:1) so the
		     hover state does not fall back under the floor. -->
		<a
			href="/settings/models#providers"
			class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-800 transition-colors"
			data-testid="no-provider-banner-cta"
		>
			Open Settings
			<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</a>
	</div>
{/if}
