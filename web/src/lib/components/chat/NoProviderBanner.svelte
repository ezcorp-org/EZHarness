<script lang="ts">
	import { onMount } from "svelte";
	import { store, refreshQuickstart } from "$lib/stores.svelte.js";
	import { providerAccess } from "$lib/provider-access.js";

	// `/api/settings` deny-lists `provider:apiKey:*` and `provider:oauth:*`,
	// so `store.settings` never carries provider creds — we have to ask the
	// server. `/api/quickstart` returns a flat boolean per onboarding step
	// and is gated only by `requireAuth`, so it works for non-admin users.
	// `null` while loading so we don't flash the warning before the answer.
	let role = $state<string | null>(null);
	let hasProvider = $derived(store.quickstartSteps?.provider ?? null);
	let access = $derived(providerAccess(role ?? undefined));

	onMount(async () => {
		try {
			const [, me] = await Promise.all([
				refreshQuickstart(),
				fetch("/api/auth/me").then(async (response) => {
					if (!response.ok) return null;
					return response.json() as Promise<{ user?: { role?: string } }>;
				}),
			]);
			role = me?.user?.role ?? null;
		} catch {
			// The provider guard stays fail-closed until identity can be read.
			role = null;
		}
	});
</script>

{#if hasProvider === false}
	<div
		class="mx-4 mt-4 rounded-md border border-[var(--color-warning,#f59e0b)]/50 bg-[var(--color-warning,#f59e0b)]/10 p-4 text-sm"
		role="status"
		data-testid="no-provider-banner"
	>
		<p class="font-semibold text-[var(--color-text-primary)]">{access.message}</p>
		<p class="mt-1 text-[var(--color-text-secondary)]">
			{#if access.canConfigure}
				You haven't connected an LLM provider yet. Add an API key or sign in with OAuth to send your first message.
			{:else}
				Ask a workspace administrator to add an API key or connect OAuth. Chat becomes available when setup is complete.
			{/if}
		</p>
		{#if access.canConfigure}
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
		{/if}
	</div>
{/if}
