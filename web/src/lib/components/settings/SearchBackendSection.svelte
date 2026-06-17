<script lang="ts">
	import { onMount } from "svelte";
	import SettingsSection from "$lib/components/settings/SettingsSection.svelte";
	import SaveIndicator from "$lib/components/settings/SaveIndicator.svelte";
	import { createSaveFlash } from "$lib/save-flash.svelte.js";
	import { SEARCH_BYOK_PROVIDERS } from "$lib/settings-search-config.js";

	type ProviderStatus = { provider: string; hasKey: boolean };

	let loading = $state(true);
	let providers = $state<ProviderStatus[]>([]);
	let searxngUrl = $state("");
	// Per-provider key input buffers — never populated from the server
	// (keys are presence-only); cleared after a successful save.
	let keyInputs = $state<Record<string, string>>({});

	const urlFlash = createSaveFlash();
	const keyFlash = createSaveFlash();

	async function load() {
		loading = true;
		try {
			const res = await fetch("/api/search/backend");
			if (res.ok) {
				const data = await res.json();
				providers = data.providers ?? [];
				searxngUrl = data.searxngUrl ?? "";
			}
		} catch {
			/* silent */
		}
		loading = false;
	}

	// onMount (not $effect): one-shot load feeding state — the self-
	// retrigger footgun the layout calls out.
	onMount(load);

	async function saveUrl() {
		await urlFlash.run(async () => {
			const res = await fetch("/api/search/backend", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ searxngUrl }),
			});
			if (!res.ok) throw new Error("save failed");
		});
	}

	async function saveKey(provider: string) {
		const apiKey = (keyInputs[provider] ?? "").trim();
		if (apiKey.length === 0) return;
		const ok = await keyFlash.run(async () => {
			const res = await fetch("/api/search/backend", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider, apiKey }),
			});
			if (!res.ok) throw new Error("save failed");
		});
		if (ok) {
			keyInputs[provider] = "";
			await load();
		}
	}

	async function deleteKey(provider: string) {
		const ok = await keyFlash.run(async () => {
			const res = await fetch("/api/search/backend", {
				method: "DELETE",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider }),
			});
			if (!res.ok) throw new Error("delete failed");
		});
		if (ok) await load();
	}
</script>

<SettingsSection
	id="search-backend"
	title="Search Backend"
	tooltip="The instance-wide search backend: the SearXNG base URL (keyless metasearch) and any BYOK provider keys (Tavily, Brave, Exa, SerpApi, Jina). Keys are encrypted at rest and never returned by any API. These are instance-only — never per-extension."
	description="Configure the search provider backend. Keys are encrypted and shown only as present/absent."
>
	{#if loading}
		<p class="text-sm text-[var(--color-text-secondary)]">Loading...</p>
	{:else}
		<div class="space-y-5" data-testid="search-backend">
			<!-- SearXNG URL -->
			<div>
				<label for="search-searxng-url" class="mb-1 block text-sm font-medium text-[var(--color-text-primary)]">
					SearXNG URL
				</label>
				<div class="flex items-center gap-2">
					<input
						id="search-searxng-url"
						type="text"
						placeholder="http://searxng:8080"
						data-testid="search-searxng-url"
						bind:value={searxngUrl}
						class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-sm text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
					/>
					<button
						type="button"
						onclick={saveUrl}
						disabled={urlFlash.saving}
						data-testid="search-searxng-save"
						class="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
					>
						Save
					</button>
					<SaveIndicator saving={urlFlash.saving} saved={urlFlash.saved} error={urlFlash.error} />
				</div>
			</div>

			<!-- BYOK provider keys -->
			<div>
				<div class="mb-2 flex items-center gap-2">
					<p class="text-sm font-medium text-[var(--color-text-primary)]">Provider API keys</p>
					<SaveIndicator saving={keyFlash.saving} saved={keyFlash.saved} error={keyFlash.error} />
				</div>
				<div class="space-y-2">
					{#each SEARCH_BYOK_PROVIDERS as provider}
						{@const status = providers.find((p) => p.provider === provider)}
						<div class="flex items-center gap-2" data-testid="search-byok-{provider}">
							<span class="w-20 text-sm capitalize text-[var(--color-text-secondary)]">{provider}</span>
							{#if status?.hasKey}
								<span
									class="rounded-full bg-green-900/40 px-2 py-0.5 text-xs text-green-400"
									data-testid="search-byok-{provider}-set">Set</span
								>
								<button
									type="button"
									onclick={() => deleteKey(provider)}
									disabled={keyFlash.saving}
									data-testid="search-byok-{provider}-remove"
									class="text-xs text-red-400 hover:text-red-300 transition-colors disabled:opacity-50"
								>
									Remove
								</button>
							{:else}
								<input
									type="password"
									placeholder="Paste {provider} API key"
									bind:value={keyInputs[provider]}
									data-testid="search-byok-{provider}-input"
									class="flex-1 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-secondary)] px-3 py-1.5 text-xs text-[var(--color-text-primary)] placeholder-[var(--color-text-muted)] focus:border-[var(--color-accent)] focus:outline-none"
								/>
								<button
									type="button"
									onclick={() => saveKey(provider)}
									disabled={keyFlash.saving || !(keyInputs[provider] ?? "").trim()}
									data-testid="search-byok-{provider}-save"
									class="rounded-md bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-500 disabled:opacity-50 transition-colors"
								>
									Save
								</button>
							{/if}
						</div>
					{/each}
				</div>
			</div>
		</div>
	{/if}
</SettingsSection>
