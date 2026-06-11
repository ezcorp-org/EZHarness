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
		<p class="font-medium text-amber-300">Connect a provider to start chatting</p>
		<p class="mt-1 text-[var(--color-text-secondary)]">
			You haven't connected an LLM provider yet. Add an API key or sign in with OAuth to send your first message.
		</p>
		<a
			href="/settings/models#providers"
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
