<script lang="ts">
	import { store } from "$lib/stores.svelte.js";
	import { hasProviderInSettings } from "$lib/has-provider.js";

	// Reactive on the layout-populated `store.settings` so connecting a
	// provider in another tab (or on the Settings page) clears the
	// banner without a reload. Mirrors the predicate used by
	// QuickStartChecklist; the server's `hasAnyProvider()` SQL helper
	// uses the same key conventions.
	const hasProvider = $derived(hasProviderInSettings(store.settings));
</script>

{#if !hasProvider}
	<div
		class="mx-4 mt-4 rounded-md border border-amber-700 bg-amber-900/20 p-4 text-sm"
		role="status"
		data-testid="no-provider-banner"
	>
		<p class="font-medium text-amber-300">Connect a provider to start chatting</p>
		<p class="mt-1 text-[var(--color-text-secondary)]">
			You haven't connected an LLM provider yet. Add an API key or sign in with OAuth to send your first message.
		</p>
		<a
			href="/settings#providers"
			class="mt-3 inline-flex items-center gap-1.5 rounded-md bg-amber-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-amber-500 transition-colors"
			data-testid="no-provider-banner-cta"
		>
			Open Settings
			<svg class="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
				<path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M9 5l7 7-7 7" />
			</svg>
		</a>
	</div>
{/if}
